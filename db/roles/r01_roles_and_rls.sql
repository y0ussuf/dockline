-- DRAFT FOR REVIEW — NOT APPLIED ANYWHERE. Read README.md first. Run on a Supabase test branch before production.
-- What it does: makes the database enforce the same permissions the app hides/shows (see js/26-roles.js).
--   * who may READ / INSERT / UPDATE / soft-DELETE each kind of record in public.records, by permission
--   * the Activity log (store 'activity') can be added to by anyone with a role, read by "activity.view", never altered
--   * roles (store 'roles') can only be changed by an admin
-- The account's role comes from the JWT (app_metadata.role = 'admin', or app_metadata.role_id = <id of a 'roles' record>).
-- It is additive except step 0, which removes the two old blanket policies (see README: do step 0 only after the API-log check).

begin;

-- 0. the old blanket policies (names as found by the read-only schema check of 2026-10-18)
drop policy if exists "anon full access" on public.records;
drop policy if exists "logged in can read"   on public.records;
drop policy if exists "logged in can write"  on public.records;
drop policy if exists "logged in can update" on public.records;
drop policy if exists crew_all on public.records;          -- only exists in the test stub

-- 1. helpers live in a schema the API does not expose
create schema if not exists app_auth;
revoke all on schema app_auth from public;
grant usage on schema app_auth to authenticated;

-- permissions of the signed-in account: '*' for an admin; the role's list otherwise
create or replace function app_auth.my_perms() returns text[]
language plpgsql stable security definer set search_path = pg_catalog, public as $$
declare meta jsonb := coalesce(auth.jwt() -> 'app_metadata', '{}'::jsonb); rid text; p jsonb;
begin
  if auth.uid() is null then return '{}'; end if;
  if meta ->> 'role' = 'admin' then return array['*']; end if;
  rid := nullif(meta ->> 'role_id', '');
  if rid is null then   -- accounts made before roles existed keep what staff could do (no settings, no backup)
    return array['products.view','products.edit','products.delete','stock.view','stock.edit','receiving','merge','move','warehouses.edit',
      'suppliers.view','suppliers.edit','orders.view','orders.create','orders.pick','orders.delete','splitter','qcheck',
      'prices.view','prices.edit','invoices.view','invoices.edit','invoices.issue','invoices.delete','reports.view','history.view','activity.view'];
  end if;
  select data -> 'perms' into p from public.records where store = 'roles' and id = rid and not deleted;
  if p is null or jsonb_typeof(p) <> 'array' then return '{}'; end if;
  return array(select jsonb_array_elements_text(p));
end $$;

create or replace function app_auth.can_any(perms text[]) returns boolean
language sql stable security definer set search_path = pg_catalog, public as $$
  select app_auth.my_perms() && (array['*'] || perms) $$;

-- which permission lets you read / write / delete each store (any one of the listed is enough)
create or replace function app_auth.read_perms(s text) returns text[] language sql immutable as $$
  select case s
    when 'products'          then array['products.view','stock.view','orders.view','orders.create','orders.pick','receiving','splitter','qcheck','invoices.view','invoices.edit','move','merge','prices.view','reports.view','products.edit']
    when 'mappings'          then array['products.view','orders.view','orders.create','orders.pick','splitter','qcheck','merge','products.edit']
    when 'orders'            then array['orders.view','orders.create','orders.pick','splitter','qcheck','invoices.view','invoices.edit','reports.view']
    when 'orderItems'        then array['orders.view','orders.create','orders.pick','splitter','qcheck','invoices.view','invoices.edit','reports.view']
    when 'suppliers'         then array['suppliers.view','suppliers.edit','products.view','receiving','orders.create','invoices.view']
    when 'warehouses'        then array['products.view','stock.view','orders.pick','orders.create','receiving','move','warehouses.edit','splitter','reports.view']
    when 'sections'          then array['products.view','stock.view','orders.pick','orders.create','receiving','move','warehouses.edit','splitter','reports.view']
    when 'boxReceipts'       then array['receiving','stock.view','reports.view','products.view']
    when 'boxTypes'          then array['receiving','stock.view','reports.view','products.view','orders.pick']
    when 'productReceipts'   then array['receiving','stock.view','reports.view','products.view']
    when 'receivingInvoices' then array['receiving','stock.view','reports.view','products.view']
    when 'batches'           then array['receiving','stock.view','reports.view','products.view','orders.pick']
    when 'invoices'          then array['invoices.view','invoices.edit','invoices.issue']
    when 'sharedSettings'    then array['products.view','stock.view','orders.view','orders.create','orders.pick','receiving','splitter','qcheck','merge','move','invoices.view','invoices.edit','prices.view','reports.view','settings.edit']
    when 'historyOrders'     then array['history.view','reports.view']
    when 'historyLines'      then array['history.view','reports.view']
    when 'productPrices'     then array['prices.view']
    when 'activity'          then array['activity.view']
    when 'roles'             then array['products.view','stock.view','orders.view','orders.create','orders.pick','receiving','splitter','qcheck','merge','move','suppliers.view','invoices.view','prices.view','reports.view','history.view','activity.view','settings.edit']  -- everyone reads the role list (needed to resolve their own)
    else array[]::text[] end $$;

