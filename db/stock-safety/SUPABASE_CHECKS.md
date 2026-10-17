# Checks to run on a disposable Supabase branch / copy

**Status of every item below: NOT RUN.** Nothing here may be described as tested until it has actually been executed on a
Supabase branch or a restored copy of the project, never on production. Record the real output next to each item.
(`verify_privileges.sql` itself has run — only on the local PostgreSQL test server.)

Set up: create a Supabase **branch** (or restore the latest backup into a new project). Create two test users in Auth:
`approver@…` and `crew@…`; note their UUIDs (`select id,email from auth.users`). Get a user JWT for each (sign in through the app or
`POST /auth/v1/token?grant_type=password`). `URL` = project URL, `ANON` = anon key, `JA`/`JC` = approver / crew access tokens.

## 0. Before applying the migration — read-only
| # | Check | How | Pass if |
|---|---|---|---|
| 0.1 | Postgres version | `select version();` | recorded (the tests ran on 16.15; Supabase may be 15 or 17 — role-membership behaviour differs, see 1.2) |
| 0.2 | `records` shape | `information_schema.columns` for `public.records` | columns `store,id,data jsonb,deleted,updated_at,updated_by`; PK `(store,id)`. Anything else ⇒ migration must be adapted |
| 0.3 | Existing triggers on `records` | `select tgname, pg_get_triggerdef(oid) from pg_trigger where tgrelid='public.records'::regclass and not tgisinternal;` | no trigger already named `zz_records_stock_guard`; note any trigger that modifies `data` or `updated_at` |
| 0.4 | RLS on `records` | `select relrowsecurity, relforcerowsecurity from pg_class where oid='public.records'::regclass;` + `pg_policies` | recorded; 001 adds a `stock_owner` policy only if RLS is on |
| 0.5 | Who owns `records` / the `public` schema | `select relowner::regrole from pg_class where oid='public.records'::regclass; select nspowner::regrole from pg_namespace where nspname='public';` | the role you will run 001 as (normally `postgres`) |
| 0.6 | Can that role create roles and hand over ownership? | `select rolcreaterole, rolsuper from pg_roles where rolname=current_user;` | `rolcreaterole = true` |
| 0.7 | Default privileges | `select defaclrole::regrole, defaclnamespace::regnamespace, defaclobjtype, defaclacl from pg_default_acl;` | recorded (explains why 001 revokes explicitly) |
| 0.8 | Exposed API schemas | Dashboard → Settings → API → "Exposed schemas" | `stock_internal` is **not** listed (it must not be) |
| 0.9 | Pooler mode in use by the API | Dashboard → Database → connection pooling | recorded (the functions use no session state, only per-transaction settings) |

## 1. Apply 001 on the branch, then verify the privilege state
| # | Check | How | Pass if |
|---|---|---|---|
| 1.1 | Migration applies cleanly as the Supabase admin role | SQL editor, run `001_stock_safety.sql` | no error. If `grant stock_owner to current_user` or `alter … owner to` fails, record the exact message |
| 1.2 | Role membership after the migration | `select pg_has_role(current_user,'stock_owner','usage'), pg_has_role(current_user,'stock_owner','set');` and `select grantor::regrole, member::regrole, admin_option, inherit_option, set_option from pg_auth_members where roleid='stock_owner'::regrole;` | usage = false and `SET ROLE stock_owner` fails. (On PG15 a CREATEROLE role may keep wider rights over roles it created — record exactly what you see and report it back; the design must then be adjusted) |
| 1.3 | Grants, RLS, ownership, execute sets | run `verify_privileges.sql` | final row `== ALL CHECKS OK ==` is true, no row with ok = false |
| 1.4 | API role identity inside a SECURITY DEFINER function | as a signed-in user call `POST $URL/rest/v1/rpc/stock_status` with `Authorization: Bearer $JC`, `apikey: $ANON` | JSON with the crew user's own `user_id`, `is_approver=false` — proves `auth.uid()` works inside the definer function |
| 1.5 | `auth.jwt()` email | `select public.stock_status()` result has the right `user_id`; call `stock_apply` (opening as approver) and read `actor_email` in `stock_movements` | equals the approver's email from the JWT, not anything sent in the body |

