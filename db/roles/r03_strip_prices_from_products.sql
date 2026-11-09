-- DRAFT FOR REVIEW — NOT APPLIED ANYWHERE. Run only after r02 AND after every device runs the app version that reads prices from productPrices.
-- Guard: refuses to run if any product still has price fields that are missing from productPrices (so nothing can be lost).
begin;
do $$
declare missing int;
begin
  select count(*) into missing from public.records p
   where p.store = 'products' and (p.data ? 'costPrice' or p.data ? 'sellPrice' or p.data ? 'priceRef' or p.data ? 'priceHistory')
     and not exists (select 1 from public.records q where q.store = 'productPrices' and q.id = p.id);
  if missing > 0 then raise exception 'Stop: % products have prices that are not in productPrices yet. Run r02 again.', missing; end if;
end $$;

-- keep a copy first (a plain table nobody but the owner can read)
create table if not exists public.records_products_before_r03 as table public.records with no data;
insert into public.records_products_before_r03 select * from public.records where store = 'products' on conflict do nothing;
alter table public.records_products_before_r03 enable row level security;   -- no policy = invisible to the API

update public.records
   set data = data - 'costPrice' - 'sellPrice' - 'priceRef' - 'priceHistory', updated_at = now(), updated_by = 'r03-strip'
 where store = 'products' and (data ? 'costPrice' or data ? 'sellPrice' or data ? 'priceRef' or data ? 'priceHistory') and id is not null;
commit;
