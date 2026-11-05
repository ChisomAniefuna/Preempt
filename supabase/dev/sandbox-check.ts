// Checks the PayPal calls Preempt makes against the real sandbox, using the same client the Edge Functions use.
//   deno run --env-file=supabase/.env --allow-env --allow-net supabase/dev/sandbox-check.ts
// Creates one $2.00 test payment, adds tracking, refunds $1.00, and replays the refund to prove idempotency.
// Prints IDs, never secrets. Sandbox only: it refuses to run against a non-sandbox base URL.
import { createPayPal, PayPalError } from '../functions/_shared/paypal/client.ts';

const need = (n: string) => { const v = Deno.env.get(n); if (!v) { console.error(`Missing ${n} in supabase/.env`); Deno.exit(2); } return v; };
const base = Deno.env.get('PAYPAL_API_BASE') ?? 'https://api-m.sandbox.paypal.com';
if (!/sandbox\.paypal\.com|localhost|127\.0\.0\.1/.test(base)) { console.error(`Refusing to run against ${base}: this check is sandbox only.`); Deno.exit(2); }
const pp = createPayPal({ clientId: need('PAYPAL_CLIENT_ID'), clientSecret: need('PAYPAL_CLIENT_SECRET'), base });

let failed = 0;
const run = async <T>(name: string, fn: () => Promise<T>, hint?: string): Promise<T | undefined> => {
  try { const r = await fn(); console.log(`PASS  ${name}`); return r; }
  catch (e) {
    failed++;
    console.log(`FAIL  ${name}\n      ${(e as Error).message.slice(0, 400)}`);
    if (hint) console.log(`      hint: ${hint}`);
    return undefined;
  }
};
const nonce = crypto.randomUUID();

const order = await run('create + capture a $2.00 test payment (card)', async () => {
  const card = { number: Deno.env.get('DEMO_CARD_NUMBER') ?? '4111111111111111', expiry: Deno.env.get('DEMO_CARD_EXPIRY') ?? '2029-12', securityCode: Deno.env.get('DEMO_CARD_CVV') ?? '123', name: 'Sam Buyer' };
  let o = await pp.createOrder({ amountCents: 200, referenceId: `CHECK-${nonce.slice(0, 6)}`, requestId: `check-create-${nonce}`, card });
  if (o.status !== 'COMPLETED') o = await pp.captureOrder(o.id, `check-capture-${nonce}`);
  const cap = o.purchase_units?.[0]?.payments?.captures?.[0];
  if (!cap) throw new Error(`no capture in response (order status ${o.status})`);
  console.log(`      order ${o.id}  capture ${cap.id}  status ${cap.status}`);
  return { orderId: o.id, captureId: cap.id };
}, 'If this fails with a card error, generate a sandbox card (developer.paypal.com > Testing tools > Credit card generator) and set DEMO_CARD_NUMBER/EXPIRY/CVV, or make a payment another way and pass its order and capture IDs to the demo.');

if (order) {
  const tn = `CHECK${nonce.slice(0, 8).toUpperCase()}`;
  const t1 = await run('add tracking (FR2)', () => pp.addTracking({ orderId: order.orderId, captureId: order.captureId, trackingNumber: tn, carrierName: 'Preempt check' }));
  if (t1) await run('add the same tracking again returns success (idempotent)', () => pp.addTracking({ orderId: order.orderId, captureId: order.captureId, trackingNumber: tn, carrierName: 'Preempt check' }));
  await run('read the order back (read-only tool)', async () => { const o = await pp.getOrder(order.orderId); console.log(`      status ${o.status}`); return o; });

  const reqId = `preempt-check-${order.captureId}`;
  const r1 = await run('refund $1.00 with a PayPal-Request-Id (FR10)', async () => { const r = await pp.refund({ captureId: order.captureId, amountCents: 100, currency: 'USD', requestId: reqId, note: 'Preempt sandbox check' }); console.log(`      refund ${r.id}  status ${r.status}`); return r; });
  if (r1) {
    await run('replaying the same request id returns the SAME refund (no double refund)', async () => {
      const r2 = await pp.refund({ captureId: order.captureId, amountCents: 100, currency: 'USD', requestId: reqId, note: 'Preempt sandbox check' });
      if (r2.id !== r1.id) throw new Error(`expected ${r1.id}, got ${r2.id}: PayPal created a second refund`);
      console.log(`      same refund ${r2.id}`);
    });
    await run('read the refund back', async () => { const r = await pp.getRefund(r1.id); console.log(`      status ${r.status}`); return r; });
  }
  await run('list disputes on the capture (read-only tool)', async () => { const d = await pp.listDisputes(order.captureId); console.log(`      open disputes: ${(d.items ?? []).length}`); return d; },
    'A 403 here means the app needs the "Disputes" feature enabled (developer dashboard > your app > Features).');
}
console.log(failed ? `\n${failed} check(s) failed` : '\nAll PayPal checks passed');
Deno.exit(failed ? 1 : 0);
