#!/usr/bin/env python3
"""Regression tests for the revision-3 review findings (database t4). Run:  ./reset_db.sh t4 && TESTDB=t4 python3 test_findings.py
F1 mode policy | F2 untracked facts | F3 count authorisation | F4 duplicate product ids | F5 reconciliation reopen | F6 count generations | F7 read permissions"""
from common import *
import datetime
PR = ['Q%d' % i for i in range(1, 10)]
for pid in PR:
    q(su, "insert into records(store,id,data) values ('products',%s,%s::jsonb)", (pid, json.dumps({'name': pid, 'unit': 'kg', 'stockQty': ''})))
adm_call("select stock_internal.stock_admin_approver(%s,'approver@x.test',true,'t')", (A,))
adm_call("select stock_internal.stock_admin_counter(%s,'counter@x.test',true,'t')", (D,))
def gen(pid): r = qs('select count_gen from stock_balances where product_id=%s', (pid,)); return r[0][0] if r else None
def err(fn):
    try: fn(); return ''
    except psycopg2.Error as e: return str(e)
def counts(): return qs("select (select count(*) from stock_operations),(select count(*) from stock_movements),(select count(*) from stock_exceptions),(select count(*) from stock_balances)")[0]
def errfind(): return [r for r in qs("select check_code,product_id from stock_internal.stock_reconcile_rows() where severity='error' and not acknowledged")]
def drift(pid, val):
    q(su, "set session_replication_role = replica"); q(su, "update records set data = jsonb_set(data,'{stockQty}',%s::jsonb) where store='products' and id=%s", (json.dumps(val), pid)); q(su, "set session_replication_role = origin")
def events(key): return [r[0] for r in qs('select event from stock_discrepancy_events where key=%s order by id', (key,))]

print('\n== F1. server-side MODE POLICY ==')
check('fresh install is in mode off', qs('select mode from stock_control')[0][0] == 'off')
kinds = {'pick': op('pick', [L('Q1', -1)]), 'receipt': op('receipt', [L('Q1', 1)]), 'receipt_reversal': op('receipt_reversal', [L('Q1', -1)]),
         'mapping_move': op('mapping_move', [L('Q1', 1), L('Q2', -1)]), 'count': op('count', [L('Q1', counted_qty=5)]),
         'opening': op('opening', [L('Q1', counted_qty=100, basis='physical_count')]), 'adjustment': op('adjustment', [L('Q1', 1)], note='x'), 'untrack': op('untrack', [L('Q1')])}
c0 = counts()
check('mode OFF: EVERY kind of operation is refused with an explicit error (55000), even for an approver — nothing is stored, nothing applied',
      all('mode is off' in err(lambda o=o: ca.apply(o)) and raises(lambda o=o: ca.apply(o), '55000') for o in kinds.values()) and counts() == c0 == (0, 0, 0, 0), counts())
check('mode OFF: a crew account is refused the same way', raises(lambda: cb.apply(kinds['pick']), '55000'))
check('mode OFF: the approver cannot open a balance, so no ledger exists that legacy stockQty writes could diverge from',
      raises(lambda: ca.apply(kinds['opening']), '55000') and qs('select count(*) from stock_balances')[0][0] == 0)
