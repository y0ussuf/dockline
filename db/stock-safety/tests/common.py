#!/usr/bin/env python3
"""Shared helpers for the tests of db/stock-safety against a REAL PostgreSQL server (every connection below is a separate server connection).
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
def adm_call(sql, params=None):
    """runs as the migrating admin role (pgadmin) — which is NOT a member of stock_owner after the migration"""
    with adm.cursor() as cur:
        try:
            cur.execute(sql, params); r = cur.fetchall() if cur.description else None; adm.commit(); return r
        except Exception:
            adm.rollback(); raise
def ctl(**kw):
    names = ', '.join(f'{k} => %s' for k in kw)
    return adm_call(f'select stock_internal.stock_admin_control({names})', list(kw.values()))[0][0]
def finish(results_file):
    fails = [r for r in results if not r[1]]
    print(f'\n{len(results) - len(fails)} passed, {len(fails)} failed')
    open(os.path.join(HERE, results_file), 'w').write('\n'.join(('PASS ' if ok else 'FAIL ') + n + ((' — ' + str(d)) if d and not ok else '') for n, ok, d in results)
                                                     + f'\n\n{len(results)-len(fails)} passed, {len(fails)} failed\n')
    sys.exit(1 if fails else 0)
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

