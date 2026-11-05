-- Demo merchant. Create the Auth user first (Dashboard > Authentication, or the CLI), then:
--   insert the user's id below or run this file, which looks the user up by email.
-- Demo login: demo@preempt.example  (set the password yourself; keep it out of the public repo).
do $$
declare uid uuid; mid uuid;
begin
  select id into uid from auth.users where email = 'demo@preempt.example';
  if uid is null then
    raise notice 'Create the auth user demo@preempt.example, then re-run seed.sql';
    return;
  end if;
  insert into merchants (user_id, name) values (uid, 'Demo Supply Co.')
    on conflict (user_id) do update set name = excluded.name returning id into mid;
  insert into policies (merchant_id, allowed_remedies, max_refund_percent, max_refund_cents, auto_approve_cents, no_scan_days, tone)
    values (mid, array['NEW_ETA','RESHIP','PARTIAL_REFUND'], 20, 1500, 500, 3, 'warm')
    on conflict (merchant_id) do nothing;
end $$;