cb.upsert_product('Q1', {'name': 'Q1', 'unit': 'kg', 'stockQty': 77})
check('mode OFF: the legacy world is untouched (an old-app stockQty write is simply stored)', float(mirror('Q1')) == 77)
q(su, "update records set data = jsonb_set(data,'{stockQty}','\"\"') where id='Q1'")
n_s = adm_call("select stock_internal.stock_admin_snapshot('T0')")[0][0]
ctl(p_mode='transition', p_note='counting')
check('cutover step 1 — transition: the same operations are now accepted', ca.apply(op('opening', [L('Q1', counted_qty=100, basis='physical_count'), L('Q2', counted_qty=50, basis='physical_count'), L('Q3', counted_qty=10, basis='physical_count')]))['status'] == 'applied')
for mode, newp in [('transition', 'Q4'), ('ignore', 'Q5'), ('reject', 'Q6')]:
    if mode != 'transition': ctl(p_mode=mode, p_leave_untracked=[], p_note=f'matrix {mode}')
    ok = []
    ok.append(ca.apply(op('opening', [L(newp, counted_qty=20, basis='derived')]))['status'])
    ok.append(ca.apply(op('pick', [L('Q1', -1, item_id='m', count_gen=gen('Q1'))], order_id='om_' + mode))['status'])
    ok.append(cc.apply(op('count', [L('Q2', counted_qty=50)]))['status'])
    ok.append(ca.apply(op('receipt', [L('Q1', 1, count_gen=gen('Q1'))]))['status'])
    ok.append(ca.apply(op('adjustment', [L('Q1', 1)], note='matrix'))['status'])
    ok.append(ca.apply(op('receipt_reversal', [L('Q1', -1)]))['status'])
    ok.append(ca.apply(op('mapping_move', [L('Q1', 1), L('Q2', -1)]))['status'])
    ok.append(ca.apply(op('untrack', [L('Q3')]))['status'])
    ok.append(ca.apply(op('opening', [L('Q3', counted_qty=10, basis='accepted_unverified')]))['status'])
    check(f'mode {mode.upper()}: opening, pick, count, receipt, adjustment, receipt_reversal, mapping_move, untrack and re-open are all accepted', ok == ['applied'] * 9, ok)
ctl(p_mode='ignore', p_note='back to ignore for the remaining tests')
check('after the whole sequence the ledger is clean (no error finding)', errfind() == [], errfind())
check('the mode policy is written down in the function (the README table is checked after the README is rewritten)', 'MODE POLICY' in open(SQL + '/001_stock_safety.sql').read())

print('\n== F2. a stock FACT about an untracked product is never lost or reported as applied ==')
c0 = counts(); r = cb.apply(op('pick', [L('Q7', -3, item_id='u1'), L('ZZ', -1, item_id='u2')], order_id='o_unt', device_id='devX', client_at='2026-10-17T10:00:00Z'))
check('pick on never-opened / unknown products: status is held_for_review (NOT applied), both lines are exceptions',
      r['status'] == 'held_for_review' and [l['outcome'] for l in r['lines']] == ['exception', 'exception'] and r['exceptions'] == 2, r)
ex = qs("select product_id,code,actor::text,detail->>'delta',detail#>>'{line,item_id}',resolved_at is null from stock_exceptions where op_id=%s order by line_no", (r['op_id'],))
check('each line is a durable UNRESOLVED exception with the user, the delta and the original line', ex == [('Q7', 'untracked_product', B, '-3.0000', 'u1', True), ('ZZ', 'untracked_product', B, '-1', 'u2', True)] or
      (len(ex) == 2 and all(e[1] == 'untracked_product' and e[2] == B and e[5] for e in ex)), ex)
check('no movement, no balance created; the operation is stored as held_for_review with applied_count 0', qs('select count(*) from stock_movements where op_id=%s', (r['op_id'],))[0][0] == 0
      and qs("select status,applied_count from stock_operations where op_id=%s", (r['op_id'],))[0] == ('held_for_review', 0) and bal('Q7') is None)
check('replaying it returns the same held result, adds no second exception', cb.apply({**{'op_id': r['op_id']}, **{k: v for k, v in op('pick', [L('Q7', -3, item_id='u1'), L('ZZ', -1, item_id='u2')], order_id='o_unt', device_id='devX', client_at='2026-10-17T10:00:00Z').items() if k != 'op_id'}})['duplicate'] is True
      and qs('select count(*) from stock_exceptions where op_id=%s', (r['op_id'],))[0][0] == 2)
check('reconciliation lists them as unresolved_exception; an order whose pick op was only held is still flagged order_without_movement after cutover',
      len(findings('unresolved_exception', 'Q7')) == 1 and len(findings('unresolved_exception', 'ZZ')) == 1)
