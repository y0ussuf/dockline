-- DRAFT — way back from r03: puts the prices back into the product records and turns the flag off. Needs the copy table made by r03.
begin;
with t as (select p.id, row_number() over (order by p.id) as n, q.data as pd
           from public.records p join public.records q on q.store = 'productPrices' and q.id = p.id where p.store = 'products')
update public.records r
   set data = r.data || coalesce(jsonb_strip_nulls(jsonb_build_object('costPrice', t.pd -> 'costPrice', 'sellPrice', t.pd -> 'sellPrice',
                                  'priceRef', t.pd -> 'priceRef', 'priceHistory', t.pd -> 'priceHistory')), '{}'::jsonb),
       updated_at = clock_timestamp() + interval '2 seconds' + t.n * interval '1 millisecond', updated_by = 'r03-rollback'
  from t where r.store = 'products' and r.id = t.id;
update public.records set data = data || '{"pricesSplit":false}', updated_at = clock_timestamp() + interval '4 seconds', updated_by = 'r03-rollback'
 where store = 'sharedSettings' and id = 'features';
commit;
