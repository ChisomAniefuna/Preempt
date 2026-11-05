-- Worker support: leases, claim functions (for update skip locked), atomic refund completion, demo time travel.

alter table shipments add column if not exists sim_scenario   text;        -- stall | failed | returned | on_time (simulated carrier)
alter table shipments add column if not exists sim_started_at timestamptz;
alter table incidents add column if not exists claimed_until  timestamptz; -- agent lease
alter table actions   add column if not exists claimed_until  timestamptz; -- executor lease
alter table offers    add column if not exists reply_processed_at timestamptz;

-- Open incidents that still need an offer. Claimed with a lease so overlapping ticks never double-work one.
create function claim_incidents(p_limit int, p_lease_seconds int default 120) returns setof incidents
language sql security definer set search_path = public as $$
  with picked as (
    select i.id from incidents i
    where i.state = 'OPEN'
      and (i.claimed_until is null or i.claimed_until < now())
      and not exists (select 1 from offers o where o.incident_id = i.id and o.status in ('DRAFT','SENT','CHOSEN','APPROVED'))
    order by i.opened_at
    for update skip locked
    limit p_limit
  )
  update incidents i set claimed_until = now() + make_interval(secs => p_lease_seconds)
  from picked where i.id = picked.id returning i.*;
$$;

-- Buyer free-text replies that have not been interpreted yet.
create function claim_replies(p_limit int) returns setof offers
language sql security definer set search_path = public as $$
  with picked as (
    select o.id from offers o
    where o.status = 'SENT' and o.buyer_reply is not null and o.buyer_choice is null and o.reply_processed_at is null
    order by o.created_at
    for update skip locked
    limit p_limit
  )
  update offers o set reply_processed_at = now() from picked where o.id = picked.id returning o.*;
$$;

-- Pending actions, optionally one specific action. Lease prevents two runs from executing the same one.
create function claim_actions(p_limit int, p_action uuid default null, p_lease_seconds int default 120) returns setof actions
language sql security definer set search_path = public as $$
  with picked as (
    select a.id from actions a
    where a.status = 'PENDING'
      and (p_action is null or a.id = p_action)
      and (a.claimed_until is null or a.claimed_until < now())
    order by a.created_at
    for update skip locked
    limit p_limit
  )
  update actions a set claimed_until = now() + make_interval(secs => p_lease_seconds)
  from picked where a.id = picked.id returning a.*;
$$;

-- Completes a refund in ONE transaction: the action, the order's refunded total and the incident.
-- Idempotent: a second call for a completed action changes nothing.
create function complete_refund(p_action uuid, p_ref text) returns boolean
language plpgsql security definer set search_path = public as $$
declare a actions; inc uuid; ord uuid;
begin
  select * into a from actions where id = p_action for update;
  if a.status = 'COMPLETED' then return false; end if;
  select o.incident_id into inc from offers o where o.id = a.offer_id;
  select i.order_id into ord from incidents i where i.id = inc;
  update orders set refunded_cents = refunded_cents + a.amount_cents where id = ord;  -- check constraint caps it at the capture
  update actions set status = 'COMPLETED', paypal_ref_id = p_ref, error = null, claimed_until = null where id = p_action;
  update incidents set state = 'RESOLVED', closed_at = now() where id = inc and state in ('EXECUTING','ACTION_FAILED');
  return true;
end $$;

-- Demo only: move a merchant's simulated shipments back in time by N days, so "now" stays real
-- while the shipments look N days older. Orders, scans and offer expiries shift with them.
create function shift_demo_time(p_merchant uuid, p_days int) returns void
language plpgsql security definer set search_path = public as $$
begin
  update orders o set promised_by = promised_by - make_interval(days => p_days), created_at = created_at - make_interval(days => p_days)
    where o.merchant_id = p_merchant and exists (select 1 from shipments s where s.order_id = o.id and s.sim_scenario is not null);
  update shipments s set
      sim_started_at = sim_started_at - make_interval(days => p_days),
      last_scan_at = last_scan_at - make_interval(days => p_days),
      events = coalesce((select jsonb_agg(case when e ? 'at' then jsonb_set(e, '{at}', to_jsonb((e->>'at')::timestamptz - make_interval(days => p_days))) else e end order by ord)
                         from jsonb_array_elements(s.events) with ordinality t(e, ord)), '[]'::jsonb)
    where s.sim_scenario is not null and s.order_id in (select id from orders where merchant_id = p_merchant);
  update offers f set expires_at = expires_at - make_interval(days => p_days)
    where f.expires_at is not null and f.incident_id in
      (select i.id from incidents i join orders o on o.id = i.order_id where o.merchant_id = p_merchant);
end $$;

-- These run with elevated rights: only the service role may call them.
revoke execute on function claim_incidents, claim_replies, claim_actions, complete_refund, shift_demo_time from public, anon, authenticated;
grant execute on function claim_incidents, claim_replies, claim_actions, complete_refund, shift_demo_time to service_role;