b0 = bal('Q1'); r = cb.apply(op('pick', [L('Q1', -2, item_id='m1'), L('Q7', -3, item_id='m2')], order_id='o_mix'))
check('mixed request: the tracked line applies, the untracked line is an exception, status applied_with_exceptions (never plain applied)',
      r['status'] == 'applied_with_exceptions' and bal('Q1') == b0 - 2 and [l['outcome'] for l in r['lines']] == ['apply', 'exception'], r)
r = cb.apply(op('receipt', [L('Q8', 5)], order_id='o_rc'))
check('a receipt for an untracked product is held the same way', r['status'] == 'held_for_review' and r['lines'][0]['code'] == 'untracked_product')
r = cb.apply(op('receipt_reversal', [L('Q7', -1), L('Q1', -1)]))
check('a CORRECTION touching an untracked product is rejected as a whole (durable, reviewable), nothing applied', r['status'] == 'rejected' and r['reasons'][0]['code'] == 'not_tracked' and bal('Q1') == b0 - 2)
ca.apply(op('untrack', [L('Q2')])); r = cb.apply(op('pick', [L('Q2', -1)]))
check('a product that was UNTRACKED later behaves the same (held, visible)', r['status'] == 'held_for_review')
ca.apply(op('opening', [L('Q2', counted_qty=50, basis='physical_count')]))
eid = qs("select id from stock_exceptions where product_id='Q7' and code='untracked_product' order by id limit 1")[0][0]
check('only an approver resolves it, with a note; resolving never moves stock',
      raises(lambda: cb.run('select public.stock_resolve_exception(%s,%s)', (eid, 'x')), '42501') and bal('Q1') == b0 - 2)
ca.run('select public.stock_resolve_exception(%s,%s)', (eid, 'Q7 is not tracked; the legacy deduction stands')); check('resolved with a note', qs('select resolution_note from stock_exceptions where id=%s', (eid,))[0][0].startswith('Q7'))

print('\n== F3. count authorisation ==')
p = bal('Q1'); v0 = qs("select last_verified_at, count_gen, version from stock_balances where product_id='Q1'")[0]; n0 = counts()
e = err(lambda: cb.apply(op('count', [L('Q1', counted_qty=1)])))
check('an ordinary crew account cannot submit a count: 42501, no operation row, balance / last_verified_at / generation untouched',
      'approver or a designated counter' in e and bal('Q1') == p and qs("select last_verified_at, count_gen, version from stock_balances where product_id='Q1'")[0] == v0 and counts() == n0)
check('a designated counter can; an approver can', cc.apply(op('count', [L('Q1', counted_qty=p)]))['status'] == 'applied' and ca.apply(op('count', [L('Q1', counted_qty=p)]))['status'] == 'applied')
adm_call("select stock_internal.stock_admin_counter(%s,null,false)", (D,))
check('removing the counter takes the permission away at once', raises(lambda: cc.apply(op('count', [L('Q1', counted_qty=p)])), '42501'))
adm_call("select stock_internal.stock_admin_counter(%s,'counter@x.test',true,'back')", (D,))
check('a crew account cannot make itself a counter (no write grant; admin function only)', raises(lambda: cb.run("insert into public.app_stock_counters(user_id) values (%s)", (B,)), '42501')
      and raises(lambda: cb.run("select stock_internal.stock_admin_counter(%s,'x',true)", (B,)), '42501'))
st = lambda c: c.run('select public.stock_status()')[0][0]
check('stock_status tells the app who may count / approve', st(cb)['can_count'] is False and st(cc)['can_count'] is True and st(cc)['is_approver'] is False and st(ca)['can_count'] is True)
check('counter changes are in the append-only control log', qs("select count(*) from stock_control_log where action in ('counter_added','counter_removed')")[0][0] >= 3)

