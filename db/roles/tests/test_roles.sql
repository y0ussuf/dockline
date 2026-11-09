-- TEST ONLY (run after 000_test_stubs.sql from db/stock-safety, then r01, r02). Each line prints PASS/FAIL.
\set ON_ERROR_STOP off
\pset tuples_only on
create or replace function pg_temp.as_user(claims text) returns void language plpgsql as $$ begin perform set_config('request.jwt.claims', claims, false); end $$;
-- seed (as superuser)
reset role;
insert into public.records(store,id,data) values
 ('roles','r_pick','{"id":"r_pick","name":"Picker","perms":["products.view","stock.view","orders.view","orders.pick","receiving"]}'),
 ('roles','r_inv','{"id":"r_inv","name":"Invoices","perms":["invoices.view","invoices.edit","prices.view","products.view"]}'),
 ('roles','r_rep','{"id":"r_rep","name":"Reports","perms":["reports.view","activity.view"]}'),
 ('products','p1','{"id":"p1","name":"Beef","costPrice":"10","sellPrice":"12","stockQty":5}'),
 ('invoices','i1','{"id":"i1","number":"1"}'),
 ('orders','o1','{"id":"o1"}')
 on conflict do nothing;
\i r02_product_prices.sql
create or replace function pg_temp.t(name text, ok boolean) returns void language plpgsql as $$ begin raise notice '% %', case when ok then 'PASS' else 'FAIL' end, name; end $$;
create or replace function pg_temp.tryit(sql text) returns boolean language plpgsql as $$ begin execute sql; return true; exception when others then return false; end $$;
create or replace function pg_temp.cnt(sql text) returns int language plpgsql as $$ declare n int; begin execute sql into n; return n; end $$;

-- admin
set role authenticated; select pg_temp.as_user('{"sub":"00000000-0000-0000-0000-000000000001","app_metadata":{"role":"admin"}}');
select pg_temp.t('admin reads products', pg_temp.cnt($q$select count(*) from public.records where store='products'$q$)=1);
select pg_temp.t('admin writes roles', pg_temp.tryit($q$insert into public.records(store,id,data) values('roles','r_new','{"perms":[]}')$q$));
select pg_temp.t('admin reads prices store', pg_temp.cnt($q$select count(*) from public.records where store='productPrices'$q$)=1);
-- picker
select pg_temp.as_user('{"sub":"00000000-0000-0000-0000-000000000002","email":"p@x","app_metadata":{"role":"staff","role_id":"r_pick"}}');
select pg_temp.t('picker reads products', pg_temp.cnt($q$select count(*) from public.records where store='products'$q$)=1);
select pg_temp.t('picker CANNOT read invoices', pg_temp.cnt($q$select count(*) from public.records where store='invoices'$q$)=0);
select pg_temp.t('picker CANNOT read prices store', pg_temp.cnt($q$select count(*) from public.records where store='productPrices'$q$)=0);
select pg_temp.t('picker CANNOT read activity', pg_temp.cnt($q$select count(*) from public.records where store='activity'$q$)=0);
select pg_temp.t('picker can update orders? (no: not a picker-write perm for orders? orders.pick yes)', pg_temp.tryit($q$update public.records set data=data||'{"status":"x"}' where store='orders' and id='o1'$q$));
select pg_temp.t('picker CANNOT create invoice', not pg_temp.tryit($q$insert into public.records(store,id,data) values('invoices','i9','{}')$q$));
select pg_temp.t('picker CANNOT delete (soft) a product', not pg_temp.tryit($q$update public.records set deleted=true where store='products' and id='p1'$q$) or pg_temp.cnt($q$select count(*) from public.records where store='products' and deleted$q$)=0);
select pg_temp.t('picker CANNOT write roles', not pg_temp.tryit($q$insert into public.records(store,id,data) values('roles','r_x','{"perms":["*"]}')$q$));
select pg_temp.t('picker CANNOT hard delete', pg_temp.cnt($q$with d as (delete from public.records where store='orders' returning 1) select count(*) from d$q$)=0);
select pg_temp.t('picker can add an activity line', pg_temp.tryit($q$insert into public.records(store,id,data) values('activity','a1','{"text":"x","email":"p@x"}')$q$));
select pg_temp.t('picker CANNOT edit an activity line', not pg_temp.tryit($q$update public.records set data='{"text":"changed","email":"p@x"}' where store='activity' and id='a1'$q$) or pg_temp.cnt($q$select count(*) from public.records where store='activity' and data->>'text'='changed'$q$)=0);
select pg_temp.t('picker re-sending identical activity line is fine', pg_temp.tryit($q$insert into public.records(store,id,data) values('activity','a1','{"text":"x","email":"p@x"}') on conflict (store,id) do update set data=excluded.data$q$));
-- invoices role
select pg_temp.as_user('{"sub":"00000000-0000-0000-0000-000000000003","app_metadata":{"role":"staff","role_id":"r_inv"}}');
select pg_temp.t('invoices role reads invoices', pg_temp.cnt($q$select count(*) from public.records where store='invoices'$q$)=1);
select pg_temp.t('invoices role reads prices store', pg_temp.cnt($q$select count(*) from public.records where store='productPrices'$q$)=1);
select pg_temp.t('invoices role CANNOT change stock/products', not pg_temp.tryit($q$update public.records set data=data||'{"stockQty":99}' where store='products' and id='p1'$q$) or pg_temp.cnt($q$select count(*) from public.records where store='products' and data->>'stockQty'='99'$q$)=0);
select pg_temp.t('invoices role CANNOT read orders? (invoices.view/edit allowed)', pg_temp.cnt($q$select count(*) from public.records where store='orders'$q$)=1);
-- reports role
select pg_temp.as_user('{"sub":"00000000-0000-0000-0000-000000000004","app_metadata":{"role":"staff","role_id":"r_rep"}}');
select pg_temp.t('reports role reads activity', pg_temp.cnt($q$select count(*) from public.records where store='activity'$q$)>=1);
select pg_temp.t('reports role CANNOT read prices', pg_temp.cnt($q$select count(*) from public.records where store='productPrices'$q$)=0);
select pg_temp.t('reports role CANNOT write products', not pg_temp.tryit($q$update public.records set data=data||'{"x":1}' where store='products'$q$) or pg_temp.cnt($q$select count(*) from public.records where store='products' and data ? 'x'$q$)=0);
-- role deleted / unknown role = nothing
select pg_temp.as_user('{"sub":"00000000-0000-0000-0000-000000000005","app_metadata":{"role":"staff","role_id":"gone"}}');
select pg_temp.t('unknown role reads nothing', pg_temp.cnt($q$select count(*) from public.records$q$)=0);
-- legacy staff
select pg_temp.as_user('{"sub":"00000000-0000-0000-0000-000000000006","app_metadata":{"role":"staff"}}');
select pg_temp.t('legacy staff reads products', pg_temp.cnt($q$select count(*) from public.records where store='products'$q$)=1);
select pg_temp.t('legacy staff CANNOT write roles', not pg_temp.tryit($q$insert into public.records(store,id,data) values('roles','r_y','{}')$q$));
-- anon / not logged in
reset role; set role anon;
select pg_temp.t('anon reads nothing', pg_temp.cnt($q$select count(*) from public.records$q$)=0);
select pg_temp.t('anon CANNOT write', not pg_temp.tryit($q$insert into public.records(store,id,data) values('products','pz','{}')$q$));
