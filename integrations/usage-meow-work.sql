-- 喵的，又要上班了 (Supabase project meow-work): 版本與留存 card on the workstation 總覽.
-- export_usage() reads the anonymous App opens (public.app_daily_opens: install_id, day, platform, app_version; kept
-- since 2026-11-02) and the App Store transactions, and push_usage() sends it hourly to public.ingest_usage on the
-- workstation (stored as docs cfg/usage-meow-work). Only iOS / Android opens count; the web preview is left out.
--   versions: per day of the last 45, how many installs opened each version (build number dropped: 3.0.1(14001) → 3.0.1).
--   first_seen: the first day each version was opened anywhere.
--   cohorts: installs grouped by the day of their first open, and how many came back the next day (d1), on day 7
--            (d7) and on any day of the first week (w1). Null while that day hasn't fully passed. The first 3 days of
--            the log are skipped: everyone already using the App showed up then and would look like new installs.
--   trial: free trials started, how many turned into a payment, are still running, or ended without paying.
create or replace function workstation.export_usage() returns jsonb
language sql stable set search_path = '' as $fn$
with
t as (select (now() at time zone 'Asia/Taipei')::date today, (select min(day) from public.app_daily_opens) since),
o as (
  select install_id, day, platform p, split_part(app_version, '(', 1) v
  from public.app_daily_opens where platform in ('ios', 'android') and coalesce(app_version, '') !~ '^web-'
),
vd as (select o.day d, o.p, o.v, count(distinct o.install_id) n from o, t where o.day > t.today - 45 group by 1, 2, 3),
fs as (select p, v, min(day) first from o group by 1, 2),
firsts as (select install_id, min(day) fd from public.app_daily_opens where platform in ('ios', 'android') group by 1),
coh as (
  select f.fd d, count(*) n,
    case when f.fd + 1 < t.today then count(*) filter (where exists (select 1 from public.app_daily_opens x where x.install_id = f.install_id and x.day = f.fd + 1)) end d1,
    case when f.fd + 7 < t.today then count(*) filter (where exists (select 1 from public.app_daily_opens x where x.install_id = f.install_id and x.day = f.fd + 7)) end d7,
    case when f.fd + 7 < t.today then count(*) filter (where exists (select 1 from public.app_daily_opens x where x.install_id = f.install_id and x.day between f.fd + 1 and f.fd + 7)) end w1
  from firsts f, t where f.fd >= t.since + 3 and f.fd < t.today
  group by f.fd, t.today
),
ev as (
  select case when jsonb_typeof(e.raw->'transaction') = 'object' then e.raw->'transaction' else e.raw end tr, e.original_transaction_id, e.created_at
  from public.store_subscription_events e where e.environment = 'Production'
),
tx as (
  select distinct on (tr->>'transactionId') coalesce(tr->>'originalTransactionId', original_transaction_id) otid,
    coalesce(nullif(tr->>'price', '')::numeric, 0) > 0 paid,
    tr->>'offerType' = '1' and coalesce(nullif(tr->>'price', '')::numeric, 0) = 0 trial,
    to_timestamp(nullif(tr->>'expiresDate', '')::numeric / 1000) ed
  from ev where tr ? 'transactionId' order by tr->>'transactionId', created_at
),
tr as (select otid, bool_or(paid) paid, max(ed) filter (where trial) ted from tx group by otid having bool_or(trial))
select jsonb_build_object(
  'at', (extract(epoch from now()) * 1000)::bigint,
  'since', (select since from t),
  'versions', coalesce((select jsonb_agg(jsonb_build_object('d', d, 'p', p, 'v', v, 'n', n) order by d, p, v) from vd), '[]'::jsonb),
  'first_seen', coalesce((select jsonb_object_agg(p || ' ' || v, first) from fs), '{}'::jsonb),
  'cohorts', coalesce((select jsonb_agg(jsonb_strip_nulls(jsonb_build_object('d', d, 'n', n, 'd1', d1, 'd7', d7, 'w1', w1)) order by d) from coh), '[]'::jsonb),
  'trial', (select jsonb_build_object('started', count(*), 'paid', count(*) filter (where paid),
     'running', count(*) filter (where not paid and ted > now()), 'lapsed', count(*) filter (where not paid and (ted is null or ted <= now()))) from tr)
)
$fn$;
revoke execute on function workstation.export_usage() from public, anon, authenticated;

create or replace function workstation.push_usage() returns int
language plpgsql security definer set search_path = '' as $fn$
declare c workstation.config; r extensions.http_response;
begin
  select * into c from workstation.config where id = 1;
  perform extensions.http_set_curlopt('CURLOPT_TIMEOUT_MS', '15000');
  r := extensions.http(('POST', c.url || '/rest/v1/rpc/ingest_usage',
        array[extensions.http_header('apikey', c.anon_key), extensions.http_header('Authorization', 'Bearer ' || c.anon_key)],
        'application/json', jsonb_build_object('p_key', c.ingest_key, 'p_product', c.product_id, 'p_snap', workstation.export_usage())::text)::extensions.http_request);
  return r.status;
end $fn$;
revoke execute on function workstation.push_usage() from public, anon, authenticated;

-- Hourly; the App opens only change once a day per install, so more often would just repeat itself.
select cron.schedule('workstation-push-usage', '37 * * * *', $$select workstation.push_usage()$$);
