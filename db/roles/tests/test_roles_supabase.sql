-- FOR THE TEST PROJECT ONLY, after test_project_setup.sql and r01_roles_and_rls.sql. Plain SQL: paste into the Supabase SQL editor and run.
-- It adds a few fake records, then pretends to be different kinds of accounts and checks what each can do.
-- Result: one row per check with PASS or FAIL (everything should say PASS). It cleans up after itself.
do $$
declare
  t jsonb; tests jsonb; res jsonb := '[]'::jsonb; n int; ok boolean; passed boolean; claims text; nm text;
begin
  insert into public.records(store,id,data) values
   ('roles','r_pick','{"id":"r_pick","name":"Picker","perms":["products.view","stock.view","orders.view","orders.pick","receiving"]}'),
   ('roles','r_inv','{"id":"r_inv","name":"Invoices","perms":["invoices.view","invoices.edit","prices.view","products.view"]}'),
   ('roles','r_rep','{"id":"r_rep","name":"Reports","perms":["reports.view","activity.view"]}'),
   ('products','p1','{"id":"p1","name":"Beef","stockQty":5}'),
   ('productPrices','p1','{"id":"p1","costPrice":"10","sellPrice":"12"}'),
   ('invoices','i1','{"id":"i1"}'), ('orders','o1','{"id":"o1"}'),
   ('activity','a0','{"id":"a0","text":"seed","email":"boss@x"}')
  on conflict (store,id) do nothing;

  -- [who, name, kind, sql, expected]   kind: count = number of rows returned, ok = statement allowed, no = statement refused
  tests := jsonb_build_array(
   jsonb_build_array('admin','admin reads products','count','select count(*) from public.records where store=''products''','1'),
   jsonb_build_array('admin','admin reads prices','count','select count(*) from public.records where store=''productPrices''','1'),
   jsonb_build_array('admin','admin can write roles','ok','insert into public.records(store,id,data) values(''roles'',''r_tmp'',''{"perms":[]}'')',null),
   jsonb_build_array('picker','picker reads products','count','select count(*) from public.records where store=''products''','1'),
   jsonb_build_array('picker','picker cannot read invoices','count','select count(*) from public.records where store=''invoices''','0'),
   jsonb_build_array('picker','picker cannot read prices','count','select count(*) from public.records where store=''productPrices''','0'),
   jsonb_build_array('picker','picker cannot read the activity log','count','select count(*) from public.records where store=''activity''','0'),
   jsonb_build_array('picker','picker can update an order','ok','update public.records set data=data||''{"status":"x"}'' where store=''orders'' and id=''o1''',null),
   jsonb_build_array('picker','picker cannot create an invoice','no','insert into public.records(store,id,data) values(''invoices'',''i9'',''{}'')',null),
   jsonb_build_array('picker','picker cannot write roles','no','insert into public.records(store,id,data) values(''roles'',''r_x'',''{"perms":["*"]}'')',null),
   jsonb_build_array('picker','picker can add an activity line','ok','insert into public.records(store,id,data) values(''activity'',''a1'',''{"text":"x","email":"picker@x"}'')',null),
   jsonb_build_array('picker','picker cannot change an activity line','no','update public.records set data=''{"text":"changed","email":"picker@x"}'' where store=''activity'' and id=''a1''',null),
   jsonb_build_array('invoices','invoices role reads invoices','count','select count(*) from public.records where store=''invoices''','1'),
   jsonb_build_array('invoices','invoices role reads prices','count','select count(*) from public.records where store=''productPrices''','1'),
   jsonb_build_array('invoices','invoices role cannot edit products','no','update public.records set data=data||''{"stockQty":99}'' where store=''products'' and id=''p1''',null),
   jsonb_build_array('reports','reports role reads the activity log','count','select count(*) from public.records where store=''activity''','2'),
   jsonb_build_array('reports','reports role cannot read prices','count','select count(*) from public.records where store=''productPrices''','0'),
   jsonb_build_array('ghost','a deleted/unknown role sees nothing','count','select count(*) from public.records','0'),
   jsonb_build_array('anon','not signed in: sees nothing','count','select count(*) from public.records','0'),
   jsonb_build_array('anon','not signed in: cannot write','no','insert into public.records(store,id,data) values(''products'',''pz'',''{}'')',null)
  );

  for t in select * from jsonb_array_elements(tests) loop
    nm := t->>1;
    claims := case t->>0
      when 'admin'    then '{"sub":"00000000-0000-0000-0000-000000000001","email":"boss@x","app_metadata":{"role":"admin"}}'
      when 'picker'   then '{"sub":"00000000-0000-0000-0000-000000000002","email":"picker@x","app_metadata":{"role":"staff","role_id":"r_pick"}}'
      when 'invoices' then '{"sub":"00000000-0000-0000-0000-000000000003","email":"inv@x","app_metadata":{"role":"staff","role_id":"r_inv"}}'
      when 'reports'  then '{"sub":"00000000-0000-0000-0000-000000000004","email":"rep@x","app_metadata":{"role":"staff","role_id":"r_rep"}}'
      when 'ghost'    then '{"sub":"00000000-0000-0000-0000-000000000005","email":"g@x","app_metadata":{"role":"staff","role_id":"gone"}}'
      else '{}' end;
    perform set_config('request.jwt.claims', claims, true);
    execute case when t->>0='anon' then 'set local role anon' else 'set local role authenticated' end;
    passed := false;
    begin
      if t->>2 = 'count' then execute t->>3 into n; passed := (n::text = t->>4);
      else
        execute t->>3; get diagnostics n = row_count;
        -- a refused UPDATE can also show up as "0 rows changed"
        passed := case t->>2 when 'ok' then n >= 1 else n = 0 end;
      end if;
    exception when others then
      passed := (t->>2 = 'no');
    end;
    execute 'reset role';
    res := res || jsonb_build_array(jsonb_build_object('check', nm, 'result', case when passed then 'PASS' else 'FAIL' end));
  end loop;

  delete from public.records where (store,id) in (('roles','r_pick'),('roles','r_inv'),('roles','r_rep'),('roles','r_tmp'),('products','p1'),('productPrices','p1'),('invoices','i1'),('orders','o1'),('activity','a0'),('activity','a1'));
  create temp table if not exists role_test_result(check_name text, result text) on commit drop;
  insert into role_test_result select x->>'check', x->>'result' from jsonb_array_elements(res) x;
  raise exception E'RESULT\n%', (select string_agg(result||'  '||check_name, E'\n' order by result desc, check_name) from role_test_result);
end $$;
