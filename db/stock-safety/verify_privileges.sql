-- READ-ONLY verification of the privilege state after migration 001. Run in the Supabase SQL editor on a disposable branch/copy
-- (it was run on the local PostgreSQL test server only — NOT yet on Supabase). Every row must show ok = true.
with
tbl as (select unnest(array['stock_control','stock_control_log','stock_cutover_snapshot','stock_legacy_writes','app_stock_approvers','stock_balances','stock_operations','stock_movements','stock_exceptions','stock_discrepancies','app_stock_counters','stock_discrepancy_events']) t),
roles as (select unnest(array['anon','authenticated','service_role']) r),
checks as (
  select format('%s has NO write privilege on %s', r, t) as what, true as expected,
         not (has_table_privilege(r, 'public.'||t, 'insert') or has_table_privilege(r, 'public.'||t, 'update') or has_table_privilege(r, 'public.'||t, 'delete') or has_table_privilege(r, 'public.'||t, 'truncate')) as actual
    from tbl, roles
  union all select format('anon cannot SELECT %s', t), true, not has_table_privilege('anon', 'public.'||t, 'select') from tbl
  union all select format('authenticated holds the SELECT "door" on %s (the ROWS are decided by the policies checked below)', t), true, has_table_privilege('authenticated', 'public.'||t, 'select') from tbl
  union all select format('service_role cannot SELECT %s', t), true, not has_table_privilege('service_role', 'public.'||t, 'select') from tbl
  union all select format('the admin role %s can SELECT %s (investigation) but not write it', current_user, t), true, has_table_privilege(current_user, 'public.'||t, 'select') from tbl
  union all select format('RLS enabled+forced on %s', t), true, (select relrowsecurity and relforcerowsecurity from pg_class where oid = ('public.'||t)::regclass) from tbl
  union all select format('%s owned by stock_owner', t), true, (select pg_get_userbyid(relowner) = 'stock_owner' from pg_class where oid = ('public.'||t)::regclass) from tbl
  union all select 'the exact set of read policies for `authenticated` is the documented one', true,
         (select string_agg(tablename || ':' || policyname, ',' order by tablename) from pg_policies where schemaname = 'public' and 'authenticated' = any(roles) and tablename in (select t from tbl))
         = 'app_stock_approvers:read_self_or_approver,app_stock_counters:read_self_or_approver,stock_balances:read_all,stock_control:read_approver,stock_control_log:read_approver,stock_cutover_snapshot:read_approver,stock_discrepancies:read_approver,stock_discrepancy_events:read_approver,stock_exceptions:read_own_or_approver,stock_legacy_writes:read_approver,stock_movements:read_own_or_approver,stock_operations:read_own_or_approver'
  union all select 'only stock_balances has an "always true" read policy for authenticated', true,
         (select coalesce(string_agg(tablename, ','), '') from pg_policies where schemaname = 'public' and 'authenticated' = any(roles) and qual = 'true' and tablename in (select t from tbl)) = 'stock_balances'
  union all select 'authenticated can execute exactly 15 stock functions (8 API + 6 guard helpers + stock_me_approver)', true,
         (select count(*) = 15 from pg_proc p where p.proowner = 'stock_owner'::regrole and has_function_privilege('authenticated', p.oid, 'execute'))
  union all select 'stock_owner: NOLOGIN, not superuser, no BYPASSRLS', true, (select not rolcanlogin and not rolsuper and not rolbypassrls from pg_roles where rolname = 'stock_owner')
  union all select 'no API role is a member of stock_owner', true, not exists (select 1 from unnest(array['anon','authenticated','service_role','authenticator']) x where pg_has_role(x, 'stock_owner', 'member'))
  union all select 'the migrating admin role has no USABLE membership of stock_owner', true, not pg_has_role(current_user, 'stock_owner', 'usage')
  union all select 'no stock function executable by PUBLIC', true, not exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where p.proowner = 'stock_owner'::regrole and a.grantee = 0 and a.privilege_type = 'EXECUTE')
  union all select 'anon can execute no stock function', true, not exists (select 1 from pg_proc p where p.proowner = 'stock_owner'::regrole and has_function_privilege('anon', p.oid, 'execute'))
  union all select 'anon has no USAGE on schema stock_internal', true, not has_schema_privilege('anon', 'stock_internal', 'usage')
  union all select 'authenticated/service_role cannot execute any stock_admin_* function', true, not exists (select 1 from pg_proc p where p.proname like 'stock\_admin\_%' and (has_function_privilege('authenticated', p.oid, 'execute') or has_function_privilege('service_role', p.oid, 'execute') or has_function_privilege('anon', p.oid, 'execute')))
  union all select 'every stock function is owned by stock_owner', true, not exists (select 1 from pg_proc p where p.pronamespace in ('public'::regnamespace, 'stock_internal'::regnamespace) and (p.proname like 'stock\_%' or p.proname = 'records_stock_guard') and p.proowner <> 'stock_owner'::regrole)
  union all select 'stock_owner has no CREATE on public or stock_internal', true, not (has_schema_privilege('stock_owner', 'public', 'create') or has_schema_privilege('stock_owner', 'stock_internal', 'create'))
  union all select 'guard trigger exists on records, enabled, fires BEFORE INSERT OR UPDATE', true,
         exists (select 1 from pg_trigger where tgrelid = 'public.records'::regclass and tgname = 'zz_records_stock_guard' and tgenabled = 'O' and (tgtype & 2) = 2 and (tgtype & 4) = 4 and (tgtype & 16) = 16)
  union all select 'append-only triggers present on the 5 ledger tables (row + truncate)', true, (select count(*) = 10 from pg_trigger where tgname like 'append\_only%')
  union all select 'enforcement mode is a known value', true, (stock_internal.stock_mode() in ('off','transition','ignore','reject'))
)
select what, expected, actual, (expected = actual) as ok from checks
union all select '== ALL CHECKS OK ==', true, bool_and(expected = actual), bool_and(expected = actual) from checks
order by 4, 1;
-- informational (read and compare by eye): who else has default privileges that could re-open grants on new objects
-- select defaclrole::regrole, defaclnamespace::regnamespace, defaclobjtype, defaclacl from pg_default_acl;