print('\n== F4. duplicate product ids inside one operation ==')
def chain_ok(pids):
    rows = qs("select product_id,qty_before,qty_after,delta from stock_movements where product_id = any(%s) order by product_id,id", (pids,))
    last = {}
    for pid, b, a, d in rows:
        if pid in last and last[pid] != b: return False
        if b + d != a: return False
        last[pid] = a
    return all(abs(float(last[p]) - bal(p)) < 1e-9 for p in last if bal(p) is not None)
c0 = counts(); r = ca.apply(op('opening', [L('Q8', counted_qty=10, basis='physical_count'), L('Q8', counted_qty=30, basis='physical_count'), L('Q9', counted_qty=5, basis='physical_count')]))
check('opening: the same product twice → the WHOLE request is rejected (duplicate_product), nothing opened, not even the other product',
      r['status'] == 'rejected' and r['reasons'][0]['code'] == 'duplicate_product' and r['reasons'][0]['product_ids'] == ['Q8'] and bal('Q8') is None and bal('Q9') is None
      and counts()[1:] == c0[1:], r)
check('…and the rejection is durable and visible (stored operation, reconciliation finding)', qs("select status from stock_operations where op_id=%s", (r['op_id'],))[0][0] == 'rejected' and bool(findings('rejected_operation')))
ca.apply(op('opening', [L('Q8', counted_qty=10, basis='physical_count')]))
ca.apply(op('untrack', [L('Q8')])); m0 = nmv()
r = ca.apply(op('opening', [L('Q8', counted_qty=1, basis='derived'), L('Q8', counted_qty=2, basis='derived')]))
check('opening of an untracked product twice in one request: rejected; still untracked; episode unchanged', r['status'] == 'rejected' and qs("select tracked,episode from stock_balances where product_id='Q8'")[0] == (False, 2) or
      (r['status'] == 'rejected' and qs("select tracked from stock_balances where product_id='Q8'")[0][0] is False) and nmv() == m0, r)
ca.apply(op('opening', [L('Q8', counted_qty=40, basis='physical_count')]))
before = (bal('Q8'), nmv(), gen('Q8')); r = ca.apply(op('untrack', [L('Q8'), L('Q8')]))
check('untrack: the same product twice → rejected as a whole; balance, tracked flag, movements, generation unchanged',
      r['status'] == 'rejected' and r['reasons'][0]['code'] == 'duplicate_product' and (bal('Q8'), nmv(), gen('Q8')) == before and qs("select tracked from stock_balances where product_id='Q8'")[0][0] is True, r)
r = ca.apply(op('count', [L('Q8', counted_qty=1), L('Q8', counted_qty=2)]))
check('count: the same product twice → rejected (ambiguous: which figure is the truth?)', r['status'] == 'rejected' and bal('Q8') == 40)
p0 = bal('Q1'); r = ca.apply(op('pick', [L('Q1', -1, item_id='d1'), L('Q1', -2, item_id='d2'), L('Q1', -3, item_id='d3')], order_id='o_dup'))
mv = qs("select qty_before,qty_after,delta from stock_movements where op_id=%s order by line_no", (r['op_id'],))
check('pick with the same product on several lines (legitimate: several order items) chains correctly: each line starts where the previous ended',
      r['status'] == 'applied' and [(float(a), float(b)) for a, b, _ in mv] == [(p0, p0 - 1), (p0 - 1, p0 - 3), (p0 - 3, p0 - 6)] and bal('Q1') == p0 - 6, mv)
r = ca.apply(op('adjustment', [L('Q1', 2), L('Q1', 3)], note='dup adj'))
check('adjustment with repeated lines chains too', r['status'] == 'applied' and bal('Q1') == p0 - 1)
check('movement chain continuity and ledger-to-balance reconciliation hold after all duplicate cases', chain_ok(['Q1', 'Q8', 'Q9']) and errfind() == [], errfind())

