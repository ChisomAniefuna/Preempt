// The executor: the ONLY code path that moves money or writes tracking. It runs an action only when the
// action exists (created by an approval), the incident is EXECUTING, no dispute is open, and the chosen
// option passes the validator again against the order's current refunded total.
import { type AuditFn } from './audit.ts';
import { addDays, type Option, type OrderFacts, type Policy, usd, ymd } from './types.ts';
import { validateChoice } from './validator.ts';

export interface ActionContext {
  action: { id: string; offer_id: string; type: 'REFUND' | 'RESHIP' | 'NEW_ETA'; amount_cents: number | null; idempotency_key: string };
  choice: Option | null; // offers.buyer_choice (the source of truth for what was approved)
  incident: { id: string; state: string; dispute_id: string | null };
  order: OrderFacts & { id: string; merchant_order_id: string; paypal_order_id: string; capture_id: string; currency: string; buyer_name: string; buyer_email: string };
  policy: Policy;
}

export interface ExecutorStore {
  loadContext(actionId: string): Promise<ActionContext | null>;
  completeRefund(actionId: string, paypalRefundId: string): Promise<boolean>; // one transaction; false if already completed
  completeNewEta(actionId: string, orderId: string, promisedBy: string): Promise<void>;
  completeReship(actionId: string, a: { orderId: string; trackingNumber: string; carrier: string; trackerId: string; promisedBy: string }): Promise<void>;
  failAction(actionId: string, incidentId: string, error: { code: string; message: string }): Promise<void>;
}

export interface ExecutorPayPal {
  refund(a: { captureId: string; amountCents: number; currency: string; requestId: string; note: string }): Promise<{ id: string; status: string }>;
  addTracking(a: { orderId: string; captureId: string; trackingNumber: string; carrierName: string }): Promise<{ trackerId: string }>;
}

export type ExecResult = { status: 'COMPLETED' | 'FAILED' | 'SKIPPED'; reason?: string; ref?: string };

export async function executeAction(deps: { store: ExecutorStore; paypal: ExecutorPayPal; audit: AuditFn; now?: () => Date }, actionId: string): Promise<ExecResult> {
  const { store, paypal, audit } = deps;
  const now = (deps.now ?? (() => new Date()))();
  const ctx = await store.loadContext(actionId);
  if (!ctx) return { status: 'SKIPPED', reason: 'action not found or already completed' };
  const { action, incident, order, choice, policy } = ctx;
  const fail = async (code: string, message: string): Promise<ExecResult> => {
    await store.failAction(action.id, incident.id, { code, message });
    await audit({ incidentId: incident.id, actor: 'EXECUTOR', kind: 'ACTION_FAILED', input: { actionId, type: action.type }, output: { code, message } });
    return { status: 'FAILED', reason: message };
  };

  if (incident.state !== 'EXECUTING') return fail('NOT_EXECUTING', `Incident is ${incident.state}, not EXECUTING.`);
  if (incident.dispute_id) return fail('DISPUTE_OPEN', 'A dispute is open on this order; no further remedy will be executed.');
  if (!choice) return fail('NO_APPROVED_OPTION', 'There is no approved option for this action.');

  const expectedType = choice.type === 'PARTIAL_REFUND' || choice.type === 'FULL_REFUND' ? 'REFUND' : choice.type;
  if (expectedType !== action.type || (action.type === 'REFUND' && action.amount_cents !== choice.amount_cents)) {
    return fail('ACTION_MISMATCH', 'The action does not match what the buyer chose and the merchant approved.');
  }
  const verdict = validateChoice(choice, { policy, order, now });
  if (!verdict.ok) {
    await audit({ incidentId: incident.id, actor: 'EXECUTOR', kind: 'EXECUTION_BLOCKED', input: { choice }, output: { violations: verdict.violations } });
    return fail('POLICY_VIOLATION', verdict.violations.map((v) => v.message).join(' '));
  }

  try {
    if (action.type === 'REFUND') {
      const r = await paypal.refund({ captureId: order.capture_id, amountCents: action.amount_cents!, currency: order.currency, requestId: action.idempotency_key, note: `Delivery issue on order ${order.merchant_order_id}` });
      if (r.status === 'FAILED' || r.status === 'CANCELLED') return fail('PAYPAL_ERROR', `PayPal reported the refund as ${r.status}.`);
      const first = await store.completeRefund(action.id, r.id);
      await audit({ incidentId: incident.id, actor: 'EXECUTOR', kind: 'REFUND_COMPLETED', input: { captureId: order.capture_id, amount: usd(action.amount_cents!), requestId: action.idempotency_key }, output: { refundId: r.id, status: r.status, firstCompletion: first } });
      return { status: 'COMPLETED', ref: r.id };
    }
    if (action.type === 'RESHIP') {
      const trackingNumber = `RS-${action.id.replace(/-/g, '').slice(0, 10).toUpperCase()}`; // deterministic, so retries are safe
      const t = await paypal.addTracking({ orderId: order.paypal_order_id, captureId: order.capture_id, trackingNumber, carrierName: 'Preempt reship' });
      await store.completeReship(action.id, { orderId: order.id, trackingNumber, carrier: 'Preempt reship', trackerId: t.trackerId, promisedBy: addDays(now, 7).toISOString() });
      await audit({ incidentId: incident.id, actor: 'EXECUTOR', kind: 'RESHIP_COMPLETED', output: { trackingNumber, trackerId: t.trackerId } });
      return { status: 'COMPLETED', ref: t.trackerId };
    }
    const promisedBy = `${choice.new_eta}T23:59:59.000Z`;
    await store.completeNewEta(action.id, order.id, promisedBy);
    await audit({ incidentId: incident.id, actor: 'EXECUTOR', kind: 'NEW_ETA_COMPLETED', output: { newEta: choice.new_eta ?? ymd(now) } });
    return { status: 'COMPLETED' };
  } catch (e) {
    return fail('PAYPAL_ERROR', (e as Error).message);
  }
}
