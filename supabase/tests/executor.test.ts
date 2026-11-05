import { assert, assertEquals } from 'jsr:@std/assert@1';
import { type ActionContext, type ExecutorPayPal, type ExecutorStore, executeAction } from '../functions/_shared/executor.ts';
import { createPayPal, PayPalError, withRetry } from '../functions/_shared/paypal/client.ts';
import type { Policy } from '../functions/_shared/types.ts';

const policy: Policy = { merchant_id: 'm', allowed_remedies: ['NEW_ETA', 'RESHIP', 'PARTIAL_REFUND'], max_refund_percent: 20, max_refund_cents: 1500, auto_approve_cents: 500, no_scan_days: 3, tone: 'warm' };
const baseCtx = (over: Partial<ActionContext> = {}): ActionContext => ({
  action: { id: 'a1', offer_id: 'o1', type: 'REFUND', amount_cents: 900, idempotency_key: 'preempt-o1' },
  choice: { type: 'PARTIAL_REFUND', amount_cents: 900 },
  incident: { id: 'i1', state: 'EXECUTING', dispute_id: null },
  order: { id: 'ord1', merchant_order_id: 'DS-1', paypal_order_id: 'PO1', capture_id: 'CAP1', currency: 'USD', buyer_name: 'Sam', buyer_email: 's@x.y', amount_cents: 4800, refunded_cents: 0, promised_by: '2026-11-09T00:00:00Z' },
  policy, ...over,
});

/** In-memory store that mimics the database's idempotent refund completion. */
function fakeStore(ctx: ActionContext) {
  const log: string[] = [];
  let completed = false;
  let refunded = ctx.order.refunded_cents;
  const store: ExecutorStore = {
    loadContext: () => Promise.resolve(completed ? null : { ...ctx, order: { ...ctx.order, refunded_cents: refunded } }),
    completeRefund: (_id, ref) => { if (completed) return Promise.resolve(false); completed = true; refunded += ctx.action.amount_cents!; log.push(`refund:${ref}`); return Promise.resolve(true); },
    completeNewEta: () => { completed = true; log.push('eta'); return Promise.resolve(); },
    completeReship: (_id, a) => { completed = true; log.push(`reship:${a.trackingNumber}`); return Promise.resolve(); },
    failAction: (_id, _inc, e) => { log.push(`fail:${e.code}`); return Promise.resolve(); },
  };
  return { store, log, refundedTotal: () => refunded };
}
const audit = () => Promise.resolve();
const okPayPal = (calls: string[] = []): ExecutorPayPal => ({
  refund: (a) => { calls.push(`refund:${a.requestId}:${a.amountCents}`); return Promise.resolve({ id: 'REF-1', status: 'COMPLETED' }); },
  addTracking: (a) => { calls.push(`track:${a.trackingNumber}`); return Promise.resolve({ trackerId: `${a.captureId}-${a.trackingNumber}` }); },
});
const now = () => new Date('2026-11-10T12:00:00Z');

Deno.test('approved refund calls PayPal once with the idempotency key and completes', async () => {
  const f = fakeStore(baseCtx()); const calls: string[] = [];
  const r = await executeAction({ store: f.store, paypal: okPayPal(calls), audit, now }, 'a1');
  assertEquals(r, { status: 'COMPLETED', ref: 'REF-1' });
  assertEquals(calls, ['refund:preempt-o1:900']);
  assertEquals(f.refundedTotal(), 900);
});

Deno.test('replaying the same action refunds nothing more', async () => {
  const f = fakeStore(baseCtx()); const calls: string[] = [];
  await executeAction({ store: f.store, paypal: okPayPal(calls), audit, now }, 'a1');
  const again = await executeAction({ store: f.store, paypal: okPayPal(calls), audit, now }, 'a1');
  assertEquals(again.status, 'SKIPPED');
  assertEquals(calls.length, 1);
  assertEquals(f.refundedTotal(), 900);
});

Deno.test('a refund over the cap is blocked at execution time even if it was approved', async () => {
  const f = fakeStore(baseCtx({ choice: { type: 'PARTIAL_REFUND', amount_cents: 3000 }, action: { id: 'a1', offer_id: 'o1', type: 'REFUND', amount_cents: 3000, idempotency_key: 'k' } }));
  const calls: string[] = [];
  const r = await executeAction({ store: f.store, paypal: okPayPal(calls), audit, now }, 'a1');
  assertEquals(r.status, 'FAILED');
  assertEquals(calls, []);
  assert(f.log.includes('fail:POLICY_VIOLATION'));
});

Deno.test('refunds can never exceed what is left on the capture', async () => {
  const ctx = baseCtx(); ctx.order.refunded_cents = 4500; // only $3 left; 20% cap would allow $9.60
  const f = fakeStore(ctx); const calls: string[] = [];
  const r = await executeAction({ store: f.store, paypal: okPayPal(calls), audit, now }, 'a1');
  assertEquals(r.status, 'FAILED'); assertEquals(calls, []);
});

Deno.test('an open dispute stops execution', async () => {
  const f = fakeStore(baseCtx({ incident: { id: 'i1', state: 'EXECUTING', dispute_id: 'D1' } })); const calls: string[] = [];
  assertEquals((await executeAction({ store: f.store, paypal: okPayPal(calls), audit, now }, 'a1')).status, 'FAILED');
  assertEquals(calls, []); assert(f.log.includes('fail:DISPUTE_OPEN'));
});

