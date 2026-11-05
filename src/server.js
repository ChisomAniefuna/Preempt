import { createServer } from 'node:http';
import { createApp } from './app.js';
import { loadPolicy, savePolicy } from './policy.js';
import { q } from './db.js';
import { addDays, ymd } from './clock.js';
import * as ui from './ui.js';

const app = createApp();
const { engine, db, clock, audit, config, paypal, carrier } = app;

const readBody = (req) => new Promise((resolve) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => resolve(b)); });
const form = async (req) => {
  const params = new URLSearchParams(await readBody(req));
  const out = {};
  for (const k of new Set(params.keys())) out[k] = params.getAll(k).length > 1 ? params.getAll(k) : params.get(k);
  return out;
};
const send = (res, status, body, type = 'text/html; charset=utf-8') => { res.writeHead(status, { 'content-type': type }); res.end(body); };
const redirect = (res, to) => { res.writeHead(303, { location: to }); res.end(); };

let seedN = 1000;
async function seedScenario(scenario, amountCents) {
  const n = ++seedN;
  const now = clock.now();
  const order = engine.ingestOrder({ merchantOrderId: `PRE-${n}`, paypalOrderId: `ORD-${n}`, captureId: `CAP-${n}`, buyerEmail: `buyer${n}@example.com`, buyerName: 'Sam Buyer', amountCents, promisedDate: ymd(addDays(now, 5)) });
  const tracking = `SIM${n}TRK`;
  await engine.shipOrder(order.id, { trackingNumber: tracking });
  const at = (d) => addDays(now, d).toISOString();
  const lines = {
    delayed: [{ status: 'IN_TRANSIT', text: 'Departed facility', occursAt: at(1) }, { status: 'DELAYED', text: 'Delayed: weather', occursAt: at(3) }],
    failed: [{ status: 'IN_TRANSIT', text: 'Out for delivery', occursAt: at(2) }, { status: 'FAILED_ATTEMPT', text: 'Delivery attempt failed: recipient unavailable', occursAt: at(3) }],
    stalled: [],
    returned: [{ status: 'IN_TRANSIT', text: 'In transit', occursAt: at(1) }, { status: 'RETURNED', text: 'Returned to sender', occursAt: at(4) }],
  };
  carrier.loadTimeline(tracking, lines[scenario] || []);
  return order;
}

