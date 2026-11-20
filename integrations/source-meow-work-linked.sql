-- Runs in the meow-work project (Supabase meow-work, ygrlvmyqrhyfkglomsbq).
-- Apple's SALES report that meow-work already fetches (public.asc_report_rows) covers every app of the developer
-- account. workstation.push() sends the rows of the apps listed here to the workstation's
-- public.ingest_store_report() with meow-work's own key (store-report-linked.sql on the workstation side).
--   額度雷達 / QuotaRadar: App Store id 6836609602 → workstation product a8a891dcdd4d407c92b1 (owner, 2026-11-21)
-- dl = downloads (first + re-downloads), sub = one-time purchases (in-app purchase units > 0 whose Parent Identifier
-- is the app's SKU), rev = customer price × units per customer currency (refund rows have negative units).

create or replace function workstation.export_linked_store(p_from date, p_to date) returns jsonb
language sql stable set search_path = '' as $fn$
with
apps(app_id, product) as (values ('6836609602', 'a8a891dcdd4d407c92b1')),
skus as (
  select distinct a.product, r.row->>'SKU' sku
  from public.asc_report_rows r join apps a on a.app_id = r.row->>'Apple Identifier'
  where r.report_type = 'SALES'
),
days as (
  select coalesce(jsonb_agg(distinct r.report_date), '[]'::jsonb) days
  from public.asc_report_rows r where r.report_type = 'SALES' and r.report_date between p_from and p_to
),
dl as (
  select a.product, r.report_date d, r.row->>'Country Code' m, sum((r.row->>'Units')::numeric) n
  from public.asc_report_rows r join apps a on a.app_id = r.row->>'Apple Identifier'
  where r.report_type = 'SALES' and r.report_date between p_from and p_to
    and r.row->>'Product Type Identifier' in ('1', '1F', '1T', 'F1', '3', '3F', '3T', 'F3')
  group by 1, 2, 3
),
iap as (
  select s.product, r.report_date d, r.row->>'Country Code' m,
    sum(greatest((r.row->>'Units')::numeric, 0)) n,
    upper(r.row->>'Customer Currency') cur,
    sum((r.row->>'Units')::numeric * coalesce(nullif(r.row->>'Customer Price', '')::numeric, 0)) amt
  from public.asc_report_rows r join skus s on s.sku = r.row->>'Parent Identifier'
  where r.report_type = 'SALES' and r.report_date between p_from and p_to
    and r.row->>'Product Type Identifier' ~ '^(IA|FI)' and r.row->>'Product Type Identifier' <> 'IAY'
  group by 1, 2, 3, 5
),
lines as (
  select product, d, m, n dl, 0 sub, null::text cur, null::numeric amt from dl
  union all
  select product, d, m, 0, n, cur, amt from iap
)
select coalesce(jsonb_agg(jsonb_build_object('product', a.product, 'pf', 'ios', 'days', (select days from days),
  'rows', coalesce((select jsonb_agg(jsonb_build_object('d', x.d, 'm', x.m, 'dl', x.dl, 'sub', x.sub,
      'rev', coalesce(x.rev, '{}'::jsonb)))
    from (select d, m, sum(dl)::int dl, sum(sub)::int sub, jsonb_object_agg(cur, amt) filter (where cur is not null) rev
          from lines where lines.product = a.product group by d, m) x), '[]'::jsonb))), '[]'::jsonb)
from apps a
$fn$;
revoke execute on function workstation.export_linked_store(date, date) from public, anon, authenticated;

-- workstation.push(): after the 挽回信 block, send each linked app's rows (see push-common.sql).
--   if to_regprocedure('workstation.export_linked_store(date,date)') is not null then
--     for v_link in select value from jsonb_array_elements(workstation.export_linked_store(v_from, v_to)) loop
--       perform extensions.http(('POST', c.url || '/rest/v1/rpc/ingest_store_report', ...,
--         jsonb_build_object('p_key', c.ingest_key, 'p_source', c.product_id, 'p_product', v_link->>'product',
--           'p_pf', v_link->>'pf', 'p_from', v_from, 'p_to', v_to, 'p_days', v_link->'days', 'p_rows', v_link->'rows')::text) ...);
--     end loop;
--   end if;
