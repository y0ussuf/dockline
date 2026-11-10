-- DRAFT FOR REVIEW — NOT APPLIED ANYWHERE. The switch-over: prices stop being part of the product records.
-- Run ONLY after (1) the app version with the price-split sync is live on every device, (2) a fresh backup, (3) at a quiet moment.
-- Until this runs the app behaves exactly as before (products carry their prices; productPrices is only a mirror).
-- What it does, in one transaction (all or nothing):
--   a) copies the CURRENT embedded prices into productPrices (embedded = the truth until now),
--   b) keeps a copy of the products table rows in a table the API cannot see,
--   c) removes the price fields from every products record,
--   d) turns on the flag the apps read: sharedSettings/features = {"pricesSplit": true}.
-- Timestamps: every row gets its own updated_at, 1 ms apart, all within ~4 seconds of now (see r02 for why).
begin;

-- b) backup copy first (RLS on, no policy = invisible to the API)
create table if not exists public.records_before_price_split (like public.records);
alter table public.records_before_price_split enable row level security;
insert into public.records_before_price_split select * from public.records where store in ('products','productPrices') on conflict do nothing;

-- a) mirror <- embedded
with src as (
  select p.id, p.deleted, row_number() over (order by p.id) as n,
         jsonb_strip_nulls(jsonb_build_object('id', p.id, 'costPrice', p.data -> 'costPrice', 'sellPrice', p.data -> 'sellPrice',
                                              'priceRef', p.data -> 'priceRef', 'priceHistory', p.data -> 'priceHistory')) as d
  from public.records p
  where p.store = 'products' and (p.data ? 'costPrice' or p.data ? 'sellPrice' or p.data ? 'priceRef' or p.data ? 'priceHistory'))
insert into public.records (store, id, data, deleted, updated_at, updated_by)
select 'productPrices', id, d, deleted, clock_timestamp() + n * interval '1 millisecond', 'r03-copy' from src
on conflict (store, id) do update set data = excluded.data, deleted = excluded.deleted, updated_at = excluded.updated_at, updated_by = excluded.updated_by;

-- sanity: every product that has prices now has a productPrices record with the same values
do $$ declare bad int; begin
  select count(*) into bad from public.records p
   where p.store = 'products' and (p.data ? 'costPrice' or p.data ? 'sellPrice' or p.data ? 'priceRef' or p.data ? 'priceHistory')
     and not exists (select 1 from public.records q where q.store = 'productPrices' and q.id = p.id
                     and q.data -> 'costPrice' is not distinct from p.data -> 'costPrice'
                     and q.data -> 'sellPrice' is not distinct from p.data -> 'sellPrice'
                     and q.data -> 'priceRef' is not distinct from p.data -> 'priceRef'
                     and q.data -> 'priceHistory' is not distinct from p.data -> 'priceHistory');
  if bad > 0 then raise exception 'Stop: % products have prices that did not copy exactly. Nothing was changed.', bad; end if;
end $$;

-- c) strip (the update also gives each product record a fresh timestamp so every device re-reads it)
with t as (select id, row_number() over (order by id) as n from public.records
           where store = 'products' and (data ? 'costPrice' or data ? 'sellPrice' or data ? 'priceRef' or data ? 'priceHistory'))
update public.records r
   set data = r.data - 'costPrice' - 'sellPrice' - 'priceRef' - 'priceHistory',
       updated_at = clock_timestamp() + interval '2 seconds' + t.n * interval '1 millisecond', updated_by = 'r03-switch'
  from t where r.store = 'products' and r.id = t.id;

-- d) the flag, last
insert into public.records (store, id, data, deleted, updated_at, updated_by)
values ('sharedSettings', 'features', '{"id":"features","pricesSplit":true}', false, clock_timestamp() + interval '4 seconds', 'r03-switch')
on conflict (store, id) do update set data = coalesce(public.records.data, '{}'::jsonb) || '{"id":"features","pricesSplit":true}', deleted = false,
                                      updated_at = excluded.updated_at, updated_by = excluded.updated_by;
commit;
