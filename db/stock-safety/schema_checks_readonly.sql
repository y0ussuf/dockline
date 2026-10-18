-- Dockline stock safety — READ-ONLY schema inspection (ONE statement, SELECT only).
-- Paste it into the Supabase SQL editor of the project you want inspected and run it. It returns ONE table: check_no | what | result.
-- It changes nothing: no INSERT/UPDATE/DELETE/DDL/GRANT, no function calls other than catalog look-ups, no reads of any record's `data`
-- (only COUNTS and TYPES of it), and it never touches auth.users or any secret. Send back the result as text/CSV (see the review notes).
with
me as (select * from pg_roles where rolname = current_user),
rec as (select c.oid, c.relowner, c.relrowsecurity, c.relforcerowsecurity, c.relkind from pg_class c where c.oid = to_regclass('public.records')),
items as (
  select '0.01' as no, 'version' as what, jsonb_build_object('version', version(), 'server_version_num', current_setting('server_version_num')) as result
  union all select '0.02', 'who am I (the role that would run 001)',
         (select jsonb_build_object('current_user', current_user, 'session_user', session_user, 'superuser', rolsuper, 'createrole', rolcreaterole, 'createdb', rolcreatedb, 'bypassrls', rolbypassrls, 'inherit', rolinherit) from me)
  union all select '0.03', 'roles that matter (existence + attributes)',
         (select coalesce(jsonb_agg(jsonb_build_object('role', rolname, 'login', rolcanlogin, 'super', rolsuper, 'bypassrls', rolbypassrls, 'createrole', rolcreaterole) order by rolname), '[]')
            from pg_roles where rolname in ('anon','authenticated','service_role','authenticator','postgres','supabase_admin','stock_owner'))
  union all select '0.04', 'which schemas the API exposes (PostgREST setting on the authenticator role)',
         (select coalesce(jsonb_agg(jsonb_build_object('role', rolname, 'config', rolconfig)), '[]') from pg_roles where rolname = 'authenticator')
  union all select '0.05', 'public.records: columns',
         (select coalesce(jsonb_agg(jsonb_build_object('column', column_name, 'type', data_type, 'nullable', is_nullable, 'default', column_default) order by ordinal_position), '[]')
            from information_schema.columns where table_schema = 'public' and table_name = 'records')
  union all select '0.06', 'public.records: constraints and indexes',
         jsonb_build_object('constraints', (select coalesce(jsonb_agg(jsonb_build_object('name', conname, 'def', pg_get_constraintdef(oid))), '[]') from pg_constraint where conrelid = to_regclass('public.records')),
                            'indexes', (select coalesce(jsonb_agg(indexdef), '[]') from pg_indexes where schemaname = 'public' and tablename = 'records'))
  union all select '0.07', 'public.records: owner, kind, row-level-security flags; owner of schema public',
         (select jsonb_build_object('owner', relowner::regrole::text, 'relkind', relkind, 'rls_enabled', relrowsecurity, 'rls_forced', relforcerowsecurity,
                 'schema_public_owner', (select nspowner::regrole::text from pg_namespace where nspname = 'public')) from rec)
  union all select '0.08', 'public.records: RLS policies',
         (select coalesce(jsonb_agg(jsonb_build_object('policy', policyname, 'cmd', cmd, 'roles', roles, 'using', qual, 'with_check', with_check)), '[]') from pg_policies where schemaname = 'public' and tablename = 'records')
  union all select '0.09', 'public.records: triggers (names + definitions)',
         (select coalesce(jsonb_agg(jsonb_build_object('name', tgname, 'enabled', tgenabled, 'def', pg_get_triggerdef(oid))), '[]') from pg_trigger where tgrelid = to_regclass('public.records') and not tgisinternal)
  union all select '0.10', 'public.records: who holds which table privilege',
         (select coalesce(jsonb_agg(jsonb_build_object('grantee', case a.grantee when 0 then 'PUBLIC' else a.grantee::regrole::text end, 'privilege', a.privilege_type) order by 1), '[]')
            from rec, aclexplode(coalesce((select relacl from pg_class where oid = rec.oid), acldefault('r', rec.relowner))) a)
  union all select '0.11', 'default privileges (explains why 001 revokes explicitly)',
         (select coalesce(jsonb_agg(jsonb_build_object('for_role', defaclrole::regrole::text, 'schema', defaclnamespace::regnamespace::text, 'objtype', defaclobjtype, 'acl', defaclacl::text)), '[]') from pg_default_acl)
  union all select '0.12', 'already-existing stock objects (must all be empty before the migration)',
         jsonb_build_object('tables', (select coalesce(jsonb_agg(relname), '[]') from pg_class where relnamespace = 'public'::regnamespace and (relname like 'stock\_%' or relname like 'app\_stock\_%')),
                            'functions', (select coalesce(jsonb_agg(p.oid::regprocedure::text), '[]') from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like 'stock\_%'),
                            'schema_stock_internal', exists (select 1 from pg_namespace where nspname = 'stock_internal'),
                            'trigger_zz_records_stock_guard', exists (select 1 from pg_trigger where tgname = 'zz_records_stock_guard'))
  union all select '0.13', 'auth helper functions the migration relies on (existence + owner only)',
         (select coalesce(jsonb_agg(jsonb_build_object('fn', p.oid::regprocedure::text, 'owner', p.proowner::regrole::text, 'security_definer', p.prosecdef)), '[]')
            from pg_proc p where p.pronamespace = 'auth'::regnamespace and p.proname in ('uid','jwt','role'))
  union all select '0.14', 'installed extensions', (select coalesce(jsonb_agg(extname order by extname), '[]') from pg_extension)
  union all select '0.15', 'event triggers (could interfere with DDL)', (select coalesce(jsonb_agg(jsonb_build_object('name', evtname, 'event', evtevent, 'enabled', evtenabled)), '[]') from pg_event_trigger)
  union all select '0.16', 'publications that include public.records (Realtime / replication)',
         (select coalesce(jsonb_agg(pubname), '[]') from pg_publication_tables where schemaname = 'public' and tablename = 'records')
  union all select '0.17', 'other tables in schema public (names, owner, RLS flag only)',
         (select coalesce(jsonb_agg(jsonb_build_object('table', relname, 'owner', relowner::regrole::text, 'rls', relrowsecurity) order by relname), '[]') from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r')
  union all select '0.18', 'data shape of public.records — COUNTS ONLY, no values',
         (select jsonb_build_object('rows_by_store_and_deleted', (select coalesce(jsonb_agg(jsonb_build_object('store', store, 'deleted', deleted, 'n', n) order by store, deleted), '[]') from (select store, deleted, count(*) n from public.records group by 1, 2) s),
                 'products_total', count(*) filter (where store = 'products' and not deleted),
                 'stockQty_json_types', (select coalesce(jsonb_object_agg(t, n), '{}') from (select coalesce(jsonb_typeof(data -> 'stockQty'), 'missing') t, count(*) n from public.records where store = 'products' and not deleted group by 1) x),
                 'stockQty_numbers_with_more_than_4_decimals', count(*) filter (where store = 'products' and not deleted and jsonb_typeof(data -> 'stockQty') = 'number' and (data ->> 'stockQty') ~ '\.\d{5,}'),
                 'stockQty_text_not_numeric_nor_empty', count(*) filter (where store = 'products' and not deleted and jsonb_typeof(data -> 'stockQty') = 'string' and (data ->> 'stockQty') <> '' and (data ->> 'stockQty') !~ '^\s*-?\d+(\.\d+)?\s*$'),
                 'products_without_unit_field', count(*) filter (where store = 'products' and not deleted and coalesce(data ->> 'unit', '') = ''),
                 'latest_update', max(updated_at))
            from public.records)
)
select no as check_no, what, result from items order by no;
