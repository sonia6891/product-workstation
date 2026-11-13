-- Workstation project: receives the 版本與留存 snapshot a source app pushes hourly (integrations/usage-meow-work.sql)
-- and keeps it as docs cfg/usage-<product>. Same push key check as ingest_metrics.
create or replace function public.ingest_usage(p_key text, p_product text, p_snap jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $fn$
begin
  if p_key is null or not exists (select 1 from private.ingest_keys k where k.product_id = p_product and k.key_hash = encode(sha256(convert_to(p_key, 'UTF8')), 'hex')) then
    raise exception 'invalid ingest key' using errcode = '42501';
  end if;
  if jsonb_typeof(p_snap) <> 'object' or length(p_snap::text) > 60000 then
    raise exception 'invalid snapshot' using errcode = '22023';
  end if;
  insert into public.docs as d (collection, id, data, updated_at, updated_by) values ('cfg', 'usage-' || p_product, p_snap, now(), 'usage')
  on conflict (collection, id) do update set data = excluded.data, updated_at = now(), updated_by = 'usage'
  where (d.data - 'at') is distinct from (excluded.data - 'at');
  return jsonb_build_object('ok', true);
end $fn$;
revoke execute on function public.ingest_usage(text, text, jsonb) from public;
grant execute on function public.ingest_usage(text, text, jsonb) to anon, authenticated;
