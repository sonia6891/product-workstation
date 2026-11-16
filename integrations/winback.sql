-- Workstation (project bpovoxjdqdwhhlfwgpep): 挽回信, one system for every product.
--  * Each source app sends, in its hourly push, the people whose auto-renew is off right now and their email
--    (workstation.export_winback() → public.ingest_winback). They land in private.winback_recipients: the website
--    can never read an email, only the edge functions (service role) can.
--  * The owner presses 寄挽回信 on 退訂紀錄 → edge function winback-send mails everyone not mailed yet, from
--    sonia@pocketjoystudio.com through Resend, with that product's letter (integrations/winback-send/letters/).
--  * Each letter's buttons carry the person's token → the page on meow.pocketjoystudio.com (Cloudflare Worker,
--    integrations/winback-page/worker.js) → edge function winback-feedback → public.winback_answer.
--  * 退訂紀錄 reads public.winback_board() (no email, no token); alerts sends new answers to LINE.
-- Campaign 'winback-1' is the first letter. Test sends use campaign 'test…' and are marked as tests everywhere.

create table if not exists private.winback_recipients (
  token text primary key default encode(extensions.gen_random_bytes(12), 'hex'),
  product_id text not null,
  campaign text not null default 'winback-1',
  account text,                 -- same code as sub_events.account (first 6 hex of md5(app user id))
  email text not null,
  platform text,                -- ios | android
  off_at timestamptz,           -- when they turned auto-renew off
  active boolean not null default true, -- false once the app no longer lists them (renewal back on, account deleted)
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  unique (product_id, campaign, email)
);
create table if not exists private.winback_responses (
  token text primary key references private.winback_recipients(token) on delete cascade,
  reason text check (reason in ('price', 'feature', 'bug', 'notneeded', 'other')),
  comeback text check (comeback in ('yes', 'maybe', 'no')),
  comment text,
  first_seen_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
revoke all on private.winback_recipients, private.winback_responses from public, anon, authenticated;

-- Source apps: the people to write to right now. Rows: [{account, email, platform, off_at}].
create or replace function public.ingest_winback(p_key text, p_product text, p_rows jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $fn$
declare v_new int; v_gone int;
begin
  if p_key is null or not exists (select 1 from private.ingest_keys k where k.product_id = p_product and k.key_hash = encode(sha256(convert_to(p_key, 'UTF8')), 'hex')) then
    raise exception 'invalid ingest key' using errcode = '42501';
  end if;
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 5000 then
    raise exception 'invalid rows' using errcode = '22023';
  end if;
  create temp table if not exists _wb (account text, email text, platform text, off_at timestamptz) on commit drop;
  truncate _wb;
  insert into _wb select distinct on (lower(btrim(x.email))) x.account, lower(btrim(x.email)), x.platform, x.off_at
    from jsonb_to_recordset(p_rows) x(account text, email text, platform text, off_at timestamptz)
    where x.email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' order by lower(btrim(x.email)), x.off_at desc;
  with up as (
    insert into private.winback_recipients as t (product_id, campaign, account, email, platform, off_at, active)
    select p_product, 'winback-1', w.account, w.email, w.platform, w.off_at, true from _wb w
    on conflict (product_id, campaign, email) do update set account = excluded.account, platform = excluded.platform,
      off_at = excluded.off_at, active = true
    where (t.account, t.platform, t.off_at, t.active) is distinct from (excluded.account, excluded.platform, excluded.off_at, true)
    returning (xmax = 0) ins
  ) select count(*) filter (where ins) into v_new from up;
  update private.winback_recipients t set active = false
  where t.product_id = p_product and t.campaign = 'winback-1' and t.active and t.sent_at is null
    and not exists (select 1 from _wb w where w.email = t.email);
  get diagnostics v_gone = row_count;
  return jsonb_build_object('ok', true, 'rows', (select count(*) from _wb), 'new', v_new, 'withdrawn', v_gone);
end $fn$;
revoke execute on function public.ingest_winback(text, text, jsonb) from public;
grant execute on function public.ingest_winback(text, text, jsonb) to anon, authenticated;

-- Edge function winback-send only (service role).
create or replace function public.winback_pending(p_product text, p_campaign text default 'winback-1')
returns table (token text, email text) language sql stable security definer set search_path = '' as $fn$
  select r.token, r.email from private.winback_recipients r
  where r.product_id = p_product and r.campaign = p_campaign and r.active and r.sent_at is null order by r.off_at
$fn$;
create or replace function public.winback_mark_sent(p_token text)
returns void language sql security definer set search_path = '' as $fn$
  update private.winback_recipients set sent_at = now() where token = p_token
$fn$;

-- Edge function winback-feedback only (service role): saves what the person answered; null = leave as it was.
create or replace function public.winback_answer(p_token text, p_reason text, p_comeback text, p_comment text)
returns text language plpgsql security definer set search_path = '' as $fn$
declare v_product text;
begin
  select r.product_id into v_product from private.winback_recipients r where r.token = p_token;
  if v_product is null then return null; end if;
  insert into private.winback_responses as t (token, reason, comeback, comment)
  values (p_token, p_reason, p_comeback, left(p_comment, 2000))
  on conflict (token) do update set reason = coalesce(excluded.reason, t.reason), comeback = coalesce(excluded.comeback, t.comeback),
    comment = case when p_comment is null then t.comment else excluded.comment end, updated_at = now();
  return v_product;
end $fn$;

-- Edge function alerts only (service role): answers given or changed in the last 2 days, settled for 5 minutes.
create or replace function public.winback_recent_answers()
returns table (product_id text, k text, updated_at timestamptz, reason text, comeback text, comment text, is_test boolean)
language sql stable security definer set search_path = '' as $fn$
  select r.product_id, left(md5(a.token), 10), a.updated_at, a.reason, a.comeback, a.comment, r.campaign like 'test%'
  from private.winback_responses a join private.winback_recipients r on r.token = a.token
  where a.updated_at > now() - interval '2 days' and a.updated_at < now() - interval '5 minutes'
  order by a.updated_at
$fn$;

revoke execute on function public.winback_pending(text, text), public.winback_mark_sent(text),
  public.winback_answer(text, text, text, text), public.winback_recent_answers() from public, anon, authenticated;

-- 退訂紀錄 page: who was written to and what they answered. Never the email or the token.
create or replace function public.winback_board()
returns table (product_id text, campaign text, account text, platform text, off_at timestamptz, active boolean,
  sent_at timestamptz, reason text, comeback text, comment text, answered_at timestamptz)
language plpgsql stable security definer set search_path = '' as $fn$
begin
  if not private.can_read() then raise exception 'not allowed' using errcode = '42501'; end if;
  return query
    select r.product_id, r.campaign, r.account, r.platform, r.off_at, r.active, r.sent_at, a.reason, a.comeback, a.comment, a.updated_at
    from private.winback_recipients r left join private.winback_responses a on a.token = r.token
    order by coalesce(a.updated_at, r.sent_at, r.off_at) desc nulls last;
end $fn$;
revoke execute on function public.winback_board() from public, anon;
grant execute on function public.winback_board() to authenticated;
