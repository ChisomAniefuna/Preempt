import { createHash } from 'node:crypto';
import { q } from './db.js';

/**
 * PayPal access is split in two objects on purpose:
 *   read  - order, tracking and dispute lookups. This is all the agent ever receives.
 *   money - refunds and tracking writes. Only the executor receives this.
 * Mock mode returns deterministic fake IDs and replays idempotently by request id.
 * Sandbox mode calls the real PayPal sandbox REST API.
 */
export function createPayPal({ db, config }) {
  const mock = config.mode === 'mock';
  let token = null;

  async function api(method, path, body, headers = {}) {
    if (!token || token.exp < Date.now()) {
      const res = await fetch(`${config.base}/v1/oauth2/token`, {
        method: 'POST',
        headers: { Authorization: `Basic ${Buffer.from(`${config.clientId}:${config.secret}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'grant_type=client_credentials',
      });
      if (!res.ok) throw new Error(`PayPal auth failed: ${res.status}`);
      const j = await res.json();
      token = { value: j.access_token, exp: Date.now() + (j.expires_in - 60) * 1000 };
    }
    const res = await fetch(`${config.base}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token.value}`, 'Content-Type': 'application/json', ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    const json = text ? JSON.parse(text) : {};
    if (!res.ok) throw new Error(`PayPal ${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
    return json;
  }

  // Replays the stored response when the same request id is used twice (mirrors PayPal-Request-Id).
  const replayable = (requestId, produce) => {
    const hit = q.get(db, 'SELECT response_json FROM paypal_requests WHERE request_id = ?', requestId);
    if (hit) return { ...JSON.parse(hit.response_json), replayed: true };
    return Promise.resolve(produce()).then((r) => {
      q.run(db, 'INSERT OR IGNORE INTO paypal_requests (request_id, response_json) VALUES (?, ?)', requestId, JSON.stringify(r));
      return r;
    });
  };
  const fakeId = (prefix, seed) => `${prefix}-${createHash('sha1').update(seed).digest('hex').slice(0, 12).toUpperCase()}`;

  const read = {
    mode: config.mode,
    async getOrder(orderId) {
      if (mock) return { id: orderId, status: 'COMPLETED' };
      return api('GET', `/v2/checkout/orders/${orderId}`);
    },
    async getShipmentTracking(captureId) {
      if (mock) return { transaction_id: captureId, trackers: q.all(db, 'SELECT s.tracking_number FROM shipments s JOIN orders o ON o.id = s.order_id WHERE o.capture_id = ?', captureId) };
      return api('GET', `/v1/shipping/trackers?transaction_id=${encodeURIComponent(captureId)}`);
    },
    async hasOpenDispute(captureId) {
      if (mock) return q.get(db, "SELECT 1 AS x FROM disputes WHERE capture_id = ? AND status != 'RESOLVED'", captureId) != null;
      const j = await api('GET', `/v1/customer/disputes?disputed_transaction_id=${encodeURIComponent(captureId)}`);
      return (j.items || []).some((d) => d.status !== 'RESOLVED');
    },
  };

  const money = {
    async addTracking({ captureId, trackingNumber, carrier }) {
      if (mock) return replayable(`track-${trackingNumber}`, () => ({ ok: true, tracking_id: fakeId('TRK', trackingNumber) }));
      const j = await api('POST', '/v1/shipping/trackers-batch', {
        trackers: [{ transaction_id: captureId, tracking_number: trackingNumber, status: 'SHIPPED', carrier: 'OTHER', carrier_name_other: carrier }],
      });
      if ((j.errors || []).length) throw new Error(`PayPal tracking error: ${JSON.stringify(j.errors)}`);
      return { ok: true, tracking_id: j.tracker_identifiers?.[0]?.tracking_number || trackingNumber };
    },
    async refundCapture({ captureId, amountCents, currency = 'USD', requestId, note }) {
      if (mock) return replayable(requestId, () => ({ id: fakeId('REF', requestId), status: 'COMPLETED', amount: { value: (amountCents / 100).toFixed(2), currency_code: currency } }));
      const j = await api('POST', `/v2/payments/captures/${captureId}/refund`, { amount: { value: (amountCents / 100).toFixed(2), currency_code: currency }, note_to_payer: note }, { 'PayPal-Request-Id': requestId });
      return { id: j.id, status: j.status, amount: j.amount };
    },
  };

  // Webhook signature check. Mock mode trusts the caller (the simulator cannot sign events).
  async function verifyWebhook(headers, event) {
    if (mock || !config.webhookId) return mock;
    const j = await api('POST', '/v1/notifications/verify-webhook-signature', {
      auth_algo: headers['paypal-auth-algo'],
      cert_url: headers['paypal-cert-url'],
      transmission_id: headers['paypal-transmission-id'],
      transmission_sig: headers['paypal-transmission-sig'],
      transmission_time: headers['paypal-transmission-time'],
      webhook_id: config.webhookId,
      webhook_event: event,
    });
    return j.verification_status === 'SUCCESS';
  }

  return { read, money, verifyWebhook, mode: config.mode };
}
