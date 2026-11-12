-- 站長 (cloud Claude) start key, used by the edge function `station`.
-- The routine id and its API token live in private.station_config, which the website's API cannot read.
-- Only the edge function (service_role) can read or change it, through the two functions below.
create table if not exists private.station_config (
  id boolean primary key default true check (id),
  routine_id text not null,
  token text not null,
  updated_at timestamptz not null default now(),
  updated_by text
);
alter table private.station_config enable row level security;
revoke all on private.station_config from public, anon, authenticated;

create or replace function public.station_config_get()
returns table (routine_id text, token text)
language sql stable security definer set search_path = ''
as $$ select c.routine_id, c.token from private.station_config c where c.id $$;

create or replace function public.station_config_set(p_routine text, p_token text, p_by text)
returns void
language sql security definer set search_path = ''
as $$
  insert into private.station_config (id, routine_id, token, updated_at, updated_by)
  values (true, p_routine, p_token, now(), p_by)
  on conflict (id) do update set routine_id = excluded.routine_id, token = excluded.token,
    updated_at = excluded.updated_at, updated_by = excluded.updated_by
$$;

revoke all on function public.station_config_get() from public, anon, authenticated;
revoke all on function public.station_config_set(text, text, text) from public, anon, authenticated;
grant execute on function public.station_config_get() to service_role;
grant execute on function public.station_config_set(text, text, text) to service_role;