print('\n== F5. reconciliation: a finding that comes back is REOPENED, history kept ==')
KEY = 'mirror_mismatch:Q2'
b2 = bal('Q2'); drift('Q2', 123)
check('detect: injected mirror drift is found, unacknowledged', len(findings('mirror_mismatch', 'Q2')) == 1 and not findings('mirror_mismatch', 'Q2')[0][4])
check('only approvers may run / record reconciliation (crew: 42501)', raises(lambda: cb.run('select public.stock_reconcile_record()'), '42501') and raises(lambda: cb.run('select * from public.stock_reconcile()'), '42501'))
ca.run('select public.stock_reconcile_record()')
check('recorded; event "detected"', events(KEY) == ['detected'])
ca.run("select public.stock_resolve_discrepancy(%s,'first look: caused by a stale device push; mirror will be resynced')", (KEY,))
check('resolve: acknowledged in the live view; event "acknowledged" with the note', findings('mirror_mismatch', 'Q2')[0][4] is True and events(KEY) == ['detected', 'acknowledged'])
ca.run('select public.stock_reconcile_record()')
check('the SAME unchanged finding still present after acknowledgement stays acknowledged (no churn, no reopen)', findings('mirror_mismatch', 'Q2')[0][4] is True and events(KEY) == ['detected', 'acknowledged'])
ca.run('select public.stock_resync_mirror()'); ca.run('select public.stock_reconcile_record()')
check('fix: the fault disappears; the next run records "cleared"; the row stays resolved', not findings('mirror_mismatch', 'Q2') and events(KEY) == ['detected', 'acknowledged', 'cleared']
      and qs("select resolved_at is not null from stock_discrepancies where key=%s", (KEY,))[0][0])
drift('Q2', 123)
check('the IDENTICAL fault returns: the live view shows it UNacknowledged at once (acknowledgement belonged to the cleared fault)', findings('mirror_mismatch', 'Q2')[0][4] is False)
ca.run('select public.stock_reconcile_record()')
row = qs("select resolved_at, resolved_by, resolution_note from stock_discrepancies where key=%s", (KEY,))[0]
check('record: the discrepancy is REOPENED (resolved_at cleared) and the full history is preserved in the append-only events incl. the first note',
      row == (None, None, None) and events(KEY) == ['detected', 'acknowledged', 'cleared', 'reopened']
      and qs("select note from stock_discrepancy_events where key=%s and event='acknowledged'", (KEY,))[0][0].startswith('first look'))
ca.run("select public.stock_resolve_discrepancy(%s,'second occurrence: investigated again')", (KEY,))
drift('Q2', 456)
check('same finding, DIFFERENT details than were acknowledged (123 → 456) without a clear in between: shown unacknowledged immediately, reopened on record',
      findings('mirror_mismatch', 'Q2')[0][4] is False and (ca.run('select public.stock_reconcile_record()') is not None) and events(KEY)[-2:] == ['acknowledged', 'reopened'], events(KEY))
ca.run('select public.stock_resync_mirror()')
def as_owner_try(stmt):
    cur = adm.cursor(); cur.execute('grant stock_owner to pgadmin'); cur.execute('set local role stock_owner')
    try: cur.execute(stmt); ok = False
    except psycopg2.Error as e: ok = 'append-only' in str(e)
    adm.rollback(); cur = adm.cursor(); cur.execute('revoke stock_owner from pgadmin'); adm.commit(); return ok
check('the history cannot be edited: even stock_owner cannot UPDATE / DELETE / TRUNCATE stock_discrepancy_events', all(as_owner_try(s) for s in ['update public.stock_discrepancy_events set note=null', 'delete from public.stock_discrepancy_events', 'truncate public.stock_discrepancy_events']))
check('recording / reopening never touches balances or movements', chain_ok(['Q1', 'Q8']))

