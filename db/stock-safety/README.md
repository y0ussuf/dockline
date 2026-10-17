# Dockline stock safety — design for review (phase 1)

**Status: NOT APPLIED anywhere. No production change has been made. The app code is untouched.**
Everything here was run only against a throw-away PostgreSQL 16 server in a sandbox.

| File | What it is |
|---|---|
| `001_stock_safety.sql` | the migration (additive only; enforcement starts **off**) |
| `002_rollback.sql` | enforcement rollback: freezes, re-mirrors, switches off; **keeps all history** |
| `003_uninstall_logic.sql` | optional: removes trigger + functions, **keeps every table and row** |
| `000_test_stubs.sql` | TEST ONLY: stands in for Supabase's roles/`auth` schema |
| `tests/run_tests.py`, `tests/reset_db.sh`, `tests/results.txt` | the automated tests and their last output |
| `../../tools/stock-legacy-report.js` | read-only report on a Dockline backup file |

## 1. What is authoritative, and who can change it

* `stock_balances` is the authoritative balance. `stock_movements` is the append-only ledger. `stock_operations` records every request (idempotency + what was asked).
* The `stockQty` inside a product record in `records` is only a **mirror** so existing sync delivers the number to devices.
* **Only functions owned by the role `stock_owner` write these tables.** `stock_owner` cannot log in, is not a superuser, does not bypass RLS, and no client-side role (`anon`, `authenticated`, `service_role`, `authenticator`) is a member of it. Clients have `SELECT` only (through RLS); they have no INSERT/UPDATE/DELETE/TRUNCATE grant and no write policy.
* **The guard on `records`** (`zz_records_stock_guard`, fires last, `BEFORE INSERT OR UPDATE`) rewrites `stockQty` in every product write to the authoritative balance, unless `current_user = 'stock_owner'`. There is **no session variable or flag** to forge: `current_user` is only `stock_owner` while a `SECURITY DEFINER` function owned by it is executing, and a client cannot `SET ROLE` to it. Ordinary updates, stale sync pushes, CSV import, backup restore, migrations and the admin role are all rewritten (tested, §8).
* **The version marker (`x-client-info: dockline/<version>`) is NOT the protection.** It only lets `reject` mode refuse *honest old apps* outright (so their offline stock changes are not silently lost). A forged header gets no ability to change a balance.
* Honest limits: a database superuser or the owner of the `records` table can disable the trigger (DDL) or edit tables directly. Nothing inside the database can prevent that. Reconciliation (§6) exists to detect it afterwards.

## 2. Offline operations and conflicting devices

*The design below is the app-side behaviour (not yet built). The server side is built and tested.*

**Two kinds of operation**
* **Facts** — things that already happened physically: finishing a pick (`pick`), receiving (`receipt`). Always accepted, even offline, even if stock goes negative (negative is recorded and flagged, never refused). Offline-capable.
* **Corrections** — deleting a receipt, mapping moves, later finished-order edits (`receipt_reversal`, `mapping_move`), counts, openings, adjustments. Validated against live stock; **online only**. A correction that would go below zero is rejected unless an **approver** supplies an override with a reason.

**Outbox.** Every stock operation gets a UUID (`op_id`) once, stored on the device in the *same local transaction* as the order/receipt change. States: `pending → sending → applied | applied_with_exceptions | rejected | failed`. It is never deleted when sent; only after the server answers is it marked. An unsent or unanswered operation is shown, not hidden.

**Retry / duplicate / timeout.** The server has a unique key on `op_id`. The same `op_id` with the same content returns the **first result** (`duplicate: true`) and creates no movement — whether the retry follows a timeout, a double-click, a page refresh, or a lost response. The same `op_id` with different content, or from a different user, is refused. Two connections sending the same operation at the same instant: the second waits for the first, then gets its result (tested with 12 simultaneous connections: exactly one movement).

