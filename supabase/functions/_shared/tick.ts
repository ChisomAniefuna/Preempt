// One run of the background loop (called by Supabase Cron every 30 seconds and by the demo panel).
// Every step is safe to run twice: rows are claimed with leases / skip locked, and each side effect is keyed.
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';
import { approveOffer } from './approve.ts';
import { type AuditFn } from './audit.ts';
import { eventsUpTo, type Scenario } from './carrier-sim.ts';
import { executeAction } from './executor.ts';
import { hashToken, signToken } from './buyer-token.ts';
import { sendBuyerEmail } from './email.ts';
import { createStore } from './store.ts';
import type { PayPal } from './paypal/client.ts';
import { createReadTools } from './paypal/toolkit.ts';
import { assess } from './agent/assess.ts';
import { propose } from './agent/propose.ts';
import { draftMessage, templateMessage } from './agent/message.ts';
import { interpret } from './agent/interpret.ts';
import type { Llm } from './agent/llm.ts';
import { evaluateRules, TERMINAL } from './risk-rules.ts';
import { addDays, type Option, type Policy, usd, ymd } from './types.ts';
import { validateMessage, validateOptions } from './validator.ts';
import { one } from './http.ts';

export interface TickDeps {
  admin: SupabaseClient; paypal: PayPal; audit: AuditFn; getLlm: () => Promise<Llm>;
  appBaseUrl: string; tokenSecret: string; now?: () => Date;
  sendEmail?: typeof sendBuyerEmail;
}
export interface TickSummary { webhooks: number; shipmentsUpdated: number; incidentsOpened: number; offersSent: number; blocked: number; replies: number; autoApproved: number; executed: number; expired: number; errors: string[] }

const OPEN_STATES = ['OPEN', 'OFFERED', 'AWAITING_APPROVAL', 'EXECUTING', 'NEEDS_MERCHANT', 'ACTION_FAILED'];
const OFFER_TTL_DAYS = 7;

export async function runTick(deps: TickDeps): Promise<TickSummary> {
  const s: TickSummary = { webhooks: 0, shipmentsUpdated: 0, incidentsOpened: 0, offersSent: 0, blocked: 0, replies: 0, autoApproved: 0, executed: 0, expired: 0, errors: [] };
  const step = async (name: string, fn: () => Promise<void>) => { try { await fn(); } catch (e) { s.errors.push(`${name}: ${(e as Error).message}`); console.error(name, e); } };
  await step('applyWebhooks', () => applyWebhooks(deps, s));
  await step('pollCarriers', () => pollCarriers(deps, s));
  await step('runRules', () => runRules(deps, s));
  await step('assessAndPropose', () => assessAndPropose(deps, s));
  await step('interpretReplies', () => interpretReplies(deps, s));
  await step('autoApprove', () => autoApprove(deps, s));
  await step('execute', () => runActions(deps, s));
  await step('expireOffers', () => expireOffers(deps, s));
  return s;
}

const nowOf = (d: TickDeps) => (d.now ?? (() => new Date()))();

// ------------------------------------------------------------------ webhooks

async function applyWebhooks(d: TickDeps, s: TickSummary) {
  const { data: events } = await d.admin.from('webhook_events').select('*').eq('verified', true).is('processed_at', null).order('received_at').limit(50);
  for (const e of events ?? []) {
    try { await handleWebhook(d, e.event_type, e.payload); }
    catch (err) { s.errors.push(`webhook ${e.id}: ${(err as Error).message}`); continue; }
    await d.admin.from('webhook_events').update({ processed_at: nowOf(d).toISOString() }).eq('id', e.id);
    s.webhooks++;
  }
}

