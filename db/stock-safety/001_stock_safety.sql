-- =============================================================================
-- Dockline stock safety — migration 001 (FOR REVIEW — NOT APPLIED ANYWHERE)
--
-- Adds an authoritative, server-side stock ledger and the only functions allowed to change it.
-- ADDITIVE ONLY: creates new objects, never drops/alters existing data. The enforcement trigger on
-- "records" is created in mode 'off' (does nothing) and is switched on later, as a separate step.
--
-- ASSUMPTION (to be verified against your real schema before this is approved): a table
--   public.records(store text, id text, data jsonb, deleted boolean, updated_at timestamptz,
--                  updated_by text, primary key (store, id))
-- as the app's sync code uses it. Anything that differs must be adapted before approval.
-- =============================================================================
begin;

-- 1. The role that owns every stock object. NOLOGIN: nobody can connect as it or SET ROLE to it
--    unless explicitly granted membership (only the migrating admin role is, below).
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'stock_owner') then
    create role stock_owner nologin;
  end if;
end $$;
grant stock_owner to current_user;           -- lets the migrating role assign ownership
grant usage on schema auth to stock_owner;   -- trusted functions call auth.uid()/auth.jwt()
grant usage, create on schema public to stock_owner;  -- CREATE only needed while ownership is transferred; revoked at the end

-- 2. Control row: enforcement mode, freeze switch, minimum app version
create table public.stock_control (
  id                 boolean primary key default true check (id),
  mode               text not null default 'off' check (mode in ('off','ignore','reject')),
  min_client_version text not null default '',
  frozen             boolean not null default false,
  frozen_reason      text,
  cutover_at         timestamptz,
  rolled_back_at     timestamptz,
  updated_at         timestamptz not null default now()
);
insert into public.stock_control default values;

-- 3. People allowed to approve openings, adjustments and negative-stock overrides
create table public.app_stock_approvers (
  user_id  uuid primary key,
  email    text,
  added_at timestamptz not null default now(),
  note     text
);

-- 4. Authoritative balances (one row per tracked product)
create table public.stock_balances (
  product_id         text primary key,
  unit               text not null,
  qty                numeric not null,
  tracked            boolean not null default true,
  opening_movement_id bigint,
  opening_qty        numeric,
  opening_basis      text check (opening_basis in ('physical_count','accepted_unverified','derived')),
  opening_at         timestamptz,
  opening_by         uuid,
  last_verified_at   timestamptz,          -- last physical count
  version            bigint not null default 1,
  updated_at         timestamptz not null default clock_timestamp()
);

-- 5. Operations (idempotency + audit of what was asked and what happened)
create table public.stock_operations (
  op_id        uuid primary key,
  kind         text not null check (kind in ('pick','receipt','receipt_reversal','mapping_move','count','opening','adjustment','untrack')),
  class        text not null check (class in ('fact','correction','count','admin')),
  request_hash text not null,
  status       text not null check (status in ('processing','applied','applied_with_exceptions','rejected')),
  result       jsonb,
  payload      jsonb not null,
  applied_count int not null default 0,
  actor        uuid not null,
  actor_email  text,
  order_id     text,
  device_id    text,
  client_at    timestamptz,
  created_at   timestamptz not null default clock_timestamp()
);

-- 6. Movements: the append-only ledger
create table public.stock_movements (
  id           bigint generated always as identity primary key,
  op_id        uuid not null references public.stock_operations(op_id),
  line_no      int  not null,
  kind         text not null,
  product_id   text not null,
  delta        numeric not null,
  qty_before   numeric not null,
  qty_after    numeric not null,
  unit         text,
  order_id     text,
  item_id      text,
  ref          text,
  proof        text not null check (proof in ('recorded','reconstructed','physical_count','accepted_unverified','derived','adjustment')),
  override     boolean not null default false,
  override_reason text,
  actor        uuid not null,
  actor_email  text,
  device_id    text,
  client_at    timestamptz,
  note         text,
  created_at   timestamptz not null default clock_timestamp(),
  unique (op_id, line_no)
);
create index stock_movements_product_idx on public.stock_movements(product_id, id);
create index stock_movements_order_idx   on public.stock_movements(order_id, item_id);

-- 7. Lines of "fact" operations that could not be applied (never silently dropped)
create table public.stock_exceptions (
  id          bigint generated always as identity primary key,
  op_id       uuid not null references public.stock_operations(op_id),
  line_no     int not null,
  product_id  text,
  code        text not null,
  detail      jsonb,
  created_at  timestamptz not null default clock_timestamp(),
  resolved_at timestamptz, resolved_by uuid, resolution_note text
);

