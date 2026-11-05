// Merchant actions on an offer. verify_jwt is on: the gateway checks the JWT, and every read here
// goes through the caller's own client so row level security decides which offers they may touch.
import { approveOffer } from '../_shared/approve.ts';
import { auditTo } from '../_shared/audit.ts';
import { makeTickDeps } from '../_shared/deps.ts';
import { handler, HttpError, json, one, subpath } from '../_shared/http.ts';
import { adminClient, userClient } from '../_shared/supabase-admin.ts';
import { runActions } from '../_shared/tick.ts';
import type { Option } from '../_shared/types.ts';
import { validateChoice } from '../_shared/validator.ts';

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void } | undefined;

Deno.serve(handler(async (req) => {
  const authHeader = req.headers.get('Authorization');
  if (!authHeader) throw new HttpError(401, 'UNAUTHORIZED', 'Sign in first.');
  const me = userClient(authHeader);
  const { data: user } = await me.auth.getUser();
  if (!user.user) throw new HttpError(401, 'UNAUTHORIZED', 'Sign in first.');

  const [offerId, verb] = subpath(req, 'offers');
  if (!offerId) throw new HttpError(404, 'NOT_FOUND', 'Missing offer id.');
  const { data: mine } = await me.from('offers').select('id, incident_id').eq('id', offerId).maybeSingle(); // RLS: own offers only
  if (!mine) throw new HttpError(404, 'NOT_FOUND', 'Offer not found.');

  const admin = adminClient();
  const audit = auditTo(admin);

  if (req.method === 'POST' && verb === 'approve') {
    const { actionId } = await approveOffer(admin, audit, { offerId, actor: 'MERCHANT', now: new Date() });
    // Run it now rather than waiting up to 30 seconds for the next tick. The action claim makes this safe.
    const deps = makeTickDeps(admin);
    const run = runActions(deps, undefined, actionId).catch((e) => console.error('immediate execution failed', e));
    if (typeof EdgeRuntime !== 'undefined') EdgeRuntime.waitUntil(run); else await run;
    return json({ ok: true, action_id: actionId });
  }

  if (req.method === 'POST' && verb === 'reject') {
    const body = await req.json().catch(() => ({}));
    const offer = await one(admin.from('offers').select('*').eq('id', offerId).single());
    const { data: moved } = await admin.from('incidents').update({ state: 'OPEN', claimed_until: null }).eq('id', offer.incident_id).eq('state', 'AWAITING_APPROVAL').select('id');
    if (!moved?.length) throw new HttpError(409, 'ALREADY_EXECUTED', 'This offer is no longer waiting for your decision.');
    await admin.from('offers').update({ status: 'REJECTED' }).eq('id', offerId);
    await audit({ incidentId: offer.incident_id, actor: 'MERCHANT', kind: 'OFFER_REJECTED', input: { options: offer.options, choice: offer.buyer_choice, note: String(body.note ?? '').slice(0, 500) } });
    return json({ ok: true });
  }

  if (req.method === 'PATCH' && !verb) {
    const body = await req.json().catch(() => ({}));
    const choice = body.choice as Option | undefined;
    if (!choice?.type) throw new HttpError(400, 'BAD_REQUEST', 'Send { choice }.');
    const offer = await one(admin.from('offers').select('*').eq('id', offerId).single());
    const incident = await one(admin.from('incidents').select('*').eq('id', offer.incident_id).single());
    if (incident.state !== 'AWAITING_APPROVAL' || offer.status !== 'CHOSEN' || !offer.buyer_choice) throw new HttpError(409, 'ALREADY_EXECUTED', 'This offer can no longer be edited.');
    if (choice.type !== offer.buyer_choice.type) throw new HttpError(422, 'POLICY_VIOLATION', 'You can change the amount or date, not the remedy the buyer chose.');
    const order = await one(admin.from('orders').select('*').eq('id', incident.order_id).single());
    const policy = await one(admin.from('policies').select('*').eq('merchant_id', order.merchant_id).single());
    const verdict = validateChoice(choice, { policy, order, now: new Date() });
    if (!verdict.ok) {
      await audit({ incidentId: incident.id, actor: 'VALIDATOR', kind: 'EDIT_BLOCKED', input: { choice }, output: { violations: verdict.violations } });
      throw new HttpError(422, 'POLICY_VIOLATION', 'That edit is outside your policy.', verdict.violations.map((v) => v.message));
    }
    const next = { ...offer.buyer_choice, ...choice };
    await admin.from('offers').update({ buyer_choice: next }).eq('id', offerId);
    await audit({ incidentId: incident.id, actor: 'MERCHANT', kind: 'CHOICE_EDITED', input: { before: offer.buyer_choice }, output: { after: next } });
    return json({ ok: true, buyer_choice: next });
  }
  throw new HttpError(404, 'NOT_FOUND', 'No such route.');
}));
