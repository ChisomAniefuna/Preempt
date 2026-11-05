import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';
import type { AuditFn, Actor } from './audit.ts';
import { HttpError, one } from './http.ts';
import type { Option } from './types.ts';
import { validateChoice } from './validator.ts';

/**
 * Turns a buyer's choice into one PENDING action. Shared by the merchant's Approve button, a retry
 * after a failed action, and policy auto-approval. It never talks to PayPal: the executor does.
 *
 * One remedy per incident: the action's idempotency key is derived from the offer, so approving
 * twice, or retrying, can only ever re-run the same action (and PayPal replays by request id).
 */
export async function approveOffer(admin: SupabaseClient, audit: AuditFn, a: { offerId: string; actor: Actor; now: Date }) {
  const { data: offer } = await admin.from('offers').select('*').eq('id', a.offerId).maybeSingle();
  if (!offer) throw new HttpError(404, 'NOT_FOUND', 'Offer not found.');
  const incident = await one(admin.from('incidents').select('*').eq('id', offer.incident_id).single());
  const order = await one(admin.from('orders').select('*').eq('id', incident.order_id).single());
  const policy = await one(admin.from('policies').select('*').eq('merchant_id', order.merchant_id).single());

  if (incident.dispute_id || incident.state === 'DISPUTED') throw new HttpError(409, 'DISPUTE_OPEN', 'A dispute is open on this order, so no remedy will be executed.');
  const retry = incident.state === 'ACTION_FAILED';
  if (!retry && !(incident.state === 'AWAITING_APPROVAL' && offer.status === 'CHOSEN')) {
    throw new HttpError(409, 'ALREADY_EXECUTED', `This offer cannot be approved now (incident ${incident.state}, offer ${offer.status}).`);
  }
  const choice = offer.buyer_choice as Option | null;
  if (!choice) throw new HttpError(409, 'BAD_REQUEST', 'The buyer has not chosen an option yet.');

  const verdict = validateChoice(choice, { policy, order, now: a.now });
  if (!verdict.ok) {
    await audit({ incidentId: incident.id, actor: 'VALIDATOR', kind: 'APPROVAL_BLOCKED', input: { choice }, output: { violations: verdict.violations } });
    throw new HttpError(422, 'POLICY_VIOLATION', 'This option is outside your policy.', verdict.violations.map((v) => v.message));
  }

  // Atomic claim: only one concurrent approval can move the incident to EXECUTING.
  const { data: moved } = await admin.from('incidents').update({ state: 'EXECUTING' }).eq('id', incident.id).eq('state', incident.state).select('id');
  if (!moved || moved.length === 0) throw new HttpError(409, 'ALREADY_EXECUTED', 'This offer was already approved.');

  const type = choice.type === 'PARTIAL_REFUND' || choice.type === 'FULL_REFUND' ? 'REFUND' : choice.type;
  const key = `preempt-${offer.id}`;
  const { data: existing } = await admin.from('actions').select('*').eq('idempotency_key', key).maybeSingle();
  if (existing?.status === 'COMPLETED') throw new HttpError(409, 'ALREADY_EXECUTED', 'This remedy was already executed.');
  let actionId: string;
  if (existing) {
    await admin.from('actions').update({ status: 'PENDING', error: null, claimed_until: null }).eq('id', existing.id);
    actionId = existing.id;
  } else {
    const { data: created, error } = await admin.from('actions').insert({ offer_id: offer.id, type, amount_cents: choice.amount_cents ?? null, idempotency_key: key }).select('id').single();
    if (error) throw new HttpError(500, 'BAD_REQUEST', `Could not queue the action: ${error.message}`);
    actionId = created.id;
  }
  await admin.from('offers').update({ status: 'APPROVED' }).eq('id', offer.id);
  await audit({ incidentId: incident.id, actor: a.actor, kind: retry ? 'ACTION_RETRIED' : 'OFFER_APPROVED', input: { offerId: offer.id, choice }, output: { actionId, idempotencyKey: key } });
  return { actionId };
}