-- 8. Findings from reconciliation (recording a finding never touches a balance)
create table public.stock_discrepancies (
  id            bigint generated always as identity primary key,
  key           text not null unique,
  check_code    text not null,
  product_id    text,
  severity      text not null,
  detail        jsonb,
  first_seen_at timestamptz not null default clock_timestamp(),
  last_seen_at  timestamptz not null default clock_timestamp(),
  resolved_at   timestamptz, resolved_by uuid, resolution_note text
);

-- 9. Ownership
alter table public.stock_control        owner to stock_owner;
alter table public.app_stock_approvers  owner to stock_owner;
alter table public.stock_balances       owner to stock_owner;
alter table public.stock_operations     owner to stock_owner;
alter table public.stock_movements      owner to stock_owner;
alter table public.stock_exceptions     owner to stock_owner;
alter table public.stock_discrepancies  owner to stock_owner;

-- 10. Privileges: clients may READ (through RLS) and NEVER write. Supabase grants ALL to
--     anon/authenticated/service_role on new public tables by default — remove it explicitly.
revoke all on public.stock_control, public.app_stock_approvers, public.stock_balances, public.stock_operations,
              public.stock_movements, public.stock_exceptions, public.stock_discrepancies
  from public, anon, authenticated, service_role;
grant select on public.stock_control, public.stock_balances, public.stock_operations, public.stock_movements,
                public.stock_exceptions, public.stock_discrepancies to authenticated;
grant select on public.app_stock_approvers to authenticated;
-- the owner role needs to write the mirror in "records"
grant select, insert, update on public.records to stock_owner;

alter table public.stock_control        enable row level security;
alter table public.app_stock_approvers  enable row level security;
alter table public.stock_balances       enable row level security;
alter table public.stock_operations     enable row level security;
alter table public.stock_movements      enable row level security;
alter table public.stock_exceptions     enable row level security;
alter table public.stock_discrepancies  enable row level security;
alter table public.stock_control        force row level security;  -- owner is bound by RLS too, so each table needs an owner policy
alter table public.app_stock_approvers  force row level security;
alter table public.stock_balances       force row level security;
alter table public.stock_operations     force row level security;
alter table public.stock_movements      force row level security;
alter table public.stock_exceptions     force row level security;
alter table public.stock_discrepancies  force row level security;

create policy read_all on public.stock_control       for select to authenticated using (true);
create policy read_all on public.stock_balances      for select to authenticated using (true);
create policy read_all on public.stock_operations    for select to authenticated using (true);
create policy read_all on public.stock_movements     for select to authenticated using (true);
create policy read_all on public.stock_exceptions    for select to authenticated using (true);
create policy read_all on public.stock_discrepancies for select to authenticated using (true);
create policy read_self on public.app_stock_approvers for select to authenticated using (user_id = auth.uid());
-- owner (the trusted functions) may do everything; nobody else has any write policy at all
create policy owner_all on public.stock_control       to stock_owner using (true) with check (true);
create policy owner_all on public.app_stock_approvers to stock_owner using (true) with check (true);
create policy owner_all on public.stock_balances      to stock_owner using (true) with check (true);
create policy owner_all on public.stock_operations    to stock_owner using (true) with check (true);
create policy owner_all on public.stock_movements     to stock_owner using (true) with check (true);
create policy owner_all on public.stock_exceptions    to stock_owner using (true) with check (true);
create policy owner_all on public.stock_discrepancies to stock_owner using (true) with check (true);
-- if "records" has RLS on, the owner role needs to be able to write the mirror
do $$ begin
  if (select relrowsecurity from pg_class where oid = 'public.records'::regclass) then
    execute 'drop policy if exists stock_owner_mirror on public.records';
    execute 'create policy stock_owner_mirror on public.records for all to stock_owner using (true) with check (true)';
  end if;
end $$;

-- 11. Append-only protection (a trigger, so it holds even for the table owner; only DDL can remove it)
create function public.stock_append_only() returns trigger language plpgsql
  set search_path = pg_catalog, public as $$
begin
  if tg_table_name = 'stock_operations' and tg_op = 'UPDATE' then
    if old.status = 'processing' then return new; end if;   -- the one in-transaction finalisation of a new operation
  end if;
  raise exception 'stock: % is append-only (% refused)', tg_table_name, tg_op using errcode = '55000';