async function handleWebhook(d: TickDeps, type: string, payload: any) {
  const r = payload?.resource ?? {};
  if (type === 'PAYMENT.CAPTURE.COMPLETED') {
    const { data: existing } = await d.admin.from('orders').select('id').eq('capture_id', r.id).maybeSingle();
    if (existing) return;
    const payeeId = r.payee?.merchant_id;
    let merchantId: string | null = null;
    if (payeeId) merchantId = (await d.admin.from('merchants').select('id').eq('paypal_payer_id', payeeId).maybeSingle()).data?.id ?? null;
    if (!merchantId) { // demo convenience: with exactly one merchant, attribute the payment to them
      const { data: all } = await d.admin.from('merchants').select('id').limit(2);
      if (all?.length === 1) merchantId = all[0].id;
    }
    if (!merchantId) { await d.audit({ actor: 'WEBHOOK', kind: 'CAPTURE_UNATTRIBUTED', input: { captureId: r.id } }); return; }
    const orderId = r.supplementary_data?.related_ids?.order_id ?? `unknown-${r.id}`;
    await d.admin.from('orders').insert({
      merchant_id: merchantId, merchant_order_id: r.invoice_id ?? r.custom_id ?? r.id, paypal_order_id: orderId, capture_id: r.id,
      amount_cents: Math.round(Number(r.amount?.value) * 100), currency: r.amount?.currency_code ?? 'USD',
      buyer_email: 'unknown@example.invalid', buyer_name: 'there', promised_by: addDays(nowOf(d), 7).toISOString(),
    });
    await d.audit({ actor: 'WEBHOOK', kind: 'ORDER_CREATED_FROM_CAPTURE', input: { captureId: r.id } });
  } else if (type === 'PAYMENT.CAPTURE.REFUNDED') {
    const { data: action } = await d.admin.from('actions').select('id, status').eq('paypal_ref_id', r.id).maybeSingle();
    if (action) { await d.audit({ actor: 'WEBHOOK', kind: 'REFUND_CONFIRMED', input: { refundId: r.id }, output: { actionStatus: action.status } }); return; }
    // A refund made outside Preempt: count it so Preempt can never refund past the capture.
    const up = (r.links ?? []).find((l: any) => l.rel === 'up')?.href as string | undefined;
    const captureId = up?.split('/').pop();
    if (!captureId) return;
    const { data: order } = await d.admin.from('orders').select('id, refunded_cents, amount_cents').eq('capture_id', captureId).maybeSingle();
    if (!order) return;
    const next = Math.min(order.amount_cents, order.refunded_cents + Math.round(Number(r.amount?.value) * 100));
    await d.admin.from('orders').update({ refunded_cents: next }).eq('id', order.id);
    await d.audit({ actor: 'WEBHOOK', kind: 'EXTERNAL_REFUND_RECORDED', input: { refundId: r.id, captureId }, output: { refundedCents: next } });
  } else if (type.startsWith('CUSTOMER.DISPUTE.')) {
    await onDispute(d, type, r);
  }
}

async function onDispute(d: TickDeps, type: string, r: any) {
  const disputeId = r.dispute_id as string;
  const captureId = r.disputed_transactions?.[0]?.seller_transaction_id as string | undefined;
  let incident: any = null;
  if (captureId) {
    const { data: order } = await d.admin.from('orders').select('id').eq('capture_id', captureId).maybeSingle();
    if (order) incident = (await d.admin.from('incidents').select('*').eq('order_id', order.id).order('opened_at', { ascending: false }).limit(1).maybeSingle()).data;
  }
  if (!incident && disputeId) incident = (await d.admin.from('incidents').select('*').eq('dispute_id', disputeId).maybeSingle()).data;
  if (!incident) { await d.audit({ actor: 'WEBHOOK', kind: 'DISPUTE_WITHOUT_INCIDENT', input: { type, disputeId, captureId } }); return; }

  if (type === 'CUSTOMER.DISPUTE.CREATED') {
    const timeline = (await d.admin.from('audit_events').select('created_at, actor, kind').eq('incident_id', incident.id).order('id')).data ?? [];
    await d.admin.from('incidents').update({ state: 'DISPUTED', dispute_id: disputeId }).eq('id', incident.id);
    // Stop outreach and never pay twice: cancel live offers and any action not yet executed.
    const { data: offers } = await d.admin.from('offers').select('id').eq('incident_id', incident.id);
    const ids = (offers ?? []).map((o: any) => o.id);
    if (ids.length) {
      await d.admin.from('offers').update({ status: 'EXPIRED' }).in('id', ids).in('status', ['SENT', 'CHOSEN']);
      await d.admin.from('actions').update({ status: 'FAILED', error: { code: 'DISPUTE_OPEN', message: 'A dispute was opened before this action ran.' } }).in('offer_id', ids).eq('status', 'PENDING');
    }
    await d.audit({ incidentId: incident.id, actor: 'WEBHOOK', kind: 'DISPUTE_OPENED', input: { disputeId, captureId }, output: { handedToMerchant: true, timeline } });
  } else {
    await d.audit({ incidentId: incident.id, actor: 'WEBHOOK', kind: type === 'CUSTOMER.DISPUTE.RESOLVED' ? 'DISPUTE_RESOLVED' : 'DISPUTE_UPDATED', input: { disputeId, status: r.status } });
  }
}

