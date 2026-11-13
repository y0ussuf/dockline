-- r05: profit & loss per vessel. The app has a new store 'expenses' (vessel expenses and dollar rates) and a new permission 'finance'.
-- Full admins already work without this script. Run it so roles that tick "Profit & loss and vessel expenses" can read and write 'expenses'.
-- Safe to run twice. Undo: r05_rollback.sql
do $$
declare src text; fixed text;
begin
  select pg_get_functiondef('app_auth.read_perms(text)'::regprocedure) into src;
  if src like '%''expenses''%' then raise notice 'read already applied'; else
    fixed := replace(src, $a$when 'productPrices'     then array['prices.view'$a$, $a$when 'expenses'          then array['finance']
    when 'productPrices'     then array['prices.view'$a$);
    if fixed = src then raise exception 'Stop: the expected read line was not found. Nothing was changed.'; end if;
    execute fixed;
  end if;
  select pg_get_functiondef('app_auth.write_perms(text)'::regprocedure) into src;
  if src like '%''expenses''%' then raise notice 'write already applied'; else
    fixed := replace(src, $a$when 'productPrices'     then array['prices.edit']$a$, $a$when 'expenses'          then array['finance']
    when 'productPrices'     then array['prices.edit']$a$);
    if fixed = src then raise exception 'Stop: the expected write line was not found. Nothing was changed.'; end if;
    execute fixed;
  end if;
  select pg_get_functiondef('app_auth.delete_perms(text)'::regprocedure) into src;
  if src like '%''expenses''%' then raise notice 'delete already applied'; else
    fixed := replace(src, $a$when 'roles' then array[]::text[]$a$, $a$when 'expenses' then array['finance']
    when 'roles' then array[]::text[]$a$);
    if fixed = src then raise exception 'Stop: the expected delete line was not found. Nothing was changed.'; end if;
    execute fixed;
  end if;
  raise notice 'done: roles with the finance permission can use expenses';
end $$;
