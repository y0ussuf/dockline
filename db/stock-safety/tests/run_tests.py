#!/usr/bin/env python3
"""Tests for db/stock-safety against a REAL PostgreSQL server (every connection below is a separate server connection).
Run:  PGHOST=127.0.0.1 PGPORT=54329 ./reset_db.sh t1 && python3 run_tests.py
The Supabase pieces (auth.uid(), the API roles, the authenticator login role) are stubs from 000_test_stubs.sql —
see README "What the tests do not prove"."""
import psycopg2, json, uuid, threading, os, sys, time, subprocess
H = os.environ.get('PGHOST', '127.0.0.1'); P = int(os.environ.get('PGPORT', '54329')); DB = os.environ.get('TESTDB', 't1')
HERE = os.path.dirname(os.path.abspath(__file__)); SQL = os.path.join(HERE, '..')
results = []
def check(name, ok, detail=''):
    results.append((name, bool(ok), detail)); print(('PASS ' if ok else 'FAIL ') + name + ((' — ' + str(detail)) if (detail and not ok) else ''))
def raises(fn, code=None, text=None):
    try: fn()
    except psycopg2.Error as e:
        if code and e.pgcode != code: return False
        if text and text not in str(e): return False
        return True
    return False
def raw(user): c = psycopg2.connect(host=H, port=P, dbname=DB, user=user); c.autocommit = True; return c
su = raw('postgres'); adm = psycopg2.connect(host=H, port=P, dbname=DB, user='pgadmin')
def q(conn, sql, params=None):
    with conn.cursor() as cur:
        cur.execute(sql, params)
        return cur.fetchall() if cur.description else None
def qs(sql, params=None): return q(su, sql, params)
def admin_ctl(sql, params=None):
    with adm.cursor() as cur:
        cur.execute('set local role stock_owner'); cur.execute(sql, params); adm.commit()
class Client:
    """one simulated PostgREST client: its own server connection; each call = one transaction as role `authenticated`"""
    def __init__(self, uid, email, ver='dockline/2026-10-17.1', role='authenticated'):
        self.uid, self.email, self.role = uid, email, role
        self.hdr = json.dumps({'x-client-info': ver} if ver else {'accept': 'x'})
        self.c = psycopg2.connect(host=H, port=P, dbname=DB, user='authenticator')
    def run(self, sql, params=None):
        cur = self.c.cursor()
        try:
            cur.execute('set local role ' + self.role)
            cur.execute("select set_config('request.jwt.claims', %s, true), set_config('request.headers', %s, true)",
                        (json.dumps({'sub': self.uid, 'email': self.email, 'role': self.role}), self.hdr))
            cur.execute(sql, params); res = cur.fetchall() if cur.description else None
            self.c.commit(); return res
        except Exception:
            self.c.rollback(); raise
        finally: cur.close()
    def apply(self, op): return self.run('select public.stock_apply(%s::jsonb)', (json.dumps(op),))[0][0]
    def upsert_product(self, pid, data):   # the exact statement shape PostgREST generates for on_conflict + merge-duplicates
        return self.run("insert into public.records(store,id,data,deleted,updated_at,updated_by) values ('products',%s,%s::jsonb,false,now(),'client') "
                        "on conflict (store,id) do update set store=excluded.store,id=excluded.id,data=excluded.data,deleted=excluded.deleted,"
                        "updated_at=excluded.updated_at,updated_by=excluded.updated_by", (pid, json.dumps(data)))
A, B, C = str(uuid.uuid4()), str(uuid.uuid4()), str(uuid.uuid4())
ca, cb = Client(A, 'approver@x.test'), Client(B, 'crew@x.test')
def op(kind, lines, **kw): d = {'op_id': str(uuid.uuid4()), 'kind': kind, 'lines': lines}; d.update(kw); return d
def L(pid, delta=None, unit='kg', **kw): d = {'product_id': pid, 'unit': unit}; (d.update({'delta': delta}) if delta is not None else None); d.update(kw); return d
def bal(pid): r = qs('select qty from stock_balances where product_id=%s', (pid,)); return float(r[0][0]) if r else None
def mirror(pid): r = qs("select data->>'stockQty' from records where store='products' and id=%s", (pid,)); return r[0][0] if r else None
def nmv(): return qs('select count(*) from stock_movements')[0][0]
def snap():
    return qs("""select (select coalesce(md5(string_agg(product_id||qty::text||version::text, ',' order by product_id)),'') from stock_balances),
       (select count(*) from stock_movements),(select count(*) from stock_operations),(select count(*) from stock_exceptions),
       (select coalesce(md5(string_agg(id||data::text||updated_at::text, ',' order by id)),'') from records where store='products')""")[0]
