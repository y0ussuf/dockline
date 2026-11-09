-- EMERGENCY WAY BACK for r01 (draft, not applied). Removes the role rules and restores "any signed-in account can read and write".
-- It deliberately does NOT bring back the open "anon" access. If you really need that for a moment, uncomment the last block, and remove it again afterwards.
begin;
do $$ declare pol record; begin
  for pol in select policyname from pg_policies where schemaname = 'public' and tablename = 'records' loop
    execute format('drop policy %I on public.records', pol.policyname);
  end loop;
end $$;
drop trigger if exists records_activity_immutable on public.records;
drop schema if exists app_auth cascade;
create policy "logged in can read"   on public.records for select to authenticated using (true);
create policy "logged in can write"  on public.records for insert to authenticated with check (true);
create policy "logged in can update" on public.records for update to authenticated using (true) with check (true);
-- create policy "anon full access" on public.records for all to public using (true) with check (true);   -- only if truly needed, then remove again
commit;