// ------------------------------------------------------------------ carrier

async function pollCarriers(d: TickDeps, s: TickSummary) {
  const now = nowOf(d);
  const { data: ships } = await d.admin.from('shipments').select('*').not('sim_scenario', 'is', null);
  for (const sh of ships ?? []) {
    if (TERMINAL.includes(sh.last_status ?? '')) continue;
    const seen = new Set((sh.events ?? []).map((e: any) => e.id));
    const fresh = eventsUpTo(sh.sim_scenario as Scenario, sh.tracking_number, sh.sim_started_at, now).filter((e) => !seen.has(e.id));
    if (fresh.length === 0) continue;
    const all = [...(sh.events ?? []), ...fresh];
    const last = fresh[fresh.length - 1];
    await d.admin.from('shipments').update({ events: all, last_status: last.status, last_scan_at: last.at }).eq('id', sh.id);
    s.shipmentsUpdated++;
    await d.audit({ actor: 'SYSTEM', kind: 'CARRIER_EVENTS', input: { tracking: sh.tracking_number }, output: { events: fresh.map((e) => `${e.status} (day ${e.day})`) } });
    if (last.status === 'DELIVERED') await closeOnDelivery(d, sh.order_id);
  }
}

/** Delivered after an offer went out: the incident is moot. A refund already paid stands as goodwill. */
async function closeOnDelivery(d: TickDeps, orderId: string) {
  const { data: incs } = await d.admin.from('incidents').select('id, state').eq('order_id', orderId).in('state', ['OPEN', 'OFFERED', 'AWAITING_APPROVAL', 'NEEDS_MERCHANT']);
  for (const inc of incs ?? []) {
    await d.admin.from('incidents').update({ state: 'RESOLVED', closed_at: nowOf(d).toISOString() }).eq('id', inc.id);
    await d.admin.from('offers').update({ status: 'EXPIRED' }).eq('incident_id', inc.id).in('status', ['SENT', 'CHOSEN']);
    await d.audit({ incidentId: inc.id, actor: 'SYSTEM', kind: 'INCIDENT_CLOSED_DELIVERED', output: { note: 'Parcel delivered; pending fix cancelled.' } });
  }
}

// ------------------------------------------------------------------ rules

async function runRules(d: TickDeps, s: TickSummary) {
  const now = nowOf(d);
  const { data: ships } = await d.admin.from('shipments').select('*, orders!inner(*)');
  const latest = new Map<string, any>();
  for (const sh of ships ?? []) { // newest shipment per order (a reship supersedes the old tracking)
    const cur = latest.get(sh.order_id);
    if (!cur || (sh.sim_started_at ?? '') > (cur.sim_started_at ?? '')) latest.set(sh.order_id, sh);
  }
  const policies = new Map<string, Policy>();
  for (const sh of latest.values()) {
    if (TERMINAL.includes(sh.last_status ?? '')  && sh.last_status === 'DELIVERED') continue;
    const order = sh.orders;
    const { data: prior } = await d.admin.from('incidents').select('state, rule_fired').eq('order_id', order.id);
    if ((prior ?? []).some((i: any) => !['RESOLVED', 'DISPUTED', 'EXPIRED'].includes(i.state))) continue;
    if (!policies.has(order.merchant_id)) policies.set(order.merchant_id, (await d.admin.from('policies').select('*').eq('merchant_id', order.merchant_id).single()).data);
    const policy = policies.get(order.merchant_id)!;
    const shippedAt = sh.sim_started_at ?? order.created_at;
    const hits = evaluateRules({ lastStatus: sh.last_status, lastScanAt: sh.last_scan_at, shippedAt, promisedBy: order.promised_by }, now, policy.no_scan_days);
    if (hits.length === 0) continue;
    if ((prior ?? []).some((i: any) => i.rule_fired === hits[0].rule)) continue; // already handled this problem once
    const { data: inc, error } = await d.admin.from('incidents').insert({ order_id: order.id, rule_fired: hits[0].rule, state: 'OPEN' }).select('id').single();
    if (error) { if (error.code !== '23505') throw new Error(error.message); continue; } // unique index: another run got there first
    s.incidentsOpened++;
    await d.audit({ incidentId: inc.id, actor: 'RULE', kind: 'INCIDENT_OPENED', input: { shipmentStatus: sh.last_status, lastScanAt: sh.last_scan_at, promisedBy: order.promised_by }, output: { hits } });
  }
}

