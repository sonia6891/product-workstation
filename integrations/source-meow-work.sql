-- 喵的，又要上班了 (Supabase project meow-work).
-- dl  = App Store SALES report total downloads (first + re-downloads, product types 1/1F/1T/F1/3/3F/3T/F3).
--       Days the report hasn't arrived yet (today, usually yesterday) and all Android use first opens
--       from app_daily_opens; the hourly 120-day push swaps in Apple's numbers once the report lands.
-- sub = new original transactions; act = transactions whose period covers the end of the day (or now);
-- rev = customer price of each paid transaction (gross, before Apple's commission), per currency.
-- All from App Store Server Notifications / verified transactions in store_subscription_events (Production).
create or replace function workstation.export_rows(p_from date, p_to date) returns jsonb
language sql stable set search_path = '' as $fn$
with
sales_days as (
  select distinct r.report_date d from public.asc_report_rows r where r.report_type = 'SALES' and r.report_date between p_from and p_to
),
ios_report as (
  select r.report_date d, r.row->>'Country Code' m, sum((r.row->>'Units')::numeric) n
  from public.asc_report_rows r
  where r.report_type = 'SALES' and r.report_date between p_from and p_to and r.row->>'Product Type Identifier' in ('1', '1F', '1T', 'F1', '3', '3F', '3T', 'F3')
  group by 1, 2
),
first_open as (
  select o.day d, o.region m, o.platform, count(*) n
  from public.app_daily_opens o
  where o.day between p_from and p_to and o.platform in ('ios', 'android')
    and not exists (select 1 from public.app_daily_opens o2 where o2.install_id = o.install_id and o2.day < o.day)
  group by 1, 2, 3
),
dl as (
  select d, m, n from ios_report
  union all select d, m, n from first_open where platform = 'android'
  union all select f.d, f.m, f.n from first_open f where f.platform = 'ios' and not exists (select 1 from sales_days s where s.d = f.d)
),
tx as (
  select distinct on (t->>'transactionId')
    t->>'transactionId' tid, t->>'originalTransactionId' otid,
    (to_timestamp((t->>'purchaseDate')::numeric / 1000) at time zone 'Asia/Taipei')::date pday,
    to_timestamp((t->>'purchaseDate')::numeric / 1000) pd,
    to_timestamp(nullif(t->>'expiresDate', '')::numeric / 1000) ed,
    coalesce(nullif(t->>'price', '')::numeric, 0) / 1000 price, t->>'currency' cur, t->>'storefront' sf,
    t ? 'revocationDate' revoked
  from public.store_subscription_events e
  cross join lateral (select case when jsonb_typeof(e.raw->'transaction') = 'object' then e.raw->'transaction' else e.raw end t) x
  where e.environment = 'Production' and t ? 'transactionId' and t ? 'purchaseDate'
  order by t->>'transactionId', e.created_at
),
subs as (
  select pday d, sf m, count(distinct otid) n from tx where tid = otid and pday between p_from and p_to group by 1, 2
),
rev as (
  select d, m, jsonb_object_agg(cur, amt) amt from (
    select pday d, sf m, cur, sum(price) amt from tx where price > 0 and not revoked and cur is not null and pday between p_from and p_to group by 1, 2, 3
  ) z group by 1, 2
),
last_sf as (
  select distinct on (otid) otid, sf from tx order by otid, pd desc
),
days as (
  select gs.d0::date d, least(now(), ((gs.d0::date + 1)::timestamp at time zone 'Asia/Taipei')) cut
  from generate_series(p_from, p_to, interval '1 day') gs(d0)
),
act as (
  select dy.d, l.sf m, count(distinct t.otid) n
  from days dy
  join tx t on t.pd < dy.cut and t.ed > dy.cut and not t.revoked
  join last_sf l on l.otid = t.otid
  group by 1, 2
),
keys as (
  select d, m from dl union select d, m from subs union select d, m from rev union select d, m from act
)
select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
  'd', k.d, 'm', k.m,
  'dl', (select sum(n) from dl where dl.d = k.d and dl.m is not distinct from k.m),
  'sub', (select sum(n) from subs where subs.d = k.d and subs.m is not distinct from k.m),
  'act', (select sum(n) from act where act.d = k.d and act.m is not distinct from k.m),
  'rev', (select amt from rev where rev.d = k.d and rev.m is not distinct from k.m)
)) order by k.d, k.m), '[]'::jsonb)
from keys k
$fn$;
revoke execute on function workstation.export_rows(date, date) from public, anon, authenticated;

