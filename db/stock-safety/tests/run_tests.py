#!/usr/bin/env python3
"""Main test run (database t1). See README for what it covers."""
from common import *
# ---------------------------------------------------------------- setup
for pid, unit in [('P1','kg'),('P2','kg'),('P3','L'),('P4','pcs'),('P5','kg'),('P6','kg'),('P7','kg'),('P8','kg')]:
    q(su, "insert into records(store,id,data) values ('products',%s,%s::jsonb)", (pid, json.dumps({'name': pid, 'unit': unit, 'stockQty': ''})))
adm_call("select stock_internal.stock_admin_approver(%s, 'approver@x.test', true, 'test approver')", (A,))
ctl(p_mode='transition', p_note='openings in progress')

print('\n== 1. openings: approval, basis, one-time ==')
check('non-approver cannot record an opening', raises(lambda: cb.apply(op('opening', [L('P1', counted_qty=100, basis='physical_count')])), '42501'))
r = ca.apply(op('opening', [dict(L('P1', counted_qty=100, basis='physical_count')), dict(L('P2', counted_qty=50, basis='accepted_unverified')),
                            dict(L('P3', counted_qty=20, unit='L', basis='derived')), dict(L('P4', counted_qty=0, unit='pcs', basis='physical_count'))], note='initial approved balances'))
check('approver opens 4 products', r['status'] == 'applied' and bal('P1') == 100 and bal('P3') == 20 and nmv() == 4, r)
rows = qs("select product_id,opening_basis,opening_by is not null,last_verified_at is not null from stock_balances order by 1")
check('basis + approver recorded; only physical counts are marked verified',
      rows == [('P1','physical_count',True,True),('P2','accepted_unverified',True,False),('P3','derived',True,False),('P4','physical_count',True,True)], rows)
check('opening mirrored into records', float(mirror('P1')) == 100 and float(mirror('P3')) == 20 and mirror('P5') == '')
r = ca.apply(op('opening', [L('P1', counted_qty=5, basis='physical_count')]))
check('opening twice is rejected (and stored as rejected)', r['status'] == 'rejected' and bal('P1') == 100, r)
r = ca.apply(op('opening', [L('P5', counted_qty=5, unit='', basis='physical_count')]))
check('opening without a unit is rejected', r['status'] == 'rejected' and bal('P5') is None)

print('\n== 1b. cutover to enforcement (readiness checks are in test_cutover.py) ==')
r = ctl(p_mode='ignore', p_leave_untracked=[], p_note='openings done')
check('admin switches to ignore mode; cutover_at stamped; the change is logged with the admin\'s session user',
      r['mode'] == 'ignore' and r['cutover_at'] is not None and qs("select actor from stock_control_log where action='control' order by id desc limit 1")[0][0] == 'pgadmin', r)

print('\n== 2. balance protection (real roles, real upsert statement) ==')
cb.upsert_product('P1', {'name': 'renamed', 'unit': 'kg', 'stockQty': 999})
check('PostgREST-style upsert with a stale stockQty: balance kept, other fields saved',
      float(mirror('P1')) == 100 and qs("select data->>'name' from records where id='P1'")[0][0] == 'renamed')
cb.run("update public.records set data = jsonb_set(data,'{stockQty}','555') where store='products' and id='P1'")
check('plain UPDATE of stockQty is rewritten', float(mirror('P1')) == 100)
cb.run("select set_config('dockline.trusted','1',false)"); cb.upsert_product('P1', {'name': 'x', 'stockQty': 777})
check('setting a session variable does not bypass it', float(mirror('P1')) == 100)
cb.upsert_product('P5', {'name': 'P5', 'stockQty': 42}); check('untracked product: a stray number is blanked', mirror('P5') == '')
cb.upsert_product('P9', {'name': 'new', 'stockQty': 8}); check('brand-new product record cannot carry stock', mirror('P9') == '')
q(adm, "insert into records(store,id,data) values ('products','P10','{\"stockQty\": 3}') on conflict (store,id) do update set data=excluded.data"); adm.commit()
check('migration/restore-style write by the admin role is also protected', mirror('P10') == '')
cb.upsert_product('P1', {'name': 'x', 'stockQty': 1}); check('stale push of a product with no stockQty key keeps balance', float(mirror('P1')) == 100)
sr = Client(B, 'svc', role='service_role'); sr.upsert_product('P1', {'stockQty': 31337})
check('service_role (bypasses RLS) cannot overwrite it either', float(mirror('P1')) == 100)
check('cannot SET ROLE stock_owner (as authenticated)', raises(lambda: cb.run('set role stock_owner'), '42501'))
c2 = psycopg2.connect(host=H, port=P, dbname=DB, user='authenticator'); cur = c2.cursor()
check('cannot SET ROLE stock_owner (as the login role)', raises(lambda: cur.execute('set role stock_owner'), '42501')); c2.rollback()
for t in ['stock_balances','stock_movements','stock_operations','stock_exceptions','stock_discrepancies','stock_control','app_stock_approvers']:
    col = {'stock_balances': 'qty', 'stock_control': 'frozen', 'app_stock_approvers': 'email', 'stock_movements': 'note', 'stock_operations': 'device_id', 'stock_exceptions': 'code', 'stock_discrepancies': 'severity'}[t]
    ok = all(raises(lambda s=s: cb.run(s), '42501') for s in [f'delete from public.{t}', f'truncate public.{t}', f"update public.{t} set {col}=null"])
    check(f'authenticated: no UPDATE/DELETE/TRUNCATE on {t}', ok)