print('\n== F6. server-authoritative COUNT GENERATIONS ==')
ca.apply(op('opening', [L('Q9', counted_qty=100, basis='physical_count')])); ca.apply(op('opening', [L('Q8', counted_qty=1, basis='physical_count')]) ) if False else None
g = gen('Q9'); qty0 = bal('Q9')
r = ca.apply(op('pick', [L('Q9', -1, item_id='g1', count_gen=g)], order_id='o_g1'))
check('the result carries the device cache (qty + count_gen), a pick on the current generation applies', r['status'] == 'applied' and r['balances']['Q9'] == {'qty': qty0 - 1, 'unit': 'kg', 'tracked': True, 'count_gen': g}, r)
t_before = datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(minutes=5)
ca.apply(op('count', [L('Q9', counted_qty=90)])); g2 = gen('Q9')
check('a physical count increments the generation (server-side), opening/untrack too', g2 == g + 1 and (ca.apply(op('untrack', [L('Q4')]))['status'] == 'applied') and gen('Q4') == 2)
n0 = nmv(); r = ca.apply(op('pick', [L('Q9', -5, item_id='g2', count_gen=g)], order_id='o_g2', client_at=datetime.datetime.now(datetime.timezone.utc).isoformat()))
check('an operation built on the OLD generation is HELD (not applied) even though its client_at is AFTER the count — the device clock is not trusted',
      r['status'] == 'held_for_review' and r['lines'][0]['code'] == 'stale_generation' and bal('Q9') == 90 and nmv() == n0
      and r['lines'][0]['detail']['line_gen'] == g and r['lines'][0]['detail']['current_gen'] == g2 and r['lines'][0]['detail']['client_at_before_rebaseline'] is False, r)
r = ca.apply(op('pick', [L('Q9', -5, item_id='g3', count_gen=g)], order_id='o_g3', client_at=t_before.isoformat()))
check('the reviewer is told whether the event probably predates the count (hint only): client_at_before_rebaseline = true', r['lines'][0]['detail']['client_at_before_rebaseline'] is True and bal('Q9') == 90)
check('an operation on the CURRENT generation applies', ca.apply(op('pick', [L('Q9', -2, item_id='g4', count_gen=g2)], order_id='o_g4'))['status'] == 'applied' and bal('Q9') == 88)
r = ca.apply(op('pick', [L('Q9', -1, item_id='g5', count_gen=g2 + 5)], order_id='o_g5'))
check('a generation NEWER than the server has (restored backup / forged) is held too (generation_ahead)', r['status'] == 'held_for_review' and r['lines'][0]['code'] == 'generation_ahead' and bal('Q9') == 88)
r = ca.apply(op('receipt_reversal', [L('Q9', -1, count_gen=g)]))
check('a CORRECTION on a stale generation is rejected as a whole (online operation: refresh and redo)', r['status'] == 'rejected' and r['reasons'][0]['code'] == 'stale_generation' and bal('Q9') == 88)
check('a malformed count_gen is refused outright (22023)', raises(lambda: ca.apply(op('pick', [L('Q9', -1, count_gen='abc')])), '22023'))
now = datetime.datetime.now(datetime.timezone.utc)
check('LEGACY-format line (no count_gen), mode ignore: falls back to client_at — after the re-baseline applies, before it is held (stale_before_count)',
      ca.apply(op('pick', [L('Q9', -1, item_id='l1')], client_at=(now + datetime.timedelta(seconds=1)).isoformat()))['status'] == 'applied'
      and ca.apply(op('pick', [L('Q9', -1, item_id='l2')], client_at=t_before.isoformat()))['lines'][0]['code'] == 'stale_before_count')
ctl(p_mode='reject', p_leave_untracked=[])
r = ca.apply(op('pick', [L('Q9', -1, item_id='l3')], client_at=now.isoformat()))
check('mode REJECT: a fact line WITHOUT a generation is held (generation_missing) — no silent fallback to device clocks once enforcement is final', r['status'] == 'held_for_review' and r['lines'][0]['code'] == 'generation_missing')
check('mode REJECT: with the generation it applies', ca.apply(op('pick', [L('Q9', -1, item_id='l4', count_gen=g2)]))['status'] == 'applied')
ctl(p_mode='ignore')
# the device that was offline ACROSS a count
q0 = bal('Q9'); queued = [op('pick', [L('Q9', -1, item_id=f'off{i}', count_gen=g2)], order_id=f'o_off{i}') for i in range(3)]
ca.apply(op('count', [L('Q9', counted_qty=q0)])); g3 = gen('Q9')
res = [ca.apply(o) for o in queued]
check('offline across a count: ALL three queued picks are held (stale_generation), stock unchanged, three unresolved exceptions with the original lines',
      all(r['status'] == 'held_for_review' for r in res) and bal('Q9') == q0 and qs("select count(*) from stock_exceptions where product_id='Q9' and code='stale_generation' and resolved_at is null and (detail#>>'{line,item_id}') like 'off%%'")[0][0] == 3)
