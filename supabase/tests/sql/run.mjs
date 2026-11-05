import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
const M = new URL('../../migrations/', import.meta.url).pathname;
const db = new PGlite();
let pass = 0, fail = 0;
const t = async (name, fn) => { try { await fn(); pass++; console.log('ok   ', name); } catch (e) { fail++; console.log('FAIL ', name, '\n      ', e.message); } };
const eq = (a, b, m = '') => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m} expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`); };
const q = async (sql, p) => (await db.query(sql, p)).rows;
const throws = async (sql, re) => { try { await db.query(sql); } catch (e) { if (re && !re.test(e.message)) throw new Error('wrong error: ' + e.message); return; } throw new Error('expected an error'); };

// --- Supabase stubs
await db.exec(`
create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
create schema auth;
create table auth.users (id uuid primary key default gen_random_uuid(), email text);
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
grant usage on schema public, auth to anon, authenticated, service_role;
`);
for (const f of ['20261023000000_schema.sql', '20261023000100_rls.sql', '20261023000300_worker.sql']) await db.exec(readFileSync(M + f, 'utf8'));
await db.exec(`grant select, insert, update, delete on all tables in schema public to authenticated, service_role; grant execute on all functions in schema public to authenticated, service_role;
revoke execute on function claim_incidents, claim_replies, claim_actions, complete_refund, shift_demo_time from authenticated;`);
console.log('migrations applied\n');

const [ua, ub] = [(await q("insert into auth.users(email) values('a@x') returning id"))[0].id, (await q("insert into auth.users(email) values('b@x') returning id"))[0].id];
const ma = (await q("insert into merchants(user_id,name) values($1,'A') returning id", [ua]))[0].id;
const mb = (await q("insert into merchants(user_id,name) values($1,'B') returning id", [ub]))[0].id;
for (const m of [ma, mb]) await q("insert into policies(merchant_id,allowed_remedies,max_refund_percent,max_refund_cents) values($1,'{NEW_ETA}',20,1500)", [m]);
const mkOrder = async (m, n, cents = 4800) => (await q("insert into orders(merchant_id,merchant_order_id,paypal_order_id,capture_id,amount_cents,buyer_email,buyer_name,promised_by) values($1,$2,$3,$4,$5,'b@e','Sam',now()+interval '3 days') returning id", [m, `O${n}`, `PO${n}`, `CAP${n}`, cents]))[0].id;
const oa = await mkOrder(ma, 1), ob = await mkOrder(mb, 2);
const incA = (await q("insert into incidents(order_id,rule_fired) values($1,'NO_SCAN') returning id", [oa]))[0].id;
const incB = (await q("insert into incidents(order_id,rule_fired) values($1,'FAILED') returning id", [ob]))[0].id;

await t('one open incident per order (partial unique index)', () => throws(`insert into incidents(order_id,rule_fired) values('${oa}','DELAYED')`, /one_open_incident_per_order/));
await t('a resolved incident allows a new one for the same order', async () => {
  const o3 = await mkOrder(ma, 3); const i = (await q("insert into incidents(order_id,rule_fired,state) values($1,'NO_SCAN','RESOLVED') returning id", [o3]))[0].id;
  await q("insert into incidents(order_id,rule_fired) values($1,'FAILED')", [o3]); void i;
});
await t('refunded_cents can never exceed the capture (check constraint)', () => throws(`update orders set refunded_cents = 4801 where id='${oa}'`, /check/));
await t('audit_events is append-only', async () => {
  await q("insert into audit_events(incident_id,actor,kind) values($1,'RULE','X')", [incA]);
  await throws("update audit_events set kind='Y'", /append-only/); await throws('delete from audit_events', /append-only/);
});

const as = async (uid, sql) => { await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub','${uid}',false)`); try { return await q(sql); } finally { await db.exec('reset role'); } };
await t('RLS: a merchant sees only their own orders and incidents', async () => {
  eq((await as(ua, 'select merchant_order_id from orders order by 1')).map((r) => r.merchant_order_id).includes('O2'), false);
  eq((await as(ua, 'select id from incidents')).some((r) => r.id === incB), false);
  eq((await as(ub, 'select id from incidents')).map((r) => r.id), [incB]);
});
await t('RLS: webhook_events is invisible to merchants', async () => {
  await q("insert into webhook_events(id,event_type,verified,payload) values('E1','X',true,'{}')");
  eq((await as(ua, 'select * from webhook_events')).length, 0);
});
await t('RLS: a merchant cannot write orders, incidents or offers', async () => {
  await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub','${ua}',false)`);
  let blocked = 0;
  for (const s of [`update orders set refunded_cents=100 where id='${oa}'`, `update incidents set state='RESOLVED' where id='${incA}'`, `delete from incidents where id='${incA}'`]) {
    const r = await db.query(s).catch(() => null); if (!r || r.affectedRows === 0) blocked++;
  }
  await db.exec('reset role'); eq(blocked, 3);
});
await t('RLS: a merchant can update their own policy but not another merchant\'s', async () => {
  await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub','${ua}',false)`);
  const own = await db.query("update policies set max_refund_percent=10 where merchant_id=$1", [ma]);
  const other = await db.query("update policies set max_refund_percent=99 where merchant_id=$1", [mb]);
  await db.exec('reset role'); eq([own.affectedRows, other.affectedRows], [1, 0]);
  eq((await q('select max_refund_percent from policies where merchant_id=$1', [mb]))[0].max_refund_percent, 20);
  await q('update policies set max_refund_percent=20 where merchant_id=$1', [ma]);
});
await t('merchants cannot call the privileged RPCs', async () => {
  await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub','${ua}',false)`);
  const r = await db.query("select complete_refund(gen_random_uuid(),'x')").catch((e) => e); await db.exec('reset role');
  if (!(r instanceof Error) || !/permission denied/.test(r.message)) throw new Error('RPC was callable: ' + (r.message ?? 'no error'));
});

