// Thin PayPal REST client (sandbox). Money and tracking writes always carry a PayPal-Request-Id.
export class PayPalError extends Error {
  constructor(public status: number, message: string, public body?: unknown) { super(message); }
  get retryable() { return this.status === 0 || this.status >= 500; }
}

export interface PayPalConfig { clientId: string; clientSecret: string; base: string }
export type Sleep = (ms: number) => Promise<void>;
const realSleep: Sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Retries network errors and 5xx with backoff (2s, 8s, 30s), reusing the same request id. 4xx fails at once. */
export async function withRetry<T>(fn: () => Promise<T>, sleep: Sleep = realSleep, delays = [2000, 8000, 30000]): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await fn(); } catch (e) {
      const retryable = e instanceof PayPalError ? e.retryable : true;
      if (!retryable || attempt >= delays.length) throw e;
      await sleep(delays[attempt]);
    }
  }
}

export function createPayPal(cfg: PayPalConfig, opts: { fetchImpl?: typeof fetch; sleep?: Sleep } = {}) {
  const doFetch = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? realSleep;
  let token: { value: string; exp: number } | null = null; // cached for the life of the function instance

  async function accessToken(): Promise<string> {
    if (token && token.exp > Date.now()) return token.value;
    let res: Response;
    try {
      res = await doFetch(`${cfg.base}/v1/oauth2/token`, {
        method: 'POST',
        headers: { Authorization: `Basic ${btoa(`${cfg.clientId}:${cfg.clientSecret}`)}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'grant_type=client_credentials',
      });
    } catch (e) { throw new PayPalError(0, `PayPal unreachable: ${(e as Error).message}`); }
    if (!res.ok) throw new PayPalError(res.status, `PayPal auth failed (${res.status})`);
    const j = await res.json();
    token = { value: j.access_token, exp: Date.now() + (Number(j.expires_in) - 120) * 1000 };
    return token.value;
  }

  async function call<T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
    const t = await accessToken();
    let res: Response;
    try {
      res = await doFetch(`${cfg.base}${path}`, { method, headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    } catch (e) { throw new PayPalError(0, `PayPal unreachable: ${(e as Error).message}`); }
    const text = await res.text();
    const parsed = text ? safeJson(text) : {};
    if (res.status === 401) token = null;
    if (!res.ok) throw new PayPalError(res.status, `PayPal ${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`, parsed);
    return parsed as T;
  }

  return {
    // ---- read-only (the agent's toolkit is built from these)
    getOrder: (orderId: string) => call<PayPalOrder>('GET', `/v2/checkout/orders/${orderId}`),
    getRefund: (refundId: string) => call<{ id: string; status: string }>('GET', `/v2/payments/refunds/${refundId}`),
    getDispute: (disputeId: string) => call<Record<string, unknown>>('GET', `/v1/customer/disputes/${disputeId}`),
    listDisputes: (captureId: string) => call<{ items?: { dispute_id: string; status: string }[] }>('GET', `/v1/customer/disputes?disputed_transaction_id=${encodeURIComponent(captureId)}`),

    // ---- demo checkout
    createOrder: (args: { amountCents: number; referenceId: string; requestId: string; card?: { number: string; expiry: string; securityCode: string; name: string } }) =>
      withRetry(() => call<PayPalOrder>('POST', '/v2/checkout/orders', {
        intent: 'CAPTURE',
        purchase_units: [{ reference_id: args.referenceId, amount: { currency_code: 'USD', value: (args.amountCents / 100).toFixed(2) } }],
        ...(args.card ? { payment_source: { card: { number: args.card.number, expiry: args.card.expiry, security_code: args.card.securityCode, name: args.card.name } } } : {}),
      }, { 'PayPal-Request-Id': args.requestId, Prefer: 'return=representation' }), sleep),
    captureOrder: (orderId: string, requestId: string) =>
      withRetry(() => call<PayPalOrder>('POST', `/v2/checkout/orders/${orderId}/capture`, {}, { 'PayPal-Request-Id': requestId, Prefer: 'return=representation' }), sleep),

    // ---- writes (called only by the executor and the demo function)
    /** Same capture + tracking pair returns 200, so repeating this call is safe. */
    addTracking: (a: { orderId: string; captureId: string; trackingNumber: string; carrierName: string }) =>
      withRetry(async () => {
        await call('POST', `/v2/checkout/orders/${a.orderId}/track`, { capture_id: a.captureId, tracking_number: a.trackingNumber, carrier: 'OTHER', carrier_name_other: a.carrierName, notify_payer: false });
        return { trackerId: `${a.captureId}-${a.trackingNumber}` };
      }, sleep),
    refund: (a: { captureId: string; amountCents: number; currency: string; requestId: string; note: string }) =>
      withRetry(() => call<{ id: string; status: string }>('POST', `/v2/payments/captures/${a.captureId}/refund`,
        { amount: { value: (a.amountCents / 100).toFixed(2), currency_code: a.currency }, note_to_payer: a.note.slice(0, 255) },
        { 'PayPal-Request-Id': a.requestId, Prefer: 'return=representation' }), sleep),

    verifyWebhookSignature: (a: { headers: Headers; webhookId: string; event: unknown }) =>
      call<{ verification_status: string }>('POST', '/v1/notifications/verify-webhook-signature', {
        auth_algo: a.headers.get('paypal-auth-algo'), cert_url: a.headers.get('paypal-cert-url'),
        transmission_id: a.headers.get('paypal-transmission-id'), transmission_sig: a.headers.get('paypal-transmission-sig'),
        transmission_time: a.headers.get('paypal-transmission-time'), webhook_id: a.webhookId, webhook_event: a.event,
      }),
  };
}

export type PayPal = ReturnType<typeof createPayPal>;

export interface PayPalOrder {
  id: string; status: string;
  purchase_units?: { payments?: { captures?: { id: string; status: string; amount: { value: string; currency_code: string } }[] } }[];
}

const safeJson = (t: string) => { try { return JSON.parse(t); } catch { return { raw: t }; } };
