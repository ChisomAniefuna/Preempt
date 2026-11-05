const env = process.env;
const port = Number(env.PORT || 3000);

export const config = {
  port,
  baseUrl: env.BASE_URL || `http://localhost:${port}`,
  dbPath: env.DB_PATH || 'preempt.db',
  noScanDays: Number(env.NO_SCAN_DAYS || 3),
  pollMs: Number(env.POLL_MS || 30000),
  anthropicKey: env.ANTHROPIC_API_KEY || '',
  model: env.PREEMPT_MODEL || 'claude-sonnet-5-5',
  paypal: {
    mode: env.PAYPAL_CLIENT_ID && env.PAYPAL_CLIENT_SECRET ? 'sandbox' : 'mock',
    clientId: env.PAYPAL_CLIENT_ID || '',
    secret: env.PAYPAL_CLIENT_SECRET || '',
    webhookId: env.PAYPAL_WEBHOOK_ID || '',
    base: 'https://api-m.sandbox.paypal.com',
  },
};
