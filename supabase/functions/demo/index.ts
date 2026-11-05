// Demo controls for judges and the presenter: create a real sandbox order with a simulated carrier timeline,
// and "advance the clock" (shift the demo shipments back in time, then run the watcher immediately).
import { PROMISE_DAYS, SCENARIOS, type Scenario } from '../_shared/carrier-sim.ts';
import { envOpt } from '../_shared/env.ts';
import { handler, HttpError, json, subpath } from '../_shared/http.ts';
import { makeTickDeps } from '../_shared/deps.ts';
import { adminClient, userClient } from '../_shared/supabase-admin.ts';
import { runTick } from '../_shared/tick.ts';
import { addDays } from '../_shared/types.ts';

const PRODUCTS = [{ name: 'Ceramic mug set', cents: 2400 }, { name: 'Desk lamp', cents: 4800 }, { name: 'Standing desk mat', cents: 9600 }];

Deno.serve(handler(async (req) => {
  if (envOpt('DEMO_ENABLED') === 'false') throw new HttpError(404, 'NOT_FOUND', 'Demo controls are disabled.');
  const authHeader = req.headers.get('Authorization');
  if (!authHeader) throw new HttpError(401, 'UNAUTHORIZED', 'Sign in first.');
  const me = userClient(authHeader);
  const { data: user } = await me.auth.getUser();
  if (!user.user) throw new HttpError(401, 'UNAUTHORIZED', 'Sign in first.');
  const { data: merchant } = await me.from('merchants').select('id').maybeSingle();
  if (!merchant) throw new HttpError(404, 'NOT_FOUND', 'No merchant is linked to this login.');
  if (req.method !== 'POST') throw new HttpError(405, 'BAD_REQUEST', 'POST only.');

  const admin = adminClient();
  const deps = makeTickDeps(admin);
  const [route] = subpath(req, 'demo');
  const body = await req.json().catch(() => ({}));

  if (route === 'scenario') {
    const scenario = body.scenario as Scenario;
    if (!SCENARIOS.includes(scenario)) throw new HttpError(400, 'BAD_REQUEST', `scenario must be one of ${SCENARIOS.join(', ')}.`);
    const { count } = await admin.from('orders').select('id', { count: 'exact', head: true }).eq('merchant_id', merchant.id);
    const product = PRODUCTS[(count ?? 0) % PRODUCTS.length];
    const pp = deps.paypal;
    const nonce = crypto.randomUUID();

    let orderId: string, captureId: string, amountCents = product.cents;
    try {
      if (body.order_id && body.capture_id) { // use an existing sandbox payment (for example one made in Postman)
        const o = await pp.getOrder(String(body.order_id));
        const cap = o.purchase_units?.[0]?.payments?.captures?.find((c) => c.id === body.capture_id);
        if (!cap) throw new HttpError(400, 'BAD_REQUEST', 'That capture_id is not on that order.');
        orderId = o.id; captureId = cap.id; amountCents = Math.round(Number(cap.amount.value) * 100);
      } else {
        const card = { number: envOpt('DEMO_CARD_NUMBER') ?? '4111111111111111', expiry: envOpt('DEMO_CARD_EXPIRY') ?? '2029-12', securityCode: envOpt('DEMO_CARD_CVV') ?? '123', name: 'Sam Buyer' };
        let o = await pp.createOrder({ amountCents: product.cents, referenceId: `DS-${nonce.slice(0, 6)}`, requestId: `demo-create-${nonce}`, card });
        if (o.status !== 'COMPLETED') o = await pp.captureOrder(o.id, `demo-capture-${nonce}`);
        const cap = o.purchase_units?.[0]?.payments?.captures?.[0];
        if (!cap) throw new Error('PayPal returned no capture.');
        orderId = o.id; captureId = cap.id;
      }
    } catch (e) {
      if (e instanceof HttpError) throw e;
      throw new HttpError(502, 'PAYPAL_ERROR', `Could not create the sandbox payment: ${(e as Error).message}. If card payments are not enabled on your sandbox account, pass an existing { order_id, capture_id } instead.`);
    }

    const now = new Date();
    const merchantOrderId = `DS-${1000 + ((count ?? 0) + 1)}`;
    const { data: order, error } = await admin.from('orders').insert({
      merchant_id: merchant.id, merchant_order_id: merchantOrderId, paypal_order_id: orderId, capture_id: captureId, amount_cents: amountCents,
      buyer_email: envOpt('DEMO_BUYER_EMAIL') ?? 'buyer@example.com', buyer_name: 'Sam Buyer', promised_by: addDays(now, PROMISE_DAYS[scenario]).toISOString(),
    }).select('id').single();
    if (error) throw new HttpError(409, 'BAD_REQUEST', `Could not save the order: ${error.message}`);

    const trackingNumber = `DEMO${nonce.slice(0, 8).toUpperCase()}`;
    let trackerId: string | null = null;
    try { trackerId = (await pp.addTracking({ orderId, captureId, trackingNumber, carrierName: 'Preempt Sim Carrier' })).trackerId; }
    catch (e) { await deps.audit({ actor: 'SYSTEM', kind: 'ADD_TRACKING_FAILED', output: { message: (e as Error).message } }); }
    await admin.from('shipments').insert({ order_id: order.id, carrier: 'Preempt Sim Carrier', tracking_number: trackingNumber, paypal_tracker_id: trackerId, sim_scenario: scenario, sim_started_at: now.toISOString(), last_status: 'SHIPMENT_CREATED', last_scan_at: now.toISOString(), events: [{ id: `${trackingNumber}-0-SHIPMENT_CREATED`, day: 0, status: 'SHIPMENT_CREATED', location: 'Austin, TX', at: now.toISOString() }] });
    await deps.audit({ actor: 'SYSTEM', kind: 'DEMO_ORDER_CREATED', output: { merchantOrderId, orderId, captureId, trackerId, scenario } });
    return json({ order: { merchant_order_id: merchantOrderId, paypal_order_id: orderId, capture_id: captureId }, tracker_id: trackerId, tracking_number: trackingNumber });
  }

  if (route === 'advance') {
    const days = Number(body.days);
    if (!Number.isInteger(days) || days < 1 || days > 30) throw new HttpError(400, 'BAD_REQUEST', 'days must be a whole number from 1 to 30.');
    const { error } = await admin.rpc('shift_demo_time', { p_merchant: merchant.id, p_days: days });
    if (error) throw new Error(error.message);
    const tick = await runTick(deps);
    return json({ ok: true, days, tick });
  }
  throw new HttpError(404, 'NOT_FOUND', 'No such route.');
}));