-- Cancellation feed for the 退訂紀錄 page: renewal turned off/on, expiry, refund, billing failure.
-- first_paid = the subscription's original purchase; paid = what this subscription has paid so far;
-- account = first 6 hex of md5(app user id), enough to spot the same person, not who they are.
create or replace function workstation.export_events(p_since timestamptz) returns jsonb
language sql stable set search_path = '' as $fn$
with
all_ev as (
  select e.*, case when jsonb_typeof(e.raw->'transaction') = 'object' then e.raw->'transaction' else e.raw end t
  from public.store_subscription_events e where e.environment = 'Production'
),
tx as (
  select distinct on (t->>'transactionId')
    t->>'transactionId' tid, coalesce(t->>'originalTransactionId', original_transaction_id) otid,
    to_timestamp((t->>'purchaseDate')::numeric / 1000) pd,
    to_timestamp(nullif(t->>'originalPurchaseDate', '')::numeric / 1000) opd,
    coalesce(nullif(t->>'price', '')::numeric, 0) / 1000 price, t->>'currency' cur, t->>'storefront' sf,
    t->>'offerType' = '1' and coalesce(nullif(t->>'price', '')::numeric, 0) = 0 trial,
    t ? 'revocationDate' revoked
  from all_ev where t ? 'transactionId' and t ? 'purchaseDate'
  order by t->>'transactionId', created_at
),
users as (
  select distinct on (coalesce(t->>'originalTransactionId', original_transaction_id)) coalesce(t->>'originalTransactionId', original_transaction_id) otid, user_id
  from all_ev where user_id is not null order by 1, created_at
),
ev as (
  select e.event_id, e.event_type, e.subtype, e.created_at at_, e.product_id,
    coalesce(e.original_transaction_id, e.t->>'originalTransactionId') otid, e.user_id
  from all_ev e
  where e.created_at >= p_since
    and (e.event_type in ('EXPIRED', 'REFUND', 'REVOKE', 'DID_FAIL_TO_RENEW', 'GRACE_PERIOD_EXPIRED')
      or (e.event_type = 'DID_CHANGE_RENEWAL_STATUS' and e.subtype in ('AUTO_RENEW_DISABLED', 'AUTO_RENEW_ENABLED')))
)
select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
  'id', ev.event_id,
  'kind', case
    when ev.event_type = 'DID_CHANGE_RENEWAL_STATUS' and ev.subtype = 'AUTO_RENEW_DISABLED' then 'cancel'
    when ev.event_type = 'DID_CHANGE_RENEWAL_STATUS' then 'resume'
    when ev.event_type in ('REFUND', 'REVOKE') then 'refund'
    when ev.event_type = 'DID_FAIL_TO_RENEW' then 'billing_fail'
    else 'expire' end,
  'subtype', ev.subtype,
  'at', ev.at_,
  'plan', ev.product_id,
  'first_paid', (select coalesce(min(x.opd), min(x.pd)) from tx x where x.otid = ev.otid),
  'trial', (select x.trial from tx x where x.otid = ev.otid and x.pd <= ev.at_ order by x.pd desc limit 1),
  'paid', (select jsonb_object_agg(z.cur, z.amt) from (select x.cur, sum(x.price) amt from tx x where x.otid = ev.otid and x.price > 0 and not x.revoked and x.pd <= ev.at_ and x.cur is not null group by 1) z),
  'm', (select x.sf from tx x where x.otid = ev.otid order by x.pd desc limit 1),
  'account', upper(left(md5(coalesce(ev.user_id, (select u.user_id from users u where u.otid = ev.otid))::text), 6))
)) order by ev.at_), '[]'::jsonb)
from ev
$fn$;
revoke execute on function workstation.export_events(timestamptz) from public, anon, authenticated;
