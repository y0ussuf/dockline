# Review of the read-only production schema results (2026-10-18)
Source: `schema_checks_readonly.sql` run by the owner on production (SELECT only). Nothing was applied or changed. Redaction: none was needed in the result.

| Check | Result | Consequence for the design |
|---|---|---|
| 0.01 | PostgreSQL **17.11** | Tests ran on 16.15. Role-membership rules should match 16, but 17 must be confirmed on the test project (SUPABASE_CHECKS 1.1/1.2) |
| 0.02 | run as `postgres`: not superuser, CREATEROLE, BYPASSRLS | as assumed; `grant stock_owner to current_user`, `alter … owner`, temporary `create` on schemas must still be proven on the test project |
| 0.04 | `authenticator` config: `session_preload_libraries=supautils, safeupdate`, `statement_timeout=8s`, `lock_timeout=8s`; exposed schemas NOT shown by SQL | (a) **supautils** may restrict role/ownership statements → test early. (b) **safeupdate** refuses UPDATE/DELETE without WHERE in API sessions: every statement in the stock functions has a WHERE (checked); one unfiltered UPDATE in the admin function was fixed (`where id`). (c) 8 s lock/statement timeouts: a stock_apply that waits >8 s on a row lock fails with an error and is simply retried with the same op_id (idempotent). Exposed schemas must be read from the dashboard |
| 0.05–0.06 | `records(store,id,data jsonb null,deleted bool,updated_at timestamptz,updated_by text)`, PK(store,id), index on updated_at | **Matches the migration's assumption exactly** |
| 0.07 | owner `postgres`, RLS enabled (not forced); schema `public` owned by `pg_database_owner` | 001 adds its `stock_owner` mirror policy because RLS is on. Granting temporary CREATE on `public` must be proven on the test project |
| 0.08 | policies: **"anon full access" ALL to `public` using(true)/check(true)**; "logged in can read/write/update" for `authenticated` | **SECURITY FINDING, independent of this feature** — see below |
| 0.09 | no triggers on `records` | no conflicts; guard name free |
| 0.10–0.11 | anon, authenticated, service_role hold ALL table privileges (incl. TRUNCATE, TRIGGER) on `records`; default ACLs grant the same on new objects | explains why 001 revokes explicitly on every new object |
| 0.12 | no stock objects, no `stock_internal`, no guard | clean slate |
| 0.13 | `auth.uid()`, `auth.jwt()`, `auth.role()` exist, owned by `supabase_auth_admin` | as assumed (behaviour inside SECURITY DEFINER still to be proven, check 1.4/1.5) |
| 0.14–0.16 | extensions: pg_stat_statements, pgcrypto, plpgsql, supabase_vault, uuid-ossp; standard Supabase event triggers; **no publication** on `records` (no Realtime) | nothing interferes with DDL; sync is polling, not Realtime |
| 0.17 | only table in `public`: `records` | no related tables |
| 0.18 | 943 live products (102 deleted); `stockQty`: 17 numbers, 78 strings, 848 missing; 0 non-numeric strings; 0 numbers with >4 decimals; **536 products have no `unit` field**; ~33 live orders, 3,850 live order items, 843 history lines; last update 2026-10-18 | at most 95 products carry a legacy number (some strings may be empty) → opening scope is small. 4-decimal rule fits the real data. **Unit decision needed** for products without a unit |

## Security finding (not caused by, but relevant to, the stock work)
The policy **"anon full access"** lets *any* caller with the project URL and the publishable key — both are in the public file `js/02-sync.js` — read, insert, update and DELETE every row of `records` without logging in. The "logged in …" policies are therefore moot. The deployed app already forces login and sends the user's token, so the anon policy appears to be a leftover. It is a production change and is **not** made here: propose a separate, reviewed step "0": confirm from the API logs that no client uses the anon role, then in the TEST project prove that dropping that policy and revoking anon's privileges on `records` keeps the app working, then approve a production change. Migration 001 does not fix it (it only makes anon *writes* fail through the guard's helper permissions; hard DELETEs stay open).

## Effects on the plan
1. Anon writes to `records` would start failing after 001 (the guard fails closed for a role without helper access). Expected and desirable, but any client still using the anon key would break — hence the log check before the cutover.
2. App phase needs a unit for every tracked product (536 have none).
3. The two unproven items most likely to need a SQL adaptation are the supautils interaction and the temporary `create` grant on a `pg_database_owner` schema — they are the first things to run on the test project.
