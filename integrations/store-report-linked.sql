-- Runs in the WORKSTATION project (product-workstation, bpovoxjdqdwhhlfwgpep).
-- Apple's official numbers for apps with no server of their own (額度雷達 / QuotaRadar, owner 2026-11-21).
-- Apple's daily SALES report covers every app of the developer account, and meow-work already fetches it
-- (public.asc_report_rows there). meow-work's workstation.push() sends the linked apps' rows here with its own
-- ingest key (workstation.export_linked_store(), source-meow-work-linked.sql), so no new key is needed.
-- private.app_events_push() (app-events.sql) then uses Apple's numbers for iPhone on every day the report
-- has arrived, and the app's own anonymous events (first open / purchase) for the days before it arrives and
-- for Android. Apple's numbers include people who turned off 傳送匿名使用統計 and every app version.
--   dl  = total downloads (first + re-downloads, product types 1/1F/1T/F1/3/3F/3T/F3), like 喵的
--   sub = one-time purchases (in-app purchase units > 0 under the app's SKU)
--   rev = customer price × units per currency (refunds come back as negative units and lower it)

-- Which source product may report Apple's numbers for which product (app_id = the App Store app id).
create table if not exists private.store_report_links (
  source_product text not null,
  product_id text not null,
  app_id text not null,
  primary key (source_product, product_id)
);
revoke all on private.store_report_links from public, anon, authenticated;
insert into private.store_report_links (source_product, product_id, app_id)
values ('meow-work', 'a8a891dcdd4d407c92b1', '6836609602')
on conflict (source_product, product_id) do update set app_id = excluded.app_id;

-- Apple's rows per report day, market and platform.
create table if not exists private.store_report_rows (
  product_id text not null,
  pf text not null,
  d date not null,
  m text not null,
  dl int not null default 0,
  sub int not null default 0,
  rev jsonb not null default '{}'::jsonb,
  primary key (product_id, pf, d, m)
);
-- The days whose report has arrived (a day with no sales still counts: it replaces the app's events with 0).
create table if not exists private.store_report_days (
  product_id text not null,
  pf text not null,
  d date not null,
  primary key (product_id, pf, d)
);
revoke all on private.store_report_rows, private.store_report_days from public, anon, authenticated;

create or replace function public.ingest_store_report(p_key text, p_source text, p_product text, p_pf text,
  p_from date, p_to date, p_days jsonb, p_rows jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $fn$
declare v_rows int; v_days int;
begin
  if p_key is null or not exists (select 1 from private.ingest_keys k where k.product_id = p_source
      and k.key_hash = encode(sha256(convert_to(p_key, 'UTF8')), 'hex')) then
    raise exception 'invalid ingest key' using errcode = '42501';
  end if;
  if not exists (select 1 from private.store_report_links l where l.source_product = p_source and l.product_id = p_product) then
    raise exception 'product not linked to this source' using errcode = '42501';
  end if;
  if p_pf not in ('ios', 'android') or p_from is null or p_to is null or p_to < p_from or p_to - p_from > 400
     or jsonb_typeof(p_days) <> 'array' or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'invalid range or rows' using errcode = '22023';
  end if;

  delete from private.store_report_rows r where r.product_id = p_product and r.pf = p_pf and r.d between p_from and p_to;
  insert into private.store_report_rows (product_id, pf, d, m, dl, sub, rev)
  select p_product, p_pf, (x->>'d')::date, private.norm_market(x->>'m'),
    sum(coalesce((x->>'dl')::int, 0)), sum(coalesce((x->>'sub')::int, 0)),
    coalesce(jsonb_object_agg(v.key, v.value::numeric) filter (where v.key is not null), '{}'::jsonb)
  from jsonb_array_elements(p_rows) x
  left join lateral jsonb_each_text(case when jsonb_typeof(x->'rev') = 'object' then x->'rev' else '{}'::jsonb end) v on true
  where (x->>'d')::date between p_from and p_to and private.norm_market(x->>'m') is not null
  group by 1, 2, 3, 4
  on conflict (product_id, pf, d, m) do nothing;
  get diagnostics v_rows = row_count;

  delete from private.store_report_days s where s.product_id = p_product and s.pf = p_pf and s.d between p_from and p_to;
  insert into private.store_report_days (product_id, pf, d)
  select distinct p_product, p_pf, (x #>> '{}')::date from jsonb_array_elements(p_days) x
  where (x #>> '{}')::date between p_from and p_to
  on conflict do nothing;
  get diagnostics v_days = row_count;

  return jsonb_build_object('ok', true, 'rows', v_rows, 'days', v_days);
end $fn$;
revoke execute on function public.ingest_store_report(text, text, text, text, date, date, jsonb, jsonb) from public;
grant execute on function public.ingest_store_report(text, text, text, text, date, date, jsonb, jsonb) to anon, authenticated;
