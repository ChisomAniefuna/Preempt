import { q } from './db.js';
import { refundedSoFar, validateOffers, loadPolicy } from './policy.js';
import { addDays, ymd } from './clock.js';

/**
 * The only module that holds PayPal money access. It runs a remedy only when:
 *  - the incident is awaiting approval and the one-time approval token matches,
 *  - the offer passes the validator again (defence in depth),
 *  - the atomic claim succeeds, so a replayed approval can never pay twice.
 */
export function createExecutor({ db, money, audit, clock }) {
  return {
    async execute(incidentId, offer, { token, approver }) {
      const inc = q.get(db, 'SELECT * FROM incidents WHERE id = ?', incidentId);
      if (!inc) return { ok: false, code: 'not_found' };
      if (inc.state === 'executed') return { ok: true, replayed: true, result: JSON.parse(inc.resolution_json) };
      if (inc.state !== 'awaiting_merchant' && inc.state !== 'escalated') return { ok: false, code: 'bad_state', state: inc.state };
      if (!token || token !== inc.approval_token || inc.approval_used) {
        audit.log('execution_refused', { incidentId, actor: approver, data: { reason: 'invalid_or_used_approval_token' } });
        return { ok: false, code: 'bad_token' };
      }

      const order = q.get(db, 'SELECT * FROM orders WHERE id = ?', inc.order_id);
      const policy = loadPolicy(db);
      const refunded = refundedSoFar(db, order.capture_id);
      const verdict = validateOffers([offer], { policy, order, refunded, now: clock.now() });
      if (!verdict.ok) {
        audit.log('execution_blocked', { incidentId, actor: approver, data: { offer, violations: verdict.violations } });
        return { ok: false, code: 'policy_violation', violations: verdict.violations };
      }

      const claim = q.run(db, "UPDATE incidents SET state = 'executing', approval_used = 1 WHERE id = ? AND state IN ('awaiting_merchant','escalated') AND approval_used = 0", incidentId);
      if (claim.changes !== 1) return { ok: false, code: 'already_claimed' };

      try {
        const result = await run(offer, order, inc);
        const now = clock.iso();
        q.run(db, "UPDATE incidents SET state = 'executed', resolution_json = ?, decided_at = ?, updated_at = ? WHERE id = ?", JSON.stringify({ offer, ...result }), now, now, incidentId);
        audit.log('remedy_executed', { incidentId, actor: approver, data: { offer, result } });
        return { ok: true, result: { offer, ...result } };
      } catch (err) {
        q.run(db, "UPDATE incidents SET state = 'awaiting_merchant', approval_used = 0, updated_at = ? WHERE id = ?", clock.iso(), incidentId);
        audit.log('execution_failed', { incidentId, actor: approver, data: { error: String(err.message || err) } });
        return { ok: false, code: 'paypal_error', error: String(err.message || err) };
      }
    },
  };

  async function run(offer, order, inc) {
    if (offer.type === 'partial_refund' || offer.type === 'full_refund') {
      const r = await money.refundCapture({ captureId: order.capture_id, amountCents: offer.amountCents, currency: order.currency, requestId: `preempt-refund-${inc.id}`, note: `Preempt: delivery issue on order ${order.merchant_order_id}` });
      q.run(db, 'INSERT INTO refunds (incident_id, capture_id, amount_cents, paypal_refund_id, created_at) VALUES (?, ?, ?, ?, ?)', inc.id, order.capture_id, offer.amountCents, r.id, clock.iso());
      return { paypalRefundId: r.id, amountCents: offer.amountCents };
    }
    if (offer.type === 'reship') {
      const tracking = offer.trackingNumber || `RESHIP-${order.merchant_order_id}-${inc.id}`;
      const t = await money.addTracking({ captureId: order.capture_id, trackingNumber: tracking, carrier: 'Preempt reship' });
      q.run(db, 'UPDATE shipments SET superseded = 1 WHERE order_id = ?', order.id);
      q.run(db, 'INSERT INTO shipments (order_id, tracking_number, carrier, label_created_at, paypal_tracking_id) VALUES (?, ?, ?, ?, ?)', order.id, tracking, 'Preempt reship', clock.iso(), t.tracking_id);
      q.run(db, 'UPDATE orders SET promised_date = ? WHERE id = ?', ymd(addDays(clock.now(), 7)), order.id);
      return { newTrackingNumber: tracking, paypalTrackingId: t.tracking_id };
    }
    if (offer.type === 'new_eta') {
      q.run(db, 'UPDATE orders SET promised_date = ? WHERE id = ?', offer.eta, order.id);
      return { newPromisedDate: offer.eta };
    }
    throw new Error(`Unsupported remedy ${offer.type}`);
  }
}
