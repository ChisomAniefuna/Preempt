-- Preempt schema. Money is integer cents plus a currency code. audit_events is append-only.

create table merchants (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null unique references auth.users(id),
  name            text not null,
  paypal_payer_id text
);

create table policies (
  merchant_id        uuid primary key references merchants(id) on delete cascade,
  allowed_remedies   text[] not null,
  max_refund_percent int not null check (max_refund_percent between 0 and 100),
  max_refund_cents   int not null check (max_refund_cents >= 0),
  auto_approve_cents int not null default 0 check (auto_approve_cents >= 0),
  no_scan_days       int not null default 3 check (no_scan_days >= 1),
  tone               text not null default 'warm',
  updated_at         timestamptz not null default now()
);

create table orders (
  id                uuid primary key default gen_random_uuid(),
  merchant_id       uuid not null references merchants(id),
  merchant_order_id text not null,
  paypal_order_id   text not null unique,
  capture_id        text not null unique,
  amount_cents      int not null,
  currency          text not null default 'USD',
  refunded_cents    int not null default 0 check (refunded_cents <= amount_cents),
  buyer_email       text not null,
  buyer_name        text not null,
  buyer_locale      text not null default 'en',
  promised_by       timestamptz not null,
  created_at        timestamptz not null default now()
);

create table shipments (
  id                uuid primary key default gen_random_uuid(),
  order_id          uuid not null references orders(id),
  carrier           text not null,
  tracking_number   text not null,
  paypal_tracker_id text,
  last_status       text,
  last_scan_at      timestamptz,
  events            jsonb not null default '[]',
  unique (order_id, tracking_number)
);

create table incidents (
  id         uuid primary key default gen_random_uuid(),
  order_id   uuid not null references orders(id),
  rule_fired text not null,
  risk_level text,
  ai_reason  text,
  state      text not null default 'OPEN',
  dispute_id text,
  opened_at  timestamptz not null default now(),
  closed_at  timestamptz
);
create unique index one_open_incident_per_order on incidents (order_id)
  where state not in ('RESOLVED', 'DISPUTED', 'EXPIRED');

create table offers (
  id               uuid primary key default gen_random_uuid(),
  incident_id      uuid not null references incidents(id),
  options          jsonb not null,
  message          text not null,
  validator_result jsonb not null,
  buyer_choice     jsonb,
  buyer_reply      text,
  status           text not null,
  token_hash       text unique,
  expires_at       timestamptz,
  created_at       timestamptz not null default now()
);

create table actions (
  id              uuid primary key default gen_random_uuid(),
  offer_id        uuid not null references offers(id),
  type            text not null,
  amount_cents    int,
  idempotency_key text not null unique,
  paypal_ref_id   text,
  status          text not null default 'PENDING',
  error           jsonb,
  created_at      timestamptz not null default now()
);

create table audit_events (
  id          bigint generated always as identity primary key,
  incident_id uuid references incidents(id),
  actor       text not null,
  kind        text not null,
  input       jsonb,
  output      jsonb,
  created_at  timestamptz not null default now()
);

create table webhook_events (
  id           text primary key,
  event_type   text not null,
  verified     boolean not null,
  payload      jsonb not null,
  processed_at timestamptz,
  received_at  timestamptz not null default now()
);

create index on orders (merchant_id);
create index on shipments (order_id);
create index on incidents (order_id);
create index on offers (incident_id);
create index on actions (offer_id);
create index on audit_events (incident_id);

-- Append-only audit log: no updates or deletes, even with the service role.
create function audit_events_immutable() returns trigger language plpgsql as $$
begin raise exception 'audit_events is append-only'; end $$;
create trigger audit_events_no_update before update or delete on audit_events
  for each row execute function audit_events_immutable();
