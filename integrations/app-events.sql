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
  o record; b record; v_name text; v_id text; v_title text; v_live date;
begin
  v_to := (now() at time zone 'Asia/Taipei')::date;
  v_from := v_to - (p_days - 1);
  for c in select * from private.app_event_products loop
    -- 下載 / 新訂閱 (購買) / 營收 per Taipei day, market and platform. 有效訂閱 does not apply (one-time purchase).
    -- iPhone purchases and refunds: from the day Apple's server notifications reach us (app_event_products.apple_live_at,
    -- apple-notifications.sql), only the ones Apple confirmed (provider 'apple', Production only, right away). Before
    -- that day: the app's own events, or Apple's daily report on days it has arrived (store-report-linked.sql).
    -- Downloads: the app's first-open events, or Apple's report on the days it has arrived.
    v_live := (c.apple_live_at at time zone 'Asia/Taipei')::date;
    select coalesce(jsonb_agg(jsonb_build_object('d', g.d, 'm', g.m, 'pf', g.pf, 'dl', g.dl, 'sub', g.sub, 'act', 0, 'rev', g.rev)), '[]'::jsonb)
    into v_rows
    from (
      select d, m, pf, sum(dl) dl, sum(sub) sub,
        coalesce(jsonb_object_agg(cur, amt) filter (where cur is not null and amt is not null), '{}'::jsonb) rev
      from (
        select d, m, pf, cur, sum(dl) dl, sum(sub) sub, sum(amt) amt
        from (
          select ev.d, ev.m, ev.pf, ev.cur,
            case when ev.reported then 0 else ev.dl end dl,
            case when ev.apple then ev.sub_apple when ev.reported then 0 else ev.sub_all end sub,
            case when ev.apple then ev.amt_apple when ev.reported then null else ev.amt_all end amt
          from (
            select x.*,
              exists (select 1 from private.store_report_days sd where sd.product_id = c.product_id and sd.pf = x.pf and sd.d = x.d) reported,
              (v_live is not null and x.pf = 'ios' and x.d >= v_live) apple
            from (
              select (e.at at time zone 'Asia/Taipei')::date d, e.market m, e.platform pf, e.currency cur,
                count(*) filter (where e.kind = 'first_open') dl,
                count(*) filter (where e.kind = 'purchase') sub_all,
                count(*) filter (where e.kind = 'purchase' and e.provider = 'apple') sub_apple,
                sum(e.amount) filter (where e.kind = 'purchase') amt_all,
                sum(e.amount) filter (where e.kind = 'purchase' and e.provider = 'apple') amt_apple
              from private.app_events e
              where e.product_id = c.product_id and e.kind in ('first_open', 'purchase')
                and (e.at at time zone 'Asia/Taipei')::date between v_from and v_to
              group by 1, 2, 3, 4
            ) x
          ) ev
          union all
          select r.d, r.m, r.pf, null, r.dl,
            case when v_live is not null and r.pf = 'ios' and r.d >= v_live then 0 else r.sub end, null
          from private.store_report_rows r where r.product_id = c.product_id and r.d between v_from and v_to
          union all
          select r.d, r.m, r.pf, v.key, 0, 0, v.value::numeric
          from private.store_report_rows r cross join lateral jsonb_each_text(r.rev) v
          where r.product_id = c.product_id and r.d between v_from and v_to
            and not (v_live is not null and r.pf = 'ios' and r.d >= v_live)
        ) s0 group by d, m, pf, cur
      ) s group by d, m, pf
    ) g;
    v_res := public.ingest_metrics(c.ingest_key, c.product_id, v_from, v_to, v_rows);

    -- Refunds → 退訂紀錄 (kind refund). account: the first 6 characters of the install id.
    select coalesce(jsonb_agg(jsonb_build_object('id', e.event_id, 'kind', 'refund', 'subtype', e.platform, 'at', e.at,
      'plan', '完整版', 'paid', case when e.currency is not null then jsonb_build_object(e.currency, e.amount) end,
      'm', e.market, 'account', upper(left(e.iid, 6)))), '[]'::jsonb)
    into v_refunds
    from private.app_events e where e.product_id = c.product_id and e.kind = 'refund' and e.at > now() - make_interval(days => p_days)
      and (v_live is null or e.platform <> 'ios' or (e.at at time zone 'Asia/Taipei')::date < v_live or e.provider = 'apple');
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
  'note', '每分鐘自動同步。iPhone 的購買和退款＝Apple 伺服器即時通知到工作站的 Supabase（只算正式購買，沙盒和 TestFlight 測試不算）；接上通知之前與 Android＝App 回報的購買。購買＝買完整版（一次買斷，沒有有效訂閱）；營收＝用戶付的金額（未扣抽成）。下載＝App 第一次開啟，Apple 每日報表到了的日子改用 Apple 的總下載。退款出現在退訂紀錄；AI 服務宕機出現在趨勢圖的事件；App 閃退出現在 Bug 追蹤。',
  'platforms', '["iOS", "Android"]'::jsonb, 'updatedAt', (extract(epoch from now()) * 1000)::bigint), updated_at = now()
