import type { PayPal } from './client.ts';

/** Verifies a PayPal webhook with PayPal's own verify-webhook-signature endpoint. Any failure means "not verified". */
export async function verifyWebhook(pp: Pick<PayPal, 'verifyWebhookSignature'>, webhookId: string, headers: Headers, event: unknown): Promise<boolean> {
  try {
    const r = await pp.verifyWebhookSignature({ headers, webhookId, event });
    return r.verification_status === 'SUCCESS';
  } catch (e) {
    console.error('webhook verification error', (e as Error).message);
    return false;
  }
}
