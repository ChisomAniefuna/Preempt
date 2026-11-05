// Verifies a PayPal webhook, stores it by event id (duplicates are ignored) and answers 200.
// worker-tick applies verified events on its next run. Unverified events are stored but never acted on.
import { envOpt } from '../_shared/env.ts';
import { handler, HttpError, json } from '../_shared/http.ts';
import { makePayPal } from '../_shared/deps.ts';
import { adminClient } from '../_shared/supabase-admin.ts';
import { verifyWebhook } from '../_shared/paypal/webhooks.ts';

Deno.serve(handler(async (req) => {
  if (req.method !== 'POST') throw new HttpError(405, 'BAD_REQUEST', 'POST only.');
  const raw = await req.text();
  let event: { id?: string; event_type?: string };
  try { event = JSON.parse(raw); } catch { throw new HttpError(400, 'BAD_REQUEST', 'Body is not JSON.'); }
  if (!event.id || !event.event_type) throw new HttpError(400, 'BAD_REQUEST', 'Not a PayPal event.');

  const webhookId = envOpt('PAYPAL_WEBHOOK_ID');
  const verified = webhookId ? await verifyWebhook(makePayPal(), webhookId, req.headers, event) : false;

  const { error } = await adminClient().from('webhook_events').upsert(
    { id: event.id, event_type: event.event_type, verified, payload: event },
    { onConflict: 'id', ignoreDuplicates: true },
  );
  if (error) throw new Error(error.message);
  return json({ received: true, verified });
}));
