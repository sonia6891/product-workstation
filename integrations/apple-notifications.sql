-- Runs in the WORKSTATION project (product-workstation, bpovoxjdqdwhhlfwgpep).
-- Apple's App Store Server Notifications V2 for apps with no server of their own (額度雷達 / QuotaRadar).
-- Owner 2026-11-21: Apple's daily report is a day late, purchases must come from our Supabase right away.
-- Apple → edge function app-store-notifications (verifies Apple's signature) → public.ingest_apple_notification()
-- → private.app_events (the same table the app's own events go to), then app-events.sql turns them into numbers:
--   ONE_TIME_CHARGE → purchase (event id tx:ios:<transactionId>, the same id the app uses, so one purchase is one row)
--   REFUND / REVOKE → refund (退訂紀錄)   REFUND_REVERSED → that refund is removed
-- Only Production counts. Sandbox and TestFlight purchases (the owner's own tests) are only logged.
-- From the first notification on (app_event_products.apple_live_at), iPhone purchases and refunds are the ones
-- Apple confirmed; the app's own iPhone purchase events are no longer counted or announced.

create table if not exists private.apple_apps (
  bundle_id text primary key,
  app_apple_id bigint not null,
  product_id text not null
);
revoke all on private.apple_apps from public, anon, authenticated;
insert into private.apple_apps (bundle_id, app_apple_id, product_id)
values ('com.quotaradar.app', 6836609602, 'a8a891dcdd4d407c92b1')
on conflict (bundle_id) do update set app_apple_id = excluded.app_apple_id, product_id = excluded.product_id;

alter table private.app_event_products add column if not exists apple_live_at timestamptz;

-- Every verified notification, so a retry from Apple is not counted twice and the owner can see what came in.
create table if not exists private.apple_notifications (
  uuid text primary key,
  product_id text not null,
  type text not null,
  subtype text,
  environment text not null,
  transaction_id text,
  store_product text,
  signed_at timestamptz,
  counted text,
  received_at timestamptz not null default now()
);
revoke all on private.apple_notifications from public, anon, authenticated;

create or replace function public.ingest_apple_notification(p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $fn$
declare
  a private.apple_apps; t jsonb := p->'tx'; v_env text := p->>'environment'; v_type text := p->>'type';
  v_counted text; v_price numeric; v_cur text; v_m text; v_at timestamptz;
begin
  select * into a from private.apple_apps x where x.bundle_id = p->>'bundle_id';
  if a.bundle_id is null then return jsonb_build_object('ignored', 'unknown_app'); end if;
  if v_env is null or v_env not in ('Production', 'Sandbox') then return jsonb_build_object('ignored', 'environment'); end if;
  if v_env = 'Production' and (p->>'app_apple_id') is distinct from a.app_apple_id::text then
    return jsonb_build_object('ignored', 'app_mismatch');
  end if;
  if coalesce(p->>'uuid', '') = '' then return jsonb_build_object('ignored', 'no_uuid'); end if;
  if exists (select 1 from private.apple_notifications n where n.uuid = p->>'uuid') then
    return jsonb_build_object('ok', true, 'duplicate', true);
  end if;

  update private.app_event_products e set apple_live_at = coalesce(e.apple_live_at, now()) where e.product_id = a.product_id;

  v_price := case when t->>'price' ~ '^-?[0-9]+(\.[0-9]+)?$' then (t->>'price')::numeric / 1000 end;
  v_cur := case when upper(t->>'currency') ~ '^[A-Z]{3}$' then upper(t->>'currency') end;
  v_m := private.norm_market(t->>'storefront');
  if v_env = 'Production' and t is not null and coalesce(t->>'id', '') <> ''
     and coalesce(t->>'ownership', 'PURCHASED') <> 'FAMILY_SHARED' then
    if v_type = 'ONE_TIME_CHARGE' then
      v_at := coalesce(to_timestamp(nullif(t->>'purchased_at', '')::numeric / 1000), now());
      insert into private.app_events (product_id, event_id, kind, at, iid, platform, market, amount, currency, provider)
      values (a.product_id, 'tx:ios:' || (t->>'id'), 'purchase', v_at, 'apple', 'ios', v_m, v_price, v_cur, 'apple')
      on conflict (product_id, event_id) do update set provider = 'apple', at = excluded.at,
        market = coalesce(excluded.market, private.app_events.market),
        amount = coalesce(excluded.amount, private.app_events.amount),
        currency = coalesce(excluded.currency, private.app_events.currency);
      v_counted := 'purchase';
    elsif v_type in ('REFUND', 'REVOKE') then
      v_at := coalesce(to_timestamp(nullif(t->>'revoked_at', '')::numeric / 1000), now());
      insert into private.app_events (product_id, event_id, kind, at, iid, platform, market, amount, currency, provider)
      values (a.product_id, 'refund:apple:' || (t->>'id'), 'refund', v_at, 'apple', 'ios', v_m, v_price, v_cur, 'apple')
      on conflict (product_id, event_id) do nothing;
      v_counted := 'refund';
    elsif v_type = 'REFUND_REVERSED' then
      delete from private.app_events e where e.product_id = a.product_id and e.event_id = 'refund:apple:' || (t->>'id');
      v_counted := 'refund_reversed';
    end if;
  end if;

  insert into private.apple_notifications (uuid, product_id, type, subtype, environment, transaction_id, store_product, signed_at, counted)
  values (p->>'uuid', a.product_id, coalesce(v_type, '?'), p->>'subtype', v_env, t->>'id', t->>'product',
    to_timestamp(nullif(p->>'signed_at', '')::numeric / 1000), v_counted)
  on conflict (uuid) do nothing;
  return jsonb_build_object('ok', true, 'product', a.product_id, 'environment', v_env, 'counted', v_counted);
end $fn$;
revoke execute on function public.ingest_apple_notification(jsonb) from public, anon, authenticated;
grant execute on function public.ingest_apple_notification(jsonb) to service_role;
