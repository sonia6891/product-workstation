-- Workstation (project bpovoxjdqdwhhlfwgpep): 蘋果與安卓分開.
-- daily_platform holds the same daily numbers as daily_metrics, split by platform ('ios' = App Store / iPhone,
-- 'android' = Google Play). daily_metrics keeps the totals exactly as before (ad spend and typed-in numbers live
-- only there); this table is only for the 蘋果與安卓 card and the 依平台 chart. A source fills it by sending
-- rows with "pf": "ios" | "android" to ingest_metrics: the totals add those rows up as they always did, and the
-- same rows land here per platform. Sources that send no "pf" leave this table alone.
create table if not exists public.daily_platform (
  product_id text not null,
  market text not null check (market ~ '^[A-Z0-9_-]{1,12}$'),
  platform text not null check (platform in ('ios', 'android')),
  date date not null,
  downloads int, new_subs int, active_subs int, revenue numeric,
  updated_at timestamptz not null default now(),
  primary key (product_id, market, platform, date)
);
alter table public.daily_platform enable row level security;
drop policy if exists platform_read on public.daily_platform;
create policy platform_read on public.daily_platform for select using ((select private.can_read()));
revoke insert, update, delete on public.daily_platform from anon, authenticated;
alter publication supabase_realtime add table public.daily_platform;

create or replace function public.ingest_metrics(p_key text, p_product text, p_from date, p_to date, p_rows jsonb)
 returns jsonb language plpgsql security definer set search_path to '' as $function$
declare
  v_cur text; v_rate numeric; v_agg jsonb; v_pf jsonb; v_up int; v_stale int; v_pup int := 0; v_pgone int := 0; v_new jsonb;