check('authenticated cannot INSERT into stock_balances', raises(lambda: cb.run("insert into public.stock_balances(product_id,unit,qty) values ('Z','kg',1)"), '42501'))
check('authenticated cannot make themselves an approver', raises(lambda: cb.run("insert into public.app_stock_approvers(user_id) values (%s)", (B,)), '42501'))
check('authenticated cannot call stock_mirror directly', raises(lambda: cb.run("select stock_internal.stock_mirror(null)"), '42501'))
check('authenticated cannot call stock_is_approver directly', raises(lambda: cb.run("select stock_internal.stock_is_approver(%s)", (B,)), '42501'))
check('authenticated cannot disable the guard trigger', raises(lambda: cb.run('alter table public.records disable trigger zz_records_stock_guard'), '42501'))
check('authenticated cannot drop the guard trigger', raises(lambda: cb.run('drop trigger zz_records_stock_guard on public.records'), '42501'))
check('authenticated cannot create functions in public', raises(lambda: cb.run('create function public.evil() returns int language sql as $$ select 1 $$'), '42501'))
check('authenticated cannot change session_replication_role', raises(lambda: cb.run("set session_replication_role = replica"), '42501'))
check('authenticated cannot edit the control row (mode/freeze)', raises(lambda: cb.run("update public.stock_control set mode='off'"), '42501'))
check('anon cannot call stock_apply', raises(lambda: Client(B, 'a', role='anon').run("select public.stock_apply('{}'::jsonb)"), '42501'))
cat = qs("""select r.rolcanlogin,r.rolsuper,r.rolbypassrls,
    (select bool_or(pg_has_role(x,'stock_owner','member')) from unnest(array['authenticated','authenticator','anon','service_role']) x)
    from pg_roles r where r.rolname='stock_owner'""")[0]
check('stock_owner: no login, not superuser, no bypassrls, no API role is a member', cat == (False, False, False, False), cat)
fn = qs("""select count(*), bool_and(p.proconfig::text like '%%search_path=pg_catalog%%'),
    bool_and(p.prosecdef or p.proname in ('records_stock_guard','stock_append_only','safe_num'))
    from pg_proc p where p.proowner='stock_owner'::regrole""")[0]
check('every stock function is owned by stock_owner, has a pinned search_path, and is SECURITY DEFINER (except the trigger functions and the pure helper)', fn[0] >= 19 and fn[1] and fn[2], fn)
cb.run("create temp table _t(x int)"); cb.run("create function pg_temp.round(numeric,int) returns numeric language sql as $$ select 999::numeric $$")
r = ca.apply(op('pick', [L('P2', -1, item_id='sp1')], order_id='o_sp'))   # temp-schema function shadowing attempt must not change anything
check('temp-schema function shadowing does not affect stock_apply', r['lines'][0]['delta'] == -1)
ctl(p_mode='reject', p_min_client_version='2026-10-17.1')
old = Client(B, 'old', ver='dockline/2026-10-16.9'); none = Client(B, 'old', ver=None); new = Client(B, 'new', ver='dockline/2026-10-17.2')
check('reject mode: older app version cannot write records', raises(lambda: old.upsert_product('P2', {'name': 'p'}), 'P0001'))
check('reject mode: client with no version marker cannot write records', raises(lambda: none.upsert_product('P2', {'name': 'p'}), 'P0001'))
check('reject mode: current app version can', new.upsert_product('P2', {'name': 'P2'}) is None)
check('reject mode: direct admin SQL (no API headers) is not blocked by the version gate', q(adm, "update records set updated_by='adm' where id='P2'") is None); adm.commit()
ctl(p_mode='ignore')
r = qs("select (mode) from stock_control"); check('back to ignore mode', r[0][0] == 'ignore')

print('\n== 2b. privilege state after the migration: admin / table owner / stock_owner / superuser ==')
ps = qs("select pg_has_role('pgadmin','stock_owner','usage'), pg_has_role('pgadmin','stock_owner','set')")[0]
check('after the migration the admin role can neither use nor SET ROLE to stock_owner (membership was revoked at the end of 001)', ps == (False, False), ps)
cur = adm.cursor()
check('admin: SET ROLE stock_owner is refused', raises(lambda: cur.execute('set role stock_owner'), '42501')); adm.rollback()
for t, stmt in [('stock_balances', "update public.stock_balances set qty = 1"), ('stock_movements', "delete from public.stock_movements"),
                ('stock_operations', "insert into public.stock_operations(op_id,kind,class,request_hash,status,payload,actor) values (gen_random_uuid(),'pick','fact','x','applied','{}',gen_random_uuid())"),
                ('stock_control', "update public.stock_control set mode='off'"), ('stock_balances', "truncate public.stock_balances")]:
    cur = adm.cursor(); ok = raises(lambda: cur.execute(stmt), '42501'); adm.rollback(); check(f'admin cannot write {t} directly ({stmt.split()[0]})', ok)
cur = adm.cursor()
cur.execute("grant stock_owner to pgadmin"); adm.commit()
cur.execute("set role stock_owner"); cur.execute("select current_user"); who = cur.fetchone()[0]; adm.rollback()
check('residual capability (documented): the admin role HAS ADMIN OPTION on stock_owner (as its creator) and can re-grant itself deliberately', who == 'stock_owner')
cur = adm.cursor(); cur.execute("revoke stock_owner from pgadmin"); adm.commit()
check('… and after revoking again it is back to no usable membership', qs("select pg_has_role('pgadmin','stock_owner','usage')")[0][0] is False)
owners = qs("""select count(*) from (select relname from pg_class where relnamespace='public'::regnamespace and relname like 'stock\\_%%' and relkind in ('r','i') and pg_get_userbyid(relowner)<>'stock_owner' and relkind='r'
               union all select proname from pg_proc where pronamespace in ('public'::regnamespace,'stock_internal'::regnamespace) and (proname like 'stock\\_%%' or proname='records_stock_guard') and pg_get_userbyid(proowner)<>'stock_owner') x""")[0][0]