// ------------------------------------------------------------------ agent: assess, propose, validate, message, send

async function assessAndPropose(d: TickDeps, s: TickSummary) {
  const { data: claimed, error } = await d.admin.rpc('claim_incidents', { p_limit: 3 });
  if (error) throw new Error(error.message);
  for (const inc of claimed ?? []) {
    try { await processIncident(d, s, inc); }
    catch (e) {
      s.errors.push(`incident ${inc.id}: ${(e as Error).message}`);
      await d.audit({ incidentId: inc.id, actor: 'SYSTEM', kind: 'AGENT_ERROR', output: { message: (e as Error).message } });
    }
  }
}

const hash = async (v: unknown) => (await hashToken(JSON.stringify(v))).slice(0, 16);

async function processIncident(d: TickDeps, s: TickSummary, inc: any) {
  const now = nowOf(d);
  const toMerchant = async (reason: string, extra: Record<string, unknown> = {}) => {
    await d.admin.from('incidents').update({ state: 'NEEDS_MERCHANT', claimed_until: null }).eq('id', inc.id);
    await d.audit({ incidentId: inc.id, actor: 'SYSTEM', kind: 'NEEDS_MERCHANT', output: { reason, ...extra } });
  };

  const order = await one(d.admin.from('orders').select('*').eq('id', inc.order_id).single());
  const policy = await one(d.admin.from('policies').select('*').eq('merchant_id', order.merchant_id).single());
  const merchant = await one(d.admin.from('merchants').select('name').eq('id', order.merchant_id).single());
  const { data: offers } = await d.admin.from('offers').select('id, options, status').eq('incident_id', inc.id);
  if ((offers ?? []).filter((o: any) => o.status !== 'BLOCKED').length >= 3) return toMerchant('Three offers have already been tried.');

  const shipments = (await d.admin.from('shipments').select('*').eq('order_id', order.id)).data ?? [];
  const shipment = shipments.sort((a: any, b: any) => (b.sim_started_at ?? '').localeCompare(a.sim_started_at ?? ''))[0];
  const { data: rejectedEvents } = await d.admin.from('audit_events').select('input').eq('incident_id', inc.id).eq('kind', 'OFFER_REJECTED');
  const rejected = (rejectedEvents ?? []).map((e: any) => ({ options: e.input?.options ?? [], note: e.input?.note }));
  const { data: priorMsgs } = await d.admin.from('offers').select('buyer_reply').eq('incident_id', inc.id).not('buyer_reply', 'is', null);

  // Read-only PayPal facts for the assessment.
  const tools = createReadTools(d.paypal);
  let paypalFacts = { orderStatus: undefined as string | undefined, captureStatuses: [] as string[], openDisputes: 0 };
  try {
    const o = await tools.get_order(order.paypal_order_id);
    const disputes = await tools.get_shipment_facts(order.capture_id);
    paypalFacts = { orderStatus: o.status, captureStatuses: o.captures.map((c) => c.status), openDisputes: disputes.openDisputes.length };
    if (disputes.openDisputes.length) {
      await d.admin.from('incidents').update({ state: 'DISPUTED', dispute_id: disputes.openDisputes[0].dispute_id, claimed_until: null }).eq('id', inc.id);
      await d.audit({ incidentId: inc.id, actor: 'SYSTEM', kind: 'OUTREACH_STOPPED', output: { reason: 'dispute already open', disputeId: disputes.openDisputes[0].dispute_id } });
      return;
    }
  } catch (e) { await d.audit({ incidentId: inc.id, actor: 'SYSTEM', kind: 'PAYPAL_LOOKUP_FAILED', output: { message: (e as Error).message } }); }

  const llm = await d.getLlm();
  const assessInput = {
    rule: inc.rule_fired, ruleDetail: inc.rule_fired, orderValueCents: order.amount_cents, promisedBy: order.promised_by,
    shipment: { carrier: shipment?.carrier ?? 'unknown', lastStatus: shipment?.last_status ?? null, lastScanAt: shipment?.last_scan_at ?? null, events: (shipment?.events ?? []).map((e: any) => ({ status: e.status, location: e.location, at: e.at })) },
    paypal: paypalFacts, priorBuyerMessages: (priorMsgs ?? []).map((m: any) => m.buyer_reply as string),
  };
  const a = await assess(llm, assessInput);
  await d.admin.from('incidents').update({ risk_level: a.object.riskLevel, ai_reason: a.object.reason }).eq('id', inc.id);
  await d.audit({ incidentId: inc.id, actor: 'AGENT', kind: 'RISK_ASSESSED', input: { inputHash: await hash(assessInput), ...a.meta }, output: a.object });
  if (!a.object.contactBuyer) return toMerchant('The agent advised against contacting the buyer.', { likelyIssue: a.object.likelyIssue });

  // Propose, validate; on a violation ask once more with the violations listed.
  let violations: any[] = [];
  let accepted: Option[] | null = null;
  for (let attempt = 1; attempt <= 2 && !accepted; attempt++) {
    const p = await propose(llm, { policy, order, assessment: a.object, todayYmd: ymd(now), violations, rejected });
    const verdict = validateOptions(p.options, { policy, order, now });
    await d.audit({ incidentId: inc.id, actor: 'AGENT', kind: 'REMEDIES_PROPOSED', input: { attempt, ...p.meta }, output: { options: p.options } });
    await d.audit({ incidentId: inc.id, actor: 'VALIDATOR', kind: verdict.ok ? 'OFFER_VALIDATED' : 'OFFER_BLOCKED', input: { attempt }, output: { violations: verdict.violations, accepted: verdict.accepted } });
    if (verdict.ok) { accepted = verdict.accepted; break; }
    s.blocked++;
    violations = verdict.violations;
    await d.admin.from('offers').insert({ incident_id: inc.id, options: p.options, message: '(blocked before sending)', validator_result: { ok: false, violations: verdict.violations }, status: 'BLOCKED' });
  }
  if (!accepted) return toMerchant('Two proposals were blocked by policy.', { violations });

  // Message: up to two model drafts, each checked against the approved options; then a deterministic template.
  const msgInput = { options: accepted, tone: policy.tone, buyerName: order.buyer_name, buyerLocale: order.buyer_locale, merchantName: merchant.name, merchantOrderId: order.merchant_order_id, promisedBy: order.promised_by };
  let draft: Awaited<ReturnType<typeof draftMessage>>['object'] | null = null;
  let problems: string[] = [];
  for (let attempt = 1; attempt <= 2 && !draft; attempt++) {
    const m = await draftMessage(llm, { ...msgInput, violations: problems });
    const v = validateMessage(m.object, accepted, order);
    await d.audit({ incidentId: inc.id, actor: 'VALIDATOR', kind: v.ok ? 'MESSAGE_VALIDATED' : 'MESSAGE_BLOCKED', input: { attempt, ...m.meta }, output: { violations: v.violations } });
    if (v.ok) draft = m.object; else problems = v.violations.map((x) => x.message);
  }
  if (!draft) {
    draft = templateMessage(msgInput);
    await d.audit({ incidentId: inc.id, actor: 'SYSTEM', kind: 'MESSAGE_TEMPLATE_USED', output: { reason: 'model drafts failed validation' } });
  }

  // Create the offer and its signed, single-use buyer link.
  const offerId = crypto.randomUUID();
  const expiresAt = addDays(now, OFFER_TTL_DAYS);
  const token = await signToken(offerId, expiresAt.getTime(), d.tokenSecret);
  const { error: insErr } = await d.admin.from('offers').insert({
    id: offerId, incident_id: inc.id, options: accepted, message: draft.body, validator_result: { ok: true, violations: [] },
    status: 'SENT', token_hash: await hashToken(token), expires_at: expiresAt.toISOString(),
  });
  if (insErr) throw new Error(`offer insert failed: ${insErr.message}`);
  const link = `${d.appBaseUrl.replace(/\/$/, '')}/b/${token}`;
  await d.audit({ incidentId: inc.id, actor: 'AGENT', kind: 'BUYER_LINK_CREATED', input: { offerId }, output: { url: link, expiresAt: expiresAt.toISOString() } });

  const mail = await (d.sendEmail ?? sendBuyerEmail)(order.buyer_email, draft.subject, `${draft.body}\n\nChoose your fix: ${link}`);
  await d.audit({ incidentId: inc.id, actor: 'AGENT', kind: mail.sent ? 'BUYER_EMAILED' : 'BUYER_EMAIL_NOT_SENT', output: { to: order.buyer_email, error: mail.error } });
  await d.admin.from('incidents').update({ state: 'OFFERED', claimed_until: null }).eq('id', inc.id);
  s.offersSent++;
}