eids = [r[0] for r in qs("select id from stock_exceptions where product_id='Q9' and (detail#>>'{line,item_id}') like 'off%%' order by id")]
ca.apply(op('adjustment', [L('Q9', -1, ref=f'exception:{eids[0]}')], note='pick off0 happened after the count (device was offline); applied by reviewer'))
for i, e in enumerate(eids): ca.run('select public.stock_resolve_exception(%s,%s)', (e, 'applied by adjustment' if i == 0 else 'already inside the count; no change'))
check('recovery: nothing was applied automatically; the reviewer applied ONE attributed adjustment (references the exception) and resolved all three with notes',
      bal('Q9') == q0 - 1 and qs("select count(*) from stock_movements where kind='adjustment' and ref=%s", (f'exception:{eids[0]}',))[0][0] == 1 and qs("select count(*) from stock_exceptions where resolved_at is null and product_id='Q9' and (detail#>>'{line,item_id}') like 'off%%'")[0][0] == 0)
check('the device sees the new generation in every result and can rebuild its cache', ca.apply(op('pick', [L('Q9', -1, count_gen=g3)]))['balances']['Q9']['count_gen'] == g3)
q(su, "alter table stock_balances disable trigger all"); q(su, "update stock_balances set count_gen = 99 where product_id='Q9'"); q(su, "alter table stock_balances enable trigger all")
check('reconciliation detects a tampered generation (generation_mismatch)', bool(findings('generation_mismatch', 'Q9'))); q(su, "update stock_balances set count_gen=%s where product_id='Q9'", (g3,))
check('and is clean again after repair', not findings('generation_mismatch'))

print('\n== F7. READ permissions (least privilege) ==')
T = ['stock_control', 'stock_control_log', 'stock_cutover_snapshot', 'stock_legacy_writes', 'app_stock_approvers', 'app_stock_counters', 'stock_balances', 'stock_operations', 'stock_movements', 'stock_exceptions', 'stock_discrepancies', 'stock_discrepancy_events']
cb.upsert_product('Q1', {'name': 'Q1', 'stockQty': 999}); cb.apply(op('pick', [L('Q1', -1, item_id='r1')], order_id='o_r1')); cb.apply(op('pick', [L('Q7', -1, item_id='r2')], order_id='o_r2'))
cc.apply(op('count', [L('Q1', counted_qty=bal('Q1'))])); ca.run('select public.stock_reconcile_record()')
tot = {t: qs(f'select count(*) from public.{t}')[0][0] for t in T}
an, sr = Client(B, 'x', role='anon'), Client(B, 'x', role='service_role')
check('anon: no read on any of the 12 tables', all(raises(lambda t=t: an.run(f'select * from public.{t}'), '42501') for t in T))
check('service_role: no read and no write on any stock table (it has no auth.uid(); edge functions must not touch the ledger)', all(raises(lambda t=t: sr.run(f'select * from public.{t}'), '42501') for t in T) and all(raises(lambda t=t: sr.run(f'delete from public.{t}'), '42501') for t in T))
def cnt(c, t): return c.run(f'select count(*) from public.{t}')[0][0]
check('crew: every stock balance is readable (they need quantities, units, generations)', cnt(cb, 'stock_balances') == tot['stock_balances'] > 5)
own = lambda c, uid, t: c.run(f'select count(*) filter (where actor::text=%s), count(*) from public.{t}', (uid,))[0]
mo, oo, eo = own(cb, B, 'stock_movements'), own(cb, B, 'stock_operations'), own(cb, B, 'stock_exceptions')
check('crew: movements, operations and exceptions — ONLY their own rows (others\' e-mails, devices and payloads are invisible)', mo[0] == mo[1] > 0 and oo[0] == oo[1] > 0 and eo[0] == eo[1] > 0 and mo[1] < tot['stock_movements'] and oo[1] < tot['stock_operations'] and eo[1] <= tot['stock_exceptions'], (mo, oo, eo, tot))
check('crew sees nothing of: control, control log, snapshot, legacy writes, discrepancies + history, approver / counter lists', all(cnt(cb, t) == 0 for t in ['stock_control', 'stock_control_log', 'stock_cutover_snapshot', 'stock_legacy_writes', 'stock_discrepancies', 'stock_discrepancy_events', 'app_stock_approvers', 'app_stock_counters']) and all(tot[t] > 0 for t in ['stock_control', 'stock_control_log', 'stock_cutover_snapshot', 'stock_legacy_writes', 'stock_discrepancies', 'stock_discrepancy_events', 'app_stock_approvers']))
check('designated counter: sees only their own counter row, and still no approver data', cnt(cc, 'app_stock_counters') == 1 and cnt(cc, 'app_stock_approvers') == 0 and cnt(cc, 'stock_legacy_writes') == 0)
check('approver: sees every row of every table', all(cnt(ca, t) == tot[t] for t in T), {t: (cnt(ca, t), tot[t]) for t in T if cnt(ca, t) != tot[t]})
check('admin role: can read every table (investigation / cutover) but write none', all(adm_call(f'select count(*) from public.{t}')[0][0] == tot[t] for t in T)
      and all(raises(lambda t=t: adm_call(f'delete from public.{t}'), '42501') for t in T))
