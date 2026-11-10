do $$
declare src text; fixed text;
begin
  select pg_get_functiondef('app_auth.read_perms(text)'::regprocedure) into src;
  fixed := replace(src, $a$array['prices.view','prices.sell','prices.cost']$a$, $a$array['prices.view']$a$);
  execute fixed;
end $$;