// ------------------------------------------------------------------ buyer free-text replies

async function interpretReplies(d: TickDeps, s: TickSummary) {
  const { data: claimed, error } = await d.admin.rpc('claim_replies', { p_limit: 5 });
  if (error) throw new Error(error.message);
  for (const offer of claimed ?? []) {
    try {
      const inc = await one(d.admin.from('incidents').select('*').eq('id', offer.incident_id).single());
      const order = await one(d.admin.from('orders').select('buyer_email, buyer_name, merchant_order_id').eq('id', inc.order_id).single());
      const r = await interpret(await d.getLlm(), { reply: offer.buyer_reply, options: offer.options });
      await d.audit({ incidentId: inc.id, actor: 'AGENT', kind: 'REPLY_INTERPRETED', input: r.meta, output: r.object });
      if (inc.state !== 'OFFERED') continue;
      if (r.object.choice !== null) {
        const { data: chose } = await d.admin.from('offers').update({ buyer_choice: offer.options[r.object.choice], status: 'CHOSEN' }).eq('id', offer.id).eq('status', 'SENT').select('id');
        if (chose?.length) await d.admin.from('incidents').update({ state: 'AWAITING_APPROVAL' }).eq('id', inc.id).eq('state', 'OFFERED');
      } else {
        await d.admin.from('incidents').update({ state: 'NEEDS_MERCHANT' }).eq('id', inc.id).eq('state', 'OFFERED');
        await d.audit({ incidentId: inc.id, actor: 'SYSTEM', kind: 'NEEDS_MERCHANT', output: { reason: r.object.wantsMore ? 'The buyer asked for more than the offer.' : 'The buyer reply was not a clear choice.', sentiment: r.object.sentiment, summary: r.object.summary } });
        const body = `Hi ${order.buyer_name},\n\nThanks for your reply about order ${order.merchant_order_id}. We have passed your message to the seller, who will get back to you personally.`;
        await (d.sendEmail ?? sendBuyerEmail)(order.buyer_email, `Re: your order ${order.merchant_order_id}`, body);
      }
      s.replies++;
    } catch (e) { s.errors.push(`reply ${offer.id}: ${(e as Error).message}`); }
  }
}