**Two devices, conflicting while offline.** Example: both pick the last 10 kg offline. Each device shows 10 kg available (it cannot know better). When they sync, the server applies the two picks one after the other under the product's row lock; the balance becomes −10 and both movements keep the balance they saw (`qty_before`/`qty_after`). Nothing is rejected (both happened), the negative balance is flagged, and appears in reconciliation and on Home. **Offline operation does not and cannot guarantee real-time availability.**

**Displayed balance.** `server balance (last sync) + sum of this device's own unsent operations`, labelled with "includes N unsent changes · last synced hh:mm". It is computed for display only and never written back into the product record.

**Unresolved problems are surfaced** in four places: (1) the device's outbox (a `rejected`/`failed`/stuck-`sending` operation stays listed with the reason); (2) a Home banner ("2 stock changes could not be applied"); (3) `stock_exceptions` (a fact line that could not be applied, e.g. unit mismatch — unresolved until an approver resolves it with a note); (4) `stock_reconcile()`, which also lists rejected operations and operations stuck in `processing`.

## 3. Operation flow (server side, `stock_apply`) — implemented and tested

1. Must be authenticated; user = `auth.uid()` + JWT email taken **server-side** (a user id in the request is never read). Frozen → refuse.
2. `kind` → class. `opening/adjustment/untrack` need an approver (else refused, nothing stored).
3. Idempotency insert on `op_id` (+ content hash). Duplicate → return stored result.
4. Lock every affected `stock_balances` row `FOR UPDATE` **in product-id order** (all functions use the same order ⇒ no deadlocks).
5. Plan every line against the live balances. Unit must equal the stock unit (case-insensitive). Mismatch: *fact* → line is **not applied** and becomes an unresolved exception; *anything else* → whole operation rejected. Untracked product → skipped (existing behaviour).
6. Negative result: fact → applied + flagged; correction/count/adjustment → needs `override=true` **and** a reason **and** an approver; else rejected.
7. Any rejection ⇒ **nothing** is applied (stored as `rejected` with reasons). Otherwise write movements, update balances, mirror into `records` — one transaction. Any error anywhere ⇒ the whole transaction rolls back, **including the idempotency row**, so a retry is clean.

## 4. Opening balances and the ledger cutoff

* **Nothing is opened automatically.** Run `node tools/stock-legacy-report.js backup.json out/` → `opening-balances.csv` has one row per tracked product with status (`COUNT REQUIRED` / `REVIEW` / `no known concern`) and blank columns **basis, quantity, approved-by, approved-at** that a person fills in. Only approved rows become `opening` operations (approver-only, one-time per product).
* Per product the **cutoff is its opening movement** (`stock_balances.opening_movement_id/opening_at`). Nothing before it is in the ledger; no historic order is converted into movements.
* Every movement carries `proof`: `recorded` (a real operation from the app), `reconstructed` (a correction to a legacy order whose original deduction is unknown — explicitly marked, never presented as `recorded`), `physical_count`, `accepted_unverified`, `derived`, `adjustment`.
* **Verified vs unverified:** a balance is *verified* only if its opening basis was `physical_count` or a later count happened (`last_verified_at`). Everything else is listed by reconciliation as `unverified_balance` until counted.
* Report format and rules: see §9 and the sample in the tool output.

## 5. Security and permissions (as implemented)

* Tables: `REVOKE ALL` from `public, anon, authenticated, service_role`, then `GRANT SELECT` to `authenticated` only; RLS enabled **and forced**; policies = read for `authenticated`, everything for `stock_owner`, nothing else. `app_stock_approvers` readable only for your own row.
* Functions: owner `stock_owner`, `SECURITY DEFINER`, `search_path = pg_catalog, public` pinned, `EXECUTE` revoked from `public/anon/service_role`, granted to `authenticated` (internal `stock_mirror`/`stock_is_approver` granted to nobody).
* Approvers are rows in `app_stock_approvers`, which only the admin can edit (SQL editor). Override attribution = the approver's `auth.uid()` + email, stored on the movement together with the reason and resulting balance.
* If `records` has RLS enabled the migration adds a policy so `stock_owner` can write the mirror.

