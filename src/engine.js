import { randomBytes } from 'node:crypto';
import { q } from './db.js';
import { loadPolicy, validateOffers, validateMessage, refundedSoFar, maxPartialRefundCents, fmt, humanDate } from './policy.js';
import { evaluateShipment } from './rules.js';
import { createExecutor } from './executor.js';
import { addDays, ymd } from './clock.js';

const ACTIVE = ['flagged', 'offered', 'awaiting_merchant', 'escalated', 'executing'];
const token = () => randomBytes(16).toString('hex');
const MAX_PROPOSE_ATTEMPTS = 3;

export function createEngine({ db, clock, audit, paypal, carrier, agent, config }) {
  const executor = createExecutor({ db, money: paypal.money, audit, clock });
  const log = (kind, incidentId, actor, data) => audit.log(kind, { incidentId, actor, data });
  const getIncident = (id) => q.get(db, 'SELECT * FROM incidents WHERE id = ?', id);
  const getOrder = (id) => q.get(db, 'SELECT * FROM orders WHERE id = ?', id);
  const touch = (id, sets, ...params) => q.run(db, `UPDATE incidents SET ${sets}, updated_at = ? WHERE id = ?`, ...params, clock.iso(), id);

  function say(incidentId, direction, body) {
    q.run(db, 'INSERT INTO messages (incident_id, direction, body, created_at) VALUES (?, ?, ?, ?)', incidentId, direction, body, clock.iso());
    log(direction === 'out' ? 'message_sent' : 'message_received', incidentId, direction === 'out' ? 'agent' : 'buyer', { body });
  }

  // FR1: a paid order, anchored on its PayPal capture ID. Idempotent per capture.
  function ingestOrder(o) {
    const existing = q.get(db, 'SELECT * FROM orders WHERE capture_id = ?', o.captureId);
    if (existing) return existing;
    q.run(db, 'INSERT INTO orders (merchant_order_id, paypal_order_id, capture_id, buyer_email, buyer_name, amount_cents, currency, promised_date, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', o.merchantOrderId, o.paypalOrderId || null, o.captureId, o.buyerEmail, o.buyerName, o.amountCents, o.currency || 'USD', o.promisedDate, clock.iso());
    const order = q.get(db, 'SELECT * FROM orders WHERE capture_id = ?', o.captureId);
    log('order_ingested', null, 'system', { orderId: order.id, captureId: order.capture_id, amountCents: order.amount_cents });
    return order;
  }

  // FR2: record tracking with PayPal when the merchant ships.
  async function shipOrder(orderId, { trackingNumber, carrier: name = 'SimCarrier' }) {
    const order = getOrder(orderId);
    const t = await paypal.money.addTracking({ captureId: order.capture_id, trackingNumber, carrier: name });
    q.run(db, 'INSERT INTO shipments (order_id, tracking_number, carrier, label_created_at, paypal_tracking_id) VALUES (?, ?, ?, ?, ?)', orderId, trackingNumber, name, clock.iso(), t.tracking_id);
    log('tracking_recorded', null, 'merchant', { orderId, trackingNumber, paypalTrackingId: t.tracking_id });
    return q.get(db, 'SELECT * FROM shipments WHERE tracking_number = ?', trackingNumber);
  }

  // FR3 + FR4: pull carrier events, update shipments, flag risks, run the pipeline for new incidents.
  async function poll({ proposer } = {}) {
    const now = clock.now();
    const open = q.all(db, "SELECT * FROM shipments WHERE superseded = 0");
    for (const e of carrier.fetchEvents(open.map((s) => s.tracking_number), now)) {
      const key = `${e.trackingNumber}|${e.status}|${e.occurredAt}`;
      const ins = q.run(db, 'INSERT OR IGNORE INTO carrier_events (idempotency_key, tracking_number, status, text, occurred_at) VALUES (?, ?, ?, ?, ?)', key, e.trackingNumber, e.status, e.text, e.occurredAt);
      if (ins.changes === 0) continue; // duplicate carrier event
      q.run(db, 'UPDATE shipments SET status = ?, last_event_at = ?, last_event_text = ? WHERE tracking_number = ?', e.status, e.occurredAt, e.text, e.trackingNumber);
      log('carrier_event', null, 'carrier', e);
      if (e.status === 'DELIVERED') onDelivered(e.trackingNumber);
    }
    const flagged = [];
    for (const s of q.all(db, "SELECT * FROM shipments WHERE superseded = 0 AND status != 'DELIVERED'")) {
      const order = getOrder(s.order_id);
      if (q.get(db, `SELECT 1 AS x FROM incidents WHERE order_id = ? AND state IN (${ACTIVE.map(() => '?').join(',')})`, order.id, ...ACTIVE)) continue;
      const hits = evaluateShipment({ order, shipment: s, now, noScanDays: config.noScanDays });
      if (hits.length === 0) continue;
      // One remedy per incident: don't re-flag a shipment we already resolved, rejected or lost to a dispute.
      if (q.get(db, "SELECT 1 AS x FROM incidents WHERE shipment_id = ? AND (state IN ('rejected','disputed','closed') OR (state = 'executed' AND rule = ?))", s.id, hits[0].rule)) continue;
      flagged.push(await openIncident(order, s, hits, proposer));
    }
    return flagged;
  }

  function onDelivered(trackingNumber) {
    const s = q.get(db, 'SELECT * FROM shipments WHERE tracking_number = ?', trackingNumber);
    const inc = q.get(db, `SELECT * FROM incidents WHERE order_id = ? AND state IN (${ACTIVE.map(() => '?').join(',')})`, s.order_id, ...ACTIVE);
    if (!inc) return;
    touch(inc.id, "state = 'closed', resolution_json = ?", JSON.stringify({ closedBy: 'delivered', note: 'Parcel delivered; any pending reship cancelled.' }));
    log('incident_closed', inc.id, 'system', { reason: 'delivered' });
  }

  async function openIncident(order, shipment, hits, proposer) {
    const primary = hits[0];
    const dispute = await paypal.read.hasOpenDispute(order.capture_id);
    const now = clock.iso();
    let id;
    try {
      id = Number(q.run(db, "INSERT INTO incidents (order_id, shipment_id, rule, signals_json, state, buyer_token, flagged_at, updated_at) VALUES (?, ?, ?, ?, 'flagged', ?, ?, ?)", order.id, shipment.id, primary.rule, JSON.stringify(hits), token(), now, now).lastInsertRowid);
    } catch {
      return null;
    }
    log('risk_flagged', id, 'rules', { hits, shipmentStatus: shipment.status });
    if (dispute) {
      touch(id, "state = 'disputed'");
      log('outreach_stopped', id, 'system', { reason: 'dispute_already_open' });
      return getIncident(id);
    }
    await runPipeline(id, proposer);
    return getIncident(id);
  }

  // AI assess -> AI propose -> validator (loop back on violations) -> message -> outreach.
  async function runPipeline(id, proposer) {
    const inc = getIncident(id);
    const order = getOrder(inc.order_id);
    const shipment = q.get(db, 'SELECT * FROM shipments WHERE id = ?', inc.shipment_id);
    const policy = loadPolicy(db);
    const refunded = refundedSoFar(db, order.capture_id);
    const base = { rule: inc.rule, signals: JSON.parse(inc.signals_json), order, shipment, policy, now: clock.now(), maxRefund: maxPartialRefundCents(policy, order, refunded) };

    const assessment = await agent.assess(base);
    touch(id, 'risk_level = ?, issue = ?, reason = ?', assessment.level, assessment.issue, assessment.reason);
    log('risk_assessed', id, `agent:${assessment.source}`, assessment);

    let feedback = [];
    let accepted = null;
    for (let attempt = 1; attempt <= MAX_PROPOSE_ATTEMPTS; attempt++) {
      const proposal = await (proposer || agent.propose.bind(agent))({ ...base, assessment }, feedback);
      const verdict = validateOffers(proposal.offers, { policy, order, refunded, now: clock.now() });
      log('remedies_proposed', id, `agent:${proposal.source || 'custom'}`, { attempt, offers: proposal.offers, reasoning: proposal.reasoning });
      log(verdict.ok ? 'validator_passed' : 'validator_blocked', id, 'validator', { attempt, accepted: verdict.accepted, violations: verdict.violations });
      if (verdict.ok) { accepted = verdict.accepted; break; }
      feedback = verdict.violations;
      if (attempt === MAX_PROPOSE_ATTEMPTS && verdict.accepted.length) accepted = verdict.accepted; // keep only what passed
    }
    if (!accepted) accepted = safeFallback(base);
    touch(id, 'offers_json = ?', JSON.stringify(accepted));

    const msg = await agent.compose({ order, offers: accepted, tone: policy.tone });
    const check = validateMessage(msg.text, accepted, order);
    log(check.ok ? 'message_validated' : 'message_blocked', id, 'validator', { problems: check.problems });
    const link = `${config.baseUrl}/b/${inc.buyer_token}`;
    say(id, 'out', `${check.ok ? msg.text : (await agent.compose({ order, offers: accepted, tone: policy.tone })).text}\n\n${link}`);
    touch(id, "state = 'offered', contacted_at = ?", clock.iso());
  }

  function safeFallback(base) {
    const eta = ymd(addDays(base.now, Math.min(base.policy.maxEtaDays, 7)));
    return base.policy.allowedRemedies.includes('new_eta') ? [{ type: 'new_eta', eta }] : [];
  }

  // FR8: buyer picks an option or writes free text. Text is classified, never obeyed.
  async function buyerRespond(buyerToken, { index, text }) {
    const inc = q.get(db, 'SELECT * FROM incidents WHERE buyer_token = ?', buyerToken);
    if (!inc) return { ok: false, code: 'not_found' };
    if (inc.state !== 'offered') return { ok: false, code: 'not_open', state: inc.state };
    const offers = JSON.parse(inc.offers_json);
    let chosen = null;
    if (Number.isInteger(index) && offers[index]) {
      chosen = offers[index];
    } else if (text && text.trim()) {
      say(inc.id, 'in', text.slice(0, 1000));
      const r = await agent.readReply({ text, offers });
      log('reply_classified', inc.id, `agent:${r.source}`, r);
      if (r.intent === 'choose') chosen = offers[r.index];
      else {
        const reply = r.intent === 'wants_more'
          ? 'Thanks for telling us. That is more than we can offer automatically, so we have passed your request to the seller to decide. We will be in touch soon.'
          : 'Sorry, we could not tell which option you prefer. Please pick one of the options on this page, or the seller will follow up.';
        say(inc.id, 'out', reply);
        if (r.intent === 'wants_more') {
          touch(inc.id, "state = 'escalated', approval_token = ?, chosen_at = ?", token(), clock.iso());
          log('escalated_to_merchant', inc.id, 'system', { reason: 'buyer_requested_more_than_policy' });
        }
        return { ok: true, escalated: r.intent === 'wants_more', message: reply };
      }
    } else return { ok: false, code: 'no_choice' };

    return onChoice(inc.id, chosen);
  }

  async function onChoice(id, chosen) {
    const order = getOrder(getIncident(id).order_id);
    const policy = loadPolicy(db);
    const approvalToken = token();
    touch(id, "state = 'awaiting_merchant', chosen_json = ?, approval_token = ?, chosen_at = ?", JSON.stringify(chosen), approvalToken, clock.iso());
    log('buyer_chose', id, 'buyer', { chosen });
    const auto = chosen.type === 'new_eta' || (chosen.type === 'partial_refund' && chosen.amountCents <= policy.autoApproveCents);
    if (auto) {
      log('auto_approved', id, 'policy', { autoApproveCents: policy.autoApproveCents });
      const r = await executor.execute(id, chosen, { token: approvalToken, approver: 'policy:auto' });
      if (r.ok) await confirmToBuyer(id, chosen, order);
      return { ok: true, autoApproved: true, result: r };
    }
    return { ok: true, awaitingMerchant: true };
  }

  async function confirmToBuyer(id, offer, order) {
    const text = offer.type === 'new_eta' ? `Thank you. Your new delivery date is ${humanDate(offer.eta)}.` : offer.type === 'reship' ? 'Thank you. A replacement is on its way and tracking has been updated.' : `Thank you. ${fmt(offer.amountCents)} has been refunded to your PayPal.`;
    say(id, 'out', text);
  }

  // FR9: approve / edit / reject. Reject sends nothing. Edits are re-validated against policy.
  async function merchantDecide(id, { action, approvalToken, edit }) {
    const inc = getIncident(id);
    if (!inc) return { ok: false, code: 'not_found' };
    const order = getOrder(inc.order_id);
    if (action === 'reject') {
      if (!['awaiting_merchant', 'escalated'].includes(inc.state)) return { ok: false, code: 'bad_state', state: inc.state };
      touch(id, "state = 'rejected', decided_at = ?, resolution_json = ?", clock.iso(), JSON.stringify({ rejected: true }));
      log('merchant_rejected', id, 'merchant', {});
      return { ok: true, rejected: true };
    }
    let offer = inc.chosen_json ? JSON.parse(inc.chosen_json) : null;
    if (edit) offer = { ...offer, ...edit };
    if (!offer) return { ok: false, code: 'no_offer' };
    if (edit) log('merchant_edited', id, 'merchant', { offer });
    const r = await executor.execute(id, offer, { token: approvalToken, approver: 'merchant' });
    if (r.ok && !r.replayed) {
      log('merchant_approved', id, 'merchant', { offer });
      await confirmToBuyer(id, offer, order);
    }
    return r;
  }

  // FR14: a dispute that happened anyway. Stop outreach, hand over the timeline.
  function onDispute(event) {
    const res = event.resource || {};
    const disputeId = res.dispute_id;
    const captureId = res.disputed_transactions?.[0]?.seller_transaction_id;
    const order = captureId ? q.get(db, 'SELECT * FROM orders WHERE capture_id = ?', captureId) : null;
    const inc = order && q.get(db, 'SELECT * FROM incidents WHERE order_id = ? ORDER BY id DESC LIMIT 1', order.id);
    q.run(db, 'INSERT OR IGNORE INTO disputes (paypal_dispute_id, capture_id, incident_id, status, created_at) VALUES (?, ?, ?, ?, ?)', disputeId, captureId || null, inc?.id || null, res.status || 'OPEN', clock.iso());
    if (event.event_type === 'CUSTOMER.DISPUTE.RESOLVED') q.run(db, "UPDATE disputes SET status = 'RESOLVED' WHERE paypal_dispute_id = ?", disputeId);
    if (inc && ACTIVE.includes(inc.state) && event.event_type !== 'CUSTOMER.DISPUTE.RESOLVED') {
      touch(inc.id, "state = 'disputed'");
      log('outreach_stopped', inc.id, 'system', { reason: 'dispute_opened', disputeId });
    }
    log('dispute_linked', inc?.id ?? null, 'paypal', { disputeId, captureId, eventType: event.event_type, timeline: inc ? audit.forIncident(inc.id).map((a) => ({ ts: a.ts, kind: a.kind })) : [] });
    return { disputeId, incidentId: inc?.id ?? null };
  }

  // FR13: numbers derived from the same tables the audit log is written alongside.
  function dashboard() {
    const one = (sql, ...p) => q.get(db, sql, ...p);
    const avgMin = (a, b) => one(`SELECT AVG((julianday(${b}) - julianday(${a})) * 1440) AS m FROM incidents WHERE ${a} IS NOT NULL AND ${b} IS NOT NULL`).m;
    const flagged = one('SELECT COUNT(*) AS c FROM incidents').c;
    const resolved = one("SELECT COUNT(*) AS c FROM incidents WHERE state IN ('executed','closed')").c;
    const disputes = one('SELECT COUNT(*) AS c FROM disputes').c;
    return {
      flagged,
      open: one(`SELECT COUNT(*) AS c FROM incidents WHERE state IN (${ACTIVE.map(() => '?').join(',')})`, ...ACTIVE).c,
      resolved,
      rejected: one("SELECT COUNT(*) AS c FROM incidents WHERE state = 'rejected'").c,
      disputesOpened: disputes,
      refundsCount: one('SELECT COUNT(*) AS c FROM refunds').c,
      refundCents: one('SELECT COALESCE(SUM(amount_cents),0) AS s FROM refunds').s,
      blockedProposals: one("SELECT COUNT(*) AS c FROM audit_log WHERE kind IN ('validator_blocked','execution_blocked')").c,
      resolutionRate: flagged ? resolved / flagged : null,
      avgMinutesToContact: avgMin('flagged_at', 'contacted_at'),
      avgMinutesToDecision: avgMin('chosen_at', 'decided_at'),
    };
  }

  return { ingestOrder, shipOrder, poll, buyerRespond, merchantDecide, onDispute, dashboard, getIncident, getOrder, executor };
}
