# Dockline stock safety — design for review (phase 1), revision 2

**Status: NOT APPLIED anywhere. No production change, no app change, no real data touched.**
Everything was run only against a throw-away PostgreSQL 16 server in a sandbox.

| File | What it is |
|---|---|
| `001_stock_safety.sql` | the migration (additive only; enforcement starts **off**) |
| `002a_rollback_hold.sql`, `002b_rollback_release.sql` | two-stage rollback; keeps all history |
| `003_uninstall_logic.sql` | optional: removes guard + functions; keeps every table/row and the append-only protection |
| `verify_privileges.sql` | read-only privilege check to run on Supabase after applying |
| `SUPABASE_CHECKS.md` | the exact checks for a disposable Supabase branch (**none run yet**) |
| `000_test_stubs.sql` | TEST ONLY: stands in for Supabase's roles/`auth` schema |
| `tests/` | `run_tests.py` (162 checks), `test_cutover.py` (38 checks), `common.py`, `reset_db.sh`, last outputs `results*.txt` |
| `../../tools/stock-legacy-report.js` | read-only report on a Dockline backup file |

## 0. What changed since revision 1 (answers to your 7 review points)

| # | Point | Result |
|---|---|---|
| 1 | `stock_owner` membership | The admin's explicit membership is now **revoked at the end of 001**. Admin day-to-day actions are `stock_internal.stock_admin_*` functions, so no membership is needed. Details §1. |
| 2 | PUBLIC EXECUTE | **Real exposure found and fixed**: in revision 1, `public.stock_auth_qty()` was executable by PUBLIC, so an unauthenticated (`anon`) caller could read any product's balance (reproduced on the old draft: `anon` got `42`). Helpers now live in a non-API schema, `anon` has no access to anything, every function ACL is explicit. §2. |
| 3 | Cutover race | New `transition` mode (detect, don't overwrite), server snapshot, `expected_legacy_qty` check on openings, an admin-only cutover that refuses while anything is unreviewed. Exact sequence §5. |
| 4 | Untrack / re-open | An opening is one per **tracking episode**, not one per product. Untrack writes a closing movement to 0; re-open starts episode 2. §6. |
| 5 | Numeric precision | The `float8` conversion is gone: numeric is mirrored as numeric (`trim_scale`), range/scale enforced by CHECK constraints. §7. |
| 6 | Supabase plan | `SUPABASE_CHECKS.md` + `verify_privileges.sql`. Nothing claimed as tested there. §10. |
| 7 | Recovery / rollback | Two-stage rollback, re-enable blocked until recount, pending offline ops handled explicitly (`stale_before_count`), no automatic correction. §9. |

Two other bugs the new tests found in my own draft, now fixed: three helper functions were left owned by the admin role instead of `stock_owner`; the append-only trigger raised a confusing error for movements.

## 1. Roles, ownership, and the membership question

Four different kinds of power, which are not the same thing:

| Who | What they can do | What they cannot do |
|---|---|---|
| **PostgreSQL superuser** (Supabase does not give you one; locally `postgres`) | anything, including bypassing triggers/RLS | — (cannot be restrained by the database; only detected by reconciliation) |
| **Table owner of `records` / migrating admin** (Supabase: `postgres`) | write `records` (guard still rewrites `stockQty`), call `stock_admin_*`, run migrations, `ALTER TABLE records DISABLE TRIGGER` (**tested: possible**) | read or write the stock tables directly (tested: permission denied), `SET ROLE stock_owner` (tested: refused) |
| **`stock_owner`** (NOLOGIN, owns every stock table/function) | only ever executes inside the SECURITY DEFINER functions; has `select/insert/update` (no delete) on `records` for the mirror; no CREATE on any schema | log in; be impersonated by an API role (no one else is a member) |
| **API roles** `anon` / `authenticated` / `service_role` | `authenticated`: SELECT on the stock tables, EXECUTE on the API functions | any write to any stock table, anything for `anon`, admin functions |

**Does the migration's membership persist?** No. 001 does `grant stock_owner to current_user` only so it can transfer ownership (and temporarily gives `stock_owner` CREATE on two schemas); the last statements revoke both. Tested: afterwards `pg_has_role(admin,'stock_owner','usage')` is false and `SET ROLE stock_owner` is refused.
**Residual capability, stated plainly:** on PostgreSQL 16 the role that *created* `stock_owner` keeps ADMIN OPTION on it (not usable for `SET ROLE`), so the admin can deliberately re-grant itself membership for maintenance (`003` does exactly this, then revokes). Tested. Anyone who can do that is already as powerful as the table owner. **Unverified on Supabase:** PostgreSQL 15 treats CREATEROLE differently (check 1.2 in `SUPABASE_CHECKS.md`).
Routine admin work needs no membership: `stock_admin_control` (mode, freeze, app version), `stock_admin_snapshot`, `stock_admin_approver`, `stock_admin_ack_legacy_writes`. They are executable **only** by the admin role; every call is written to the append-only `stock_control_log` with the session user.

## 2. EXECUTE grants — least privilege

* Revision 1 problem (reproduced): `stock_mode()` / `stock_auth_qty()` had PUBLIC EXECUTE and were SECURITY DEFINER, so any caller with the anon key could call `rpc/stock_auth_qty` and read any balance.
* Now: `REVOKE ALL` on every stock function from PUBLIC/anon/authenticated/service_role in a loop (Supabase's default ACLs would otherwise re-open them), then explicit grants:
  * `authenticated`: exactly the 8 API functions + the 6 helpers the guard needs (tested: exact set equality).
  * `service_role`: only the guard helpers. `anon`: **nothing**, and no USAGE on schema `stock_internal`.
  * admin functions: the admin role only.
* Helpers sit in schema `stock_internal`, which must **not** be an exposed API schema (check 0.8/2.3). Even if it were exposed, `anon` has no usage and `authenticated` can only read what it can already `SELECT`.
* Why writers need EXECUTE at all: the guard is a trigger running as the *writer* (it has to, to know who the writer is — see §3). Any role that writes `records` therefore needs the few helpers; a role without them gets a hard error (fails closed, never bypasses).
* `verify_privileges.sql` checks all of this and was shown to fail when a bad grant is added.

## 3. Balance protection (unchanged principle)
`stock_balances` is authoritative; `stockQty` inside a `records` product is only a mirror. The `BEFORE INSERT OR UPDATE` guard on `records` rewrites `stockQty` to the authoritative value unless `current_user = 'stock_owner'` — which is true only while a SECURITY DEFINER function owned by it runs; there is no session variable to forge. Modes: **off** (nothing), **transition** (products with a balance protected + logged; products without one pass through *and are logged*), **ignore** (all protected, unopened products blanked, every attempt logged), **reject** (+ refuse API clients without a current `x-client-info`; not a security boundary, only stops honest old apps). Every rewritten/blanked/passed attempt lands in `stock_legacy_writes` (old, attempted, kept, user, app version, time).

## 4. Offline operations (design for the app; server side built and tested)
* **Facts** (`pick`, `receipt`) are always accepted, even offline, even if stock goes negative (flagged). **Corrections, counts, openings, adjustments** need a connection and live validation; negatives need an approver's override with a reason.
* Every operation has a UUID created once and stored on the device in the same local transaction as the order/receipt change; states `pending → sending → applied | applied_with_exceptions | rejected | failed`; never deleted when sent.
* Retries/double-clicks/timeouts: the server's unique `op_id` returns the first result (`duplicate:true`); same id with different content or another user is refused (tested incl. 12 simultaneous identical requests, lost connection before commit, committed-but-unanswered).
* Two devices offline on the same stock: both picks apply in arrival order under the row lock; the balance may go negative (flagged). Displayed balance = last server balance + this device's unsent operations, labelled; never written back. Offline operation cannot guarantee real-time availability.
* **New rule (stale_before_count):** a *fact* whose `client_at` is earlier than the product's last physical count is **not applied** (the count already contains it) and becomes a visible, unresolved exception that an approver resolves with a note — never a silent double count. (`client_at` is the device clock; skew is a limit.)
* Unit mismatch on a fact line → same: exception, not applied. Rejections and exceptions are surfaced on the device, in Home, and in `stock_reconcile()`.

## 5. Cutover sequence (exact) — legacy backup → counting → openings → `cutover_at` → `ignore`
Goal: no real receipt/pick/old-device write during the window is lost or silently overwritten. Everything below is implemented and exercised in `tests/test_cutover.py`, except the human steps.

| Step | Who/what | Effect / protection |
|---|---|---|
| C0 | Admin: backups (Supabase + every device JSON); apply 001 (mode `off`, nothing changes); run `verify_privileges.sql`; add approvers with `stock_admin_approver` | additive only |
| C1 | Everyone: open the app, wait until sync is OK with nothing pending | reduces the unsynced-device risk (the server cannot see a device's unsent edits) |
| C2 | Admin: `stock_admin_snapshot('T0')` (server's legacy `stockQty` per product, append-only, with who/when); take one device JSON backup and run the legacy report | the **T0 reference**. (Automatic backup-vs-snapshot comparison in the report tool is not built yet — compare by eye for now) |
| C3 | Admin: `stock_admin_control(p_mode => 'transition')` | **detect-only**: no product changes; from now every legacy stock change is passed through *and logged* (old, new, user, version). Picking/receiving on the old app continues |
| C4 | Approvers count and record openings. Each opening line carries `expected_legacy_qty` = the number the approver saw. | If the legacy number has moved since (a pick/receipt happened meanwhile) the opening is **refused** (`legacy_qty_changed`, showing expected vs now). The approver re-counts or submits a corrected figure with basis `derived`. Nothing is overwritten silently. The movement records the replaced legacy figure |
| C5 | Admin: `stock_cutover_status()` | lists unopened products that still hold a legacy number, unacknowledged legacy writes, drift since T0. Each logged write is reviewed, then acknowledged **with a note** (`stock_admin_ack_legacy_writes`) — a write after a product was opened was rejected-and-kept, so its physical effect needs a count or an attributed adjustment |
| C6 | Admin: `stock_admin_control(p_mode => 'ignore', p_leave_untracked => '{…}')` | **refused** while any product with a legacy number has no opening (unless listed *exactly* in `p_leave_untracked`, which logs that its number is discarded), or while any legacy write is unacknowledged. Success stamps `cutover_at` in the same transaction as the mode switch |
| C7 | Release the new app; when every device is updated: `stock_admin_control(p_mode => 'reject', p_min_client_version => '…')` | old apps get an explicit "update the app" error instead of silently losing stock changes |
| C8 | First days | an order an old device finishes after `cutover_at` with no stock operation is flagged `order_without_movement`; stale legacy pushes keep being logged; reconciliation daily |

Residual risks, honestly: an old device that stays offline holding unsynced stock changes and syncs after cutover is rewritten + logged, so its physical effect is *visible but not applied* until someone counts/adjusts; a pick that happens between the final count and the opening is caught only if it reached the server (a quiet few minutes around each opening is recommended); the version header can be forged (the guard does not depend on it).

## 6. Opening / untracking lifecycle
* An opening is **one per tracking episode** (the earlier "one-time per product" wording was wrong). `stock_balances.episode` counts episodes.
* **Untrack** (approver only): a closing movement `delta = −balance`, `qty_after = 0`, closing figure recorded; the balance stays as a row with `tracked=false`, history untouched; mirror becomes `""`; picks on it are skipped; counts refused; stray legacy numbers blanked and logged.
* **Re-open** (approver only): new opening movement, episode + 1, **new cutoff** = that movement (`opening_movement_id`), unit may change (explicit new baseline), `last_verified_at` reset — an accepted-unverified re-opening is unverified until counted. A second opening while tracked is refused.
* Reconciliation: each episode must start with exactly one `opening`; chain continuity holds across episodes (closed at 0); `ledger_mismatch` sums all deltas (closed episodes net to 0). Tested: movements `opening, pick, untrack, opening` with episodes `1,1,1,2`; clean chain; listed as unverified.

## 7. Numeric precision
* **Before:** mirror used `to_jsonb(qty::float8)`. Within our range that happens to round-trip, but it was an unnecessary lossy hop.
* **Now:** `to_jsonb(trim_scale(qty))` — numeric stays numeric; the JSON number is the exact decimal. Balances are `numeric` with `CHECK (qty = round(qty,4) AND abs(qty) < 1e9)` (≤13 significant digits, so a JavaScript double reads it back exactly); deltas rounded to 4 decimals (half up — visible, tested: `1.23456 → 1.2346`, `+0.00005 → +0.0001`); counts ≥ 1e9 are refused. The app's own `round2`/`parseFloat` keep working (it stores a JSON number today and still gets one).
* Reconciliation compares numerics (`safe_num`), so scale/`5.0` vs `5` cannot cause a false `mirror_mismatch`. Tested with 313 values (up to `999999999.9999`, `0.0001`, 4-decimals, 300 random), `0.1+0.2 = 0.3` exactly, a JS `JSON.parse/parseFloat` round trip via Node, and a legacy `0.30000000000000004` write being rewritten.

## 8. Reconciliation (read-only)
`stock_reconcile()` reports (never changes inventory): `chain_break`, `ledger_mismatch`, `movement_without_balance`, `mirror_mismatch`, `negative_balance`, `unverified_balance`, `duplicate_pick`, `order_without_movement`, `operation_movement_mismatch`, `rejected_operation`, `unresolved_exception`, `legacy_write`, `stuck_operation`. `stock_reconcile_record()` stores findings; an approver can **acknowledge** one with a note (the history is kept). Balances change only through new attributed movements.

## 9. Rollout, rollback, recovery — including devices and old apps
**Rollout:** §5, then watch reconciliation for days; the finished-order editor stays disabled until you approve it separately.

**Rollback is two stages (both tested, history preserved):**
* **A — hold** (`002a`): freeze new stock operations, mode → `transition`. Stale/old devices that push stock are *not* applied and are logged. Nothing is corrected automatically.
* **Review:** every `stock_legacy_writes` row is reviewed; `stock_admin_ack_legacy_writes('<decision>')`.
* **B — release** (`002b`): **refused** while unacknowledged writes exist. Then: copy final balances into `records` (legacy devices start from the right numbers), stay frozen, stamp `rolled_back_at`, mode `off`. Ledger tables untouched (row counts + checksum compared).

**Devices with pending offline operations**
* During hold/after release they get an explicit error (SQLSTATE 55000 "frozen"); the operation **stays on the device** as pending — it is neither dropped, nor applied, nor silently turned into a legacy deduction. (Device-side display/export of the outbox is app work, not built.)
* After re-enable they are sent; any whose `client_at` predates the post-rollback count is **not applied** (`stale_before_count` exception) and waits for an approver's note. Operations newer than the count apply normally.
**Failed/rejected operations:** stay stored and listed (`rejected_operation`); nothing retries them automatically; an approver resolves each by a count or attributed adjustment.
**Old app versions:** in `reject` mode they are refused with "update the app". During hold they are logged-not-applied. After release they can write `stockQty` again (legacy source of truth) — they can never touch `stock_balances` or the ledger — and reconciliation shows the drift.
**Re-enable** (mode `off → transition/ignore/reject`): **blocked** until every tracked product has been physically counted *after* `rolled_back_at` (the message lists them; `stock_cutover_status()` too). The count deliberately overwrites the legacy-era number with an attributed movement. `cutover_at` is reset.
**Recovery from damage:** freeze → `stock_reconcile()` → physical count of the affected products → `stock_resync_mirror()` (repairs a damaged mirror only) → approver acknowledges the historical findings with notes → unfreeze. Nothing deleted.
**Uninstall** (`003`): drops guard + functions, keeps all tables/rows and the append-only triggers.

## 10. Supabase integration plan
See `SUPABASE_CHECKS.md`: 0.x (read-only, before applying), 1.x (apply on a branch; `verify_privileges.sql`; `auth.uid()`/`auth.jwt()`/SECURITY DEFINER proof), 2.x (REST/RPC behaviour incl. the app's real `on_conflict` upsert and idempotent replay), 3.x (CORS preflight for `x-client-info`, real-origin fetch), 4.x (RLS interplay, sync pull of the mirror, API-level concurrency). **None has been run; none may be described as tested until it has.**

## 11. Test evidence — what actually ran
All on **real PostgreSQL 16.15**; each simulated client is a separate server connection that logs in as `authenticator` and `SET ROLE authenticated`, like PostgREST. Final runs: `run_tests.py` **162 passed, 0 failed**; `test_cutover.py` **38 passed, 0 failed**; each repeated 3× on freshly rebuilt databases. Outputs: `tests/results.txt`, `tests/results_cutover.txt`.

| Area | Tested against PostgreSQL |
|---|---|
| Privilege state | membership revoked after migration; admin cannot SET ROLE/write stock tables; admin CAN re-grant itself and CAN disable the guard (and the drift is then detected); ownership of every object; stock_owner has no CREATE |
| EXECUTE grants | no PUBLIC; `anon` none (functions, schema, tables); exact function sets for `authenticated`/`service_role`; admin functions admin-only; helpers gone from `public` |
| Balance protection | PostgREST-shaped upsert, plain UPDATE, forged "trusted" variable, new/untracked product, admin and `service_role` writes — all rewritten; clients cannot touch tables/triggers/roles; temp-schema shadowing no effect |
| Idempotency / atomicity / concurrency | replay, conflicting reuse, 12 simultaneous duplicates, lost connection, forced failure at 5 stages, 30 simultaneous picks, opposite lock orders, two racing corrections, picks racing stale pushes |
| Cutover window | legacy writes passed + logged in `transition`; openings refused on moved legacy figure (incl. the race); cutover refused until unopened products + unacknowledged writes are resolved; explicit leave-untracked; post-cutover legacy writes rewritten + logged; legacy-finished order after cutover flagged |
| Lifecycle / numeric | untrack, re-open, episodes, reconciliation across episodes; 313-value precision sweep, Node round trip, rounding, bounds |
| Rollback / re-enable | hold → refuse-until-ack → release; ledger checksum unchanged; frozen refusals; old-app write accepted only after release; re-enable blocked until recount; stale offline pick becomes an exception; reject-mode refusal of an old version; uninstall keeps history |
| Reconciliation | 8 injected fault kinds each detected; recording findings changes no balance; ledger tables refuse UPDATE/DELETE/TRUNCATE even for `stock_owner` |
| Mutation checks | guard disabled ⇒ 10 failures (revision 1 run); a write grant added ⇒ test fails; a PUBLIC grant added ⇒ `verify_privileges.sql` fails |

**NOT tested / limitations**
* **Not Supabase.** `auth.uid()`, the API roles, default privileges, the `postgres` role (and PG15/17 differences) are stubs/assumptions. `SUPABASE_CHECKS.md` lists what must be run there.
* **Not real PostgREST.** The upsert SQL is my reproduction; whether `x-client-info` passes Supabase's CORS preflight is **unverified**; header-based mode `reject` is unproven end to end.
* Your actual `records` schema/RLS/triggers are unknown; the migration assumes the columns in its header.
* Concurrency: 12–30 connections on one local server; no crash/`kill -9`, pooler modes, or volume tests. A superuser can bypass everything (detected, not prevented).
* **No app code exists** for the outbox, banner, fallback, stock screens, or the backup-vs-snapshot comparison in the report tool — §4's device behaviour is design, not tested.
* The legacy report was tested only on a small synthetic backup.
* I make **no claim** that stock integrity is guaranteed; the tests show the mechanisms behave as designed in this environment.

## 12. Still needed from you
Schema/RLS/trigger query results (see earlier message and `SUPABASE_CHECKS.md` §0), a real JSON backup, the approvers' identities, whether any crew must not record counts (currently any signed-in user can), and whether any device may stay on an old version for a while.