## 6. Reconciliation (read-only)

`select * from stock_reconcile()` compares, per product, the opening movement + every later movement against the current balance, and checks the chain (each movement must start where the previous ended). It reports, and **never changes inventory**: `chain_break` (missing/altered movement), `ledger_mismatch`, `movement_without_balance`, `mirror_mismatch`, `negative_balance`, `unverified_balance`, `duplicate_pick` (same order line deducted twice), `order_without_movement` (order marked stock-applied after cutover with no operation), `operation_movement_mismatch` (an operation says N lines applied but ledger has a different number), `rejected_operation`, `unresolved_exception`, `stuck_operation`.
`stock_reconcile_record()` saves the findings (history of what was seen); an approver can mark one `acknowledged` with a note — that never deletes it. The only way to change a balance is a new, attributed movement (count / adjustment).

## 7. Rollout, backup, recovery

**Before anything:** (1) Supabase backup/point-in-time snapshot and an export of the `records` table; (2) a JSON backup from every device; (3) you review the results of the read-only schema queries against this migration's assumptions.
**Rollout order** (each step verified before the next; the finished-order editor stays **disabled** throughout):
1. Apply `001` on a *copy* of production (or a Supabase branch) first, run the tests' reconciliation checks, then on production. Mode is `off`: nothing changes.
2. Run the legacy report on a fresh backup; you decide the opening basis per product (count the flagged ones).
3. Approver applies the openings. `stock_control.cutover_at` set. Mode → `ignore` (guard rewrites stale stock; old apps keep working but their stock changes are ignored — and **lost**, which is why step 5 follows quickly).
4. Release the new app (version header + outbox + stock operations). Verify with a real pick/receipt on two devices.
5. When every device is updated: `min_client_version` set and mode → `reject` (old apps get an update-required error instead of silently losing stock changes).
6. Watch reconciliation for several days. Only then build finished-order editing (separate PR).

**Rollback** (`002`): freeze → mirror final balances into `records` → mode `off`. Tested with recorded history: all movements/operations/balances unchanged (row counts and checksum compared), mirror equals the final balances, `stock_apply` refuses further operations. **After rollback an old app can write `stockQty` in `records` again** (it is the legacy source of truth by definition); it still cannot change `stock_balances` or the ledger, and reconciliation shows the drift (`mirror_mismatch`). **Re-enabling later requires a fresh count/opening of every drifted product**, otherwise the guard would overwrite legacy-era numbers with stale balances. A new-protocol app seeing `mode=off`/`frozen` must fall back to the legacy local stock path (client item, not built yet).
**Recovery from damage** (tested): freeze → reconcile (read-only) shows what is wrong → physical count of the affected products (a normal attributed `count` movement) → `stock_resync_mirror()` repairs a damaged mirror → approver acknowledges the historical findings with notes → unfreeze. Nothing is deleted at any step.

## 8. Test evidence — what was actually run

`tests/results.txt` (last run **105 passed, 0 failed**, repeated 4× on freshly rebuilt databases). All of it ran on a **real PostgreSQL 16.15 server**; every simulated client is a separate server connection that logs in as the `authenticator` role and does `SET ROLE authenticated`, as PostgREST does.

