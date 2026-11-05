// Verifies the three PayPal calls Preempt makes against the real sandbox.
//   PAYPAL_CLIENT_ID=... PAYPAL_CLIENT_SECRET=... ORDER_ID=... CAPTURE_ID=... [REFUND_CENTS=100] npm run sandbox-check
import { openDb } from '../src/db.js';
import { config } from '../src/config.js';
import { createPayPal } from '../src/paypal.js';

if (config.paypal.mode !== 'sandbox') { console.error('Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET first.'); process.exit(1); }
const { ORDER_ID, CAPTURE_ID, REFUND_CENTS } = process.env;
if (!ORDER_ID || !CAPTURE_ID) { console.error('Set ORDER_ID and CAPTURE_ID from a completed sandbox payment.'); process.exit(1); }

const pp = createPayPal({ db: openDb(), config: config.paypal });
const step = async (name, fn) => {
  try { console.log(`PASS ${name}`, JSON.stringify(await fn())); } catch (e) { console.log(`FAIL ${name}: ${e.message}`); process.exitCode = 1; }
};

await step('auth + get order (read)', async () => { const o = await pp.read.getOrder(ORDER_ID); return { id: o.id, status: o.status }; });
await step('add tracking (FR2)', () => pp.money.addTracking({ captureId: CAPTURE_ID, trackingNumber: `PREEMPT-CHECK-${Date.now()}`, carrier: 'Preempt check' }));
await step('open-dispute lookup', async () => ({ open: await pp.read.hasOpenDispute(CAPTURE_ID) }));
if (REFUND_CENTS) await step(`refund ${REFUND_CENTS} cents (FR10)`, () => pp.money.refundCapture({ captureId: CAPTURE_ID, amountCents: Number(REFUND_CENTS), requestId: `preempt-check-${CAPTURE_ID}-${REFUND_CENTS}`, note: 'Preempt sandbox check' }));
else console.log('SKIP refund (set REFUND_CENTS=100 to test it)');
