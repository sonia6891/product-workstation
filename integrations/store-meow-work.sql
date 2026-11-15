-- 喵的，又要上班了: one view of paid store subscriptions from BOTH stores, official purchases only
-- (App Store environment 'Production', Google Play 'PRODUCTION'; Sandbox and Google test accounts never count).
-- Every count on the workstation (新訂閱, 有效訂閱, 營收, 訂閱現況, 退訂紀錄, 關閉續訂版本) and the hourly LINE card
-- reads these two functions, so both stores are counted the same way.
--
-- Google Play, mapped onto the App Store's words:
--   subscription id = the first order id (GPA.xxxx); each renewal is order GPA.xxxx..0, ..1, … = one paid period.
--   period start = the subscription's startTime for the first order, else the first notice about that order;
--   period end = lineItems expiryTime; price = the plan's recurring price (0 in a free trial);
--   market = regionCode turned into the App Store's 3-letter code (TW → TWN) so one country is one market.
--   RTDN 3 cancelled by the user → 關閉自動續訂, 7 restarted → 重新開啟, 13 → 到期, 12 revoked → 退款,
--   5 on hold / 6 grace period → 扣款失敗. A cancel the system makes (failed billing, test purchase ending) is not
--   counted as the person turning renewal off.

create or replace function workstation.cc3(p text) returns text
language sql immutable set search_path = '' as $fn$
  select coalesce((select a3 from (values
    ('TW','TWN'),('HK','HKG'),('MO','MAC'),('CN','CHN'),('JP','JPN'),('KR','KOR'),('SG','SGP'),('MY','MYS'),('TH','THA'),
    ('VN','VNM'),('PH','PHL'),('ID','IDN'),('IN','IND'),('AU','AUS'),('NZ','NZL'),('US','USA'),('CA','CAN'),('MX','MEX'),
    ('BR','BRA'),('GB','GBR'),('IE','IRL'),('FR','FRA'),('DE','DEU'),('NL','NLD'),('BE','BEL'),('ES','ESP'),('IT','ITA'),
    ('PT','PRT'),('CH','CHE'),('AT','AUT'),('SE','SWE'),('NO','NOR'),('DK','DNK'),('FI','FIN'),('PL','POL'),('AE','ARE'),
    ('SA','SAU'),('IL','ISR'),('TR','TUR'),('ZA','ZAF')) m(a2, a3) where a2 = upper(p)), nullif(upper(p), ''));
$fn$;

-- Paid (or free-trial) periods: one row per App Store transaction / Google Play order.
create or replace function workstation.store_tx()
returns table (platform text, tid text, otid text, pd timestamptz, opd timestamptz, ed timestamptz, price numeric,
  cur text, sf text, prod text, trial boolean, revoked boolean)