const route = async (req, res) => {
  const url = new URL(req.url, config.baseUrl);
  const p = url.pathname;
  const m = req.method;
  let match;

  if (m === 'GET' && p === '/') return redirect(res, '/merchant');

  if (m === 'GET' && p === '/merchant') {
    const rows = q.all(db, "SELECT * FROM incidents WHERE state IN ('awaiting_merchant','escalated') ORDER BY id").map((inc) => ({ inc, order: engine.getOrder(inc.order_id), chosen: inc.chosen_json ? JSON.parse(inc.chosen_json) : null }));
    const all = q.all(db, 'SELECT i.*, o.merchant_order_id FROM incidents i JOIN orders o ON o.id = i.order_id ORDER BY i.id DESC');
    return send(res, 200, ui.inboxPage(rows, all));
  }
  if (m === 'GET' && (match = p.match(/^\/merchant\/incidents\/(\d+)$/))) {
    const inc = engine.getIncident(+match[1]);
    if (!inc) return send(res, 404, 'Not found');
    return send(res, 200, ui.incidentPage(inc, engine.getOrder(inc.order_id), audit.forIncident(inc.id), q.all(db, 'SELECT * FROM messages WHERE incident_id = ? ORDER BY id', inc.id), url.searchParams.get('flash')));
  }
  if (m === 'POST' && (match = p.match(/^\/merchant\/incidents\/(\d+)\/decision$/))) {
    const f = await form(req);
    const edit = f.action === 'edit' ? (f.amount ? { amountCents: Math.round(Number(f.amount) * 100) } : f.eta ? { eta: f.eta } : null) : null;
    const r = await engine.merchantDecide(+match[1], { action: f.action === 'edit' ? 'approve' : f.action, approvalToken: f.token, edit });
    const flash = r.ok ? (r.rejected ? 'Rejected. Nothing was sent.' : 'Approved and executed.') : `Not executed: ${r.code}${r.violations ? ' — ' + r.violations.map((v) => v.message).join('; ') : ''}`;
    return redirect(res, `/merchant/incidents/${match[1]}?flash=${encodeURIComponent(flash)}`);
  }

  if (m === 'GET' && p === '/dashboard') return send(res, 200, ui.dashboardPage(engine.dashboard()));
  if (m === 'GET' && p === '/api/dashboard') return send(res, 200, JSON.stringify(engine.dashboard()), 'application/json');

  if (p === '/policy') {
    if (m === 'POST') {
      const f = await form(req);
      savePolicy(db, { allowedRemedies: [].concat(f.allowedRemedies || []), refundCapPercent: f.refundCapPercent, refundCapCents: Math.round(Number(f.refundCapUsd) * 100), autoApproveCents: Math.round(Number(f.autoApproveUsd) * 100), maxEtaDays: f.maxEtaDays, tone: f.tone });
      return redirect(res, '/policy?saved=1');
    }
    return send(res, 200, ui.policyPage(loadPolicy(db), url.searchParams.has('saved')));
  }

  if ((match = p.match(/^\/b\/([a-f0-9]+)$/))) {
    const inc = q.get(db, 'SELECT * FROM incidents WHERE buyer_token = ?', match[1]);
    if (!inc) return send(res, 404, 'Not found');
    if (m === 'POST') {
      const f = await form(req);
      await engine.buyerRespond(match[1], { index: f.index !== undefined ? Number(f.index) : undefined, text: f.text });
      return redirect(res, p);
    }
    const msgs = q.all(db, 'SELECT * FROM messages WHERE incident_id = ? ORDER BY id', inc.id);
    return send(res, 200, ui.buyerPage(engine.getIncident(inc.id), engine.getOrder(inc.order_id), msgs, JSON.parse(inc.offers_json || '[]')));
  }

  if (m === 'POST' && p === '/webhooks/paypal') {
    const raw = await readBody(req);
    const event = JSON.parse(raw || '{}');
    if (!(await paypal.verifyWebhook(req.headers, event))) return send(res, 401, 'bad signature');
    if (event.event_type === 'PAYMENT.CAPTURE.COMPLETED') {
      const r = event.resource || {};
      const order = engine.ingestOrder({ merchantOrderId: r.invoice_id || r.id, paypalOrderId: r.supplementary_data?.related_ids?.order_id, captureId: r.id, buyerEmail: r.payer?.email_address || 'unknown@example.com', buyerName: r.payer?.name?.given_name || 'there', amountCents: Math.round(Number(r.amount?.value) * 100), currency: r.amount?.currency_code, promisedDate: ymd(addDays(clock.now(), 7)) });
      return send(res, 200, JSON.stringify({ orderId: order.id }), 'application/json');
    }
    if (event.event_type?.startsWith('CUSTOMER.DISPUTE.')) return send(res, 200, JSON.stringify(engine.onDispute(event)), 'application/json');
    return send(res, 200, '{}', 'application/json');
  }

  if (m === 'POST' && p === '/api/poll') return send(res, 200, JSON.stringify({ flagged: (await engine.poll()).map((i) => i?.id) }), 'application/json');

  if (p === '/dev' || p.startsWith('/dev/')) {
    if (m === 'GET' && p === '/dev') {
      const rows = q.all(db, 'SELECT o.*, s.tracking_number, s.status FROM orders o LEFT JOIN shipments s ON s.order_id = o.id AND s.superseded = 0 ORDER BY o.id DESC');
      return send(res, 200, ui.devPage(rows, url.searchParams.get('flash')));
    }
    if (m === 'POST' && p === '/dev/seed') {
      const f = await form(req);
      const o = await seedScenario(f.scenario, Math.round(Number(f.amount) * 100));
      return redirect(res, `/dev?flash=${encodeURIComponent(`Seeded ${o.merchant_order_id}`)}`);
    }
    if (m === 'POST' && p === '/dev/advance') {
      const f = await form(req);
      clock.advanceDays(Number(f.days) || 0);
      const flagged = await engine.poll();
      return redirect(res, `/dev?flash=${encodeURIComponent(`Clock +${f.days}d. Flagged ${flagged.length} order(s). Inbox: /merchant`)}`);
    }
  }
  send(res, 404, 'Not found');
};

createServer((req, res) => route(req, res).catch((err) => { console.error(err); send(res, 500, 'Server error'); })).listen(config.port, () => {
  console.log(`Preempt on ${config.baseUrl}  (PayPal: ${paypal.mode}, agent: ${config.anthropicKey ? 'Claude' : 'fallback'})`);
});
setInterval(() => engine.poll().catch((e) => console.error('poll failed', e)), config.pollMs).unref();