// ------------------------------------------------------------------ auto-approve and execute

async function autoApprove(d: TickDeps, s: TickSummary) {
  const { data: offers } = await d.admin.from('offers').select('id, buyer_choice, incidents!inner(id, state, order_id)').eq('status', 'CHOSEN').eq('incidents.state', 'AWAITING_APPROVAL').limit(20);
  for (const o of offers ?? []) {
    const choice = o.buyer_choice as Option;
    const order = await one(d.admin.from('orders').select('merchant_id').eq('id', (o as any).incidents.order_id).single());
    const policy = await one(d.admin.from('policies').select('auto_approve_cents').eq('merchant_id', order.merchant_id).single());
    const limit = policy.auto_approve_cents as number;
    const qualifies = limit > 0 && (choice.type === 'NEW_ETA' || (choice.type === 'PARTIAL_REFUND' && (choice.amount_cents ?? Infinity) <= limit));
    if (!qualifies) continue;
    try {
      await approveOffer(d.admin, d.audit, { offerId: o.id, actor: 'POLICY', now: nowOf(d) });
      await d.audit({ incidentId: (o as any).incidents.id, actor: 'POLICY', kind: 'AUTO_APPROVED', output: { thresholdCents: limit, choice } });
      s.autoApproved++;
    } catch (e) { s.errors.push(`auto-approve ${o.id}: ${(e as Error).message}`); }
  }
}

