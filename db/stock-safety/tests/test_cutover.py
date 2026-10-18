#!/usr/bin/env python3
"""The cutover window (database t3): legacy numbers exist, devices keep working on the old app while openings are prepared.
Run:  ./reset_db.sh t3 && TESTDB=t3 python3 test_cutover.py"""
import os; os.environ['TESTDB'] = 't3'
from common import *
import datetime

def status(): return qs('select stock_internal.stock_cutover_status_data()')[0][0]
def legacy_pass(c, pid, qty, name=None): c.upsert_product(pid, {'name': name or pid, 'unit': 'kg', 'stockQty': qty})
def legacy(pid): r = qs("select data->>'stockQty' from records where store='products' and id=%s", (pid,)); return r[0][0]
def nlog(where='true', params=None): return qs(f'select count(*) from stock_legacy_writes where {where}', params)[0][0]
def err(fn):
    try: fn(); return ''
    except psycopg2.Error as e: return str(e)

print('== A. legacy world: mode off, three tracked products on the old app ==')
for pid, q0 in [('L1', 100), ('L2', 50), ('L3', 30), ('L4', '')]:
    q(su, "insert into records(store,id,data) values ('products',%s,%s::jsonb)", (pid, json.dumps({'name': pid, 'unit': 'kg', 'stockQty': q0})))
adm_call("select stock_internal.stock_admin_approver(%s,'approver@x.test',true,'test')", (A,))
legacy_pass(cb, 'L1', 95)
check('mode off: legacy writes pass through untouched and nothing is logged (nothing is enforced yet)', legacy('L1') in ('95', '95.0') and nlog() == 0)

print('\n== B. T0: server snapshot, then detect-only transition mode ==')
n = adm_call("select stock_internal.stock_admin_snapshot('T0')")[0][0]
check('snapshot of every product\'s legacy stockQty is stored server-side, append-only, with who/when', n == 4 and qs("select count(*) from stock_cutover_snapshot where label='T0'")[0][0] == 4
      and raises(lambda: adm_call("delete from stock_cutover_snapshot"), '42501'))
check('only the admin can take a snapshot', raises(lambda: cb.run("select stock_internal.stock_admin_snapshot('x')"), '42501'))
st = status(); check('status before transition lists the 3 legacy-tracked products as unopened; no drift yet', len(st['unopened_products_with_legacy_stock']) == 3 and st['drift_since_snapshot'] == [], st)
ctl(p_mode='transition', p_note='counting period starts')

print('\n== C. window: old devices keep picking/receiving while approvers count ==')
legacy_pass(cb, 'L1', 90)                         # a real pick on a legacy device (95 -> 90)
legacy_pass(cb, 'L1', 90, name='renamed')         # an unrelated edit, same number
legacy_pass(cb, 'L2', 45)                         # another real pick
rows = qs("select product_id, old_qty, attempted_qty, kept_qty, mode from stock_legacy_writes order by id")
check('every legacy stock change in the window is passed through AND logged (old, new, who); a rename with the same number is not noise',
      [(r[0], float(r[1]), float(r[2]), float(r[3]), r[4]) for r in rows] == [('L1', 95.0, 90.0, 90.0, 'transition'), ('L2', 50.0, 45.0, 45.0, 'transition')], rows)
check('the log records the client user and app version header', qs("select count(*) from stock_legacy_writes where client_user=%s and client_info like 'dockline/%%'", (B,))[0][0] == 2)
st = status(); check('status shows the drift since the snapshot (so counted figures can be compared)', {d['product_id'] for d in st['drift_since_snapshot']} == {'L1', 'L2'} and st['unacknowledged_legacy_writes'] == 2, st)

