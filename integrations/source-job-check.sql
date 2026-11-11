-- 職缺體檢 (Supabase project job-check). Only on the Taiwan App Store; free for now.
-- dl = new users (the first open creates an anonymous account); act = profiles on the pro plan.
-- An App Store pro counts only with a Production subscription valid that day: TestFlight and Xcode purchases are
-- Sandbox (internal.app_store_subscriptions.environment) and set the same plan, so they would show as paying users.
create or replace function workstation.export_rows(p_from date, p_to date) returns jsonb
language sql stable set search_path = '' as $fn$
with days as (
  select gs.d0::date d, least(now(), ((gs.d0::date + 1)::timestamp at time zone 'Asia/Taipei')) cut
  from generate_series(p_from, p_to, interval '1 day') gs(d0)
),
dl as (
  select (u.created_at at time zone 'Asia/Taipei')::date d, count(*) n from auth.users u
  where (u.created_at at time zone 'Asia/Taipei')::date between p_from and p_to group by 1
),
act as (
  select dy.d, count(*) n from days dy join public.profiles p on p.plan = 'pro' and p.plan_expire_at > dy.cut and p.created_at < dy.cut
  where p.billing_provider is distinct from 'app_store' or exists (
    select 1 from internal.app_store_subscriptions s
    where s.user_id = p.id and s.environment = 'Production' and not s.revoked and s.expires_at > dy.cut)
  group by 1
)
select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object('d', dy.d, 'm', 'TW', 'dl', dl.n, 'act', act.n)) order by dy.d), '[]'::jsonb)
from days dy left join dl on dl.d = dy.d left join act on act.d = dy.d
where dl.n is not null or act.n is not null
$fn$;
revoke execute on function workstation.export_rows(date, date) from public, anon, authenticated;
