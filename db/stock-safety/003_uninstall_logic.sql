-- OPTIONAL, after rollback: removes the guard trigger and all functions but KEEPS every table, every row, and the append-only
-- triggers on the ledger tables (history stays readable and protected).
-- Needs temporary membership of stock_owner (the functions are owned by it); revoked again at the end.
begin;
grant stock_owner to current_user;
drop trigger if exists zz_records_stock_guard on public.records;
do $$ declare f record; begin
  -- stock_append_only() is KEPT: the append-only triggers on the ledger tables depend on it and must keep protecting the history
  for f in select p.oid::regprocedure as sig from pg_proc p where p.proowner = 'stock_owner'::regrole and p.proname <> 'stock_append_only' loop
    execute format('drop function %s', f.sig);
  end loop;
end $$;
revoke stock_owner from current_user;
commit;
