-- undo r05: remove the 'expenses' lines from the three permission functions
do $$
declare src text; fixed text; f text;
begin
  foreach f in array array['read_perms','write_perms','delete_perms'] loop
    select pg_get_functiondef(('app_auth.'||f||'(text)')::regprocedure) into src;
    fixed := regexp_replace(src, E'\\s*when ''expenses''\\s+then array\\[''finance''\\]', '', 'g');
    if fixed <> src then execute fixed; end if;
  end loop;
  raise notice 'done';
end $$;
