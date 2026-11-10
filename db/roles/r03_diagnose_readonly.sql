-- READ-ONLY (changes nothing). Run only if r03 stops with "did not copy exactly". Shows up to 15 products whose current prices differ from
-- what the copy would hold, and what kind of value each price field has. Send the result back.
select p.id, p.data ->> 'name' as name,
       jsonb_typeof(p.data -> 'costPrice') as cost_type, p.data -> 'costPrice' as cost,
       jsonb_typeof(p.data -> 'sellPrice') as sell_type, p.data -> 'sellPrice' as sell,
       jsonb_typeof(p.data -> 'priceRef') as ref_type, jsonb_typeof(p.data -> 'priceHistory') as hist_type,
       p.deleted, (select count(*) from public.records q where q.store = 'productPrices' and q.id = p.id) as copies
from public.records p
where p.store = 'products' and (p.data ? 'costPrice' or p.data ? 'sellPrice' or p.data ? 'priceRef' or p.data ? 'priceHistory')
  and not exists (select 1 from public.records q where q.store = 'productPrices' and q.id = p.id
                  and (q.data - 'id') = jsonb_strip_nulls(jsonb_build_object('costPrice', p.data -> 'costPrice', 'sellPrice', p.data -> 'sellPrice',
                                                                               'priceRef', p.data -> 'priceRef', 'priceHistory', p.data -> 'priceHistory')))
limit 15;
