-- Workstation project. A bug marked 已解決 (by hand, by Sentry, or by sentry-sync once the fix shipped) leaves the
-- Bug 追蹤 list: it moves to collection 'solved' (same id, plus solvedAt), which the website doesn't show.
-- sentry-sync reads 'solved' so it doesn't add the same Sentry issue again, and brings it back as 待處理, with its
-- history, if it happens after it was solved. To bring one back by hand:
--   insert into docs (collection, id, data) select 'issues', id, (data - 'solvedAt') || '{"status":"new"}' from docs where collection = 'solved' and id = '<id>';
--   delete from docs where collection = 'solved' and id = '<id>';
alter table public.docs drop constraint docs_collection_check;
alter table public.docs add constraint docs_collection_check check (collection = any (array['cfg', 'products', 'issues', 'events', 'solved']));

create or replace function private.move_solved_bug() returns trigger
language plpgsql security definer set search_path = '' as $fn$
begin
  if new.collection = 'issues' and new.data->>'type' = 'bug' and new.data->>'status' = 'done' then
    insert into public.docs (collection, id, data, updated_at, updated_by)
    values ('solved', new.id, new.data || jsonb_build_object('solvedAt', (extract(epoch from now()) * 1000)::bigint), now(), new.updated_by)
    on conflict (collection, id) do update set data = excluded.data, updated_at = now(), updated_by = excluded.updated_by;
    delete from public.docs where collection = 'issues' and id = new.id;
  end if;
  return null;
end $fn$;
revoke execute on function private.move_solved_bug() from public, anon, authenticated;
create trigger move_solved_bug after insert or update on public.docs
  for each row when (new.collection = 'issues' and new.data->>'status' = 'done') execute function private.move_solved_bug();