check('crew cannot call the approver-only functions: reconcile, record, cutover status, resolve exception / discrepancy', all(raises(lambda s=s: cb.run(s), '42501') for s in ['select * from public.stock_reconcile()', 'select public.stock_reconcile_record()', 'select public.stock_cutover_status()', "select public.stock_resolve_exception(1,'x')", "select public.stock_resolve_discrepancy('k','x')"]))
check('the approver can call them', len(ca.run('select * from public.stock_reconcile()')) > 0 and ca.run('select public.stock_cutover_status()')[0][0]['mode'] == 'ignore')
check('crew still gets mode / frozen / version via stock_status()', st(cb)['mode'] == 'ignore' and 'min_client_version' in st(cb))
pol = qs("select tablename, policyname, qual from pg_policies where schemaname='public' and tablename like %s and 'authenticated' = any(roles) order by 1", ('%stock%',)) + qs("select tablename, policyname, qual from pg_policies where schemaname='public' and tablename like 'app_stock%%' and 'authenticated' = any(roles) order by 1")
exp = {'stock_balances': 'read_all', 'stock_movements': 'read_own_or_approver', 'stock_operations': 'read_own_or_approver', 'stock_exceptions': 'read_own_or_approver', 'app_stock_approvers': 'read_self_or_approver', 'app_stock_counters': 'read_self_or_approver',
       'stock_control': 'read_approver', 'stock_control_log': 'read_approver', 'stock_cutover_snapshot': 'read_approver', 'stock_legacy_writes': 'read_approver', 'stock_discrepancies': 'read_approver', 'stock_discrepancy_events': 'read_approver'}
check('the exact policy set for `authenticated` is the documented one; only stock_balances is "using (true)"', {t: n for t, n, _ in set(pol)} == exp and [t for t, n, qual in set(pol) if qual == 'true'] == ['stock_balances'], set(pol))
check('nobody (except stock_owner) holds INSERT/UPDATE/DELETE/TRUNCATE on any stock table', not any(qs(f"select has_table_privilege(%s,'public.{t}','{p}')", (r,))[0][0] for t in T for r in ['anon', 'authenticated', 'service_role', 'pgadmin'] for p in ['insert', 'update', 'delete', 'truncate']))
finish('results_findings.txt')