| Area | Actually tested against PostgreSQL |
|---|---|
| Permissions | clients can't INSERT/UPDATE/DELETE/TRUNCATE any stock table; can't `SET ROLE stock_owner`; can't disable/drop the trigger, create functions in `public`, change `session_replication_role`, edit the control row, call internal functions, make themselves approver; anon/service_role refused; catalog check that `stock_owner` has no login/superuser/bypassrls and all trusted functions are SECURITY DEFINER with pinned search_path; temp-schema function shadowing has no effect |
| Balance protection | PostgREST-shaped `INSERT … ON CONFLICT DO UPDATE` upsert, plain UPDATE, a "trusted" session variable, new/untracked products, admin-role write, `service_role` write — stale `stockQty` is rewritten every time |
| Idempotency | replay, same id different content, same id different user, 12 simultaneous identical requests, connection lost before commit, committed-but-unanswered |
| Atomicity | forced failure at: 2nd movement insert, balance update, mirror update, operation finalisation, exception insert — each leaves *nothing* behind; retry then applies once |
| Rules | units, untracked, negative facts, override needs approver + reason, counts, adjustments, all-or-nothing corrections |
| Concurrency (separate connections) | 30 simultaneous picks on one product; opposite lock order across 20 multi-product ops (no deadlock); two corrections racing (one applies, one rejected); 30 picks racing 60 stale product pushes |
| Reconciliation | injected faults (deleted movement, tampered balance, tampered mirror, orphan movement, wrong operation count, ghost order, duplicate pick) are each detected; recording findings doesn't change inventory; owner role can't UPDATE/DELETE the ledger |
| Recovery & rollback | freeze, count-based recovery, acknowledge; `002` with history intact; `003` keeps tables |
| Mutation checks | with the guard disabled 10 tests failed; with an UPDATE grant added to `authenticated`, the permission test failed — i.e. the tests can detect a broken protection |

**NOT tested / limitations (please read):**
* **Not Supabase.** `auth.uid()`, the API roles, default privileges and the `postgres` admin role are **stubs** modelled on Supabase (`000_test_stubs.sql`). Real behaviour must be checked on a Supabase branch/copy before approval.
* **Not real PostgREST.** The upsert SQL is my reproduction of what PostgREST generates for `on_conflict` + `merge-duplicates`; whether the `x-client-info` header passes Supabase's CORS preflight is **unverified**.
* **Your actual `records` schema/RLS/triggers are unknown** — the migration assumes `(store, id, data jsonb, deleted, updated_at, updated_by)` with primary key `(store, id)`.
* Concurrency was 12–30 connections against one local server — good evidence the locking logic is right, not a proof for every interleaving. Server crash/`kill -9` mid-transaction, connection pooling modes, and large data volumes were **not** tested (PostgreSQL's own durability is relied on).
* **No app (JavaScript) code exists yet** for the outbox, the operations, the banner or the fallback — so offline behaviour in §2 is design, not tested behaviour.
* Legacy report tested only on a small synthetic backup (3 orders, 6 products), not your real data.
* I make **no claim** that stock integrity is guaranteed. The tests show the *mechanisms* behave as designed in this environment.

## 9. Legacy-data report

`node tools/stock-legacy-report.js dockline-backup.json out/` → `stock-legacy-report.md`, `opening-balances.csv`, `legacy-orders.csv`. Rules:
* **Every** historical deduction is `unproven` (the app never stored per-line deductions). Orders are graded `not deducted` (finished but `stockApplied` never set), `unproven — with concerns`, or `unproven — derivable from current lines` (recomputable, still not proof).
* Concerns flagged per line: picked unit ≠ stock unit; no quantity; product deleted; mapping changed since import; item still pending on a finished order.
* Products: `COUNT REQUIRED` (negative balance, no unit, unit mismatch, mapping drift, missing quantity), `REVIEW (history cannot be proven)` (has history, no specific concern), `no known concern` (no history at all).
* Declared **not recoverable**: manual overwrites, deleted receipts, anything lost to stale syncs.

## 10. Needed from you before approval

Results of the read-only queries (schema, indexes, constraints, RLS policies, triggers, grants, functions, row counts, `stockQty` types); a JSON backup for the real report; who the approvers are; whether any crew should *not* be allowed to record counts (currently any signed-in user can); whether any device may stay on an old version for a while.