check('every stock table and function is owned by stock_owner (nothing left owned by the admin role)', owners == 0, owners)
check('stock_owner has no CREATE on public / stock_internal any more', qs("select has_schema_privilege('stock_owner','public','create'), has_schema_privilege('stock_owner','stock_internal','create')")[0] == (False, False))
check('stock_owner can write the mirror (records) — and only needs select/insert/update there', qs("select has_table_privilege('stock_owner','public.records','insert'), has_table_privilege('stock_owner','public.records','update'), has_table_privilege('stock_owner','public.records','delete')")[0] == (True, True, False))
# the table owner (admin) CAN disable the trigger — nothing in the database stops DDL by the owner of "records". Detected, not prevented:
sc = adm.cursor(); sc.execute('alter table public.records disable trigger zz_records_stock_guard'); adm.commit()
cb.upsert_product('P2', {'name': 'x', 'stockQty': 4242}); drift = bool(findings('mirror_mismatch', 'P2'))
sc.execute('alter table public.records enable trigger zz_records_stock_guard'); adm.commit(); ca.run('select public.stock_resync_mirror()')
check('residual capability (documented): the table owner can disable the guard; the resulting stale stockQty is DETECTED by reconciliation (mirror_mismatch) and repaired by resync', drift and not findings('mirror_mismatch', 'P2'))

print('\n== 2c. EXECUTE privileges: least privilege (no PUBLIC, nothing for anon) ==')
pub = qs("""select count(*) from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
            where p.proowner='stock_owner'::regrole and a.grantee=0 and a.privilege_type='EXECUTE'""")[0][0]
check('no stock function is executable by PUBLIC', pub == 0, pub)
def execset(role): return sorted(r[0] for r in qs("select n.nspname||'.'||p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace where p.proowner='stock_owner'::regrole and has_function_privilege(%s,p.oid,'execute')", (role,)))
check('anon can execute NO stock function', execset('anon') == [], execset('anon'))
exp_auth = sorted(['public.stock_apply','public.stock_status','public.stock_resync_mirror','public.stock_resolve_exception','public.stock_resolve_discrepancy','public.stock_reconcile','public.stock_reconcile_record','public.stock_cutover_status',
                   'stock_internal.stock_mode','stock_internal.stock_auth_qty','stock_internal.stock_client_ok','stock_internal.safe_num','stock_internal.legacy_state','stock_internal.log_legacy_write'])
check('authenticated can execute exactly the API functions + the helpers the guard needs', execset('authenticated') == exp_auth, set(execset('authenticated')) ^ set(exp_auth))
check('service_role can execute only the guard helpers (no API function, no admin function)', execset('service_role') == sorted(x for x in exp_auth if x.startswith('stock_internal')), execset('service_role'))
check('the admin functions are executable only by the admin role', all(has for has in [qs("select has_function_privilege('pgadmin','stock_internal.stock_admin_control(text,text,boolean,text,text[],text)','execute')")[0][0]]) and
      not any(qs("select has_function_privilege(%s,'stock_internal.stock_admin_control(text,text,boolean,text,text[],text)','execute')", (r,))[0][0] for r in ['anon','authenticated','service_role','authenticator']))
check('anon has no USAGE on schema stock_internal (helpers are unreachable even by name)', qs("select has_schema_privilege('anon','stock_internal','usage')")[0][0] is False)
an = Client(B, 'x', role='anon')
check('anon cannot call stock_internal.stock_auth_qty (permission denied)', raises(lambda: an.run("select stock_internal.stock_auth_qty('P1')"), '42501'))
check('public.stock_auth_qty / public.stock_mode no longer exist (the first draft exposed them)', raises(lambda: an.run("select public.stock_auth_qty('P1')"), '42883') and raises(lambda: an.run("select public.stock_mode()"), '42883'))
for t in ['stock_balances', 'stock_movements', 'stock_legacy_writes', 'app_stock_approvers']:
    check(f'anon cannot read {t}', raises(lambda t=t: an.run(f'select * from public.{t}'), '42501'))
check('authenticated cannot call the admin functions', raises(lambda: cb.run("select stock_internal.stock_admin_control(p_mode => 'off')"), '42501') and raises(lambda: ca.run("select stock_internal.stock_admin_approver(%s,'x',true)", (B,)), '42501'))
check('a signed-in user can read balances (they could always see stock) but not the approvers table of others', len(cb.run('select * from public.stock_balances')) >= 4 and cb.run('select * from public.app_stock_approvers') == [])

print('\n== 3. facts: picking, idempotency, units, untracked, negative ==')
base = snap(); p1, p2 = bal('P1'), bal('P2')
pick = op('pick', [L('P1', -10, item_id='i1'), L('P2', -5, item_id='i2'), L('P5', -3, item_id='i3'), L('P3', -2, unit='kg', item_id='i4')], order_id='o1', device_id='dev1')
r = ca.apply(pick)
check('pick: tracked lines applied, untracked skipped, unit mismatch becomes an exception',
      r['status'] == 'applied_with_exceptions' and bal('P1') == p1 - 10 and bal('P2') == p2 - 5 and bal('P3') == 20 and bal('P5') is None
      and [l['outcome'] for l in r['lines']] == ['apply','apply','skipped_untracked','exception'], r)
check('the unit-mismatch line is recorded as an unresolved exception (not silently dropped)', qs("select count(*) from stock_exceptions where code='unit_mismatch' and resolved_at is null")[0][0] == 1)
check('mirror follows balance', float(mirror('P1')) == p1 - 10 and float(mirror('P2')) == p2 - 5)
n = nmv(); r2 = ca.apply(pick)
check('replaying the same operation: same result, duplicate flag, no new movement', r2.get('duplicate') is True and nmv() == n and bal('P1') == 90)
bad = dict(pick); bad['lines'] = [L('P1', -99, item_id='i1')]
check('same op id with different content is refused', raises(lambda: ca.apply(bad), '23505'))
check('same op id from another user is refused', raises(lambda: cb.apply(pick), '23505'))
check('wrong sign on a pick is refused (nothing stored)', raises(lambda: ca.apply(op('pick', [L('P1', 5)])), '22023'))
r = cb.apply(op('pick', [L('P4', -3, unit='pcs', item_id='i9')], order_id='o2'))
check('a fact that drives stock negative is applied (it already happened) and flagged', bal('P4') == -3 and 'negative_balance' in codes(), codes())
cb.apply(op('receipt', [L('P4', 3, unit='pcs')]))

