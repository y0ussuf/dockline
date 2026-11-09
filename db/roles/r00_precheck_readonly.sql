-- READ-ONLY. Safe to run in the Supabase SQL editor: it only LOOKS, it changes nothing. Shows the rules currently protecting `records`.
select policyname, roles, cmd, qual as using_condition, with_check
from pg_policies where schemaname = 'public' and tablename = 'records' order by policyname;

select relrowsecurity as rls_on, relforcerowsecurity as rls_forced from pg_class where oid = 'public.records'::regclass;
select store, count(*) filter (where not deleted) as live_rows from public.records group by store order by store;
