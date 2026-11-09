-- DRAFT FOR REVIEW — NOT APPLIED ANYWHERE. Step 2 of 3 for really hiding prices from roles without "See costs, markup and prices".
-- The database can allow or refuse a whole record but cannot hide one field of it, so prices get their own store, 'productPrices',
-- one record per product (same id as the product). r01 already makes that store readable only with prices.view and writable only with prices.edit.
--
--   r02 (this file)  : COPIES every product's price fields into productPrices. products is not changed, nothing breaks. Safe to re-run.
--   app update       : (next change, not in this PR) the sync layer sends/receives prices through productPrices and no longer sends them in products.
--   r03 (afterwards) : removes the price fields from the products records, so roles without prices.view can never receive them.
-- Run r03 only after every device runs the updated app, and only after a backup.

begin;
insert into public.records (store, id, data, deleted, updated_at, updated_by)
select 'productPrices', p.id,
       jsonb_strip_nulls(jsonb_build_object(
         'id', p.id,
         'costPrice', p.data -> 'costPrice',
         'sellPrice', p.data -> 'sellPrice',
         'priceRef', p.data -> 'priceRef',
         'priceHistory', p.data -> 'priceHistory')),
       p.deleted, now(), 'r02-backfill'
from public.records p
where p.store = 'products'
  and (p.data ? 'costPrice' or p.data ? 'sellPrice' or p.data ? 'priceRef' or p.data ? 'priceHistory')
on conflict (store, id) do nothing;      -- never overwrite a price record that already exists
commit;