where d.collection = 'products' and d.id = 'a8a891dcdd4d407c92b1';

-- Right away on LINE (owner, 2026-11-20: 「今天有人訂閱，我就是要及時收到」): every purchase and refund,
-- the first phone to see a provider's outage that day, and the first time a crash is seen. Sent through
-- the edge function line-relay (pg_net, after the app's call commits); retry_key makes LINE deliver each once.
create or replace function private.app_event_notify() returns trigger
language plpgsql security definer set search_path = '' as $fn$
declare c private.app_event_products; v_name text; v_text text; v_m text; v_n int;
begin
  select * into c from private.app_event_products p where p.product_id = new.product_id;
  if c.product_id is null then return null; end if;
  -- iPhone purchases and refunds once Apple's notifications arrive: only Apple's confirmed one is announced. When the
  -- app's own event came first, Apple's notification turns it into provider 'apple' (an update), and that is announced.
  if new.platform = 'ios' and new.kind in ('purchase', 'refund') and c.apple_live_at is not null and new.provider is distinct from 'apple' then
    return null;
  end if;
  if tg_op = 'UPDATE' and (old.provider is not distinct from 'apple' or new.provider is distinct from 'apple') then return null; end if;
  select coalesce(d.data->>'name', new.product_id) into v_name from public.docs d where d.collection = 'products' and d.id = new.product_id;
  v_name := coalesce(v_name, new.product_id);
  if new.kind = 'purchase' then
    select count(*) into v_n from private.app_events e where e.product_id = new.product_id and e.kind = 'purchase'
      and (e.at at time zone 'Asia/Taipei')::date = (new.at at time zone 'Asia/Taipei')::date
      and (e.platform <> 'ios' or c.apple_live_at is null or e.provider = 'apple');
    v_text := '💰 ' || v_name || ' 有人買了完整版！' || E'\n'
      || coalesce(new.currency || ' ' || trim(to_char(new.amount, 'FM999999990.##')), '金額不明') || '・'
      || case new.platform when 'ios' then 'iPhone' when 'android' then 'Android' else new.platform end || '・' || coalesce(new.market, '')
      || coalesce('・v' || new.version, '') || case when new.provider = 'apple' then '・Apple 已確認' else '' end
      || E'\n今天第 ' || v_n || ' 筆';
  elsif new.kind = 'refund' then
    v_text := '↩️ ' || v_name || ' 完整版被退款（或撤銷）' || E'\n'
      || coalesce(new.currency || ' ' || trim(to_char(new.amount, 'FM999999990.##')) || '・', '')
      || case new.platform when 'ios' then 'iPhone' when 'android' then 'Android' else new.platform end || '・' || coalesce(new.market, '');
  elsif new.kind = 'outage' and new.provider is not null and not exists (
      select 1 from private.app_events e where e.product_id = new.product_id and e.kind = 'outage' and e.provider = new.provider
        and e.event_id <> new.event_id and (e.at at time zone 'Asia/Taipei')::date = (new.at at time zone 'Asia/Taipei')::date) then
    v_text := '⚠️ ' || initcap(new.provider) || ' 服務宕機' || E'\n' || v_name || ' 的用戶在 '
      || to_char(new.at at time zone 'Asia/Taipei', 'HH24:MI') || ' 偵測到（狀態：' || coalesce(new.indicator, '?') || '）';
  elsif new.kind = 'crash' and new.msg is not null and not exists (
      select 1 from private.app_events e where e.product_id = new.product_id and e.kind = 'crash' and e.msg = new.msg and e.event_id <> new.event_id) then
    v_text := '🐞 ' || v_name || ' 新的閃退' || E'\n' || left(new.msg, 200) || E'\n'
      || case new.platform when 'ios' then 'iPhone' when 'android' then 'Android' else new.platform end || '・v' || coalesce(new.version, '')
      || E'\n已加到 Bug 追蹤（下一分鐘）';
  end if;
  if v_text is null then return null; end if;
  v_m := md5(new.product_id || ':' || new.event_id);
  perform net.http_post(
    url := 'https://bpovoxjdqdwhhlfwgpep.supabase.co/functions/v1/line-relay',
    body := jsonb_build_object('key', c.ingest_key, 'product', new.product_id, 'text', v_text,
      'retry_key', substr(v_m, 1, 8) || '-' || substr(v_m, 9, 4) || '-' || substr(v_m, 13, 4) || '-' || substr(v_m, 17, 4) || '-' || substr(v_m, 21, 12)),
    headers := jsonb_build_object('Content-Type', 'application/json'),
    timeout_milliseconds := 10000);
  return null;
exception when others then
  return null; -- a LINE problem never loses the event
end $fn$;
revoke execute on function private.app_event_notify() from public, anon, authenticated;
drop trigger if exists app_event_notify on private.app_events;
create trigger app_event_notify after insert or update of provider on private.app_events for each row execute function private.app_event_notify();
