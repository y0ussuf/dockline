-- DRAFT FOR REVIEW — NOT APPLIED ANYWHERE. OPTIONAL early copy (r03 does the same copy again at switch-over, so skipping this is fine).
-- Copies every product's price fields into the 'productPrices' store (one record per product, same id). `products` is not changed.
-- Every row gets its own updated_at (1 ms apart): the app pulls "everything after the last timestamp it saw", so rows sharing one timestamp
-- across a 500-row page boundary would be skipped.
begin;
with src as (
  select p.id, p.deleted, row_number() over (order by p.id) as n,
         jsonb_strip_nulls(jsonb_build_object('id', p.id, 'costPrice', p.data -> 'costPrice', 'sellPrice', p.data -> 'sellPrice',
                                              'priceRef', p.data -> 'priceRef', 'priceHistory', p.data -> 'priceHistory')) as d
  from public.records p
  where p.store = 'products' and (p.data ? 'costPrice' or p.data ? 'sellPrice' or p.data ? 'priceRef' or p.data ? 'priceHistory'))
insert into public.records (store, id, data, deleted, updated_at, updated_by)
select 'productPrices', id, d, deleted, clock_timestamp() + n * interval '1 millisecond', 'r02-copy' from src
on conflict (store, id) do nothing;      -- never overwrite a price record that already exists
commit;
