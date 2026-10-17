-- TEST ENVIRONMENT ONLY — never run on Supabase. Recreates the pieces of a Supabase project the migration relies on,
-- so the migration can be exercised on a real PostgreSQL server. Run as a superuser on an empty database.
create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
create role authenticator login noinherit; grant anon, authenticated, service_role to authenticator;
-- stand-in for Supabase's "postgres" admin role: NOT a superuser, but can create roles
create role pgadmin login createrole;
create schema auth; alter schema auth owner to pgadmin;
grant usage on schema auth to anon, authenticated, service_role;
create function auth.uid() returns uuid language sql stable as
  $$ select coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''),
                     (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid $$;
create function auth.jwt() returns jsonb language sql stable as
  $$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
alter function auth.uid() owner to pgadmin; alter function auth.jwt() owner to pgadmin;
grant usage on schema public to anon, authenticated, service_role;
alter schema public owner to pgadmin;
-- Supabase's default privileges: every new public table/function is open to the API roles
alter default privileges for role pgadmin in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges for role pgadmin in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges for role pgadmin in schema public grant all on functions to anon, authenticated, service_role;
set role pgadmin;
create table public.records (
  store text not null, id text not null, data jsonb, deleted boolean not null default false,
  updated_at timestamptz not null default now(), updated_by text, primary key (store, id));
alter table public.records enable row level security;
create policy crew_all on public.records for all to authenticated using (true) with check (true);
reset role;
