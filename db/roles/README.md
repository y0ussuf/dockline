# Dockline roles — database side (DRAFT, nothing applied)

**Status: not applied anywhere. No production change was made. Everything here was run only on a throw-away local PostgreSQL 16.**
The app side (js/26-roles.js) works on its own: it hides what a role may not use. These files make the database refuse the same things, so hiding can't be bypassed.

| File | What it does |
|---|---|
| `r01_roles_and_rls.sql` | Per-permission read/write/delete rules on `records`; activity log append-only; roles admin-only. Replaces the old blanket policies. |
| `r02_product_prices.sql` | OPTIONAL early copy of prices into `productPrices` (non-destructive; r03 repeats the copy). |
| `r04_sell_cost_split.sql` | Lets roles with only "See sell prices" or only "See cost prices" read the prices store (needed once the app is updated). Rollback: `r04_rollback.sql`. |
| `r05_finance.sql` | Lets roles with the new "Profit & loss and vessel expenses" permission read and write vessel expenses (full admins work without it). Rollback: `r05_rollback.sql`. |
| `r03_switch_prices_to_own_store.sql` | The switch-over, one transaction: copies current prices, keeps a backup copy, removes prices from `products`, turns on the flag `sharedSettings/features.pricesSplit`. Refuses (and changes nothing) if any copy is not exact. `r03_rollback.sql` puts prices back. |
| `../../supabase/functions/team-admin/index.ts` | Admin-only function the Team page calls to list/create people, set roles and passwords, remove accounts. |
| `tests/test_roles.sql` | 27 checks (admin, picker, invoices, reports, unknown role, legacy staff, anon). Result: 27 pass, 0 fail. Run after `db/stock-safety/000_test_stubs.sql` + r01. |

## How a role reaches the database
The account's `app_metadata` holds `role: "admin"` (everything) or `role: "staff"` + `role_id`. `role_id` points at one `roles` record (name + list of permission keys — the same keys as in `PERM_GROUPS` in js/26-roles.js). The database reads it from the login token, so a role change takes effect when the token refreshes (≤ ~1 hour) or on next sign-in. Accounts made before roles existed (staff, no `role_id`) keep their old abilities minus settings/backup.

## Important facts and limits
1. **Prices are only really hidden after r03.** Until then product records still carry prices. The app sync (PR: price split) is already switch-aware: it mirrors prices into `productPrices` on every price save, and flips to "prices only in productPrices" when it reads the flag r03 sets. Known remaining leak: activity-log lines carry old → new price values for roles with `activity.view` (the screen hides them for roles without price access; the database does not).
2. **Step 0 of r01 drops the old policies, including "anon full access".** That is the security finding in `db/stock-safety/PRODUCTION_SCHEMA_REVIEW.md`: today anyone with the URL and the public key can read and change everything without logging in. Before applying: check the API logs that nothing uses the anon role; then test on a Supabase branch.
3. **Upserts need visibility.** The app saves with `INSERT … ON CONFLICT DO UPDATE`, which Postgres only allows on rows the caller can see. So anyone who may write a kind of record can also see it (except activity: people see only their own lines unless they have "activity.view"). Found by the tests.
4. **Picking, receiving, merge, move write to `products`** (stock, location), so those roles may update product records; the database can't restrict *which fields* inside a record. Field-level rules (e.g. "pickers can't change a product's name") are enforced in the app only. Stock-quantity edits by hand are blocked in the app for roles without "Edit stock by hand"; the database cannot tell a hand edit from a pick.
5. **The activity log is also written by the app on the device**, so a modified app could omit lines. The database guarantees only that lines already saved can't be changed or removed by non-admins.
6. This does not touch the paused stock-safety design; its own migration (`db/stock-safety`) is independent. If both are applied, apply roles' step 0 and stock-safety's policies together on the test branch and re-run both test suites.

## Order to apply (when you decide)
1. Backup. 2. Test branch: r01, then `tests/test_roles.sql` (with stubs only on a plain local Postgres; on Supabase use real test accounts), then try the app with a picker, an invoices-only and an admin account.
3. Deploy `team-admin`. 4. Production: r01. 5. Price split: merge the app update and let every device load it; backup; quiet moment; run r03. Rollback: r03_rollback.sql.
Rollback of r01: recreate the old policy ("logged in can …" for `authenticated`) and `drop schema app_auth cascade`.