print('\n== D. openings must not silently overwrite what changed meanwhile ==')
r = ca.apply(op('opening', [L('L1', counted_qty=88, basis='physical_count')]))
check('opening without the legacy figure the approver saw is refused', r['status'] == 'rejected' and r['reasons'][0]['code'] == 'expected_legacy_qty_required' and r['reasons'][0]['detail']['legacy_now'] in (90, 90.0), r)
r = ca.apply(op('opening', [L('L1', counted_qty=88, basis='physical_count', expected_legacy_qty=95)]))
check('opening based on a stale figure (saw 95, legacy is now 90) is REFUSED with both numbers shown', r['status'] == 'rejected' and r['reasons'][0]['code'] == 'legacy_qty_changed' and r['reasons'][0]['detail'] == {'expected': 95, 'legacy_now': 90}, r)
check('nothing was changed by the refusals', bal('L1') is None and legacy('L1') in ('90', '90.0'))
r = ca.apply(op('opening', [L('L1', counted_qty=88, basis='physical_count', expected_legacy_qty=90)]))
rf = qs("select ref, proof from stock_movements where product_id='L1'")[0]
check('opening with the current legacy figure applies; the replaced legacy number is recorded on the movement', r['status'] == 'applied' and bal('L1') == 88 and 'replaced legacy stockQty 90' in rf[0] and rf[1] == 'physical_count', rf)
legacy_pass(cb, 'L2', 44)                          # race: a legacy device picks again AFTER the approver looked, BEFORE the opening
r = ca.apply(op('opening', [L('L2', counted_qty=44, basis='physical_count', expected_legacy_qty=45)]))
check('race: a legacy pick between "approver looked" and "opening recorded" is caught (45 expected, 44 now)', r['status'] == 'rejected' and r['reasons'][0]['code'] == 'legacy_qty_changed', r)
r = ca.apply(op('opening', [L('L2', counted_qty=43, basis='derived', expected_legacy_qty=44)], note='counted 44 then one more pick'))
check('approver re-submits with the new figure and a conscious basis (derived)', r['status'] == 'applied' and bal('L2') == 43)
legacy_pass(cb, 'L1', 85)                          # old device finishes an order AFTER L1 was opened
check('after L1 is opened, a legacy device\'s stock change is NOT applied (authoritative value kept) and is logged with what was kept',
      float(legacy('L1')) == 88 and nlog("product_id='L1' and attempted_qty=85 and kept_qty=88") == 1)

print('\n== E. cutover readiness: nothing is switched on while something is unreviewed ==')
e1 = err(lambda: ctl(p_mode='ignore', p_leave_untracked=[]))
check('blocked: product L3 still has a legacy number and no opening', '55000' in e1 or 'L3' in e1 and 'no opening balance' in e1, e1[:200])
e2 = err(lambda: ctl(p_mode='ignore', p_leave_untracked=['L3']))
check('blocked: unacknowledged legacy writes remain (even though L3 is explicitly listed)', 'unacknowledged legacy stock write' in e2, e2[:200])
check('the admin cannot cut over by listing a wrong set of products', 'no opening balance' in err(lambda: ctl(p_mode='ignore', p_leave_untracked=['L3', 'L4'])))
check('only the admin may acknowledge; a note is mandatory', raises(lambda: cb.run("select stock_internal.stock_admin_ack_legacy_writes('x')"), '42501'))
k = adm_call("select stock_internal.stock_admin_ack_legacy_writes('reviewed: L1/L2 picks during counting are included in the openings; L1 stale push 85 ignored')")[0][0]
r = ctl(p_mode='ignore', p_leave_untracked=['L3'], p_note='L3 deliberately left untracked; its legacy number 30 is discarded')
check(f'after review ({k} writes acknowledged) and an explicit decision about L3, cutover succeeds; cutover_at is stamped', r['mode'] == 'ignore' and r['cutover_at'] is not None, r)
log = qs("select detail from stock_control_log where action='control' order by id desc limit 1")[0][0]
check('the decision (including the product whose number was discarded) is in the append-only control log', log['left_untracked'] == ['L3'] and log['mode_to'] == 'ignore')
legacy_pass(cb, 'L3', 25)
check('L3 (left untracked): a later legacy write is blanked, never applied, and logged', legacy('L3') == '' and nlog("product_id='L3' and attempted_qty=25") == 1)
legacy_pass(cb, 'L2', 40)
check('post-cutover legacy writes on tracked products are rewritten and logged (visible, not blocking)', float(legacy('L2')) == 43 and nlog("product_id='L2' and attempted_qty=40 and kept_qty=43") == 1)

print('\n== F. old devices finishing orders after cutover are DETECTED ==')
cut = qs('select cutover_at from stock_control')[0][0]
q(su, "insert into records(store,id,data) values ('orders','O_legacy_before',%s::jsonb)", (json.dumps({'stockApplied': True, 'completedAt': (cut - datetime.timedelta(hours=1)).isoformat()}),))
q(su, "insert into records(store,id,data) values ('orders','O_legacy_after',%s::jsonb)", (json.dumps({'stockApplied': True, 'completedAt': (cut + datetime.timedelta(minutes=5)).isoformat()}),))
f = {r[3] for r in qs('select product_id,check_code,severity,key,acknowledged from stock_internal.stock_reconcile_rows()')}
check('an order finished (stockApplied) after cutover with no stock operation is flagged; one finished before is not', 'order_without_movement:O_legacy_after' in f and 'order_without_movement:O_legacy_before' not in f, f)
check('unacknowledged legacy writes appear in reconciliation until someone acknowledges them', any(k.startswith('legacy_write:') for k in f))

