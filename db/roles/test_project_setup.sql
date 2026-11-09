-- FOR A SEPARATE, EMPTY TEST PROJECT ONLY — never run this on your real project (it would not hurt a table that already exists, but there is no reason to).
-- Recreates the `records` table and the four rules your production table has today, so r01 can be tried on a faithful copy.
create table if not exists public.records (
  store text not null, id text not null, data jsonb, deleted boolean not null default false,
  updated_at timestamptz not null default now(), updated_by text, primary key (store, id));
create index if not exists records_updated_at_idx on public.records (updated_at);
alter table public.records enable row level security;
drop policy if exists "anon full access" on public.records;
drop policy if exists "logged in can read" on public.records;
drop policy if exists "logged in can write" on public.records;
drop policy if exists "logged in can update" on public.records;
create policy "anon full access"   on public.records for all    to public        using (true) with check (true);
create policy "logged in can read"   on public.records for select to authenticated using (true);
create policy "logged in can write"  on public.records for insert to authenticated with check (true);
create policy "logged in can update" on public.records for update to authenticated using (true) with check (true);
