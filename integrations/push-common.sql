-- Runs in each SOURCE app's Supabase project (meow-work, job-check, ...).
-- Pushes that app's numbers to the workstation every minute. Needs the `http` and `pg_cron` extensions.
-- The workstation side (public.ingest_metrics, private.ingest_keys) is the `live_ingest` migration of the
-- product-workstation project. Each product's key lives only in its source project's workstation.config;
-- the workstation stores just sha256(key) in private.ingest_keys.

create schema if not exists workstation;
revoke all on schema workstation from public, anon, authenticated;

create table if not exists workstation.config (
  id int primary key default 1 check (id = 1),
  url text not null, anon_key text not null, ingest_key text not null, product_id text not null,
  last_status int, last_body text, last_at timestamptz
);
revoke all on workstation.config from public, anon, authenticated;

-- insert into workstation.config (id, url, anon_key, ingest_key, product_id)
-- values (1, 'https://bpovoxjdqdwhhlfwgpep.supabase.co', '<workstation anon key>', '<this product''s ingest key>', '<product id>');

create or replace function workstation.push(p_days int) returns int
language plpgsql security definer set search_path = '' as $fn$
declare c workstation.config; v_to date; v_from date; v_body jsonb; r extensions.http_response;
begin
  select * into c from workstation.config where id = 1;
  v_to := (now() at time zone 'Asia/Taipei')::date; v_from := v_to - (p_days - 1);
  v_body := jsonb_build_object('p_key', c.ingest_key, 'p_product', c.product_id, 'p_from', v_from, 'p_to', v_to, 'p_rows', workstation.export_rows(v_from, v_to));
  perform extensions.http_set_curlopt('CURLOPT_TIMEOUT_MS', '15000');
  r := extensions.http(('POST', c.url || '/rest/v1/rpc/ingest_metrics',
        array[extensions.http_header('apikey', c.anon_key), extensions.http_header('Authorization', 'Bearer ' || c.anon_key)],
        'application/json', v_body::text)::extensions.http_request);
  update workstation.config set last_status = r.status, last_body = left(r.content, 500), last_at = now() where id = 1;
  return r.status;
end $fn$;
revoke execute on function workstation.push(int) from public, anon, authenticated;

-- Today and the two days before, every minute; the last 120 days once an hour (late App Store reports).
select cron.schedule('workstation-push-live', '* * * * *', $$select workstation.push(3)$$);
select cron.schedule('workstation-push-full', '17 * * * *', $$select workstation.push(120)$$);

-- export_rows(p_from, p_to) is per app (see source-*.sql). It returns
-- [{d: 'YYYY-MM-DD' (Asia/Taipei), m: country code (2- or 3-letter, normalised by the workstation),
--   dl, sub, act: integers, rev: {currency code: amount}}]