Deno.test('an incident that is not EXECUTING is never run', async () => {
  const f = fakeStore(baseCtx({ incident: { id: 'i1', state: 'AWAITING_APPROVAL', dispute_id: null } })); const calls: string[] = [];
  assertEquals((await executeAction({ store: f.store, paypal: okPayPal(calls), audit, now }, 'a1')).status, 'FAILED');
  assertEquals(calls, []);
});

Deno.test('an action that does not match the approved choice is refused', async () => {
  const f = fakeStore(baseCtx({ action: { id: 'a1', offer_id: 'o1', type: 'REFUND', amount_cents: 1200, idempotency_key: 'k' } })); const calls: string[] = [];
  const r = await executeAction({ store: f.store, paypal: okPayPal(calls), audit, now }, 'a1');
  assertEquals(r.status, 'FAILED'); assertEquals(calls, []); assert(f.log.includes('fail:ACTION_MISMATCH'));
});

Deno.test('a PayPal 4xx fails the action without completing it', async () => {
  const f = fakeStore(baseCtx());
  const paypal: ExecutorPayPal = { ...okPayPal(), refund: () => Promise.reject(new PayPalError(422, 'CAPTURE_FULLY_REFUNDED')) };
  const r = await executeAction({ store: f.store, paypal, audit, now }, 'a1');
  assertEquals(r.status, 'FAILED'); assertEquals(f.refundedTotal(), 0); assert(f.log.includes('fail:PAYPAL_ERROR'));
});

Deno.test('reship uses a deterministic tracking number so retries are safe', async () => {
  const ctx = baseCtx({ choice: { type: 'RESHIP' }, action: { id: 'abcdef12-3456-7890-abcd-ef1234567890', offer_id: 'o1', type: 'RESHIP', amount_cents: null, idempotency_key: 'k' } });
  const f1 = fakeStore(ctx), f2 = fakeStore(ctx); const c1: string[] = [], c2: string[] = [];
  await executeAction({ store: f1.store, paypal: okPayPal(c1), audit, now }, 'x');
  await executeAction({ store: f2.store, paypal: okPayPal(c2), audit, now }, 'x');
  assertEquals(c1, c2); assert(c1[0].startsWith('track:RS-ABCDEF1234'));
});

Deno.test('new ETA completes without calling PayPal', async () => {
  const ctx = baseCtx({ choice: { type: 'NEW_ETA', new_eta: '2026-11-15' }, action: { id: 'a1', offer_id: 'o1', type: 'NEW_ETA', amount_cents: null, idempotency_key: 'k' } });
  const f = fakeStore(ctx); const calls: string[] = [];
  assertEquals((await executeAction({ store: f.store, paypal: okPayPal(calls), audit, now }, 'a1')).status, 'COMPLETED');
  assertEquals(calls, []); assertEquals(f.log, ['eta']);
});

// ---------------------------------------------------------------- PayPal client

Deno.test('withRetry retries 5xx with the backoff schedule and stops on 4xx', async () => {
  const waits: number[] = []; let n = 0;
  const v = await withRetry(() => { if (++n < 3) throw new PayPalError(503, 'down'); return Promise.resolve('ok'); }, (ms) => { waits.push(ms); return Promise.resolve(); });
  assertEquals([v, n, waits], ['ok', 3, [2000, 8000]]);
  let m = 0;
  try { await withRetry(() => { m++; throw new PayPalError(400, 'bad'); }, () => Promise.resolve()); } catch { /* expected */ }
  assertEquals(m, 1);
  waits.length = 0; let k = 0;
  try { await withRetry(() => { k++; throw new PayPalError(500, 'x'); }, (ms) => { waits.push(ms); return Promise.resolve(); }); } catch { /* expected */ }
  assertEquals([k, waits], [4, [2000, 8000, 30000]]);
});

Deno.test('refund sends the same PayPal-Request-Id on every retry and caches the OAuth token', async () => {
  const seen: { path: string; reqId: string | null }[] = []; let tokenCalls = 0; let refundCalls = 0;
  const fetchImpl = ((url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    if (path === '/v1/oauth2/token') { tokenCalls++; return Promise.resolve(new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }))); }
    refundCalls++;
    seen.push({ path, reqId: (init.headers as Record<string, string>)['PayPal-Request-Id'] });
    return Promise.resolve(refundCalls === 1 ? new Response('{}', { status: 503 }) : new Response(JSON.stringify({ id: 'R1', status: 'COMPLETED' })));
  }) as unknown as typeof fetch;
  const pp = createPayPal({ clientId: 'c', clientSecret: 's', base: 'https://api-m.sandbox.paypal.com' }, { fetchImpl, sleep: () => Promise.resolve() });
  const r = await pp.refund({ captureId: 'CAP', amountCents: 450, currency: 'USD', requestId: 'preempt-o1', note: 'n' });
  assertEquals(r.id, 'R1');
  assertEquals(seen.map((s) => s.reqId), ['preempt-o1', 'preempt-o1']);
  assertEquals(seen[0].path, '/v2/payments/captures/CAP/refund');
  assertEquals(tokenCalls, 1);
});