end $$;
alter function public.stock_append_only() owner to stock_owner;
create trigger append_only_mv  before update or delete on public.stock_movements   for each row execute function public.stock_append_only();
create trigger append_only_op  before update or delete on public.stock_operations  for each row execute function public.stock_append_only();
create trigger append_only_mv_t  before truncate on public.stock_movements  for each statement execute function public.stock_append_only();
create trigger append_only_op_t  before truncate on public.stock_operations for each statement execute function public.stock_append_only();

-- 12. Small trusted helpers
create function public.stock_mode() returns text language sql stable security definer
  set search_path = pg_catalog, public as $$ select mode from public.stock_control $$;
create function public.stock_auth_qty(p_id text) returns numeric language sql stable security definer
  set search_path = pg_catalog, public as
  $$ select qty from public.stock_balances where product_id = p_id and tracked $$;
create function public.stock_is_approver(p_uid uuid) returns boolean language sql stable security definer
  set search_path = pg_catalog, public as
  $$ select exists (select 1 from public.app_stock_approvers where user_id = p_uid) $$;
-- app-version gate. NOT a security boundary (a header can be forged); it only stops honest OLD apps.
create function public.stock_client_ok() returns boolean language plpgsql stable security definer
  set search_path = pg_catalog, public as $$
declare h text := current_setting('request.headers', true); ci text; m text[]; need text; mm text[];
begin
  if h is null or h = '' then return true; end if;          -- not coming through the API (admin SQL / migrations)
  ci := (h::jsonb) ->> 'x-client-info';
  select min_client_version into need from public.stock_control;
  if coalesce(need,'') = '' then return true; end if;
  m  := regexp_match(coalesce(ci,''), '^dockline/(\d{4}-\d{2}-\d{2})\.(\d+)$');
  if m is null then return false; end if;
  mm := regexp_match(need, '^(\d{4}-\d{2}-\d{2})\.(\d+)$');
  return (m[1], m[2]::int) >= (mm[1], mm[2]::int);
end $$;
alter function public.stock_mode()          owner to stock_owner;
alter function public.stock_auth_qty(text)  owner to stock_owner;
alter function public.stock_is_approver(uuid) owner to stock_owner;
alter function public.stock_client_ok()     owner to stock_owner;

-- 13. THE GUARD on "records". Runs as the invoker. The ONLY path that may change a product's stockQty is a
--     statement executed while current_user = stock_owner, i.e. inside the SECURITY DEFINER functions below.
--     current_user cannot be forged by a client: it can't SET ROLE stock_owner (no membership) and there is no
--     session variable to set. Everyone else — API clients, stale sync pushes, CSV import, backup restore,
--     the migrating admin — has stockQty overwritten with the authoritative balance.
create function public.records_stock_guard() returns trigger language plpgsql
  set search_path = pg_catalog, public as $$
declare m text; q numeric;
begin
  if current_user = 'stock_owner' then return new; end if;
  m := public.stock_mode();
  if m = 'off' then return new; end if;
  if m = 'reject' and not public.stock_client_ok() then
    raise exception 'dockline: this app version is no longer supported — please update the app' using errcode = 'P0001';
  end if;
  if new.store = 'products' and new.data is not null and jsonb_typeof(new.data) = 'object' then
    q := public.stock_auth_qty(new.id);
    if q is not null then
      new.data := jsonb_set(new.data, '{stockQty}', to_jsonb(q::float8), true);
    elsif coalesce(new.data ->> 'stockQty', '') <> '' then
      new.data := jsonb_set(new.data, '{stockQty}', '""'::jsonb, true);
    end if;
  end if;
  return new;
end $$;
alter function public.records_stock_guard() owner to stock_owner;
-- named zz_ so it fires after any other BEFORE trigger and has the last word
create trigger zz_records_stock_guard before insert or update on public.records
  for each row execute function public.records_stock_guard();