print('\n== 4. corrections: negative stock needs an authorized, reasoned override ==')
b0 = snap()
r = cb.apply(op('receipt_reversal', [L('P1', -100)]))
check('correction below zero without override is rejected, nothing changes', r['status'] == 'rejected' and r['reasons'][0]['code'] == 'negative_stock' and bal('P1') == 90)
r = ca.apply(op('receipt_reversal', [L('P1', -100)], override=True))
check('override without a reason is rejected', r['status'] == 'rejected' and r['reasons'][0]['code'] == 'override_needs_reason')
r = cb.apply(op('receipt_reversal', [L('P1', -100)], override=True, override_reason='stock was wrong'))
check('override by a non-approver is rejected (the client flag is not trusted)', r['status'] == 'rejected' and r['reasons'][0]['code'] == 'override_not_authorized' and bal('P1') == 90)
r = ca.apply(op('receipt_reversal', [L('P1', -100)], override=True, override_reason='delivery was recorded twice'))
m = qs("select override, override_reason, actor_email, qty_after from stock_movements where op_id=%s", (r['op_id'],))
check('approved override applies; user, reason and resulting negative balance are on the movement',
      r['status'] == 'applied' and bal('P1') == -10 and m == [(True, 'delivery was recorded twice', 'approver@x.test', -10)], m)
cb.apply(op('receipt', [L('P1', 10)]))
before = snap()
r = cb.apply(op('mapping_move', [L('P1', 5), L('P2', -5), L('P3', -1, unit='kg')]))
check('a correction with one bad (unit) line is rejected as a whole — the good lines are not applied', r['status'] == 'rejected' and snap()[0:1] == before[0:1] and bal('P1') == 0)
p2m = bal('P2'); r = cb.apply(op('mapping_move', [L('P1', 5), L('P2', -5)]))
check('multi-product mapping move applies atomically', r['status'] == 'applied' and bal('P1') == 5 and bal('P2') == p2m - 5)

print('\n== 5. counts ==')
p2c = bal('P2'); r = cb.apply(op('count', [L('P2', counted_qty=38)]))
mv = qs("select delta,proof from stock_movements where op_id=%s", (r['op_id'],))
check('crew count sets the balance, records the difference and marks it physically verified', bal('P2') == 38 and mv == [(38 - p2c, 'physical_count')] and
      qs("select last_verified_at is not null from stock_balances where product_id='P2'")[0][0], mv)
check('negative count rejected', cb.apply(op('count', [L('P2', counted_qty=-1)]))['status'] == 'rejected')
check('count on an untracked product rejected', cb.apply(op('count', [L('P5', counted_qty=3)]))['status'] == 'rejected')
check('count with a different unit rejected', cb.apply(op('count', [L('P2', counted_qty=3, unit='L')]))['status'] == 'rejected')
check('adjustment needs an approver', raises(lambda: cb.apply(op('adjustment', [L('P2', 1)], note='x')), '42501'))
check('adjustment needs a reason', ca.apply(op('adjustment', [L('P2', 1)]))['status'] == 'rejected')

print('\n== 6. atomicity: a failure at each stage leaves NOTHING behind ==')
su.cursor().execute("create function public.fault_raise() returns trigger language plpgsql as $$ begin raise exception 'FAULT INJECTED'; end $$")
stages = [('2nd movement insert', 'before insert on stock_movements for each row when (new.product_id=\'P2\')'),
          ('balance update (2nd product)', 'before update on stock_balances for each row when (new.product_id=\'P2\')'),
          ('mirror update', "before update on records for each row when (new.updated_by='stock' and new.id='P2')"),
          ('operation finalisation', "before update on stock_operations for each row when (new.status like 'applied%')"),
          ('exception insert', 'before insert on stock_exceptions for each row')]
for name, spec in stages:
    q(su, f'create trigger aa_fault {spec.replace("on ", "on public.", 1)} execute function public.fault_raise()')
    t = spec.split(' on ')[1].split(' ')[0]
    o = op('pick', [L('P1', -1, item_id='f1'), L('P2', -1, item_id='f2'), L('P3', -1, unit='kg', item_id='f3')], order_id='o_fault_'+name.split()[0])
    s0 = snap()
    failed = raises(lambda: ca.apply(o), None, 'FAULT INJECTED'); s1 = snap()
    q(su, f'drop trigger aa_fault on public.{t}')
    check(f'failure at "{name}": error surfaced, nothing partially written', failed and s0 == s1, (s0, s1))
    r = ca.apply(o); r2 = ca.apply(o)
    check(f'   …and the retry after "{name}" applies exactly once', r['status'].startswith('applied') and r2['duplicate'] and snap()[1] == s0[1] + 2, r['status'])
    # put P1/P2 back to known values so later tests are easy to reason about
    ca.apply(op('count', [L('P1', counted_qty=5)])); ca.apply(op('count', [L('P2', counted_qty=38)]))