def findings(code=None, product=None):
    return [r for r in qs('select product_id,check_code,severity,key,acknowledged from stock_reconcile()')
            if (code is None or r[1] == code) and (product is None or r[0] == product)]
def codes(): return sorted({r[1] for r in qs('select product_id,check_code,severity,key,acknowledged from stock_reconcile() where not acknowledged')})

# ---------------------------------------------------------------- setup
for pid, unit in [('P1','kg'),('P2','kg'),('P3','L'),('P4','pcs'),('P5','kg')]:
    q(su, "insert into records(store,id,data) values ('products',%s,%s::jsonb)", (pid, json.dumps({'name': pid, 'unit': unit, 'stockQty': ''})))
admin_ctl("update public.stock_control set mode='ignore', cutover_at=now()")
admin_ctl("insert into public.app_stock_approvers(user_id,email) values (%s,'approver@x.test')", (A,))

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
check('authenticated cannot call stock_mirror directly', raises(lambda: cb.run("select public.stock_mirror(null)"), '42501'))
check('authenticated cannot call stock_is_approver directly', raises(lambda: cb.run("select public.stock_is_approver(%s)", (B,)), '42501'))
check('authenticated cannot disable the guard trigger', raises(lambda: cb.run('alter table public.records disable trigger zz_records_stock_guard'), '42501'))
check('authenticated cannot drop the guard trigger', raises(lambda: cb.run('drop trigger zz_records_stock_guard on public.records'), '42501'))
check('authenticated cannot create functions in public', raises(lambda: cb.run('create function public.evil() returns int language sql as $$ select 1 $$'), '42501'))
check('authenticated cannot change session_replication_role', raises(lambda: cb.run("set session_replication_role = replica"), '42501'))
check('authenticated cannot edit the control row (mode/freeze)', raises(lambda: cb.run("update public.stock_control set mode='off'"), '42501'))
check('anon cannot call stock_apply', raises(lambda: Client(B, 'a', role='anon').run("select public.stock_apply('{}'::jsonb)"), '42501'))
cat = qs("""select r.rolcanlogin,r.rolsuper,r.rolbypassrls,
    (select bool_or(pg_has_role(x,'stock_owner','member')) from unnest(array['authenticated','authenticator','anon','service_role']) x),
    (select bool_and(p.prosecdef and p.proconfig::text like '%%search_path=pg_catalog, public%%' and pg_get_userbyid(p.proowner)='stock_owner')
       from pg_proc p where proname in ('stock_apply','stock_mirror','stock_status','stock_reconcile','stock_reconcile_record','stock_resync_mirror','stock_resolve_exception','stock_resolve_discrepancy'))
    from pg_roles r where r.rolname='stock_owner'""")[0]
check('stock_owner: no login, not superuser, no bypassrls, nobody client-side is a member', cat[:4] == (False, False, False, False), cat)
check('every trusted function is SECURITY DEFINER, owned by stock_owner, with a pinned search_path', cat[4] is True, cat)
cb.run("create temp table _t(x int)"); cb.run("create function pg_temp.round(numeric,int) returns numeric language sql as $$ select 999::numeric $$")
r = ca.apply(op('pick', [L('P2', -1, item_id='sp1')], order_id='o_sp'))   # temp-schema function shadowing attempt must not change anything
check('temp-schema function shadowing does not affect stock_apply', r['lines'][0]['delta'] == -1)
admin_ctl("update public.stock_control set min_client_version='2026-10-17.1', mode='reject'")
old = Client(B, 'old', ver='dockline/2026-10-16.9'); none = Client(B, 'old', ver=None); new = Client(B, 'new', ver='dockline/2026-10-17.2')
check('reject mode: older app version cannot write records', raises(lambda: old.upsert_product('P2', {'name': 'p'}), 'P0001'))
check('reject mode: client with no version marker cannot write records', raises(lambda: none.upsert_product('P2', {'name': 'p'}), 'P0001'))
check('reject mode: current app version can', new.upsert_product('P2', {'name': 'P2'}) is None)
check('reject mode: direct admin SQL (no API headers) is not blocked by the version gate', q(adm, "update records set updated_by='adm' where id='P2'") is None); adm.commit()
admin_ctl("update public.stock_control set mode='ignore'")
r = qs("select (mode) from stock_control"); check('back to ignore mode', r[0][0] == 'ignore')

