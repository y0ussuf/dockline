-- =============================================================================
-- Dockline stock safety — migration 001, revision 2 (FOR REVIEW — NOT APPLIED ANYWHERE)
--
-- Adds an authoritative, server-side stock ledger and the only functions allowed to change it.
-- ADDITIVE ONLY: creates new objects, never drops/alters existing data. Enforcement starts OFF.
--
-- ASSUMPTION (verify against your real schema before approval): a table
--   public.records(store text, id text, data jsonb, deleted boolean, updated_at timestamptz,
--                  updated_by text, primary key (store, id))
-- as the app's sync code uses it.
--
-- Roles in play (see README §1):  the MIGRATING ADMIN role (Supabase: "postgres"; here: whoever runs this file),
-- the table owner of "records" (normally the same role), and "stock_owner" (new, NOLOGIN). Nobody is a superuser here.
-- =============================================================================
begin;

-- 1. stock_owner: owns every stock object. NOLOGIN. The migrating role is made a member ONLY so it can hand
--    ownership over below; that membership is REVOKED again at the end of this file.
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'stock_owner') then create role stock_owner nologin; end if;
end $$;
grant stock_owner to current_user;
grant usage on schema auth to stock_owner;
create schema stock_internal;                           -- NOT an API schema: helpers and admin functions live here
grant usage, create on schema stock_internal to stock_owner;   -- CREATE only for the ownership transfer
grant usage, create on schema public to stock_owner;           -- (revoked at the end)
grant usage on schema stock_internal to current_user;

-- 2. Control, snapshots, logs
create table public.stock_control (
  id                 boolean primary key default true check (id),
  mode               text not null default 'off' check (mode in ('off','transition','ignore','reject')),
  min_client_version text not null default '',
  frozen             boolean not null default false,
  frozen_reason      text,
  cutover_at         timestamptz,
  rolled_back_at     timestamptz,
  updated_at         timestamptz not null default now()
);
insert into public.stock_control default values;

create table public.stock_control_log (          -- every admin action, who (session user) and when
  id bigint generated always as identity primary key,
  at timestamptz not null default clock_timestamp(), actor text not null, action text not null, detail jsonb
);
create table public.stock_cutover_snapshot (     -- server-side picture of legacy stockQty values at a named moment
  label text not null, product_id text not null, legacy_qty numeric, record_updated_at timestamptz,
  taken_at timestamptz not null default clock_timestamp(), taken_by text,
  primary key (label, product_id)
);
create table public.stock_legacy_writes (        -- every attempt, by any client, to change a stockQty it may not change
  id bigint generated always as identity primary key,
  at timestamptz not null default clock_timestamp(),
  product_id text not null, old_qty numeric, attempted_qty numeric, kept_qty numeric,
  mode text not null, client_user uuid, client_info text,
  acknowledged_at timestamptz, acknowledged_by text, ack_note text
);
create table public.app_stock_approvers (
  user_id uuid primary key, email text, added_at timestamptz not null default now(), note text
);

-- 3. Authoritative balances. One row per product; "episode" counts tracking periods (opening ... untrack).
create table public.stock_balances (
  product_id          text primary key,
  unit                text not null,
  qty                 numeric not null check (qty = round(qty, 4) and abs(qty) < 1000000000),
  tracked             boolean not null default true,
  episode             int not null default 1,
  opening_movement_id bigint,                 -- the cutoff: nothing before this movement of this episode is in the ledger
  opening_qty         numeric,
  opening_basis       text check (opening_basis in ('physical_count','accepted_unverified','derived')),
  opening_at          timestamptz,
  opening_by          uuid,
  last_verified_at    timestamptz,            -- last physical count (or physical-count opening)
  version             bigint not null default 1,
  updated_at          timestamptz not null default clock_timestamp()
);

create table public.stock_operations (
  op_id uuid primary key,
  kind text not null check (kind in ('pick','receipt','receipt_reversal','mapping_move','count','opening','adjustment','untrack')),
  class text not null check (class in ('fact','correction','count','admin')),
  request_hash text not null,
  status text not null check (status in ('processing','applied','applied_with_exceptions','rejected')),
  result jsonb, payload jsonb not null, applied_count int not null default 0,
  actor uuid not null, actor_email text, order_id text, device_id text, client_at timestamptz,
  created_at timestamptz not null default clock_timestamp()
);
create table public.stock_movements (
  id bigint generated always as identity primary key,
  op_id uuid not null references public.stock_operations(op_id),
  line_no int not null, kind text not null, product_id text not null, episode int not null default 1,
  delta numeric not null check (delta = round(delta, 4)),
  qty_before numeric not null, qty_after numeric not null,
  unit text, order_id text, item_id text, ref text,
  proof text not null check (proof in ('recorded','reconstructed','physical_count','accepted_unverified','derived','adjustment')),
  override boolean not null default false, override_reason text,
  actor uuid not null, actor_email text, device_id text, client_at timestamptz, note text,
  created_at timestamptz not null default clock_timestamp(),
  unique (op_id, line_no)
);
create index stock_movements_product_idx on public.stock_movements(product_id, id);
create index stock_movements_order_idx   on public.stock_movements(order_id, item_id);
create table public.stock_exceptions (          -- fact lines that could NOT be applied (never silently dropped)
  id bigint generated always as identity primary key,
  op_id uuid not null references public.stock_operations(op_id), line_no int not null, product_id text,
  code text not null, detail jsonb, created_at timestamptz not null default clock_timestamp(),
  resolved_at timestamptz, resolved_by uuid, resolution_note text
);
create table public.stock_discrepancies (       -- findings from reconciliation; recording one never touches a balance
  id bigint generated always as identity primary key,
  key text not null unique, check_code text not null, product_id text, severity text not null, detail jsonb,
  first_seen_at timestamptz not null default clock_timestamp(), last_seen_at timestamptz not null default clock_timestamp(),
  resolved_at timestamptz, resolved_by uuid, resolution_note text
);