## 2. API behaviour (curl or the app's REST client)
| # | Check | Expected |
|---|---|---|
| 2.1 | `GET $URL/rest/v1/stock_balances` with only the anon key (no user token) | 401/403 or an empty list — never data |
| 2.2 | `POST $URL/rest/v1/rpc/stock_auth_qty` (anon, then user) | 404 / "function not found" — it must not exist in `public` |
| 2.3 | `POST .../rpc/stock_auth_qty` with header `Content-Profile: stock_internal` | error (schema not exposed) |
| 2.4 | `POST .../rpc/stock_admin_control` (user token) | 404 or permission denied |
| 2.5 | `PATCH $URL/rest/v1/stock_balances?product_id=eq.X` (user token) with `{"qty":999}` | 403 permission denied; balance unchanged |
| 2.6 | **The app's real upsert**: `POST $URL/rest/v1/records?on_conflict=store,id` with header `Prefer: resolution=merge-duplicates,return=minimal` and body `[{"store":"products","id":"<opened product>","data":{"name":"t","stockQty":999},"deleted":false,"updated_at":"…","updated_by":"t"}]` in mode `transition` or `ignore` | 2xx; then `GET …/records?store=eq.products&id=eq.<id>` shows the authoritative `stockQty`, not 999; a row appears in `stock_legacy_writes` |
| 2.7 | Same upsert on a product that has **no** balance, mode `ignore` | `stockQty` becomes `""`; logged |
| 2.8 | Replay `stock_apply` with the same `op_id` twice (curl) | second response has `"duplicate": true`; one movement |
| 2.9 | Two `stock_apply` calls with the same `op_id` and different bodies | second fails with SQLSTATE 23505 |

## 3. Version header and CORS (browser)
| # | Check | Expected |
|---|---|---|
| 3.1 | Preflight: `curl -i -X OPTIONS "$URL/rest/v1/records" -H "Origin: https://y0ussuf.github.io" -H "Access-Control-Request-Method: POST" -H "Access-Control-Request-Headers: x-client-info,apikey,authorization,content-type,prefer"` | `Access-Control-Allow-Headers` includes `x-client-info` (if it does not, use another allowed header or move the marker into the JWT/an RPC argument — design change needed) |
| 3.2 | From the real app origin (browser devtools console on https://y0ussuf.github.io/dockline/ on a *test copy* of the app) send a `fetch` to `…/rest/v1/records?select=id&limit=1` with `x-client-info: dockline/2026-10-17.1` | succeeds (no CORS error) |
| 3.3 | In `reject` mode with `min_client_version = '2026-10-17.1'` | write without the header → 400/`P0001` "update the app"; with `dockline/2026-10-17.1` → ok; reads are unaffected |
| 3.4 | Does PostgREST expose the request headers to the trigger? | After a `transition`-mode legacy write, `select client_info from stock_legacy_writes order by id desc limit 1` shows the header value |

## 4. Behaviour that needs a real project
* **RLS interplay**: with RLS on `records`, `stock_apply` (opening/count) must still be able to update the mirror (policy `stock_owner_mirror`). Pass if the mirrored `stockQty` changes.
* **Realtime / sync cursor**: after a `stock_apply`, a second device's `pullChanges` receives the product record (the mirror update bumps `updated_at`).
* **Concurrency**: run the same race as `tests/run_tests.py` §8 through the API with two real clients (e.g. two scripts looping `stock_apply` on one product). Pass if the final balance = start − total and `select * from stock_reconcile()` has no error rows. (Do not run the destructive fault-injection tests on Supabase — they need a superuser.)
* **Reconcile + record**: `select * from stock_reconcile();` then `select public.stock_reconcile_record();` as a signed-in user.
* **Rollback rehearsal**: run `002a`, `002b`, then re-enable (see README §8) on the branch.
* **Uninstall**: `003_uninstall_logic.sql` then re-apply `001` is *not* supported (tables exist) — rehearse restore-from-backup instead.

## 5. Report back
For each numbered item: PASS / FAIL, the exact output, date and branch name. Failures change the design, not the tests.