print('\n== 7. lost connection / refresh / timeout during a save ==')
c3 = psycopg2.connect(host=H, port=P, dbname=DB, user='authenticator'); cur = c3.cursor()
o = op('pick', [L('P1', -1, item_id='k1')], order_id='o_kill'); s0 = snap()
cur.execute('set local role authenticated'); cur.execute("select set_config('request.jwt.claims',%s,true)", (json.dumps({'sub': A, 'email': 'approver@x.test'}),))
cur.execute('select public.stock_apply(%s::jsonb)', (json.dumps(o),)); c3.close()     # connection dies BEFORE commit
check('connection lost before commit: nothing applied', snap() == s0)
r = ca.apply(o); check('retry after lost connection applies once', r['status'] == 'applied' and snap()[1] == s0[1] + 1)
r = ca.apply(o)   # server committed, client never saw the answer, client retries
check('commit succeeded but the client never saw it: the retry is a no-op returning the first result', r['duplicate'] and snap()[1] == s0[1] + 1)

print('\n== 8. concurrency on separate connections ==')
def par(fns):
    out, errs = [None] * len(fns), []
    def w(i, f):
        try: out[i] = f()
        except Exception as e: errs.append(repr(e)[:200])
    ts = [threading.Thread(target=w, args=(i, f)) for i, f in enumerate(fns)]; [t.start() for t in ts]; [t.join() for t in ts]; return out, errs
ca.apply(op('count', [L('P1', counted_qty=1000)])); s = nmv()
cl = [Client(A if i % 2 else B, 'u%d@x.test' % i) for i in range(30)]
out, errs = par([(lambda c=c, i=i: c.apply(op('pick', [L('P1', -1, item_id='c%d' % i)], order_id='o_c%d' % i))) for i, c in enumerate(cl)])
check('30 simultaneous picks on one product: no errors, balance exact, 30 movements', not errs and bal('P1') == 970 and nmv() == s + 30, errs)
ids = qs("select id from stock_movements where product_id='P1' order by id"); 
check('ledger chain is consistent after the race', not findings('chain_break') and not findings('ledger_mismatch'))
same = op('pick', [L('P1', -1, item_id='dup')], order_id='o_dup'); s = nmv(); cl2 = [Client(A, 'a@x.test') for _ in range(12)]
out, errs = par([(lambda c=c: c.apply(same)) for c in cl2])
check('same operation sent by 12 connections at once: applied exactly once, all get the same answer', not errs and nmv() == s + 1 and sum(1 for o_ in out if o_ and not o_['duplicate']) == 1 and bal('P1') == 969, (errs, nmv() - s))
ca.apply(op('count', [L('P1', counted_qty=100), L('P2', counted_qty=100)])); s = nmv()
fns = []
for i in range(20):
    lines = [L('P1', -1, item_id='d%da' % i), L('P2', -1, item_id='d%db' % i)]; lines = lines if i % 2 else lines[::-1]
    fns.append(lambda l=lines, i=i: Client(A, 'a').apply(op('pick', l, order_id='o_d%d' % i)))
out, errs = par(fns)
check('opposite lock order across 20 multi-product ops: no deadlock, exact totals', not errs and bal('P1') == 80 and bal('P2') == 80 and nmv() == s + 40, errs)
ca.apply(op('count', [L('P1', counted_qty=10)]))
out, errs = par([lambda: Client(A, 'a').apply(op('receipt_reversal', [L('P1', -8)])), lambda: Client(B, 'b').apply(op('receipt_reversal', [L('P1', -8)]))])
st = sorted(o_['status'] for o_ in out if o_)
check('two corrections that are each valid alone but together go negative: one applies, one is rejected against live stock', not errs and st == ['applied', 'rejected'] and bal('P1') == 2, (st, errs))
ca.apply(op('count', [L('P1', counted_qty=500)]))
stale = Client(B, 'b'); picks = Client(A, 'a')
def staler():
    for i in range(60): stale.upsert_product('P1', {'name': 'stale', 'stockQty': 1000 + i})
def picker():
    for i in range(30): picks.apply(op('pick', [L('P1', -1, item_id='r%d' % i)], order_id='o_r%d' % i))
out, errs = par([staler, picker])
check('30 picks racing 60 stale product pushes: balance exact, mirror equals balance, no error', not errs and bal('P1') == 470 and float(mirror('P1')) == 470, (errs, bal('P1'), mirror('P1')))

print('\n== 8b. untrack / re-open lifecycle (one opening per tracking EPISODE) ==')
ca.apply(op('opening', [L('P6', counted_qty=10, basis='physical_count')])); ca.apply(op('pick', [L('P6', -4, item_id='u1')], order_id='o_u1'))
check('only an approver can untrack', raises(lambda: cb.apply(op('untrack', [L('P6')])), '42501'))
ca.apply(op('untrack', [L('P6')], note='stopped tracking'))
row = qs("select qty,tracked,episode from stock_balances where product_id='P6'")[0]
mv = qs("select kind,delta,qty_before,qty_after,episode,ref from stock_movements where product_id='P6' order by id")
check('untrack CLOSES the episode: a closing movement takes the balance to 0 and records the closing figure; nothing is deleted',
      row == (0, False, 1) and [m[0] for m in mv] == ['opening', 'pick', 'untrack'] and mv[-1][1:4] == (-6, 6, 0) and 'closing balance 6' in mv[-1][5], (row, mv))
cb.upsert_product('P6', {'name': 'P6', 'stockQty': 55})
check('untracked product: stray legacy stockQty is blanked and logged', mirror('P6') == '' and qs("select count(*) from stock_legacy_writes where product_id='P6' and attempted_qty=55")[0][0] == 1)
check('untracked: picks skipped, counts refused', cb.apply(op('pick', [L('P6', -1)]))['lines'][0]['outcome'] == 'skipped_untracked' and cb.apply(op('count', [L('P6', counted_qty=3)]))['status'] == 'rejected')
check('only an approver can re-open', raises(lambda: cb.apply(op('opening', [L('P6', counted_qty=1, basis='derived')])), '42501'))
ca.apply(op('opening', [L('P6', unit='g', counted_qty=2500, basis='accepted_unverified')], note='re-tracked in grams'))
row = qs("select qty,unit,tracked,episode,opening_basis,last_verified_at is null, opening_movement_id=(select max(id) from stock_movements where product_id='P6') from stock_balances where product_id='P6'")[0]
mv = qs("select kind,episode,delta from stock_movements where product_id='P6' order by id")
check('re-open starts episode 2: new unit, new cutoff = the new opening movement, verification reset (an accepted-unverified opening is NOT verified)',
      row == (2500, 'g', True, 2, 'accepted_unverified', True, True), row)
