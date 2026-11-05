-- Row level security. The browser reads its own merchant's rows and edits its own policy.
-- Every other write happens in Edge Functions with the service role key.

create function my_merchant_ids() returns setof uuid
  language sql stable security definer set search_path = public as
  $$ select id from merchants where user_id = auth.uid() $$;

alter table merchants enable row level security;
alter table policies enable row level security;
alter table orders enable row level security;
alter table shipments enable row level security;
alter table incidents enable row level security;
alter table offers enable row level security;
alter table actions enable row level security;
alter table audit_events enable row level security;
alter table webhook_events enable row level security; -- no policies: service role only

create policy "merchant reads self" on merchants for select using (user_id = auth.uid());

create policy "merchant reads own policy" on policies for select using (merchant_id in (select my_merchant_ids()));
create policy "merchant updates own policy" on policies for update
  using (merchant_id in (select my_merchant_ids())) with check (merchant_id in (select my_merchant_ids()));

create policy "merchant reads own orders" on orders for select using (merchant_id in (select my_merchant_ids()));

create policy "merchant reads own shipments" on shipments for select
  using (order_id in (select id from orders where merchant_id in (select my_merchant_ids())));

create policy "merchant reads own incidents" on incidents for select
  using (order_id in (select id from orders where merchant_id in (select my_merchant_ids())));

create policy "merchant reads own offers" on offers for select
  using (incident_id in (select i.id from incidents i join orders o on o.id = i.order_id where o.merchant_id in (select my_merchant_ids())));

create policy "merchant reads own actions" on actions for select
  using (offer_id in (select f.id from offers f join incidents i on i.id = f.incident_id join orders o on o.id = i.order_id where o.merchant_id in (select my_merchant_ids())));

create policy "merchant reads own audit" on audit_events for select
  using (incident_id in (select i.id from incidents i join orders o on o.id = i.order_id where o.merchant_id in (select my_merchant_ids())));

-- Dashboard numbers, per merchant, under the caller's row level security.
-- Cost avoided uses the product PRD's ~$315 all-in cost of a chargeback as a proxy.
create view dashboard_totals with (security_invoker = true) as
select
  m.id as merchant_id,
  (select count(*) from incidents i join orders o on o.id = i.order_id where o.merchant_id = m.id) as incidents_opened,
  (select count(*) from incidents i join orders o on o.id = i.order_id where o.merchant_id = m.id and i.state = 'RESOLVED') as resolved_without_dispute,
  (select coalesce(sum(a.amount_cents), 0) from actions a join offers f on f.id = a.offer_id join incidents i on i.id = f.incident_id join orders o on o.id = i.order_id where o.merchant_id = m.id and a.type = 'REFUND' and a.status = 'COMPLETED') as refunds_issued_cents,
  (select count(*) from actions a join offers f on f.id = a.offer_id join incidents i on i.id = f.incident_id join orders o on o.id = i.order_id where o.merchant_id = m.id and a.type = 'REFUND' and a.status = 'COMPLETED') as refunds_count,
  (select count(*) from incidents i join orders o on o.id = i.order_id where o.merchant_id = m.id and i.state = 'DISPUTED') as disputes_opened,
  (select count(*) * 31500 from incidents i join orders o on o.id = i.order_id where o.merchant_id = m.id and i.state = 'RESOLVED') as estimated_cost_avoided_cents
from merchants m;