-- 14. The one function that changes stock
create function public.stock_apply(p_op jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $fn$
declare
  v_actor uuid := auth.uid();
  v_email text := nullif(auth.jwt() ->> 'email', '');
  v_frozen boolean; v_freeze_reason text;
  v_op_id uuid; v_kind text; v_class text; v_hash text;
  v_override boolean := coalesce((p_op ->> 'override')::boolean, false);
  v_oreason text := nullif(btrim(coalesce(p_op ->> 'override_reason', '')), '');
  v_note text := nullif(btrim(coalesce(p_op ->> 'note', '')), '');
  v_approver boolean;
  v_old public.stock_operations%rowtype;
  v_lines jsonb; v_n int; i int; ln jsonb;
  v_pid text; v_unit text; v_delta numeric; v_cnt numeric; v_basis text;
  v_cur jsonb := '{}'::jsonb;
  v_plan jsonb := '[]'::jsonb;
  b public.stock_balances%rowtype;
  v_before numeric; v_after numeric; v_out text; v_why text; v_neg boolean; v_proof text;
  v_rej jsonb := '[]'::jsonb; v_exc int := 0; v_applied int := 0;
  v_ids text[]; v_status text; v_result jsonb; p jsonb; v_mid bigint;
  v_order text := nullif(p_op ->> 'order_id', '');
begin
  if v_actor is null then raise exception 'stock: not authenticated' using errcode = '28000'; end if;
  select frozen, frozen_reason into v_frozen, v_freeze_reason from public.stock_control;
  if v_frozen then raise exception 'stock: stock changes are frozen (%)', coalesce(v_freeze_reason, 'maintenance') using errcode = '55000'; end if;

  begin v_op_id := (p_op ->> 'op_id')::uuid; exception when others then
    raise exception 'stock: op_id must be a uuid' using errcode = '22023'; end;
  if v_op_id is null then raise exception 'stock: op_id is required' using errcode = '22023'; end if;
  v_kind := p_op ->> 'kind';
  v_class := case v_kind when 'pick' then 'fact' when 'receipt' then 'fact'
      when 'receipt_reversal' then 'correction' when 'mapping_move' then 'correction'
      when 'count' then 'count' when 'opening' then 'admin' when 'adjustment' then 'admin' when 'untrack' then 'admin' end;
  if v_class is null then raise exception 'stock: unknown kind %', v_kind using errcode = '22023'; end if;
  v_lines := p_op -> 'lines';
  if jsonb_typeof(v_lines) is distinct from 'array' or jsonb_array_length(v_lines) = 0 or jsonb_array_length(v_lines) > 200 then
    raise exception 'stock: lines must be an array of 1..200 entries' using errcode = '22023'; end if;
  v_n := jsonb_array_length(v_lines);
  v_approver := public.stock_is_approver(v_actor);
  if v_class = 'admin' and not v_approver then
    raise exception 'stock: only a stock approver may record %', v_kind using errcode = '42501'; end if;
  v_hash := md5((p_op - 'op_id')::text);

  -- idempotency: the unique key on op_id makes a concurrent duplicate wait for the first transaction
  insert into public.stock_operations(op_id, kind, class, request_hash, status, payload, actor, actor_email, order_id, device_id, client_at)
  values (v_op_id, v_kind, v_class, v_hash, 'processing', p_op, v_actor, v_email, v_order, nullif(p_op ->> 'device_id',''),
          nullif(p_op ->> 'client_at','')::timestamptz)
  on conflict (op_id) do nothing;
  if not found then
    select * into v_old from public.stock_operations where op_id = v_op_id;
    if v_old.request_hash <> v_hash or v_old.actor <> v_actor then
      raise exception 'stock: operation id % was already used for a different request', v_op_id using errcode = '23505'; end if;
    return coalesce(v_old.result, '{}'::jsonb) || jsonb_build_object('duplicate', true);
  end if;

  -- lock every product involved, in a fixed order (all stock functions do this => no deadlocks)
  select array_agg(distinct x ->> 'product_id') into v_ids from jsonb_array_elements(v_lines) x;
  if v_ids is null or exists (select 1 from unnest(v_ids) u where u is null) then
    raise exception 'stock: every line needs a product_id' using errcode = '22023'; end if;
  perform 1 from public.stock_balances where product_id = any(v_ids) order by product_id for update;

  -- pass 1: plan every line against live balances
  for i in 1 .. v_n loop
    ln := v_lines -> (i - 1);
    v_pid := ln ->> 'product_id';
    v_unit := lower(btrim(coalesce(ln ->> 'unit', '')));
    select * into b from public.stock_balances where product_id = v_pid;
    v_out := 'apply'; v_why := null; v_delta := 0; v_proof := 'recorded'; v_neg := false;
    v_before := coalesce((v_cur ->> v_pid)::numeric, b.qty, 0);
    v_after := v_before;

    if v_kind = 'opening' then
      v_cnt := round((ln ->> 'counted_qty')::numeric, 4); v_basis := ln ->> 'basis';
      if b.product_id is not null and b.tracked then v_out := 'reject'; v_why := 'already_opened';
      elsif v_cnt is null or v_cnt < 0 or v_unit = '' or v_basis is null
            or v_basis not in ('physical_count','accepted_unverified','derived') then v_out := 'reject'; v_why := 'invalid_opening';
      elsif not exists (select 1 from public.records where store = 'products' and id = v_pid and not deleted) then
        v_out := 'reject'; v_why := 'unknown_product';
      else v_after := v_cnt; v_delta := v_cnt - v_before; v_proof := v_basis; end if;

    elsif v_kind = 'untrack' then
      if b.product_id is null or not b.tracked then v_out := 'reject'; v_why := 'not_tracked'; end if;

    elsif b.product_id is null or not b.tracked then
      if v_kind = 'count' then v_out := 'reject'; v_why := 'not_tracked';
      else v_out := 'skipped_untracked'; end if;

    elsif v_unit = '' or v_unit <> lower(btrim(b.unit)) then
      if v_class = 'fact' then v_out := 'unit_mismatch'; v_exc := v_exc + 1; v_why := format('line unit "%s" differs from stock unit "%s"', ln ->> 'unit', b.unit);
      else v_out := 'reject'; v_why := 'unit_mismatch'; end if;

    elsif v_kind = 'count' then
      v_cnt := round((ln ->> 'counted_qty')::numeric, 4);
      if v_cnt is null or v_cnt < 0 then v_out := 'reject'; v_why := 'invalid_count';
      else v_after := v_cnt; v_delta := v_cnt - v_before; v_proof := 'physical_count'; end if;

    else
      v_delta := round((ln ->> 'delta')::numeric, 4);
      if v_delta is null then raise exception 'stock: line % needs a delta', i using errcode = '22023'; end if;
      if (v_kind = 'pick' and v_delta > 0) or (v_kind in ('receipt') and v_delta < 0) or (v_kind = 'receipt_reversal' and v_delta > 0) then
        raise exception 'stock: line % has the wrong sign for %', i, v_kind using errcode = '22023'; end if;
      v_after := v_before + v_delta;
      if v_kind = 'adjustment' then
        v_proof := 'adjustment';
        if v_note is null then v_out := 'reject'; v_why := 'adjustment_needs_reason'; end if;
      elsif ln ->> 'basis' = 'reconstructed' then v_proof := 'reconstructed'; end if;
      if v_out = 'apply' and v_after < 0 then
        v_neg := true;
        if v_class <> 'fact' then
          if not v_override then v_out := 'reject'; v_why := 'negative_stock';
          elsif v_oreason is null then v_out := 'reject'; v_why := 'override_needs_reason';
          elsif not v_approver then v_out := 'reject'; v_why := 'override_not_authorized'; end if;
        end if;
      end if;
    end if;

    if v_out = 'reject' then v_rej := v_rej || jsonb_build_object('line_no', i, 'product_id', v_pid, 'code', v_why); end if;
    if v_out = 'apply' then v_cur := jsonb_set(v_cur, array[v_pid], to_jsonb(v_after)); end if;
    v_plan := v_plan || jsonb_build_object('line_no', i, 'product_id', v_pid, 'outcome', v_out, 'why', v_why,
        'qty_before', v_before, 'delta', v_delta, 'qty_after', v_after, 'unit', ln ->> 'unit', 'negative', v_neg,
        'proof', v_proof, 'item_id', ln ->> 'item_id', 'ref', ln ->> 'ref', 'ln_unit', coalesce(ln ->> 'unit', b.unit));
  end loop;

  -- corrections/counts/admin changes are all-or-nothing
  if jsonb_array_length(v_rej) > 0 then
    v_result := jsonb_build_object('op_id', v_op_id, 'status', 'rejected', 'reasons', v_rej, 'lines', v_plan, 'duplicate', false);
    update public.stock_operations set status = 'rejected', result = v_result where op_id = v_op_id;
    return v_result;
  end if;

  -- pass 2: apply
  for i in 0 .. v_n - 1 loop
    p := v_plan -> i;
    if p ->> 'outcome' = 'unit_mismatch' then
      insert into public.stock_exceptions(op_id, line_no, product_id, code, detail)
      values (v_op_id, i + 1, p ->> 'product_id', 'unit_mismatch', jsonb_build_object('reason', p ->> 'why', 'delta', p -> 'delta', 'line', v_lines -> i));
      continue;
    end if;
    if p ->> 'outcome' <> 'apply' then continue; end if;
    v_pid := p ->> 'product_id';
    insert into public.stock_movements(op_id, line_no, kind, product_id, delta, qty_before, qty_after, unit, order_id, item_id, ref,
        proof, override, override_reason, actor, actor_email, device_id, client_at, note)
    values (v_op_id, i + 1, v_kind, v_pid, (p ->> 'delta')::numeric, (p ->> 'qty_before')::numeric, (p ->> 'qty_after')::numeric,
        p ->> 'ln_unit', v_order, p ->> 'item_id', p ->> 'ref', p ->> 'proof',
        (p ->> 'negative')::boolean and v_class <> 'fact' and v_override, case when (p ->> 'negative')::boolean and v_class <> 'fact' then v_oreason end,
        v_actor, v_email, nullif(p_op ->> 'device_id',''), nullif(p_op ->> 'client_at','')::timestamptz, v_note)
    returning id into v_mid;
    if v_kind = 'opening' then
      insert into public.stock_balances(product_id, unit, qty, tracked, opening_movement_id, opening_qty, opening_basis, opening_at, opening_by, last_verified_at)
      values (v_pid, v_lines -> i ->> 'unit', (p ->> 'qty_after')::numeric, true, v_mid, (p ->> 'qty_after')::numeric,
              p ->> 'proof', clock_timestamp(), v_actor, case when p ->> 'proof' = 'physical_count' then clock_timestamp() end)
      on conflict (product_id) do update set unit = excluded.unit, qty = excluded.qty, tracked = true,
              opening_movement_id = excluded.opening_movement_id, opening_qty = excluded.opening_qty, opening_basis = excluded.opening_basis,
              opening_at = excluded.opening_at, opening_by = excluded.opening_by, last_verified_at = excluded.last_verified_at,
              version = public.stock_balances.version + 1, updated_at = clock_timestamp();
    elsif v_kind = 'untrack' then
      update public.stock_balances set tracked = false, version = version + 1, updated_at = clock_timestamp() where product_id = v_pid;
    else
      update public.stock_balances set qty = (p ->> 'qty_after')::numeric, version = version + 1, updated_at = clock_timestamp(),
             last_verified_at = case when v_kind = 'count' then clock_timestamp() else last_verified_at end
       where product_id = v_pid;
    end if;
    v_applied := v_applied + 1;
  end loop;

  -- mirror the authoritative values into "records" so every device receives them through normal sync
  perform public.stock_mirror(v_ids);

  v_status := case when v_exc > 0 then 'applied_with_exceptions' else 'applied' end;
  v_result := jsonb_build_object('op_id', v_op_id, 'status', v_status, 'lines', v_plan, 'exceptions', v_exc, 'duplicate', false);
  update public.stock_operations set status = v_status, result = v_result, applied_count = v_applied where op_id = v_op_id;
  return v_result;
end
$fn$;

create function public.stock_mirror(p_ids text[]) returns int language plpgsql security definer
  set search_path = pg_catalog, public as $$
declare n int;
begin
  update public.records r
     set data = jsonb_set(r.data, '{stockQty}', case when b.tracked then to_jsonb(b.qty::float8) else '""'::jsonb end, true),
         updated_at = clock_timestamp(), updated_by = 'stock'
    from public.stock_balances b
   where r.store = 'products' and r.id = b.product_id and r.data is not null and not r.deleted
     and (p_ids is null or b.product_id = any(p_ids));
  get diagnostics n = row_count;
  return n;
end $$;

create function public.stock_status() returns jsonb language sql stable security definer
  set search_path = pg_catalog, public as $$
  select jsonb_build_object('mode', mode, 'frozen', frozen, 'frozen_reason', frozen_reason,
         'min_client_version', min_client_version, 'cutover_at', cutover_at,
         'is_approver', public.stock_is_approver(auth.uid()), 'user_id', auth.uid())
  from public.stock_control $$;

-- Re-mirrors every authoritative balance into records (recovery / after rollback). Approver only.
create function public.stock_resync_mirror() returns int language plpgsql security definer
  set search_path = pg_catalog, public as $$
begin
  if auth.uid() is null or not public.stock_is_approver(auth.uid()) then
    raise exception 'stock: approver only' using errcode = '42501'; end if;
  return public.stock_mirror(null);
end $$;

create function public.stock_resolve_exception(p_id bigint, p_note text) returns void language plpgsql security definer
  set search_path = pg_catalog, public as $$
begin
  if auth.uid() is null or not public.stock_is_approver(auth.uid()) then raise exception 'stock: approver only' using errcode = '42501'; end if;
  if nullif(btrim(coalesce(p_note,'')),'') is null then raise exception 'stock: a note is required' using errcode = '22023'; end if;
  update public.stock_exceptions set resolved_at = now(), resolved_by = auth.uid(), resolution_note = p_note where id = p_id and resolved_at is null;
end $$;

create function public.stock_resolve_discrepancy(p_key text, p_note text) returns void language plpgsql security definer
  set search_path = pg_catalog, public as $$
begin
  if auth.uid() is null or not public.stock_is_approver(auth.uid()) then raise exception 'stock: approver only' using errcode = '42501'; end if;
  if nullif(btrim(coalesce(p_note,'')),'') is null then raise exception 'stock: a note is required' using errcode = '22023'; end if;
  insert into public.stock_discrepancies(key, check_code, severity, resolved_at, resolved_by, resolution_note)
  values (p_key, split_part(p_key, ':', 1), 'info', now(), auth.uid(), p_note)
  on conflict (key) do update set resolved_at = now(), resolved_by = auth.uid(), resolution_note = p_note;
end $$;

-- 15. Reconciliation: READ-ONLY. It reports; it never changes a balance, movement or mirror.
create function public.stock_reconcile() returns table(product_id text, check_code text, severity text, detail jsonb, key text, acknowledged boolean)
language sql stable security definer set search_path = pg_catalog, public as $$
  with mv as (
    select m.*, lag(qty_after) over (partition by m.product_id order by m.id) prev_after,
           row_number() over (partition by m.product_id order by m.id) rn
      from public.stock_movements m),
  f as (
    -- each movement must start where the previous one ended (detects a missing or altered movement)
    select product_id, 'chain_break' check_code, 'error' severity,
           jsonb_build_object('movement_id', id, 'qty_before', qty_before, 'previous_qty_after', prev_after) detail, 'chain_break:' || id key
      from mv where (rn > 1 and qty_before is distinct from prev_after) or (rn = 1 and kind <> 'opening')
    union all
    select b.product_id, 'ledger_mismatch', 'error',
           jsonb_build_object('balance', b.qty, 'sum_of_movements', coalesce(s.t, 0)), 'ledger_mismatch:' || b.product_id
      from public.stock_balances b left join (select m.product_id, sum(m.delta) t from public.stock_movements m group by 1) s using (product_id)
     where b.qty is distinct from coalesce(s.t, 0)
    union all
    select m.product_id, 'movement_without_balance', 'error', jsonb_build_object('movements', count(*)), 'movement_without_balance:' || m.product_id
      from public.stock_movements m where not exists (select 1 from public.stock_balances b where b.product_id = m.product_id) group by m.product_id
    union all
    select b.product_id, 'mirror_mismatch', 'error',
           jsonb_build_object('balance', b.qty, 'records_stockQty', r.data -> 'stockQty'), 'mirror_mismatch:' || b.product_id
      from public.stock_balances b join public.records r on r.store = 'products' and r.id = b.product_id and not r.deleted
     where b.tracked and (case when jsonb_typeof(r.data -> 'stockQty') = 'number' then (r.data ->> 'stockQty')::numeric end) is distinct from b.qty
    union all
    select product_id, 'negative_balance', 'warning', jsonb_build_object('balance', qty), 'negative_balance:' || product_id
      from public.stock_balances where tracked and qty < 0
    union all
    select product_id, 'unverified_balance', 'info',
           jsonb_build_object('opening_basis', opening_basis, 'opening_at', opening_at, 'last_physical_count', last_verified_at), 'unverified_balance:' || product_id
      from public.stock_balances where tracked and last_verified_at is null
    union all
    select m.product_id, 'duplicate_pick', 'error', jsonb_build_object('order_id', m.order_id, 'item_id', m.item_id, 'movements', count(*)),
           'duplicate_pick:' || m.order_id || ':' || m.item_id || ':' || m.product_id
      from public.stock_movements m where m.kind = 'pick' and m.order_id is not null and m.item_id is not null
     group by m.order_id, m.item_id, m.product_id having count(*) > 1
    union all
    select null, 'order_without_movement', 'error', jsonb_build_object('order_id', r.id), 'order_without_movement:' || r.id
      from public.records r, public.stock_control c
     where r.store = 'orders' and not r.deleted and r.data ->> 'stockApplied' = 'true' and c.cutover_at is not null
       and (r.data ->> 'completedAt') ~ '^\d{4}-\d{2}-\d{2}' and (r.data ->> 'completedAt')::timestamptz >= c.cutover_at
       and not exists (select 1 from public.stock_operations o where o.order_id = r.id and o.kind = 'pick' and o.status like 'applied%')
    union all
    select null, 'operation_movement_mismatch', 'error', jsonb_build_object('op_id', o.op_id, 'applied_count', o.applied_count, 'movements', coalesce(mc.c, 0)),
           'operation_movement_mismatch:' || o.op_id
      from public.stock_operations o left join (select op_id, count(*) c from public.stock_movements group by 1) mc using (op_id)
     where o.status like 'applied%' and o.applied_count <> coalesce(mc.c, 0)
    union all
    select null, 'rejected_operation', 'warning', jsonb_build_object('op_id', op_id, 'kind', kind, 'reasons', result -> 'reasons', 'at', created_at), 'rejected_operation:' || op_id
      from public.stock_operations where status = 'rejected'
    union all
    select product_id, 'unresolved_exception', 'warning', jsonb_build_object('exception_id', id, 'code', code, 'op_id', op_id), 'unresolved_exception:' || id
      from public.stock_exceptions where resolved_at is null
    union all
    select null, 'stuck_operation', 'error', jsonb_build_object('op_id', op_id), 'stuck_operation:' || op_id
      from public.stock_operations where status = 'processing' and created_at < now() - interval '5 minutes')
  select f.product_id, f.check_code, f.severity, f.detail, f.key,
         exists (select 1 from public.stock_discrepancies d where d.key = f.key and d.resolved_at is not null)
    from f order by case f.severity when 'error' then 0 when 'warning' then 1 else 2 end, f.key
$$;

-- Saves current findings (so history of what was seen/when exists). Changes NO balance.
create function public.stock_reconcile_record() returns int language plpgsql security definer
  set search_path = pg_catalog, public as $$
declare n int;
begin
  if auth.uid() is null then raise exception 'stock: not authenticated' using errcode = '28000'; end if;
  insert into public.stock_discrepancies(key, check_code, product_id, severity, detail)
  select r.key, r.check_code, r.product_id, r.severity, r.detail from public.stock_reconcile() r
  on conflict (key) do update set last_seen_at = clock_timestamp(), detail = excluded.detail, severity = excluded.severity,
        product_id = excluded.product_id, check_code = excluded.check_code;
  get diagnostics n = row_count;
  return n;
end $$;

-- 16. Ownership + execute permissions for the functions
alter function public.stock_apply(jsonb)               owner to stock_owner;
alter function public.stock_mirror(text[])             owner to stock_owner;
alter function public.stock_status()                   owner to stock_owner;
alter function public.stock_resync_mirror()            owner to stock_owner;
alter function public.stock_resolve_exception(bigint,text) owner to stock_owner;
alter function public.stock_resolve_discrepancy(text,text) owner to stock_owner;
alter function public.stock_reconcile()                owner to stock_owner;
alter function public.stock_reconcile_record()         owner to stock_owner;

revoke all on function public.stock_apply(jsonb), public.stock_mirror(text[]), public.stock_status(), public.stock_resync_mirror(),
  public.stock_resolve_exception(bigint,text), public.stock_resolve_discrepancy(text,text), public.stock_reconcile(),
  public.stock_reconcile_record(), public.stock_append_only() from public, anon, authenticated, service_role;
grant execute on function public.stock_apply(jsonb), public.stock_status(), public.stock_resync_mirror(),
  public.stock_resolve_exception(bigint,text), public.stock_resolve_discrepancy(text,text), public.stock_reconcile(),
  public.stock_reconcile_record() to authenticated;
-- stock_mirror is internal (called only from other trusted functions, which run as stock_owner) — nobody else may run it.
-- helpers used by the guard trigger run as whoever writes "records" (the trigger is SECURITY INVOKER):
grant execute on function public.stock_mode(), public.stock_auth_qty(text), public.stock_client_ok() to public;
revoke all on function public.stock_is_approver(uuid) from public, anon, authenticated, service_role;

revoke create on schema public from stock_owner;   -- no longer needed

commit;