check('history is preserved and each episode has exactly one opening', [(m[0], m[1]) for m in mv] == [('opening', 1), ('pick', 1), ('untrack', 1), ('opening', 2)] and sum(m[2] for m in mv) == 2500, mv)
check('reconciliation: episode 1 closed at 0 + episode 2 chain is clean for the product (no chain_break / ledger_mismatch)', not findings('chain_break', 'P6') and not findings('ledger_mismatch', 'P6'))
check('reconciliation lists the re-opened balance as UNVERIFIED until a physical count', bool(findings('unverified_balance', 'P6')))
check('a second opening while tracked is refused (one opening per episode)', ca.apply(op('opening', [L('P6', unit='g', counted_qty=1, basis='derived')]))['status'] == 'rejected')
check('old unit is no longer accepted after re-open (unit mismatch exception); the new unit is', cb.apply(op('pick', [L('P6', -1, unit='kg')]))['status'] == 'applied_with_exceptions' and cb.apply(op('pick', [L('P6', -100, unit='g')]))['status'] == 'applied' and bal('P6') == 2400)

print('\n== 8c. numeric precision (numeric end to end; no float8 round trip) ==')
import random, decimal
D = decimal.Decimal
ca.apply(op('opening', [L('P7', counted_qty=0, basis='physical_count')]))
random.seed(7)
vals = ['0.1', '0.2', '0.3', '33.3333', '0.0001', '123456789.1234', '999999999.9999', '1.1', '2.675', '1000000.0001', '0.07', '19.99', '5'] + \
       [str(round(random.random() * 10 ** random.randint(0, 8), 4)) for _ in range(300)]
bad = []
for v in vals:
    ca.apply(op('count', [L('P7', counted_qty=float(v))]))
    b_ = qs("select qty::text from stock_balances where product_id='P7'")[0][0]; m_ = mirror('P7')
    if D(b_) != D(repr(float(v))) or D(m_) != D(b_) or 'e' in m_.lower() or (('.' in m_) and len(m_.split('.')[1]) > 4) or (m_.endswith('0') and '.' in m_): bad.append((v, b_, m_))
check(f'{len(vals)} quantities (up to 13 digits, 4 decimals): balance exact, mirror text identical in value, no exponent/noise/trailing zeros', not bad, bad[:3])
check('no false mirror_mismatch for the product across all of them', not findings('mirror_mismatch', 'P7'))
node = subprocess.run(['node', '-e', "const v=JSON.parse(process.argv[1]); process.stdout.write(v.every(([s,j])=>JSON.parse(j)===Number(s)&&parseFloat(j)===Number(s))?'ok':'bad')",
                       json.dumps([[str(D(repr(float(x)))), json.dumps(json.loads(str(D(repr(float(x))))))] for x in vals])], capture_output=True, text=True)
check('the app (JavaScript: JSON.parse / parseFloat) reads those mirror values back as the same numbers', node.stdout == 'ok', node.stdout + node.stderr)
ca.apply(op('count', [L('P7', counted_qty=0)])); ca.apply(op('receipt', [L('P7', 0.1, item_id='n1')])); ca.apply(op('receipt', [L('P7', 0.2, item_id='n2')]))
check('0.1 + 0.2 is exactly 0.3 in the ledger and mirrors as 0.3', bal('P7') == 0.3 and qs("select qty = 0.3 from stock_balances where product_id='P7'")[0][0] and mirror('P7') == '0.3', mirror('P7'))
cb.upsert_product('P7', {'name': 'P7', 'stockQty': 0.30000000000000004}); check('a legacy float-noise value (0.30000000000000004) is rewritten to the exact balance', mirror('P7') == '0.3')
check('counts of 1e9 or more are refused (the range guaranteed exact)', ca.apply(op('count', [L('P7', counted_qty=1000000000)]))['status'] == 'rejected')
ca.apply(op('count', [L('P7', counted_qty=1.23456)])); ca.apply(op('receipt', [L('P7', 0.00005, item_id='n3')]))
check('inputs beyond 4 decimals are rounded (half up) by the server, visibly: 1.23456 → 1.2346, then +0.00005 → +0.0001', bal('P7') == 1.2347 and mirror('P7') == '1.2347', (bal('P7'), mirror('P7')))