create or replace function app_auth.write_perms(s text) returns text[] language sql immutable as $$
  select case s
    when 'products'          then array['products.edit','stock.edit','prices.edit','orders.pick','orders.create','receiving','move','merge']
    when 'mappings'          then array['products.edit','orders.create','orders.pick','splitter','qcheck','merge']
    when 'orders'            then array['orders.create','orders.pick','splitter','qcheck','invoices.edit']
    when 'orderItems'        then array['orders.create','orders.pick','splitter','qcheck','invoices.edit']
    when 'suppliers'         then array['suppliers.edit','products.edit','receiving']
    when 'warehouses'        then array['warehouses.edit']
    when 'sections'          then array['warehouses.edit','move']
    when 'boxReceipts'       then array['receiving','stock.edit']
    when 'boxTypes'          then array['receiving']
    when 'productReceipts'   then array['receiving','stock.edit']
    when 'receivingInvoices' then array['receiving']
    when 'batches'           then array['receiving','stock.edit','orders.pick']
    when 'invoices'          then array['invoices.edit','invoices.issue']
    when 'sharedSettings'    then array['settings.edit','merge','move','products.edit','stock.edit','prices.edit','invoices.edit','orders.create','receiving']
    when 'historyOrders'     then array['reports.view','settings.edit']
    when 'historyLines'      then array['reports.view','settings.edit']
    when 'productPrices'     then array['prices.edit']
    when 'activity'          then array['activity.view','products.view','stock.view','orders.view','orders.create','orders.pick','receiving','splitter','qcheck','merge','move','suppliers.view','invoices.view','prices.view','reports.view','history.view','settings.edit']  -- anyone with a role may add log lines
    when 'roles'             then array[]::text[]   -- admin only ('*' is always allowed)
    else array[]::text[] end $$;

-- marking a record deleted needs more than editing it: the *.delete permissions where the app has them
create or replace function app_auth.delete_perms(s text) returns text[] language sql immutable as $$
  select case s
    when 'products' then array['products.delete']
    when 'orders'   then array['orders.delete']
    when 'orderItems' then array['orders.delete','orders.create','orders.pick','splitter']   -- picking/splitting rewrites lines
    when 'invoices' then array['invoices.delete','invoices.edit']                              -- drafts can be discarded by editors; issued ones are protected in the app
    when 'roles' then array[]::text[]
    when 'activity' then array[]::text[]
    else app_auth.write_perms(s) end $$;

revoke all on all functions in schema app_auth from public;
grant execute on all functions in schema app_auth to authenticated;

-- 2. the policies (one per command; RLS stays enabled, not forced)
alter table public.records enable row level security;

-- Note: the app saves with an upsert (INSERT … ON CONFLICT DO UPDATE), and Postgres requires the existing row to be visible for that.
-- So anyone who may WRITE a kind of record can also see it — except the activity log, where people see only their own lines unless they have activity.view.
create policy records_select on public.records for select to authenticated
  using ( case when store = 'activity'
               then app_auth.can_any(app_auth.read_perms(store)) or (data ->> 'email') = (auth.jwt() ->> 'email')
               else app_auth.can_any(app_auth.read_perms(store) || app_auth.write_perms(store)) end );

create policy records_insert on public.records for insert to authenticated
  with check ( app_auth.can_any(app_auth.write_perms(store)) and (not deleted or app_auth.can_any(app_auth.delete_perms(store))) );

create policy records_update on public.records for update to authenticated
  using      ( app_auth.can_any(app_auth.write_perms(store)) )
  with check ( app_auth.can_any(app_auth.write_perms(store)) and (not deleted or app_auth.can_any(app_auth.delete_perms(store))) );

create policy records_hard_delete on public.records for delete to authenticated
  using ( (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin' );

-- 3. the activity log can be added to but never rewritten: a non-admin may only re-send an identical row (an interrupted sync retry)
create or replace function app_auth.activity_immutable() returns trigger language plpgsql as $$
begin
  if (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin' then return new; end if;
  if old.store = 'activity' and (new.data is distinct from old.data or new.deleted is distinct from old.deleted or new.store <> old.store) then
    raise exception 'The activity log cannot be changed' using errcode = '42501';
  end if;
  return new;
end $$;
drop trigger if exists records_activity_immutable on public.records;
create trigger records_activity_immutable before update on public.records for each row execute function app_auth.activity_immutable();

commit;
