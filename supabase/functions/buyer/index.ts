// Public buyer API, authorised only by a signed link token. GET ?token= shows the offer; POST /choose records a choice or a reply.
import { auditTo } from '../_shared/audit.ts';
import { hashToken, verifyToken } from '../_shared/buyer-token.ts';
import { env } from '../_shared/env.ts';
import { handler, HttpError, json, one, subpath } from '../_shared/http.ts';
import { adminClient } from '../_shared/supabase-admin.ts';

// Best-effort rate limit per function instance (a shared limiter would need a table).
const hits = new Map<string, number[]>();
function limit(key: string, max: number) {
  const now = Date.now();
  const recent = (hits.get(key) ?? []).filter((t) => now - t < 60_000);
  if (recent.length >= max) throw new HttpError(429, 'RATE_LIMITED', 'Too many requests. Please wait a minute and try again.');
  hits.set(key, [...recent, now]);
}

async function load(admin: ReturnType<typeof adminClient>, token: string) {
  const t = await verifyToken(token, env('BUYER_LINK_SECRET'));
  if (!t.ok) throw new HttpError(404, 'NOT_FOUND', 'This link is not valid.');
  const { data: offer } = await admin.from('offers').select('*').eq('id', t.offerId).maybeSingle();
  if (!offer || offer.token_hash !== (await hashToken(token))) throw new HttpError(404, 'NOT_FOUND', 'This link is not valid.');
  const incident = await one(admin.from('incidents').select('*').eq('id', offer.incident_id).single());
  const order = await one(admin.from('orders').select('merchant_order_id, buyer_name, merchant_id').eq('id', incident.order_id).single());
  const merchant = await one(admin.from('merchants').select('name').eq('id', order.merchant_id).single());
  return { offer, incident, order, merchant, expiresAtMs: t.expiresAtMs };
}

function view(c: Awaited<ReturnType<typeof load>>) {
  const { offer, incident } = c;
  const replied = offer.buyer_reply != null;
  let status: 'OPEN' | 'CHOSEN' | 'RESOLVED' | 'EXPIRED' = 'OPEN';
  if (incident.state === 'RESOLVED' && offer.status === 'APPROVED') status = 'RESOLVED';
  else if (offer.status === 'CHOSEN' || offer.status === 'APPROVED' || (offer.status === 'SENT' && replied)) status = 'CHOSEN';
  else if (offer.status !== 'SENT') status = 'EXPIRED';
  return {
    status, merchant_name: c.merchant.name, buyer_name: c.order.buyer_name, merchant_order_id: c.order.merchant_order_id,
    message: offer.message, options: offer.options, chosen: offer.buyer_choice ?? null,
    reply_ack: replied && !offer.buyer_choice ? 'We have passed your note to the seller, who will get back to you.' : null,
  };
}

Deno.serve(handler(async (req) => {
  const admin = adminClient();
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
  const route = subpath(req, 'buyer');

  if (req.method === 'GET' && route.length === 0) {
    limit(`get:${ip}`, 60);
    const token = new URL(req.url).searchParams.get('token') ?? '';
    const c = await load(admin, token);
    if (c.offer.status === 'SENT' && c.offer.buyer_reply == null && Date.now() > c.expiresAtMs) throw new HttpError(410, 'TOKEN_EXPIRED', 'This link has expired.');
    return json(view(c));
  }

  if (req.method === 'POST' && route[0] === 'choose') {
    limit(`choose:${ip}`, 10);
    const body = await req.json().catch(() => ({}));
    const c = await load(admin, String(body.token ?? ''));
    const { offer, incident } = c;
    if (Date.now() > c.expiresAtMs && offer.status === 'SENT') throw new HttpError(410, 'TOKEN_EXPIRED', 'This link has expired.');
    if (incident.state === 'DISPUTED' || incident.dispute_id) throw new HttpError(409, 'DISPUTE_OPEN', 'This order is no longer open for choices.');
    if (offer.status !== 'SENT' || incident.state !== 'OFFERED' || offer.buyer_reply != null) throw new HttpError(409, 'ALREADY_EXECUTED', 'A choice was already made on this link.');
    const audit = auditTo(admin);

    if (Number.isInteger(body.choice_index)) {
      const picked = offer.options[body.choice_index];
      if (!picked) throw new HttpError(400, 'BAD_REQUEST', 'That option does not exist.');
      const { data: won } = await admin.from('offers').update({ buyer_choice: picked, status: 'CHOSEN' }).eq('id', offer.id).eq('status', 'SENT').select('id');
      if (!won?.length) throw new HttpError(409, 'ALREADY_EXECUTED', 'A choice was already made on this link.');
      await admin.from('incidents').update({ state: 'AWAITING_APPROVAL' }).eq('id', incident.id).eq('state', 'OFFERED');
      await audit({ incidentId: incident.id, actor: 'BUYER', kind: 'BUYER_CHOSE', output: { choice: picked } });
    } else if (typeof body.reply === 'string' && body.reply.trim()) {
      const reply = body.reply.trim().slice(0, 1000);
      const { data: won } = await admin.from('offers').update({ buyer_reply: reply }).eq('id', offer.id).eq('status', 'SENT').is('buyer_reply', null).select('id');
      if (!won?.length) throw new HttpError(409, 'ALREADY_EXECUTED', 'A reply was already sent on this link.');
      await audit({ incidentId: incident.id, actor: 'BUYER', kind: 'BUYER_REPLIED', output: { reply } });
    } else {
      throw new HttpError(400, 'BAD_REQUEST', 'Send choice_index or reply.');
    }
    return json(view(await load(admin, body.token)));
  }
  throw new HttpError(404, 'NOT_FOUND', 'No such route.');
}));