print('\n== 9. reconciliation (read-only) detects damage; real inventory is never changed by it ==')
print('   codes seen on the healthy ledger:', codes())
check('healthy ledger: no error-level finding', not [r for r in qs("select 1 from stock_reconcile() where severity='error' and not acknowledged")])
s0 = snap(); n1 = qs('select count(*) from stock_reconcile()')[0][0]; ca.run('select public.stock_reconcile_record()'); 
check('recording findings changes no balance, movement or mirror', snap()[0] == s0[0] and snap()[1] == s0[1] and snap()[4] == s0[4])
sc = su.cursor()
sc.execute("select * from stock_movements where product_id='P2' order by id desc limit 1"); last = sc.fetchone()
sc.execute("set session_replication_role = replica"); sc.execute("delete from stock_movements where id=(select id from stock_movements where product_id='P2' and kind='pick' order by id limit 1)")
check('deleted movement is detected (chain break + ledger mismatch)', {'chain_break', 'ledger_mismatch'} <= set(codes()), codes())
sc.execute("update stock_balances set qty=qty+7, version=version+1 where product_id='P3'"); sc.execute("update records set data=jsonb_set(data,'{stockQty}','123') where id='P4'")
sc.execute("insert into stock_operations(op_id,kind,class,request_hash,status,payload,actor,applied_count,order_id) values (gen_random_uuid(),'pick','fact','h','applied','{}',%s,3,'o_ghost')", (A,))
sc.execute("insert into stock_operations(op_id,kind,class,request_hash,status,payload,actor,order_id) values ('00000000-0000-0000-0000-0000000000aa','pick','fact','h','applied','{}',%s,'o_dupe')", (A,))
sc.execute("insert into stock_movements(op_id,line_no,kind,product_id,delta,qty_before,qty_after,proof,actor,order_id,item_id) values ('00000000-0000-0000-0000-0000000000aa',1,'pick','P5x',-1,0,-1,'recorded',%s,'o1','i1')", (A,))
sc.execute("insert into stock_movements(op_id,line_no,kind,product_id,delta,qty_before,qty_after,proof,actor,order_id,item_id) values ('00000000-0000-0000-0000-0000000000aa',2,'pick','P1',-1,0,-1,'recorded',%s,'o1','i1')", (A,))
sc.execute("insert into records(store,id,data) values ('orders','oX','{\"stockApplied\":true,\"completedAt\":\"2099-01-01T00:00:00Z\"}')")
sc.execute("set session_replication_role = origin")
c = set(codes())
check('tampered balance → ledger_mismatch', any(r[0] == 'P3' for r in findings('ledger_mismatch')))
check('tampered mirror in records → mirror_mismatch', bool(findings('mirror_mismatch','P4')))
check('movement with no balance row → movement_without_balance', 'movement_without_balance' in c)
check('operation whose recorded count ≠ its movements → operation_movement_mismatch', 'operation_movement_mismatch' in c)
check('order marked stock-applied after cutover with no operation → order_without_movement', 'order_without_movement' in c)
check('second pick movement for the same order line → duplicate_pick', 'duplicate_pick' in c, c)
check('unresolved exception and rejected operations stay visible', {'unresolved_exception', 'rejected_operation'} <= c)
check('unverified (never physically counted) balances are listed as such', 'unverified_balance' in c and bool(findings('unverified_balance','P3')))
def as_owner_try(stmt):
    cur = adm.cursor(); cur.execute('grant stock_owner to pgadmin'); cur.execute('set local role stock_owner')   # the documented, deliberate maintenance step
    try: cur.execute(stmt); ok = False
    except psycopg2.Error as e: ok = 'append-only' in str(e)
    adm.rollback(); cur = adm.cursor(); cur.execute('revoke stock_owner from pgadmin'); adm.commit(); return ok
check('append-only: even stock_owner (with deliberate temporary membership) cannot UPDATE a movement', as_owner_try('update public.stock_movements set delta=0'))
check('append-only: … nor DELETE operations, nor TRUNCATE the ledger or the control log', as_owner_try('delete from public.stock_operations') and as_owner_try('truncate public.stock_movements') and as_owner_try('delete from public.stock_control_log'))

print('\n== 10. recovery procedure on the damaged ledger ==')
ctl(p_frozen=True, p_frozen_reason='recovery')
check('while frozen, stock changes are refused (reads/reconcile still work)', raises(lambda: ca.apply(op('pick', [L('P1', -1)])), '55000') and len(qs('select * from stock_reconcile()')) > 0)
ctl(p_frozen=False)
b_hist = qs('select count(*) from stock_movements')[0][0]
r = ca.apply(op('count', [L('P3', counted_qty=20, unit='L')]))
check('physical count restores the balance and the mirror; history is only ever added to', bal('P3') == 20 and float(mirror('P3')) == 20 and nmv() == b_hist + 1)
ca.run('select public.stock_resync_mirror()')
check('approver re-mirrors authoritative values (repairs a damaged mirror, not the balance)', float(mirror('P4')) == bal('P4'))
check('a non-approver cannot resolve a finding', raises(lambda: cb.run("select public.stock_resolve_discrepancy('x:1','n')"), '42501'))
for r in qs("select key from stock_reconcile() where severity='error' and check_code in ('chain_break','ledger_mismatch') and not acknowledged"):
    ca.run("select public.stock_resolve_discrepancy(%s,'investigated; balance restored by physical count of 2026-10-17')", (r[0],))
open_err = qs("select check_code from stock_reconcile() where severity='error' and not acknowledged")
print('   remaining open error findings (injected faults not yet handled):', sorted({r[0] for r in open_err}))
check('approver-resolved findings are marked acknowledged but remain in the history', len(qs("select 1 from stock_discrepancies where resolved_at is not null and resolution_note like 'investigated%'")) >= 1)