await t('claim_incidents: claims OPEN incidents with no live offer, once, with a lease', async () => {
  const first = (await q('select id from claim_incidents(10)')).map((r) => r.id);
  eq([incA, incB].every((x) => first.includes(x)), true);
  eq((await q('select id from claim_incidents(10)')).filter((r) => [incA, incB].includes(r.id)).length, 0); // leased
  await q("update incidents set claimed_until = now() - interval '1 second'");
  await q("insert into offers(incident_id,options,message,validator_result,status) values($1,'[]','m','{}','SENT')", [incA]);
  const again = (await q('select id from claim_incidents(10)')).map((r) => r.id); eq(again.includes(incA), false); eq(again.includes(incB), true);
});

// An approved refund waiting to execute
const offer = (await q(`insert into offers(incident_id,options,message,validator_result,status,buyer_choice) values($1,'[]','m','{}','APPROVED','{"type":"PARTIAL_REFUND","amount_cents":900}') returning id`, [incB]))[0].id;
await q("update incidents set state='EXECUTING' where id=$1", [incB]);
const act = (await q("insert into actions(offer_id,type,amount_cents,idempotency_key) values($1,'REFUND',900,'preempt-k') returning id", [offer]))[0].id;
await t('actions.idempotency_key is unique (one action per offer)', () => throws(`insert into actions(offer_id,type,amount_cents,idempotency_key) values('${offer}','REFUND',900,'preempt-k')`, /unique|duplicate/));
await t('claim_actions leases a pending action to exactly one caller', async () => {
  eq((await q('select id from claim_actions(5, $1)', [act])).length, 1); eq((await q('select id from claim_actions(5, $1)', [act])).length, 0);
});
await t('complete_refund: one transaction updates action, order total and incident; replay changes nothing', async () => {
  eq((await q("select complete_refund($1,'REF-1') as r", [act]))[0].r, true);
  eq((await q('select refunded_cents from orders where id=$1', [ob]))[0].refunded_cents, 900);
  eq((await q('select state from incidents where id=$1', [incB]))[0].state, 'RESOLVED');
  eq((await q('select status, paypal_ref_id from actions where id=$1', [act]))[0], { status: 'COMPLETED', paypal_ref_id: 'REF-1' });
  eq((await q("select complete_refund($1,'REF-2') as r", [act]))[0].r, false);
  eq((await q('select refunded_cents from orders where id=$1', [ob]))[0].refunded_cents, 900); // not doubled
  eq((await q('select paypal_ref_id from actions where id=$1', [act]))[0].paypal_ref_id, 'REF-1');
});
await t('complete_refund refuses to push refunds past the capture', async () => {
  const o = await mkOrder(ma, 9, 1000); const i = (await q("insert into incidents(order_id,rule_fired,state) values($1,'NO_SCAN','EXECUTING') returning id", [o]))[0].id;
  const f = (await q("insert into offers(incident_id,options,message,validator_result,status) values($1,'[]','m','{}','APPROVED') returning id", [i]))[0].id;
  const a = (await q("insert into actions(offer_id,type,amount_cents,idempotency_key) values($1,'REFUND',1500,'k-over') returning id", [f]))[0].id;
  await throws(`select complete_refund('${a}','R')`, /check/);
  eq((await q('select refunded_cents from orders where id=$1', [o]))[0].refunded_cents, 0); // rolled back
  eq((await q('select status from actions where id=$1', [a]))[0].status, 'PENDING');
});
await t('claim_replies picks up unprocessed buyer replies once', async () => {
  const o4 = await mkOrder(ma, 4); const i = (await q("insert into incidents(order_id,rule_fired) values($1,'NO_SCAN') returning id", [o4]))[0].id;
  const f = (await q("insert into offers(incident_id,options,message,validator_result,status,buyer_reply) values($1,'[]','m','{}','SENT','can I wait?') returning id", [i]))[0].id;
  eq((await q('select id from claim_replies(5)')).map((r) => r.id), [f]); eq((await q('select id from claim_replies(5)')).length, 0);
});
await t('dashboard_totals respects RLS and counts correctly', async () => {
  const a = await as(ua, 'select * from dashboard_totals'); eq(a.length, 1); eq(a[0].merchant_id, ma);
  const b = await as(ub, 'select * from dashboard_totals'); eq(b.length, 1);
  eq([Number(b[0].resolved_without_dispute), Number(b[0].refunds_issued_cents), Number(b[0].refunds_count), Number(b[0].estimated_cost_avoided_cents)], [1, 900, 1, 31500]);
});
await t('shift_demo_time moves demo shipments, promised date and scans back by N days', async () => {
  const o = await mkOrder(ma, 5); await q("update orders set promised_by = timestamptz '2026-11-10 00:00+00', created_at = timestamptz '2026-11-05 00:00+00' where id=$1", [o]);
  await q(`insert into shipments(order_id,carrier,tracking_number,sim_scenario,sim_started_at,last_scan_at,events) values($1,'c','T5','stall','2026-11-05 00:00+00','2026-11-07 00:00+00','[{"id":"a","status":"IN_TRANSIT","at":"2026-11-07T00:00:00.000Z"}]')`, [o]);
  await q('select shift_demo_time($1, 3)', [ma]);
  const r = (await q("select to_char(promised_by at time zone 'utc','YYYY-MM-DD') p, to_char(sim_started_at at time zone 'utc','YYYY-MM-DD') s, to_char(last_scan_at at time zone 'utc','YYYY-MM-DD') l, events->0->>'at' e from shipments s join orders o on o.id=s.order_id where s.tracking_number='T5'"))[0];
  eq([r.p, r.s, r.l], ['2026-11-07', '2026-11-02', '2026-11-04']); eq(r.e.startsWith('2026-11-04'), true);
});
await t('shift_demo_time leaves real (non-simulated) shipments and other merchants alone', async () => {
  const o = await mkOrder(mb, 6); await q("update orders set promised_by = timestamptz '2026-11-10 00:00+00' where id=$1", [o]);
  await q("insert into shipments(order_id,carrier,tracking_number) values($1,'c','REAL6')", [o]);
  await q('select shift_demo_time($1, 5)', [ma]);
  eq((await q("select to_char(promised_by at time zone 'utc','YYYY-MM-DD') p from orders where id=$1", [o]))[0].p, '2026-11-10');
});
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
