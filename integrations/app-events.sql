-- Runs in the WORKSTATION project (product-workstation, bpovoxjdqdwhhlfwgpep).
-- For apps with no server of their own (額度雷達 / QuotaRadar, product a8a891dcdd4d407c92b1): the app
-- sends a few anonymous events straight here (src/core/workstation.ts in the app), and a cron job
-- turns them into the same numbers the other products push (owner, 2026-11-20).
--   first_open → 下載   purchase → 新訂閱＋營收 (one-time full version)   refund → 退訂紀錄（退款）
--   outage → 事件 (trend-chart marker, kind other)   crash → Bug 追蹤 (issues, id app-<product>-<hash>)
-- No account, email or AI data reaches this table: install id (random, made by the app), platform,
-- region, app version, and per kind price/currency, provider/status, or the crash's first line.
-- Pause: select cron.unschedule('app-events-push'); select cron.unschedule('app-events-push-full');

create table if not exists private.app_events (
  product_id text not null,
  event_id text not null,
  kind text not null check (kind in ('first_open', 'purchase', 'refund', 'outage', 'crash')),
  at timestamptz not null,
  iid text not null,
  platform text,
  market text,
  version text,
  amount numeric,
  currency text,
  provider text,
  indicator text,
  msg text,
  received_at timestamptz not null default now(),
  primary key (product_id, event_id)
);
create index if not exists app_events_at on private.app_events (product_id, at);
create index if not exists app_events_iid on private.app_events (product_id, iid, received_at);
revoke all on private.app_events from public, anon, authenticated;

-- Products that send events, with the ingest key the cron uses for public.ingest_metrics/ingest_events
-- (only its sha256 is in private.ingest_keys, like every other product).
create table if not exists private.app_event_products (
  product_id text primary key,
  ingest_key text not null,
  last_push jsonb,
  last_at timestamptz
);
revoke all on private.app_event_products from public, anon, authenticated;

-- Marker / bug docs this job created, so one the owner deletes is not added again.
create table if not exists private.app_event_docs (
  collection text not null,
  id text not null,
  created_at timestamptz not null default now(),
  primary key (collection, id)
);
revoke all on private.app_event_docs from public, anon, authenticated;

-- 額度雷達: a new key, made here so it never leaves the database.
with k as (
  insert into private.app_event_products (product_id, ingest_key)
  values ('a8a891dcdd4d407c92b1', replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''))
  on conflict (product_id) do nothing
  returning product_id, ingest_key
)
insert into private.ingest_keys (product_id, key_hash)
select product_id, encode(sha256(convert_to(ingest_key, 'UTF8')), 'hex') from k;

