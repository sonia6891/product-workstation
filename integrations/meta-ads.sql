-- Meta 廣告費自動同步 (workstation project). The edge function meta-ads-sync (integrations/meta-ads-sync/index.ts) reads
-- each day's spend per campaign and country from the Meta Marketing API, already converted to the workstation currency,
-- and hands it here. Only the 'Meta' channel of daily_metrics.ad_spend changes: other channels typed in by hand stay.
-- A day/market/product in the window that Meta no longer reports loses its Meta amount (and the row goes when nothing
-- else is left on it). Callable by the service role only.
create or replace function public.ingest_ad_spend(p_channel text, p_from date, p_to date, p_rows jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $fn$
declare v_up int; v_gone int;
begin
  if p_channel is null or p_from is null or p_to is null or p_to < p_from or p_to - p_from > 400 or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'invalid input' using errcode = '22023';
  end if;
  create temp table if not exists _ad (p text, m text, d date, v numeric) on commit drop;
  truncate _ad;
  insert into _ad
    select r->>'p', private.norm_market(r->>'m'), (r->>'d')::date, round(sum((r->>'v')::numeric), 2)
    from jsonb_array_elements(p_rows) r
    where (r->>'d')::date between p_from and p_to and exists (select 1 from public.docs x where x.collection = 'products' and x.id = r->>'p')
    group by 1, 2, 3;

  with up as (
    insert into public.daily_metrics as t (product_id, market, date, ad_spend, sample, updated_at)
    select a.p, a.m, a.d, jsonb_build_object(p_channel, a.v), false, now() from _ad a
    on conflict (product_id, market, date) do update
      set ad_spend = coalesce(t.ad_spend, '{}'::jsonb) || jsonb_build_object(p_channel, excluded.ad_spend->p_channel), updated_at = now()
      where t.ad_spend->p_channel is distinct from excluded.ad_spend->p_channel
    returning 1
  ) select count(*) into v_up from up;

  -- No longer reported: take the channel off; a row with nothing else on it goes.
  with gone as (
    update public.daily_metrics t set ad_spend = nullif(t.ad_spend - p_channel, '{}'::jsonb), updated_at = now()
    where t.date between p_from and p_to and t.ad_spend ? p_channel
      and not exists (select 1 from _ad a where a.p = t.product_id and a.m = t.market and a.d = t.date)
    returning 1
  ) select count(*) into v_gone from gone;
  delete from public.daily_metrics t where t.date between p_from and p_to and t.ad_spend is null
    and t.downloads is null and t.new_subs is null and t.active_subs is null and t.revenue is null;

  return jsonb_build_object('ok', true, 'rows', (select count(*) from _ad), 'changed', v_up + v_gone);
end $fn$;
revoke execute on function public.ingest_ad_spend(text, date, date, jsonb) from public, anon, authenticated;
grant execute on function public.ingest_ad_spend(text, date, date, jsonb) to service_role;