language sql stable set search_path = '' as $fn$
with apple as (
  select distinct on (t->>'transactionId')
    'app_store'::text platform, t->>'transactionId' tid, coalesce(t->>'originalTransactionId', e.original_transaction_id) otid,
    to_timestamp((t->>'purchaseDate')::numeric / 1000) pd,
    to_timestamp(nullif(t->>'originalPurchaseDate', '')::numeric / 1000) opd,
    to_timestamp(nullif(t->>'expiresDate', '')::numeric / 1000) ed,
    coalesce(nullif(t->>'price', '')::numeric, 0) / 1000 price, t->>'currency' cur, t->>'storefront' sf,
    coalesce(t->>'productId', e.product_id) prod,
    t->>'offerType' = '1' and coalesce(nullif(t->>'price', '')::numeric, 0) = 0 trial,
    t ? 'revocationDate' revoked
  from public.store_subscription_events e
  cross join lateral (select case when jsonb_typeof(e.raw->'transaction') = 'object' then e.raw->'transaction' else e.raw end t) x
  where e.platform = 'app_store' and e.environment = 'Production' and t ? 'transactionId' and t ? 'purchaseDate'
  order by t->>'transactionId', e.created_at
),
g as (
  select e.event_type, e.created_at, e.product_id, s, s->'lineItems'->0 li,
    coalesce(s->'lineItems'->0->>'latestSuccessfulOrderId', s->>'latestOrderId', e.original_transaction_id) tid
  from public.store_subscription_events e
  cross join lateral (select coalesce(e.raw->'subscription', e.raw) s) x
  where e.platform = 'google_play' and upper(coalesce(e.environment, '')) = 'PRODUCTION'
),
google as (
  select 'google_play'::text platform, tid, regexp_replace(tid, '\.\.\d+$', '') otid,
    case when tid !~ '\.\.\d+$' then coalesce(min((s->>'startTime')::timestamptz), min(created_at)) else min(created_at) end pd,
    min((s->>'startTime')::timestamptz) opd,
    max((li->>'expiryTime')::timestamptz) ed,
    case when bool_or(li->'offerPhase' ? 'freeTrial') then 0 else coalesce(max(
      coalesce((li->'autoRenewingPlan'->'recurringPrice'->>'units')::numeric, 0)
      + coalesce((li->'autoRenewingPlan'->'recurringPrice'->>'nanos')::numeric, 0) / 1e9), 0) end price,
    max(li->'autoRenewingPlan'->'recurringPrice'->>'currencyCode') cur,
    workstation.cc3(max(s->>'regionCode')) sf,
    coalesce(max(li->>'productId'), max(product_id)) prod,
    bool_or(li->'offerPhase' ? 'freeTrial') trial,
    bool_or(event_type = 'RTDN_12') revoked
  from g where tid is not null and tid like 'GPA.%'
  group by tid
)
select * from apple union all select * from google
$fn$;

-- Store notices, in the App Store's words (see the mapping above), with the subscription id of store_tx().
create or replace function workstation.store_events()
returns table (event_id text, platform text, event_type text, subtype text, created_at timestamptz, product_id text,
  otid text, user_id uuid, app_version text)
language sql stable set search_path = '' as $fn$
  select e.event_id::text, e.platform::text, e.event_type::text, e.subtype::text, e.created_at, e.product_id::text,
    coalesce(e.original_transaction_id, t->>'originalTransactionId'), e.user_id, e.app_version
  from public.store_subscription_events e
  cross join lateral (select case when jsonb_typeof(e.raw->'transaction') = 'object' then e.raw->'transaction' else e.raw end t) x
  where e.platform = 'app_store' and e.environment = 'Production'
  union all
  select e.event_id::text, e.platform::text, m.et, m.st, e.created_at, e.product_id::text,
    regexp_replace(coalesce(s->'lineItems'->0->>'latestSuccessfulOrderId', s->>'latestOrderId', e.original_transaction_id), '\.\.\d+$', ''),
    e.user_id, e.app_version
  from public.store_subscription_events e
  cross join lateral (select coalesce(e.raw->'subscription', e.raw) s) x
  cross join lateral (select case
      when e.event_type = 'RTDN_3' and (s->'canceledStateContext' ? 'userInitiatedCancellation'
        or s->'canceledStateContext' ? 'developerInitiatedCancellation') then 'DID_CHANGE_RENEWAL_STATUS'
      when e.event_type = 'RTDN_7' then 'DID_CHANGE_RENEWAL_STATUS'
      when e.event_type = 'RTDN_13' then 'EXPIRED'
      when e.event_type = 'RTDN_12' then 'REVOKE'
      when e.event_type in ('RTDN_5', 'RTDN_6') then 'DID_FAIL_TO_RENEW'
      when e.event_type = 'RTDN_4' then 'SUBSCRIBED'
      when e.event_type = 'RTDN_2' then 'DID_RENEW'
      else e.event_type end et,
    case when e.event_type = 'RTDN_3' then 'AUTO_RENEW_DISABLED' when e.event_type = 'RTDN_7' then 'AUTO_RENEW_ENABLED'
      else e.subtype end st) m
  where e.platform = 'google_play' and upper(coalesce(e.environment, '')) = 'PRODUCTION'
$fn$;

revoke execute on function workstation.store_tx() from public, anon, authenticated;
revoke execute on function workstation.store_events() from public, anon, authenticated;