print('\n== G. offline devices, failed operations, old app versions through rollback and re-enable ==')
ledger0 = qs("select (select count(*) from stock_movements),(select md5(string_agg(product_id||qty::text,',' order by product_id)) from stock_balances)")[0]
offline_op = op('pick', [L('L1', -2, item_id='off1')], order_id='o_offline', client_at=(datetime.datetime.now(datetime.timezone.utc)).isoformat())   # created offline, not yet sent
bad = ca.apply(op('receipt_reversal', [L('L2', -999)]))
check('a correction that fails is stored as REJECTED and stays visible (no automatic retry exists)', bad['status'] == 'rejected' and bool(findings('rejected_operation')))
subprocess.run(['psql', '-q', '-v', 'ON_ERROR_STOP=1', '-h', H, '-p', str(P), '-U', 'pgadmin', '-d', DB, '-f', os.path.join(SQL, '002a_rollback_hold.sql')], check=True, capture_output=True)
check('rollback hold: the offline device\'s queued operation is refused with an explicit error, nothing applied', raises(lambda: ca.apply(offline_op), '55000') and nmv() == ledger0[0])
legacy_pass(cb, 'L1', 12)
check('rollback hold: an old-version device pushing stock is logged and the authoritative value kept', float(legacy('L1')) == 88 and nlog("product_id='L1' and attempted_qty=12") == 1)
check('rollback release is refused until that is reviewed', 'unacknowledged' in err(lambda: ctl(p_mode='off')))
adm_call("select stock_internal.stock_admin_ack_legacy_writes('reviewed: device Y still on the old app; its numbers are discarded, balances stand')")
ctl(p_mode='off'); st = status()
check('release: off + frozen + rolled_back_at; ledger and balances unchanged; the records mirror equals the final balances', st['mode'] == 'off' and st['frozen'] and st['rolled_back_at']
      and qs("select (select count(*) from stock_movements),(select md5(string_agg(product_id||qty::text,',' order by product_id)) from stock_balances)")[0] == ledger0 and float(legacy('L1')) == 88 and float(legacy('L2')) == 43)
legacy_pass(cb, 'L1', 70)                           # legacy world resumes: a real pick of 18 on an old device
check('legacy world resumes: the old app\'s numbers are accepted again (and are the only record of those picks)', float(legacy('L1')) == 70 and bal('L1') == 88)
e = err(lambda: ctl(p_mode='ignore', p_leave_untracked=[]))
check('enforcement is blocked until every tracked product is physically counted since the rollback (message lists them)', 'L1' in e and 'L2' in e and 'physically counted' in e, e[:200])
st = status(); check('status lists exactly those products', st['balances_not_counted_since_rollback'] == ['L1', 'L2'], st)
ctl(p_frozen=False)
check('mode off: even after unfreezing, every stock operation is refused (the legacy guard is off)', 'mode is off' in err(lambda: ca.apply(op('count', [L('L1', counted_qty=69)]))))
ctl(p_mode='transition', p_note='recount period')
g_old = qs("select count_gen from stock_balances where product_id='L1'")[0][0]
offline_op2 = op('pick', [L('L1', -1, item_id='off2', count_gen=g_old)], order_id='o_offline2')       # built by a device that cached the pre-rollback generation
ca.apply(op('count', [L('L1', counted_qty=69)])); ca.apply(op('count', [L('L2', counted_qty=42)]))
r2 = ca.apply(offline_op2)
check('a queued operation carrying the PRE-recount count generation is held (stale_generation) — the recount re-baselined the product', r2['status'] == 'held_for_review' and r2['lines'][0]['code'] == 'stale_generation' and bal('L1') == 69, r2)
r = ca.apply(offline_op)
check('the offline pick that was created BEFORE the recount is not applied (the count already contains it): visible exception, no silent double count',
      r['status'] == 'held_for_review' and r['lines'][0]['code'] == 'stale_before_count' and bal('L1') == 69, r)
check('it stays visible and unresolved until an approver decides (with a note)', bool(findings('unresolved_exception', 'L1')))
eid = qs("select id from stock_exceptions where code='stale_before_count' and resolved_at is null")[0][0]
check('only an approver can resolve it, and a note is required', raises(lambda: cb.run('select public.stock_resolve_exception(%s,%s)', (eid, 'x')), '42501') and raises(lambda: ca.run('select public.stock_resolve_exception(%s,%s)', (eid, '')), '22023'))
ca.run('select public.stock_resolve_exception(%s,%s)', (eid, 'pick happened before the recount; count already includes it'))
r = ctl(p_mode='ignore', p_leave_untracked=[], p_min_client_version='2026-10-17.5', p_note='re-enabled')
check('re-enable succeeds only now; cutover_at is reset; the min app version is set', r['mode'] == 'ignore')
old = Client(B, 'oldapp', ver='dockline/2026-10-01.1')
ctl(p_mode='reject')
check('reject mode: an old app version is refused outright (explicit error, not a silent loss)', raises(lambda: old.upsert_product('L1', {'name': 'x'}), 'P0001'))
check('every step of the above is in the control log with the admin\'s session user', qs("select count(*) from stock_control_log where actor='pgadmin'")[0][0] >= 8)
finish('results_cutover.txt')