begin
  if p_key is null or not exists (select 1 from private.ingest_keys k where k.product_id = p_product and k.key_hash = encode(sha256(convert_to(p_key, 'UTF8')), 'hex')) then
    raise exception 'invalid ingest key' using errcode = '42501';
  end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 400 or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'invalid range or rows' using errcode = '22023';
  end if;

  select coalesce(nullif(d.data->>'currency', ''), 'USD') into v_cur from public.docs d where d.collection = 'cfg' and d.id = 'main';
  v_cur := coalesce(v_cur, 'USD');
  select f.per_usd into v_rate from private.fx f where f.code = v_cur;
  v_rate := coalesce(v_rate, 1);

  create temp table if not exists _rows (d date, m text, pf text, dl numeric, sub numeric, act numeric, rev numeric) on commit drop;
  truncate _rows;
  insert into _rows
    select (r->>'d')::date, private.norm_market(r->>'m'), nullif(r->>'pf', ''),
      coalesce((r->>'dl')::numeric, 0), coalesce((r->>'sub')::numeric, 0), coalesce((r->>'act')::numeric, 0),
      coalesce((select sum(v.value::numeric / f.per_usd) from jsonb_each_text(case when jsonb_typeof(r->'rev') = 'object' then r->'rev' else '{}'::jsonb end) v join private.fx f on f.code = upper(v.key)), 0) * v_rate
    from jsonb_array_elements(p_rows) r;

  select coalesce(jsonb_agg(jsonb_build_object('d', a.d, 'm', a.m, 'dl', a.dl, 'sub', a.sub, 'act', a.act, 'rev', a.rev)), '[]'::jsonb) into v_agg
  from (
    select s.d, s.m, sum(s.dl)::int dl, sum(s.sub)::int sub, sum(s.act)::int act, round(sum(s.rev), 2) rev
    from _rows s where s.d between p_from and p_to
    group by s.d, s.m
  ) a;

  with up as (
    insert into public.daily_metrics as t (product_id, market, date, downloads, new_subs, active_subs, revenue, sample, updated_at)
    select p_product, x.m, x.d, x.dl, x.sub, x.act, x.rev, false, now() from jsonb_to_recordset(v_agg) x(d date, m text, dl int, sub int, act int, rev numeric)
    on conflict (product_id, market, date) do update set downloads = excluded.downloads, new_subs = excluded.new_subs, active_subs = excluded.active_subs, revenue = excluded.revenue, sample = false, updated_at = now()
    where (t.downloads, t.new_subs, t.active_subs, t.revenue, t.sample) is distinct from (excluded.downloads, excluded.new_subs, excluded.active_subs, excluded.revenue, false)
    returning 1
  ) select count(*) into v_up from up;

  -- Days/markets in the window that the source no longer reports: drop them (or zero them if ad spend was typed in).
  delete from public.daily_metrics t where t.product_id = p_product and t.date between p_from and p_to and t.ad_spend is null
    and not exists (select 1 from jsonb_to_recordset(v_agg) x(d date, m text) where x.d = t.date and x.m = t.market);
  get diagnostics v_stale = row_count;
  update public.daily_metrics t set downloads = 0, new_subs = 0, active_subs = 0, revenue = 0, updated_at = now()
  where t.product_id = p_product and t.date between p_from and p_to and t.ad_spend is not null
    and (coalesce(t.downloads, 0), coalesce(t.new_subs, 0), coalesce(t.active_subs, 0), coalesce(t.revenue, 0)) <> (0, 0, 0, 0)
    and not exists (select 1 from jsonb_to_recordset(v_agg) x(d date, m text) where x.d = t.date and x.m = t.market);

  -- 蘋果與安卓: only when the source says which platform each row is.
  if exists (select 1 from _rows where pf in ('ios', 'android')) then
    with agg as (
      select s.d, s.m, s.pf, sum(s.dl)::int dl, sum(s.sub)::int sub, sum(s.act)::int act, round(sum(s.rev), 2) rev
      from _rows s where s.d between p_from and p_to and s.pf in ('ios', 'android') group by 1, 2, 3
    ), up as (
      insert into public.daily_platform as t (product_id, market, platform, date, downloads, new_subs, active_subs, revenue, updated_at)
      select p_product, a.m, a.pf, a.d, a.dl, a.sub, a.act, a.rev, now() from agg a
      on conflict (product_id, market, platform, date) do update set downloads = excluded.downloads, new_subs = excluded.new_subs,
        active_subs = excluded.active_subs, revenue = excluded.revenue, updated_at = now()
      where (t.downloads, t.new_subs, t.active_subs, t.revenue) is distinct from (excluded.downloads, excluded.new_subs, excluded.active_subs, excluded.revenue)
      returning 1
    ) select count(*) into v_pup from up;
    delete from public.daily_platform t where t.product_id = p_product and t.date between p_from and p_to
      and not exists (select 1 from _rows s where s.d = t.date and s.m = t.market and s.pf = t.platform);
    get diagnostics v_pgone = row_count;
  end if;

  -- New markets get a Chinese name in settings.
  select jsonb_agg(jsonb_build_object('code', n.m, 'name', coalesce(c.name, n.m)) order by n.m) into v_new
  from (select distinct x.m from jsonb_to_recordset(v_agg) x(m text)) n
  left join private.country c on c.a2 = n.m
  where not exists (select 1 from public.docs d, jsonb_array_elements(coalesce(d.data->'markets', '[]'::jsonb)) e where d.collection = 'cfg' and d.id = 'main' and e->>'code' = n.m);
  if v_new is not null then
    update public.docs d set data = jsonb_set(d.data, '{markets}', coalesce(d.data->'markets', '[]'::jsonb) || v_new), updated_at = now()
    where d.collection = 'cfg' and d.id = 'main';
  end if;

  insert into public.docs as d (collection, id, data, updated_at)
  values ('cfg', 'sync', jsonb_build_object('sources', jsonb_build_object(p_product, jsonb_build_object('at', (extract(epoch from now()) * 1000)::bigint, 'changed', v_up + v_stale + v_pup + v_pgone))), now())
  on conflict (collection, id) do update set data = jsonb_set(coalesce(d.data, '{}'::jsonb) || jsonb_build_object('sources', coalesce(d.data->'sources', '{}'::jsonb)), array['sources', p_product], jsonb_build_object('at', (extract(epoch from now()) * 1000)::bigint, 'changed', v_up + v_stale + v_pup + v_pgone)), updated_at = now();

  return jsonb_build_object('ok', true, 'rows', jsonb_array_length(v_agg), 'changed', v_up + v_stale + v_pup + v_pgone);
end $function$;