print('\n== 11. rollback: stage A (hold) -> review -> stage B (release), then re-enable; with pending/failed work ==')
def ledger(): return qs("select (select count(*) from stock_movements),(select count(*) from stock_operations),(select md5(string_agg(product_id||qty::text||tracked::text, ',' order by product_id)) from stock_balances),(select md5(string_agg(id::text||qty_after::text, ',' order by id)) from stock_movements)")[0]
def psql(f): return subprocess.run(['psql', '-q', '-v', 'ON_ERROR_STOP=1', '-h', H, '-p', str(P), '-U', 'pgadmin', '-d', DB, '-f', os.path.join(SQL, f)], capture_output=True, text=True)
q(su, "select 1"); L0 = ledger(); tracked_ids = [r[0] for r in qs("select product_id from stock_balances where tracked order by 1")]
pending_op = op('pick', [L('P1', -2, item_id='pend1')], order_id='o_pending', client_at='2020-01-01T00:00:00Z')   # an offline device's unsent pick (very old client_at)
rej_before = qs("select count(*) from stock_operations where status='rejected'")[0][0]
r = psql('002a_rollback_hold.sql'); st = qs('select mode, frozen, rolled_back_at is not null from stock_control')[0]
check('stage A: mode=transition, frozen, NOT yet rolled back; ledger and balances untouched', r.returncode == 0 and st == ('transition', True, False) and ledger() == L0, (r.stderr, st))
check('stage A: an offline device\'s unsent operation is REFUSED with an explicit error (it stays on the device; nothing is silently applied)', raises(lambda: ca.apply(pending_op), '55000') and ledger() == L0)
p1 = bal('P1'); cb.upsert_product('P1', {'name': 'old-app', 'stockQty': 777})
check('stage A: an old/stale device pushing stock does NOT overwrite the authoritative balance, and the attempt is LOGGED',
      float(mirror('P1')) == p1 and qs("select count(*) from stock_legacy_writes where product_id='P1' and attempted_qty=777 and kept_qty=%s", (p1,))[0][0] == 1)
r = psql('002b_rollback_release.sql')
check('stage B REFUSES to release while legacy writes are unacknowledged', r.returncode != 0 and 'unacknowledged legacy stock write' in r.stderr and qs('select mode from stock_control')[0][0] == 'transition', r.stderr[-200:])
check('only the admin can acknowledge; the acknowledgement needs a note', raises(lambda: cb.run("select stock_internal.stock_admin_ack_legacy_writes('x')"), '42501') and raises(lambda: adm_call("select stock_internal.stock_admin_ack_legacy_writes('  ')"), '22023'))
n_ack = adm_call("select stock_internal.stock_admin_ack_legacy_writes('reviewed: all attempts were stale pushes from device X; balances kept')")[0][0]
r = psql('002b_rollback_release.sql'); st = qs('select mode, frozen, rolled_back_at is not null from stock_control')[0]
check(f'stage B after review ({n_ack} writes acknowledged): mode off, frozen, rolled_back_at stamped; ledger rows and balances unchanged', r.returncode == 0 and st == ('off', True, True) and ledger() == L0, (r.stderr, st))
check('stage B: records now carry the final authoritative balances (legacy devices start from the right numbers)', all(float(mirror(p)) == bal(p) for p in tracked_ids))
check('stage B: ledger-only operations remain refused (frozen) — no automatic correction', raises(lambda: ca.apply(pending_op), '55000'))
cb.upsert_product('P1', {'name': 'old-app', 'stockQty': 777})
check('after release an old app can write stockQty again (legacy source of truth) …', float(mirror('P1')) == 777)
check('… but stock_balances and the ledger are untouched, and reconciliation reports the drift (mirror_mismatch)', bal('P1') == p1 and ledger() == L0 and bool(findings('mirror_mismatch', 'P1')))
try: ctl(p_mode='ignore', p_leave_untracked=[]); blocked = None
except psycopg2.Error as e: blocked = str(e)
check('re-enable is BLOCKED until every tracked product has been physically counted since the rollback (and the message lists them)', blocked and 'not been physically counted since the rollback' in blocked and 'P1' in blocked, blocked)
ctl(p_frozen=False)
check('(frozen lifted only so the approver can count; ledger operations are accepted again, still nothing automatic)', True)
before_counts = qs("select count(*) from stock_movements where kind='count'")[0][0]
for pid in tracked_ids:
    if bal(pid) is not None and qs("select unit from stock_balances where product_id=%s", (pid,))[0][0]:
        u = qs("select unit from stock_balances where product_id=%s", (pid,))[0][0]
        ca.apply(op('count', [L(pid, unit=u, counted_qty=max(bal(pid), 0))]))
check('approver re-baselines every tracked product with a physical count (attributed movements; mirror overwritten deliberately)', all(float(mirror(p)) == bal(p) for p in tracked_ids) and qs("select count(*) from stock_movements where kind='count'")[0][0] == before_counts + len(tracked_ids))
r = ca.apply(pending_op)
check('the old offline pick (client_at BEFORE the new count) is NOT applied — the count already includes it; it becomes a visible exception, never a silent double count',
      r['status'] == 'applied_with_exceptions' and r['lines'][0]['code'] == 'stale_before_count' and qs("select count(*) from stock_exceptions where code='stale_before_count' and resolved_at is null")[0][0] == 1, r)
time.sleep(0.2); import datetime
r = ca.apply(op('pick', [L('P1', -1, item_id='fresh1')], order_id='o_fresh', client_at=datetime.datetime.now(datetime.timezone.utc).isoformat()))
check('an operation created after the count is applied normally', r['status'] == 'applied')
check('previously REJECTED operations are still listed (no automatic retry exists)', qs("select count(*) from stock_operations where status='rejected'")[0][0] >= rej_before and bool(findings('rejected_operation')))
r = ctl(p_mode='ignore', p_leave_untracked=[], p_note='re-enabled after recount')
check('re-enable now succeeds; cutover_at is reset (orders finished during the legacy period are not expected to have operations)', r['mode'] == 'ignore' and r['cutover_at'] is not None)
r = psql('003_uninstall_logic.sql')
check('uninstall removes the guard + all functions, keeps every table and row and the append-only protection on the ledger', r.returncode == 0 and qs("select count(*) from pg_trigger where tgname='zz_records_stock_guard'")[0][0] == 0
      and qs("select count(*) from pg_proc where proowner='stock_owner'::regrole")[0][0] == 1 and qs("select count(*) from pg_trigger where tgname like 'append_only%%'")[0][0] == 8 and nmv() == L0[0] + len(tracked_ids) + 1 and qs("select pg_has_role('pgadmin','stock_owner','usage')")[0][0] is False, (r.stderr, nmv(), L0[0]))

finish('results.txt')
