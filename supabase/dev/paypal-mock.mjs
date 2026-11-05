// Local stand-in for the PayPal sandbox REST API. Idempotent by PayPal-Request-Id, like the real one.
import { createServer } from 'node:http';
const state = { orders: {}, refunds: {}, byRequest: {}, calls: [], openDispute: null };
const id = (p) => `${p}-${Math.random().toString(36).slice(2, 12).toUpperCase()}`;
createServer((req, res) => {
  let body = ''; req.on('data', (c) => (body += c));
  req.on('end', () => {
    const u = new URL(req.url, 'http://x'); const p = u.pathname; const reqId = req.headers['paypal-request-id'];
    const send = (code, o) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    let json = {}; try { json = body ? JSON.parse(body) : {}; } catch { json = { raw: body }; }
    if (!p.startsWith('/_')) state.calls.push({ m: req.method, p, reqId, body: json });
    if (p === '/_log') return send(200, state);
    if (p === '/_dispute') { state.openDispute = json.id ?? null; return send(200, { ok: true }); }
    if (p === '/v1/oauth2/token') return send(200, { access_token: 'mock-token', expires_in: 32000 });
    if (p === '/v2/checkout/orders' && req.method === 'POST') {
      if (reqId && state.byRequest[reqId]) return send(200, state.byRequest[reqId]);
      const oid = id('ORD'); const cap = { id: id('CAP'), status: 'COMPLETED', amount: json.purchase_units[0].amount };
      const o = { id: oid, status: 'COMPLETED', purchase_units: [{ payments: { captures: [cap] } }] };
      state.orders[oid] = o; if (reqId) state.byRequest[reqId] = o; return send(201, o);
    }
    let m;
    if ((m = p.match(/^\/v2\/checkout\/orders\/([^/]+)$/))) return state.orders[m[1]] ? send(200, state.orders[m[1]]) : send(404, { name: 'RESOURCE_NOT_FOUND' });
    if ((m = p.match(/^\/v2\/checkout\/orders\/([^/]+)\/track$/))) return send(200, {});
    if ((m = p.match(/^\/v2\/payments\/captures\/([^/]+)\/refund$/))) {
      if (reqId && state.byRequest[reqId]) return send(200, state.byRequest[reqId]);
      const cents = Math.round(Number(json.amount.value) * 100);
      const prior = state.refunds[m[1]] ?? 0;
      const cap = Object.values(state.orders).flatMap((o) => o.purchase_units[0].payments.captures).find((c) => c.id === m[1]);
      if (!cap) return send(404, { name: 'RESOURCE_NOT_FOUND' });
      if (prior + cents > Math.round(Number(cap.amount.value) * 100)) return send(422, { name: 'UNPROCESSABLE_ENTITY', details: [{ issue: 'REFUND_AMOUNT_EXCEEDED' }] });
      state.refunds[m[1]] = prior + cents;
      const r = { id: id('REF'), status: 'COMPLETED' }; if (reqId) state.byRequest[reqId] = r; return send(201, r);
    }
    if ((m = p.match(/^\/v2\/payments\/refunds\/([^/]+)$/))) return send(200, { id: m[1], status: 'COMPLETED' });
    if (p === '/v1/customer/disputes') return send(200, { items: state.openDispute ? [{ dispute_id: state.openDispute, status: 'OPEN' }] : [] });
    if (p === '/v1/notifications/verify-webhook-signature') return send(200, { verification_status: 'SUCCESS' });
    send(404, { name: 'NOT_FOUND', path: p });
  });
}).listen(4010, '::', () => console.log('paypal mock on 4010'));