-- Called by the app with the public anon key. Checks every field; ignores ids it already has.
-- Limits: 50 events a call, 300 a day per install, 20,000 an hour per product.
create or replace function public.ingest_app_events(p_product text, p_events jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $fn$
declare v_n int;
begin
  if not exists (select 1 from private.app_event_products p where p.product_id = p_product) then
    raise exception 'unknown product' using errcode = '42501';
  end if;
  if jsonb_typeof(p_events) <> 'array' or jsonb_array_length(p_events) = 0 or jsonb_array_length(p_events) > 50 then
    raise exception 'invalid events' using errcode = '22023';
  end if;
  if (select count(*) from private.app_events e where e.product_id = p_product and e.received_at > now() - interval '1 hour') > 20000 then
    raise exception 'too many events' using errcode = '54000';
  end if;
  with x as (
    select * from jsonb_to_recordset(p_events) x(id text, kind text, at timestamptz, iid text, pf text, m text, v text,
      amt numeric, cur text, prov text, ind text, msg text)
  ), ok as (
    select x.* from x
    where x.id is not null and length(x.id) between 1 and 160
      and x.kind in ('first_open', 'purchase', 'refund', 'outage', 'crash')
      and x.iid ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$'
      and x.at between now() - interval '30 days' and now() + interval '1 day'
      and (select count(*) from private.app_events e where e.product_id = p_product and e.iid = x.iid and e.received_at > now() - interval '1 day') < 300
  ), ins as (
    insert into private.app_events (product_id, event_id, kind, at, iid, platform, market, version, amount, currency, provider, indicator, msg)
    select p_product, ok.id, ok.kind, ok.at, ok.iid,
      case when ok.pf in ('ios', 'android') then ok.pf else 'other' end,
      private.norm_market(ok.m),
      left(ok.v, 20),
      case when ok.kind in ('purchase', 'refund') and ok.amt between 0 and 100000 then ok.amt end,
      case when ok.kind in ('purchase', 'refund') and upper(ok.cur) ~ '^[A-Z]{3}$' then upper(ok.cur) end,
      case when ok.kind = 'outage' and ok.prov ~ '^[a-z0-9_-]{1,20}$' then ok.prov end,
      case when ok.kind = 'outage' then left(ok.ind, 20) end,
      case when ok.kind = 'crash' then left(ok.msg, 200) end
    from ok
    on conflict (product_id, event_id) do nothing
    returning 1
  ) select count(*) into v_n from ins;
  return jsonb_build_object('ok', true, 'stored', v_n);
end $fn$;
revoke execute on function public.ingest_app_events(text, jsonb) from public;
grant execute on function public.ingest_app_events(text, jsonb) to anon, authenticated;

-- Every minute (last 3 days) and hourly (last 120 days): events → daily numbers, refunds, markers, bugs.
create or replace function private.app_events_push(p_days int)
returns jsonb language plpgsql security definer set search_path = '' as $fn$
declare
  c record; v_to date; v_from date; v_rows jsonb; v_refunds jsonb; v_res jsonb; v_ref jsonb; v_out jsonb := '{}'::jsonb;
  o record; b record; v_name text; v_id text; v_title text;
begin
  v_to := (now() at time zone 'Asia/Taipei')::date;
  v_from := v_to - (p_days - 1);
  for c in select * from private.app_event_products loop
    -- 下載 / 新訂閱 / 營收 per Taipei day, market and platform. 有效訂閱 does not apply (one-time purchase).
    select coalesce(jsonb_agg(jsonb_build_object('d', g.d, 'm', g.m, 'pf', g.pf, 'dl', g.dl, 'sub', g.sub, 'act', 0, 'rev', g.rev)), '[]'::jsonb)
    into v_rows
    from (
      select d, m, pf, sum(dl) dl, sum(sub) sub,
        coalesce(jsonb_object_agg(cur, amt) filter (where cur is not null), '{}'::jsonb) rev
      from (
        select (e.at at time zone 'Asia/Taipei')::date d, e.market m, e.platform pf,
          count(*) filter (where e.kind = 'first_open') dl,
          count(*) filter (where e.kind = 'purchase') sub,
          e.currency cur, sum(e.amount) filter (where e.kind = 'purchase') amt
        from private.app_events e
        where e.product_id = c.product_id and e.kind in ('first_open', 'purchase')
          and (e.at at time zone 'Asia/Taipei')::date between v_from and v_to
        group by 1, 2, 3, e.currency
      ) s group by d, m, pf
    ) g;
    v_res := public.ingest_metrics(c.ingest_key, c.product_id, v_from, v_to, v_rows);

    -- Refunds → 退訂紀錄 (kind refund). account: the first 6 characters of the install id.
    select coalesce(jsonb_agg(jsonb_build_object('id', e.event_id, 'kind', 'refund', 'subtype', e.platform, 'at', e.at,
      'plan', '完整版', 'paid', case when e.currency is not null then jsonb_build_object(e.currency, e.amount) end,
      'm', e.market, 'account', upper(left(e.iid, 6)))), '[]'::jsonb)
    into v_refunds
    from private.app_events e where e.product_id = c.product_id and e.kind = 'refund' and e.at > now() - make_interval(days => p_days);
    if jsonb_array_length(v_refunds) > 0 then v_ref := public.ingest_events(c.ingest_key, c.product_id, v_refunds); end if;

    -- Outages → one trend-chart marker per provider per Taipei day, with how many phones saw it.
    for o in
      select e.provider, (e.at at time zone 'Asia/Taipei')::date d, count(distinct e.iid) phones, min(e.at) first_at
      from private.app_events e
      where e.product_id = c.product_id and e.kind = 'outage' and e.provider is not null
        and (e.at at time zone 'Asia/Taipei')::date between v_from and v_to
      group by 1, 2
    loop
      v_name := case o.provider when 'claude' then 'Claude' when 'chatgpt' then 'ChatGPT' when 'gpt' then 'ChatGPT'
        when 'grok' then 'Grok' when 'gemini' then 'Gemini' else initcap(o.provider) end;
      v_id := 'outage-' || c.product_id || '-' || o.provider || '-' || o.d;
      v_title := v_name || ' 服務宕機（' || to_char(o.first_at at time zone 'Asia/Taipei', 'HH24:MI') || ' 起，' || o.phones || ' 支手機偵測到）';
      if exists (select 1 from public.docs d where d.collection = 'events' and d.id = v_id) then
        update public.docs d set data = d.data || jsonb_build_object('title', v_title), updated_at = now(), updated_by = 'app-events'
        where d.collection = 'events' and d.id = v_id and d.data->>'title' is distinct from v_title;
      elsif not exists (select 1 from private.app_event_docs x where x.collection = 'events' and x.id = v_id) then
        insert into public.docs (collection, id, data, updated_at, updated_by)
        values ('events', v_id, jsonb_build_object('auto', true, 'date', o.d, 'kind', 'other', 'title', v_title,
          'product', c.product_id, 'createdAt', (extract(epoch from now()) * 1000)::bigint), now(), 'app-events');
        insert into private.app_event_docs (collection, id) values ('events', v_id) on conflict do nothing;
      end if;
    end loop;

    -- Crashes → Bug 追蹤, one per first line of the error. 5+ phones → P1, otherwise P2.
    for b in
      select e.msg, count(*) n, count(distinct e.iid) users, min(e.at) first_at, max(e.at) last_at,
        string_agg(distinct e.platform, '/') pfs, max(e.version) ver
      from private.app_events e
      where e.product_id = c.product_id and e.kind = 'crash' and e.msg is not null
      group by e.msg
    loop
      v_id := 'app-' || c.product_id || '-' || left(md5(b.msg), 10);
      if exists (select 1 from public.docs d where d.collection = 'issues' and d.id = v_id) then
        update public.docs d set
          data = d.data || jsonb_build_object('app', jsonb_build_object('count', b.n, 'users', b.users, 'lastSeen', (extract(epoch from b.last_at) * 1000)::bigint),
            'updatedAt', greatest(coalesce((d.data->>'updatedAt')::bigint, 0), (extract(epoch from b.last_at) * 1000)::bigint))
            || case when b.users >= 5 and coalesce(d.data->>'priority', 'P3') > 'P1' then jsonb_build_object('priority', 'P1') else '{}'::jsonb end,
          updated_at = now(), updated_by = 'app-events'
        where d.collection = 'issues' and d.id = v_id
          and (d.data->'app'->>'count')::int is distinct from b.n::int;
      elsif not exists (select 1 from private.app_event_docs x where x.collection = 'issues' and x.id = v_id)
        and not exists (select 1 from public.docs d where d.collection = 'solved' and d.id = v_id) then
        insert into public.docs (collection, id, data, updated_at, updated_by)
        values ('issues', v_id, jsonb_build_object('type', 'bug', 'title', left(b.msg, 120), 'product', c.product_id,
          'priority', case when b.users >= 5 then 'P1' else 'P2' end, 'status', 'new', 'platform', b.pfs, 'version', coalesce(b.ver, ''), 'owner', '',
          'desc', b.msg || E'\n\n來源：App 閃退回報（JavaScript，下次開 App 時送出）',
          'createdAt', (extract(epoch from b.first_at) * 1000)::bigint, 'updatedAt', (extract(epoch from b.last_at) * 1000)::bigint,
          'app', jsonb_build_object('count', b.n, 'users', b.users, 'lastSeen', (extract(epoch from b.last_at) * 1000)::bigint)), now(), 'app-events');
        insert into private.app_event_docs (collection, id) values ('issues', v_id) on conflict do nothing;
      end if;
    end loop;

    update private.app_event_products p set last_push = jsonb_build_object('metrics', v_res, 'refunds', v_ref), last_at = now()
    where p.product_id = c.product_id;
    v_out := v_out || jsonb_build_object(c.product_id, v_res);
  end loop;
  return v_out;
end $fn$;
revoke execute on function private.app_events_push(int) from public, anon, authenticated;

select cron.schedule('app-events-push', '* * * * *', $$select private.app_events_push(3)$$);
select cron.schedule('app-events-push-full', '23 * * * *', $$select private.app_events_push(120)$$);

-- What the product card says about where the numbers come from.
update public.docs d set data = d.data || jsonb_build_object(
  'note', '每分鐘自動同步（App 直接回報匿名事件，沒有自己的伺服器）。下載＝App 第一次開啟；新訂閱＝買完整版（一次買斷，不是訂閱，所以沒有有效訂閱）；營收＝商店標價（未扣抽成）。退款出現在退訂紀錄；AI 服務宕機出現在趨勢圖的事件；App 閃退出現在 Bug 追蹤。關掉「傳送匿名使用統計」的人不算在內。iOS 1.0.1、Android 第一版起才有。',
  'platforms', '["iOS", "Android"]'::jsonb, 'updatedAt', (extract(epoch from now()) * 1000)::bigint), updated_at = now()
where d.collection = 'products' and d.id = 'a8a891dcdd4d407c92b1';