-- 4. Helpers (schema stock_internal — not exposed through the API)
create function stock_internal.safe_num(j jsonb) returns numeric language sql immutable
  set search_path = pg_catalog as $$
  select case jsonb_typeof(j)
           when 'number' then (j #>> '{}')::numeric
           when 'string' then case when (j #>> '{}') ~ '^\s*-?\d+(\.\d+)?\s*$' then btrim(j #>> '{}')::numeric end
         end $$;
create function stock_internal.stock_mode() returns text language sql stable security definer
  set search_path = pg_catalog, public as $$ select mode from public.stock_control $$;
create function stock_internal.stock_auth_qty(p_id text) returns numeric language sql stable security definer
  set search_path = pg_catalog, public as $$ select qty from public.stock_balances where product_id = p_id and tracked $$;
create function stock_internal.stock_is_approver(p_uid uuid) returns boolean language sql stable security definer
  set search_path = pg_catalog, public as $$ select exists (select 1 from public.app_stock_approvers where user_id = p_uid) $$;
-- current legacy stockQty held in records: {exists, qty}
create function stock_internal.legacy_state(p_id text) returns jsonb language sql stable security definer
  set search_path = pg_catalog, public as $$
  select coalesce((select jsonb_build_object('exists', true, 'qty', stock_internal.safe_num(data -> 'stockQty'))
                     from public.records where store = 'products' and id = p_id and not deleted),
                  jsonb_build_object('exists', false, 'qty', null)) $$;
create function stock_internal.log_legacy_write(p_id text, p_old numeric, p_attempted numeric, p_kept numeric, p_mode text) returns void
language plpgsql security definer set search_path = pg_catalog, public as $$
declare cl text := nullif(current_setting('request.jwt.claims', true), ''); h text := nullif(current_setting('request.headers', true), '');
begin
  insert into public.stock_legacy_writes(product_id, old_qty, attempted_qty, kept_qty, mode, client_user, client_info)
  values (p_id, p_old, p_attempted, p_kept, p_mode,
          case when cl is not null then nullif((cl::jsonb) ->> 'sub', '')::uuid end,
          case when h is not null then (h::jsonb) ->> 'x-client-info' end);
end $$;
-- app-version gate. NOT a security boundary (a header can be forged); it only stops honest OLD apps.
create function stock_internal.stock_client_ok() returns boolean language plpgsql stable security definer
  set search_path = pg_catalog, public as $$
declare h text := current_setting('request.headers', true); ci text; m text[]; need text; mm text[];
begin
  if h is null or h = '' then return true; end if;          -- not coming through the API (admin SQL / migrations)
  ci := (h::jsonb) ->> 'x-client-info';
  select min_client_version into need from public.stock_control;
  if coalesce(need, '') = '' then return true; end if;
  m  := regexp_match(coalesce(ci, ''), '^dockline/(\d{4}-\d{2}-\d{2})\.(\d+)$');
  if m is null then return false; end if;
  mm := regexp_match(need, '^(\d{4}-\d{2}-\d{2})\.(\d+)$');
  return (m[1], m[2]::int) >= (mm[1], mm[2]::int);
end $$;
-- the mirror: numeric is written to JSON AS numeric (no float8 round trip), trailing zeros trimmed
create function stock_internal.stock_mirror(p_ids text[]) returns int language plpgsql security definer
  set search_path = pg_catalog, public as $$
declare n int;
begin
  update public.records r
     set data = jsonb_set(r.data, '{stockQty}', case when b.tracked then to_jsonb(trim_scale(b.qty)) else '""'::jsonb end, true),
         updated_at = clock_timestamp(), updated_by = 'stock'
    from public.stock_balances b
   where r.store = 'products' and r.id = b.product_id and r.data is not null and not r.deleted
     and (p_ids is null or b.product_id = any(p_ids));
  get diagnostics n = row_count;
  return n;
end $$;
create function stock_internal.stock_append_only() returns trigger language plpgsql set search_path = pg_catalog, public as $$
begin
  if tg_table_name = 'stock_operations' and tg_op = 'UPDATE' then
    if old.status = 'processing' then return new; end if;   -- the one in-transaction finalisation of a new operation
  end if;
  raise exception 'stock: % is append-only (% refused)', tg_table_name, tg_op using errcode = '55000';
end $$;

-- 5. THE GUARD on "records" (SECURITY INVOKER). The only writer allowed to change a product's stockQty is a statement
--    running while current_user = 'stock_owner', i.e. inside the SECURITY DEFINER functions of this migration.
--    Modes:  off        = does nothing
--            transition = products that already have a balance are protected (stale value rewritten + logged);
--                         products with NO balance yet pass through unchanged, and any change is LOGGED (never silent)
--            ignore     = every product protected; unopened products get stockQty blanked; every attempt is logged
--            reject     = like ignore, and API clients without an up-to-date x-client-info are refused outright
create function stock_internal.records_stock_guard() returns trigger language plpgsql set search_path = pg_catalog, public as $$
declare m text; q numeric; new_q numeric; old_q numeric; st jsonb;
begin
  if current_user = 'stock_owner' then return new; end if;
  m := stock_internal.stock_mode();
  if m = 'off' then return new; end if;
  if m = 'reject' and not stock_internal.stock_client_ok() then
    raise exception 'dockline: this app version is no longer supported — please update the app' using errcode = 'P0001';
  end if;
  if new.store = 'products' and new.data is not null and jsonb_typeof(new.data) = 'object' then
    q := stock_internal.stock_auth_qty(new.id);
    new_q := stock_internal.safe_num(new.data -> 'stockQty');
    if q is not null then                                           -- has an authoritative balance
      if new_q is not null and new_q <> q then
        perform stock_internal.log_legacy_write(new.id, q, new_q, q, m);
      end if;
      new.data := jsonb_set(new.data, '{stockQty}', to_jsonb(trim_scale(q)), true);
    else                                                            -- no balance (never opened, or untracked)
      if tg_op = 'UPDATE' then old_q := stock_internal.safe_num(old.data -> 'stockQty');
      else st := stock_internal.legacy_state(new.id); old_q := (st ->> 'qty')::numeric; end if;
      if m = 'transition' then
        -- pass through, but never silently: an upsert fires the INSERT trigger first (row already there) — only the UPDATE trigger logs it
        if new_q is distinct from old_q and (tg_op = 'UPDATE' or not coalesce((st ->> 'exists')::boolean, false)) then
          perform stock_internal.log_legacy_write(new.id, old_q, new_q, new_q, m);
        end if;
      else
        -- an attempt to put a number on a product that has no balance. The INSERT half of an upsert blanks the value first,
        -- so the UPDATE half would no longer see it: therefore EVERY non-blank attempt is logged here, once.
        if new_q is not null then perform stock_internal.log_legacy_write(new.id, old_q, new_q, null, m); end if;
        if coalesce(new.data ->> 'stockQty', '') <> '' then new.data := jsonb_set(new.data, '{stockQty}', '""'::jsonb, true); end if;
      end if;
    end if;
  end if;
  return new;
end $$;

-- 6. Ownership transfer (everything above was created by the admin role)
do $$ declare f record; begin
  for f in select c.oid::regclass::text as t from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
           and c.relname in ('stock_control','stock_control_log','stock_cutover_snapshot','stock_legacy_writes','app_stock_approvers',
                             'stock_balances','stock_operations','stock_movements','stock_exceptions','stock_discrepancies') loop
    execute format('alter table %s owner to stock_owner', f.t);
  end loop;
end $$;

-- 7. Append-only protection (a trigger — holds even for the table owner; only DDL can remove it)
create trigger append_only_mv   before update or delete on public.stock_movements      for each row       execute function stock_internal.stock_append_only();
create trigger append_only_op   before update or delete on public.stock_operations     for each row       execute function stock_internal.stock_append_only();
create trigger append_only_log  before update or delete on public.stock_control_log    for each row       execute function stock_internal.stock_append_only();
create trigger append_only_snap before update or delete on public.stock_cutover_snapshot for each row     execute function stock_internal.stock_append_only();
create trigger append_only_mv_t   before truncate on public.stock_movements        for each statement execute function stock_internal.stock_append_only();
create trigger append_only_op_t   before truncate on public.stock_operations       for each statement execute function stock_internal.stock_append_only();
create trigger append_only_log_t  before truncate on public.stock_control_log      for each statement execute function stock_internal.stock_append_only();
create trigger append_only_snap_t before truncate on public.stock_cutover_snapshot for each statement execute function stock_internal.stock_append_only();
-- the guard (named zz_ so it fires after any other BEFORE trigger and has the last word)
create trigger zz_records_stock_guard before insert or update on public.records
  for each row execute function stock_internal.records_stock_guard();

-- 8. THE one function that changes stock
create function public.stock_apply(p_op jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $fn$
declare
  v_actor uuid := auth.uid();
  v_email text := nullif(auth.jwt() ->> 'email', '');
  v_frozen boolean; v_freeze_reason text; v_mode text;
  v_op_id uuid; v_kind text; v_class text; v_hash text;
  v_override boolean := coalesce((p_op ->> 'override')::boolean, false);
  v_oreason text := nullif(btrim(coalesce(p_op ->> 'override_reason', '')), '');
  v_note text := nullif(btrim(coalesce(p_op ->> 'note', '')), '');
  v_cl timestamptz := nullif(p_op ->> 'client_at', '')::timestamptz;
  v_approver boolean;
  v_old public.stock_operations%rowtype;
  v_lines jsonb; v_n int; i int; ln jsonb;
  v_pid text; v_unit text; v_delta numeric; v_cnt numeric; v_basis text; v_leg numeric; v_ep int; v_ref text; v_code text; v_detail jsonb;
  v_cur jsonb := '{}'::jsonb; v_plan jsonb := '[]'::jsonb;
  b public.stock_balances%rowtype;
  v_before numeric; v_after numeric; v_out text; v_neg boolean; v_proof text;
  v_rej jsonb := '[]'::jsonb; v_exc int := 0; v_applied int := 0;
  v_ids text[]; v_status text; v_result jsonb; p jsonb; v_mid bigint;
  v_order text := nullif(p_op ->> 'order_id', '');
begin
  if v_actor is null then raise exception 'stock: not authenticated' using errcode = '28000'; end if;
  select frozen, frozen_reason, mode into v_frozen, v_freeze_reason, v_mode from public.stock_control;
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
  v_approver := stock_internal.stock_is_approver(v_actor);
  if v_class = 'admin' and not v_approver then
    raise exception 'stock: only a stock approver may record %', v_kind using errcode = '42501'; end if;
  v_hash := md5((p_op - 'op_id')::text);

  insert into public.stock_operations(op_id, kind, class, request_hash, status, payload, actor, actor_email, order_id, device_id, client_at)
  values (v_op_id, v_kind, v_class, v_hash, 'processing', p_op, v_actor, v_email, v_order, nullif(p_op ->> 'device_id', ''), v_cl)
  on conflict (op_id) do nothing;
  if not found then
    select * into v_old from public.stock_operations where op_id = v_op_id;
    if v_old.request_hash <> v_hash or v_old.actor <> v_actor then
      raise exception 'stock: operation id % was already used for a different request', v_op_id using errcode = '23505'; end if;
    return coalesce(v_old.result, '{}'::jsonb) || jsonb_build_object('duplicate', true);
  end if;

  select array_agg(distinct x ->> 'product_id') into v_ids from jsonb_array_elements(v_lines) x;
  if v_ids is null or exists (select 1 from unnest(v_ids) u where u is null) then
    raise exception 'stock: every line needs a product_id' using errcode = '22023'; end if;
  perform 1 from public.stock_balances where product_id = any(v_ids) order by product_id for update;          -- lock order: balances (by id) ...
  if v_kind = 'opening' then                                                                                 -- ... then the legacy records being replaced
    perform 1 from public.records where store = 'products' and id = any(v_ids) order by id for update; end if;

  for i in 1 .. v_n loop
    ln := v_lines -> (i - 1);
    v_pid := ln ->> 'product_id';
    v_unit := lower(btrim(coalesce(ln ->> 'unit', '')));
    select * into b from public.stock_balances where product_id = v_pid;
    v_out := 'apply'; v_code := null; v_detail := null; v_delta := 0; v_proof := 'recorded'; v_neg := false; v_ref := ln ->> 'ref'; v_ep := coalesce(b.episode, 1);
    v_before := coalesce((v_cur ->> v_pid)::numeric, b.qty, 0);
    v_after := v_before;

    if v_kind = 'opening' then
      v_cnt := round((ln ->> 'counted_qty')::numeric, 4); v_basis := ln ->> 'basis';
      v_ep := case when b.product_id is null then 1 else b.episode + 1 end;
      if b.product_id is not null and b.tracked then v_out := 'reject'; v_code := 'already_opened';
      elsif v_cnt is null or v_cnt < 0 or v_cnt >= 1000000000 or v_unit = '' or v_basis is null
            or v_basis not in ('physical_count','accepted_unverified','derived') then v_out := 'reject'; v_code := 'invalid_opening';
      elsif not exists (select 1 from public.records where store = 'products' and id = v_pid and not deleted) then
        v_out := 'reject'; v_code := 'unknown_product';
      else
        v_leg := (stock_internal.legacy_state(v_pid) ->> 'qty')::numeric;       -- the legacy number this opening will REPLACE
        if v_mode in ('off', 'transition') and v_leg is not null then
          if nullif(ln ->> 'expected_legacy_qty', '') is null then v_out := 'reject'; v_code := 'expected_legacy_qty_required'; v_detail := jsonb_build_object('legacy_now', v_leg);
          elsif (ln ->> 'expected_legacy_qty')::numeric <> v_leg then
            v_out := 'reject'; v_code := 'legacy_qty_changed';
            v_detail := jsonb_build_object('expected', (ln ->> 'expected_legacy_qty')::numeric, 'legacy_now', v_leg);
          end if;
        end if;
        if v_out = 'apply' then
          v_after := v_cnt; v_delta := v_cnt - v_before; v_proof := v_basis;
          if v_leg is not null then v_ref := coalesce(v_ref || '; ', '') || 'replaced legacy stockQty ' || v_leg; end if;
        end if;
      end if;

    elsif v_kind = 'untrack' then
      if b.product_id is null or not b.tracked then v_out := 'reject'; v_code := 'not_tracked';
      else v_after := 0; v_delta := -b.qty; v_ref := coalesce(v_ref || '; ', '') || 'closing balance ' || b.qty; end if;

    elsif b.product_id is null or not b.tracked then
      if v_kind = 'count' then v_out := 'reject'; v_code := 'not_tracked'; else v_out := 'skipped_untracked'; end if;

    elsif v_unit = '' or v_unit <> lower(btrim(b.unit)) then
      if v_class = 'fact' then
        v_out := 'exception'; v_code := 'unit_mismatch';
        v_detail := jsonb_build_object('line_unit', ln ->> 'unit', 'stock_unit', b.unit);
      else v_out := 'reject'; v_code := 'unit_mismatch'; end if;

    elsif v_class = 'fact' and v_cl is not null and b.last_verified_at is not null and v_cl < b.last_verified_at then
      -- this event happened BEFORE the last physical count, so the count already includes it: applying it would count it twice
      v_out := 'exception'; v_code := 'stale_before_count';
      v_detail := jsonb_build_object('client_at', v_cl, 'last_count_at', b.last_verified_at);

    elsif v_kind = 'count' then
      v_cnt := round((ln ->> 'counted_qty')::numeric, 4);
      if v_cnt is null or v_cnt < 0 or v_cnt >= 1000000000 then v_out := 'reject'; v_code := 'invalid_count';
      else v_after := v_cnt; v_delta := v_cnt - v_before; v_proof := 'physical_count'; end if;

    else
      v_delta := round((ln ->> 'delta')::numeric, 4);
      if v_delta is null then raise exception 'stock: line % needs a delta', i using errcode = '22023'; end if;
      if (v_kind = 'pick' and v_delta > 0) or (v_kind = 'receipt' and v_delta < 0) or (v_kind = 'receipt_reversal' and v_delta > 0) then
        raise exception 'stock: line % has the wrong sign for %', i, v_kind using errcode = '22023'; end if;
      v_after := v_before + v_delta;
      if v_kind = 'adjustment' then
        v_proof := 'adjustment';
        if v_note is null then v_out := 'reject'; v_code := 'adjustment_needs_reason'; end if;
      elsif ln ->> 'basis' = 'reconstructed' then v_proof := 'reconstructed'; end if;
      if v_out = 'apply' and v_after < 0 then
        v_neg := true;
        if v_class <> 'fact' then
          if not v_override then v_out := 'reject'; v_code := 'negative_stock';
          elsif v_oreason is null then v_out := 'reject'; v_code := 'override_needs_reason';
          elsif not v_approver then v_out := 'reject'; v_code := 'override_not_authorized'; end if;
        end if;
      end if;
    end if;

    if v_out = 'reject' then v_rej := v_rej || jsonb_build_object('line_no', i, 'product_id', v_pid, 'code', v_code, 'detail', v_detail); end if;
    if v_out = 'exception' then v_exc := v_exc + 1; end if;
    if v_out = 'apply' then v_cur := jsonb_set(v_cur, array[v_pid], to_jsonb(v_after)); end if;
    v_plan := v_plan || jsonb_build_object('line_no', i, 'product_id', v_pid, 'outcome', v_out, 'code', v_code, 'detail', v_detail,
        'qty_before', v_before, 'delta', v_delta, 'qty_after', v_after, 'negative', v_neg, 'proof', v_proof, 'episode', v_ep,
        'item_id', ln ->> 'item_id', 'ref', v_ref, 'unit', coalesce(ln ->> 'unit', b.unit));
  end loop;

  if jsonb_array_length(v_rej) > 0 then            -- corrections / counts / admin changes are all-or-nothing
    v_result := jsonb_build_object('op_id', v_op_id, 'status', 'rejected', 'reasons', v_rej, 'lines', v_plan, 'duplicate', false);
    update public.stock_operations set status = 'rejected', result = v_result where op_id = v_op_id;
    return v_result;
  end if;

  for i in 0 .. v_n - 1 loop
    p := v_plan -> i;
    if p ->> 'outcome' = 'exception' then
      insert into public.stock_exceptions(op_id, line_no, product_id, code, detail)
      values (v_op_id, i + 1, p ->> 'product_id', p ->> 'code', coalesce(p -> 'detail', '{}'::jsonb) || jsonb_build_object('delta', p -> 'delta', 'line', v_lines -> i));
      continue;
    end if;
    if p ->> 'outcome' <> 'apply' then continue; end if;
    v_pid := p ->> 'product_id';
    insert into public.stock_movements(op_id, line_no, kind, product_id, episode, delta, qty_before, qty_after, unit, order_id, item_id, ref,
        proof, override, override_reason, actor, actor_email, device_id, client_at, note)
    values (v_op_id, i + 1, v_kind, v_pid, (p ->> 'episode')::int, (p ->> 'delta')::numeric, (p ->> 'qty_before')::numeric, (p ->> 'qty_after')::numeric,
        p ->> 'unit', v_order, p ->> 'item_id', p ->> 'ref', p ->> 'proof',
        (p ->> 'negative')::boolean and v_class <> 'fact' and v_override, case when (p ->> 'negative')::boolean and v_class <> 'fact' then v_oreason end,
        v_actor, v_email, nullif(p_op ->> 'device_id', ''), v_cl, v_note)
    returning id into v_mid;
    if v_kind = 'opening' then
      insert into public.stock_balances(product_id, unit, qty, tracked, episode, opening_movement_id, opening_qty, opening_basis, opening_at, opening_by, last_verified_at)
      values (v_pid, v_lines -> i ->> 'unit', (p ->> 'qty_after')::numeric, true, (p ->> 'episode')::int, v_mid, (p ->> 'qty_after')::numeric,
              p ->> 'proof', clock_timestamp(), v_actor, case when p ->> 'proof' = 'physical_count' then clock_timestamp() end)
      on conflict (product_id) do update set unit = excluded.unit, qty = excluded.qty, tracked = true, episode = excluded.episode,
              opening_movement_id = excluded.opening_movement_id, opening_qty = excluded.opening_qty, opening_basis = excluded.opening_basis,
              opening_at = excluded.opening_at, opening_by = excluded.opening_by, last_verified_at = excluded.last_verified_at,
              version = public.stock_balances.version + 1, updated_at = clock_timestamp();
    elsif v_kind = 'untrack' then
      update public.stock_balances set qty = 0, tracked = false, version = version + 1, updated_at = clock_timestamp() where product_id = v_pid;
    else
      update public.stock_balances set qty = (p ->> 'qty_after')::numeric, version = version + 1, updated_at = clock_timestamp(),
             last_verified_at = case when v_kind = 'count' then clock_timestamp() else last_verified_at end
       where product_id = v_pid;
    end if;
    v_applied := v_applied + 1;
  end loop;

  perform stock_internal.stock_mirror(v_ids);
  v_status := case when v_exc > 0 then 'applied_with_exceptions' else 'applied' end;
  v_result := jsonb_build_object('op_id', v_op_id, 'status', v_status, 'lines', v_plan, 'exceptions', v_exc, 'duplicate', false);
  update public.stock_operations set status = v_status, result = v_result, applied_count = v_applied where op_id = v_op_id;
  return v_result;
end
$fn$;

create function public.stock_status() returns jsonb language sql stable security definer set search_path = pg_catalog, public as $$
  select jsonb_build_object('mode', mode, 'frozen', frozen, 'frozen_reason', frozen_reason, 'min_client_version', min_client_version,
         'cutover_at', cutover_at, 'rolled_back_at', rolled_back_at, 'is_approver', stock_internal.stock_is_approver(auth.uid()), 'user_id', auth.uid())
  from public.stock_control $$;

create function public.stock_resync_mirror() returns int language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  if auth.uid() is null or not stock_internal.stock_is_approver(auth.uid()) then raise exception 'stock: approver only' using errcode = '42501'; end if;
  return stock_internal.stock_mirror(null);
end $$;
create function public.stock_resolve_exception(p_id bigint, p_note text) returns void language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  if auth.uid() is null or not stock_internal.stock_is_approver(auth.uid()) then raise exception 'stock: approver only' using errcode = '42501'; end if;
  if nullif(btrim(coalesce(p_note, '')), '') is null then raise exception 'stock: a note is required' using errcode = '22023'; end if;
  update public.stock_exceptions set resolved_at = now(), resolved_by = auth.uid(), resolution_note = p_note where id = p_id and resolved_at is null;
end $$;
create function public.stock_resolve_discrepancy(p_key text, p_note text) returns void language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  if auth.uid() is null or not stock_internal.stock_is_approver(auth.uid()) then raise exception 'stock: approver only' using errcode = '42501'; end if;
  if nullif(btrim(coalesce(p_note, '')), '') is null then raise exception 'stock: a note is required' using errcode = '22023'; end if;
  insert into public.stock_discrepancies(key, check_code, severity, resolved_at, resolved_by, resolution_note)
  values (p_key, split_part(p_key, ':', 1), 'info', now(), auth.uid(), p_note)
  on conflict (key) do update set resolved_at = now(), resolved_by = auth.uid(), resolution_note = p_note;
end $$;

-- 9. Cutover status (read-only; anyone signed in may look)
create function public.stock_cutover_status() returns jsonb language sql stable security definer set search_path = pg_catalog, public as $$
  select jsonb_build_object(
    'mode', c.mode, 'frozen', c.frozen, 'cutover_at', c.cutover_at, 'rolled_back_at', c.rolled_back_at,
    'unopened_products_with_legacy_stock', coalesce((select jsonb_agg(jsonb_build_object('product_id', r.id, 'legacy_qty', stock_internal.safe_num(r.data -> 'stockQty')) order by r.id)
        from public.records r where r.store = 'products' and not r.deleted and stock_internal.safe_num(r.data -> 'stockQty') is not null
         and not exists (select 1 from public.stock_balances b where b.product_id = r.id and b.tracked)), '[]'::jsonb),
    'unacknowledged_legacy_writes', (select count(*) from public.stock_legacy_writes where acknowledged_at is null),
    'drift_since_snapshot', coalesce((select jsonb_agg(jsonb_build_object('product_id', s.product_id, 'snapshot_qty', s.legacy_qty, 'legacy_now', stock_internal.safe_num(r.data -> 'stockQty')) order by s.product_id)
        from public.stock_cutover_snapshot s join public.records r on r.store = 'products' and r.id = s.product_id
        where s.label = (select label from public.stock_cutover_snapshot order by taken_at desc limit 1)
          and s.legacy_qty is distinct from stock_internal.safe_num(r.data -> 'stockQty')
          and not exists (select 1 from public.stock_balances b where b.product_id = s.product_id and b.tracked)), '[]'::jsonb),
    'balances_not_counted_since_rollback', case when c.rolled_back_at is null then '[]'::jsonb else
        coalesce((select jsonb_agg(b.product_id order by b.product_id) from public.stock_balances b where b.tracked
                   and (b.last_verified_at is null or b.last_verified_at <= c.rolled_back_at)), '[]'::jsonb) end)
  from public.stock_control c $$;

-- 10. ADMIN functions — callable ONLY by the migrating admin role (EXECUTE granted to nobody else); every call is logged
create function stock_internal.stock_admin_snapshot(p_label text) returns int language plpgsql security definer set search_path = pg_catalog, public as $$
declare n int;
begin
  insert into public.stock_cutover_snapshot(label, product_id, legacy_qty, record_updated_at, taken_by)
  select p_label, r.id, stock_internal.safe_num(r.data -> 'stockQty'), r.updated_at, session_user
    from public.records r where r.store = 'products' and not r.deleted;
  get diagnostics n = row_count;
  insert into public.stock_control_log(actor, action, detail) values (session_user, 'snapshot', jsonb_build_object('label', p_label, 'products', n));
  return n;
end $$;

create function stock_internal.stock_admin_approver(p_user uuid, p_email text, p_add boolean, p_note text default null) returns void
language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  if p_add then insert into public.app_stock_approvers(user_id, email, note) values (p_user, p_email, p_note) on conflict (user_id) do update set email = excluded.email, note = excluded.note;
  else delete from public.app_stock_approvers where user_id = p_user; end if;
  insert into public.stock_control_log(actor, action, detail) values (session_user, case when p_add then 'approver_added' else 'approver_removed' end,
         jsonb_build_object('user_id', p_user, 'email', p_email, 'note', p_note));
end $$;

create function stock_internal.stock_admin_ack_legacy_writes(p_note text, p_up_to_id bigint default null) returns int
language plpgsql security definer set search_path = pg_catalog, public as $$
declare n int;
begin
  if nullif(btrim(coalesce(p_note, '')), '') is null then raise exception 'stock: a note is required' using errcode = '22023'; end if;
  update public.stock_legacy_writes set acknowledged_at = now(), acknowledged_by = session_user, ack_note = p_note
   where acknowledged_at is null and (p_up_to_id is null or id <= p_up_to_id);
  get diagnostics n = row_count;
  insert into public.stock_control_log(actor, action, detail) values (session_user, 'legacy_writes_acknowledged', jsonb_build_object('count', n, 'note', p_note));
  return n;
end $$;

create function stock_internal.stock_admin_control(p_mode text default null, p_min_client_version text default null, p_frozen boolean default null,
                                                   p_frozen_reason text default null, p_leave_untracked text[] default null, p_note text default null)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare c public.stock_control%rowtype; v_unopened text[]; v_unack int; v_stale text[]; v_old_mode text; v_had_balances boolean; v_mirrored int := 0;
begin
  select * into c from public.stock_control for update;
  v_old_mode := c.mode;
  if p_mode is not null and p_mode not in ('off','transition','ignore','reject') then raise exception 'stock: unknown mode %', p_mode using errcode = '22023'; end if;
  select exists (select 1 from public.stock_balances) into v_had_balances;

  if p_mode is not null and p_mode <> c.mode then
    select count(*) into v_unack from public.stock_legacy_writes where acknowledged_at is null;
    -- after a rollback, nothing may be switched back on until every balance has been physically counted since
    if c.mode = 'off' and c.rolled_back_at is not null and p_mode <> 'off' then
      select array_agg(b.product_id order by b.product_id) into v_stale from public.stock_balances b
       where b.tracked and (b.last_verified_at is null or b.last_verified_at <= c.rolled_back_at);
      if v_stale is not null then raise exception 'stock: re-enable blocked — % tracked product(s) have not been physically counted since the rollback: %', array_length(v_stale, 1), v_stale using errcode = '55000'; end if;
    end if;
    if p_mode in ('ignore','reject') and c.mode in ('off','transition') then
      select array_agg(r.id order by r.id) into v_unopened from public.records r
       where r.store = 'products' and not r.deleted and stock_internal.safe_num(r.data -> 'stockQty') is not null
         and not exists (select 1 from public.stock_balances b where b.product_id = r.id and b.tracked);
      if coalesce((select array_agg(x order by x) from unnest(v_unopened) x), '{}') is distinct from coalesce((select array_agg(x order by x) from unnest(p_leave_untracked) x), '{}') then
        raise exception 'stock: cutover blocked — products with a legacy stock number but no opening balance: %. Open them, or list exactly these ids in p_leave_untracked to confirm their legacy number is discarded.', v_unopened using errcode = '55000'; end if;
      if v_unack > 0 then raise exception 'stock: cutover blocked — % unacknowledged legacy stock write(s) (see stock_legacy_writes)', v_unack using errcode = '55000'; end if;
      c.cutover_at := clock_timestamp();                      -- orders finished from now on must have a stock operation
    end if;
    if p_mode = 'off' and v_had_balances then               -- rollback release
      if v_unack > 0 then raise exception 'stock: rollback release blocked — % unacknowledged legacy stock write(s)', v_unack using errcode = '55000'; end if;
      v_mirrored := stock_internal.stock_mirror(null);       -- records <- final authoritative balances
      c.rolled_back_at := clock_timestamp(); c.frozen := true;
      c.frozen_reason := coalesce(p_frozen_reason, 'ROLLED BACK: ledger is read-only history; stock_balances is no longer authoritative');
    end if;
    c.mode := p_mode;
  end if;
  if p_min_client_version is not null then c.min_client_version := p_min_client_version; end if;
  if p_frozen is not null then c.frozen := p_frozen; c.frozen_reason := case when p_frozen then p_frozen_reason end; end if;
  update public.stock_control set mode = c.mode, min_client_version = c.min_client_version, frozen = c.frozen, frozen_reason = c.frozen_reason,
         cutover_at = c.cutover_at, rolled_back_at = c.rolled_back_at, updated_at = now();
  insert into public.stock_control_log(actor, action, detail) values (session_user, 'control',
     jsonb_build_object('mode_from', v_old_mode, 'mode_to', c.mode, 'frozen', c.frozen, 'min_client_version', c.min_client_version, 'note', p_note,
                        'left_untracked', p_leave_untracked, 'mirrored', v_mirrored));
  return jsonb_build_object('mode', c.mode, 'frozen', c.frozen, 'cutover_at', c.cutover_at, 'rolled_back_at', c.rolled_back_at, 'mirrored', v_mirrored);
end $$;

-- 11. Reconciliation: READ-ONLY. It reports; it never changes a balance, movement or mirror.
create function public.stock_reconcile() returns table(product_id text, check_code text, severity text, detail jsonb, key text, acknowledged boolean)
language sql stable security definer set search_path = pg_catalog, public as $$
  with mv as (
    select m.*, lag(qty_after) over (partition by m.product_id order by m.id) prev_after,
           row_number() over (partition by m.product_id order by m.id) rn,
           row_number() over (partition by m.product_id, m.episode order by m.id) rn_ep
      from public.stock_movements m),
  f as (
    -- each movement must start where the previous one ended; each episode must start with exactly one opening
    select product_id, 'chain_break' check_code, 'error' severity,
           jsonb_build_object('movement_id', id, 'qty_before', qty_before, 'previous_qty_after', prev_after) detail, 'chain_break:' || id key
      from mv where (rn > 1 and qty_before is distinct from prev_after) or (rn_ep = 1 and kind <> 'opening') or (rn_ep > 1 and kind = 'opening')
    union all
    select b.product_id, 'ledger_mismatch', 'error', jsonb_build_object('balance', b.qty, 'sum_of_movements', coalesce(s.t, 0)), 'ledger_mismatch:' || b.product_id
      from public.stock_balances b left join (select m.product_id, sum(m.delta) t from public.stock_movements m group by 1) s using (product_id)
     where b.qty is distinct from coalesce(s.t, 0)
    union all
    select m.product_id, 'movement_without_balance', 'error', jsonb_build_object('movements', count(*)), 'movement_without_balance:' || m.product_id
      from public.stock_movements m where not exists (select 1 from public.stock_balances b where b.product_id = m.product_id) group by m.product_id
    union all
    select b.product_id, 'mirror_mismatch', 'error', jsonb_build_object('balance', b.qty, 'records_stockQty', r.data -> 'stockQty'), 'mirror_mismatch:' || b.product_id
      from public.stock_balances b join public.records r on r.store = 'products' and r.id = b.product_id and not r.deleted
     where b.tracked and stock_internal.safe_num(r.data -> 'stockQty') is distinct from b.qty
    union all
    select b.product_id, 'mirror_mismatch', 'error', jsonb_build_object('balance', 'untracked', 'records_stockQty', r.data -> 'stockQty'), 'mirror_mismatch:' || b.product_id
      from public.stock_balances b join public.records r on r.store = 'products' and r.id = b.product_id and not r.deleted
     where not b.tracked and stock_internal.safe_num(r.data -> 'stockQty') is not null
    union all
    select product_id, 'negative_balance', 'warning', jsonb_build_object('balance', qty), 'negative_balance:' || product_id from public.stock_balances where tracked and qty < 0
    union all
    select product_id, 'unverified_balance', 'info', jsonb_build_object('opening_basis', opening_basis, 'opening_at', opening_at, 'episode', episode, 'last_physical_count', last_verified_at),
           'unverified_balance:' || product_id from public.stock_balances where tracked and last_verified_at is null
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
    select product_id, 'legacy_write', 'warning', jsonb_build_object('write_id', id, 'old', old_qty, 'attempted', attempted_qty, 'kept', kept_qty, 'mode', mode, 'at', at),
           'legacy_write:' || id from public.stock_legacy_writes where acknowledged_at is null
    union all
    select null, 'stuck_operation', 'error', jsonb_build_object('op_id', op_id), 'stuck_operation:' || op_id
      from public.stock_operations where status = 'processing' and created_at < now() - interval '5 minutes')
  select f.product_id, f.check_code, f.severity, f.detail, f.key,
         exists (select 1 from public.stock_discrepancies d where d.key = f.key and d.resolved_at is not null)
    from f order by case f.severity when 'error' then 0 when 'warning' then 1 else 2 end, f.key
$$;
create function public.stock_reconcile_record() returns int language plpgsql security definer set search_path = pg_catalog, public as $$
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

-- 12. Ownership of everything created above, then lock down privileges
do $$ declare f record; begin
  for f in select p.oid::regprocedure as sig from pg_proc p
            where p.pronamespace in ('public'::regnamespace, 'stock_internal'::regnamespace) and p.proowner = current_user::regrole
              and (p.pronamespace = 'stock_internal'::regnamespace or p.proname like 'stock\_%') loop
    execute format('alter function %s owner to stock_owner', f.sig);
  end loop;
end $$;
-- nobody but the owner has ANY privilege on any stock function until granted below (Supabase's default ACLs would otherwise leave EXECUTE open)
do $$ declare f record; begin
  for f in select p.oid::regprocedure as sig from pg_proc p where p.proowner = 'stock_owner'::regrole loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', f.sig);
  end loop;
end $$;

revoke all on public.stock_control, public.stock_control_log, public.stock_cutover_snapshot, public.stock_legacy_writes, public.app_stock_approvers,
              public.stock_balances, public.stock_operations, public.stock_movements, public.stock_exceptions, public.stock_discrepancies
  from public, anon, authenticated, service_role;
grant select on public.stock_control, public.stock_control_log, public.stock_cutover_snapshot, public.stock_legacy_writes, public.stock_balances,
                public.stock_operations, public.stock_movements, public.stock_exceptions, public.stock_discrepancies, public.app_stock_approvers to authenticated;
grant select, insert, update on public.records to stock_owner;

do $$ declare t text; begin
  for t in select unnest(array['stock_control','stock_control_log','stock_cutover_snapshot','stock_legacy_writes','app_stock_approvers',
                               'stock_balances','stock_operations','stock_movements','stock_exceptions','stock_discrepancies']) loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
    execute format('create policy owner_all on public.%I to stock_owner using (true) with check (true)', t);
    if t = 'app_stock_approvers' then execute format('create policy read_self on public.%I for select to authenticated using (user_id = auth.uid())', t);
    else execute format('create policy read_all on public.%I for select to authenticated using (true)', t); end if;
  end loop;
end $$;
do $$ begin                                     -- if "records" has RLS on, the owner role needs to be able to write the mirror
  if (select relrowsecurity from pg_class where oid = 'public.records'::regclass) then
    execute 'drop policy if exists stock_owner_mirror on public.records';
    execute 'create policy stock_owner_mirror on public.records for all to stock_owner using (true) with check (true)';
  end if;
end $$;

-- API functions: signed-in users only
grant execute on function public.stock_apply(jsonb), public.stock_status(), public.stock_resync_mirror(), public.stock_resolve_exception(bigint, text),
  public.stock_resolve_discrepancy(text, text), public.stock_reconcile(), public.stock_reconcile_record(), public.stock_cutover_status() to authenticated;
-- schema stock_internal is NOT an API schema. The roles that can write "records" (and therefore fire the guard, which runs as the writer)
-- need USAGE + EXECUTE on the few helpers the guard calls; "anon" gets nothing at all.
grant usage on schema stock_internal to authenticated, service_role;
grant execute on function stock_internal.stock_mode(), stock_internal.stock_auth_qty(text), stock_internal.stock_client_ok(), stock_internal.safe_num(jsonb),
  stock_internal.legacy_state(text), stock_internal.log_legacy_write(text, numeric, numeric, numeric, text) to authenticated, service_role;
-- the migrating admin role: also a "records" writer (so same helper access) and the ONLY caller of the admin functions
do $$ begin
  execute format('grant execute on function stock_internal.stock_mode(), stock_internal.stock_auth_qty(text), stock_internal.stock_client_ok(), stock_internal.safe_num(jsonb), stock_internal.legacy_state(text), stock_internal.log_legacy_write(text, numeric, numeric, numeric, text) to %I', current_user);
  execute format('grant execute on function stock_internal.stock_admin_snapshot(text), stock_internal.stock_admin_approver(uuid, text, boolean, text), stock_internal.stock_admin_ack_legacy_writes(text, bigint), stock_internal.stock_admin_control(text, text, boolean, text, text[], text) to %I', current_user);
end $$;

-- 13. Hand-over complete: the admin no longer needs (and no longer has) membership of stock_owner
revoke create on schema public from stock_owner;
revoke create on schema stock_internal from stock_owner;
revoke stock_owner from current_user;

commit;