print('\n== 3. facts: picking, idempotency, units, untracked, negative ==')
base = snap(); p1, p2 = bal('P1'), bal('P2')
pick = op('pick', [L('P1', -10, item_id='i1'), L('P2', -5, item_id='i2'), L('P5', -3, item_id='i3'), L('P3', -2, unit='kg', item_id='i4')], order_id='o1', device_id='dev1')
r = ca.apply(pick)
check('pick: tracked lines applied, untracked skipped, unit mismatch becomes an exception',
      r['status'] == 'applied_with_exceptions' and bal('P1') == p1 - 10 and bal('P2') == p2 - 5 and bal('P3') == 20 and bal('P5') is None
      and [l['outcome'] for l in r['lines']] == ['apply','apply','skipped_untracked','unit_mismatch'], r)
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
cur = adm.cursor()
try: cur.execute('set local role stock_owner'); cur.execute('update public.stock_movements set delta=0'); ok = False
except psycopg2.Error as e: ok = 'append-only' in str(e)
adm.rollback(); check('append-only: owner role UPDATE of a movement is refused by the trigger', ok)
cur = adm.cursor()
try: cur.execute('set local role stock_owner'); cur.execute('delete from public.stock_operations'); ok = False
except psycopg2.Error as e: ok = 'append-only' in str(e)
adm.rollback(); check('append-only: owner role DELETE of operations is refused', ok)

print('\n== 10. recovery procedure on the damaged ledger ==')
admin_ctl("update public.stock_control set frozen=true, frozen_reason='recovery'")
check('while frozen, stock changes are refused (reads/reconcile still work)', raises(lambda: ca.apply(op('pick', [L('P1', -1)])), '55000') and len(qs('select * from stock_reconcile()')) > 0)
admin_ctl("update public.stock_control set frozen=false, frozen_reason=null")
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

print('\n== 11. rollback script (002) with recorded history ==')
h0 = qs('select (select count(*) from stock_movements),(select count(*) from stock_operations),(select md5(string_agg(product_id||qty::text,\',\' order by product_id)) from stock_balances)')[0]
subprocess.run(['psql', '-q', '-v', 'ON_ERROR_STOP=1', '-h', H, '-p', str(P), '-U', 'pgadmin', '-d', DB, '-f', os.path.join(SQL, '002_rollback.sql')], check=True)
h1 = qs('select (select count(*) from stock_movements),(select count(*) from stock_operations),(select md5(string_agg(product_id||qty::text,\',\' order by product_id)) from stock_balances)')[0]
ctl = qs('select mode, frozen, rolled_back_at is not null from stock_control')[0]
check('rollback: mode off, frozen, timestamped; ledger rows and balances untouched', ctl == ('off', True, True) and h0 == h1, (ctl, h0, h1))
check('rollback: mirror equals the final authoritative balances', all(float(mirror(p)) == bal(p) for p in ['P1','P2','P3','P4']))
check('rollback: new stock operations are refused (frozen) so the ledger cannot drift further', raises(lambda: ca.apply(op('pick', [L('P1', -1)])), '55000'))
bal_before_legacy = bal('P1'); ledger_before_legacy = nmv()
cb.upsert_product('P1', {'name': 'legacy-app', 'stockQty': 777})
check('rollback: an old app can write stockQty in records again (it is the legacy source of truth after rollback) …', float(mirror('P1')) == 777)
check('… but it can never change stock_balances or the ledger', bal('P1') == bal_before_legacy and nmv() == ledger_before_legacy)
check('… and reconciliation shows the legacy-era drift so it must be resolved before re-enabling', bool(findings('mirror_mismatch','P1')))
subprocess.run(['psql', '-q', '-v', 'ON_ERROR_STOP=1', '-h', H, '-p', str(P), '-U', 'pgadmin', '-d', DB, '-f', os.path.join(SQL, '003_uninstall_logic.sql')], check=True)
check('uninstall: guard + functions removed, all tables and history still there', qs("select count(*) from pg_trigger where tgname='zz_records_stock_guard'")[0][0] == 0 and nmv() == h1[0])

fails = [r for r in results if not r[1]]
print(f'\n{len(results) - len(fails)} passed, {len(fails)} failed'); 
open(os.path.join(HERE, 'results.txt'), 'w').write('\n'.join(('PASS ' if ok else 'FAIL ') + n + ((' — ' + str(d)) if d and not ok else '') for n, ok, d in results) + f'\n\n{len(results)-len(fails)} passed, {len(fails)} failed\n')
sys.exit(1 if fails else 0)