/** Executes claimed PENDING actions (or just one, when called right after a merchant approval). */
export async function runActions(d: TickDeps, s?: TickSummary, only?: string) {
  const { data: claimed, error } = await d.admin.rpc('claim_actions', { p_limit: 5, p_action: only ?? null });
  if (error) throw new Error(error.message);
  const store = createStore(d.admin);
  for (const a of claimed ?? []) {
    const r = await executeAction({ store, paypal: executorPayPal(d.paypal), audit: d.audit, now: d.now }, a.id);
    if (r.status === 'COMPLETED') {
      if (s) s.executed++;
      await notifyOutcome(d, a.id);
    }
  }
}

const executorPayPal = (pp: PayPal) => ({
  refund: (a: Parameters<PayPal['refund']>[0]) => pp.refund(a),
  addTracking: (a: Parameters<PayPal['addTracking']>[0]) => pp.addTracking(a),
});

async function notifyOutcome(d: TickDeps, actionId: string) {
  const a = await one(d.admin.from('actions').select('type, amount_cents, offer_id').eq('id', actionId).single());
  const offer = await one(d.admin.from('offers').select('incident_id, buyer_choice').eq('id', a.offer_id).single());
  const inc = await one(d.admin.from('incidents').select('order_id').eq('id', offer.incident_id).single());
  const order = await one(d.admin.from('orders').select('buyer_email, buyer_name, merchant_order_id').eq('id', inc.order_id).single());
  const what = a.type === 'REFUND' ? `${usd(a.amount_cents)} has been refunded to your PayPal account` : a.type === 'RESHIP' ? 'a replacement is on its way and the tracking has been updated' : `your new delivery date is ${offer.buyer_choice?.new_eta}`;
  const mail = await (d.sendEmail ?? sendBuyerEmail)(order.buyer_email, `Your order ${order.merchant_order_id} is sorted`, `Hi ${order.buyer_name},\n\nThank you for choosing: ${what}.\n\nWe are sorry for the trouble.`);
  await d.audit({ incidentId: offer.incident_id, actor: 'AGENT', kind: mail.sent ? 'BUYER_CONFIRMED' : 'BUYER_CONFIRMATION_NOT_SENT', output: { error: mail.error } });
}

// ------------------------------------------------------------------ expiry

async function expireOffers(d: TickDeps, s: TickSummary) {
  const { data: stale } = await d.admin.from('offers').select('id, incident_id').eq('status', 'SENT').lt('expires_at', nowOf(d).toISOString()).limit(20);
  for (const o of stale ?? []) {
    await d.admin.from('offers').update({ status: 'EXPIRED' }).eq('id', o.id).eq('status', 'SENT');
    await d.admin.from('incidents').update({ state: 'EXPIRED', closed_at: nowOf(d).toISOString() }).eq('id', o.incident_id).eq('state', 'OFFERED');
    await d.audit({ incidentId: o.incident_id, actor: 'SYSTEM', kind: 'OFFER_EXPIRED' });
    s.expired++;
  }
}

export { OPEN_STATES };
