-- r04: let roles see sell prices and cost prices separately.
-- The app now has two permissions, 'prices.sell' and 'prices.cost'. The prices store (productPrices) must be readable by
-- anyone holding either one (the old 'prices.view' keeps working = both). Nothing else changes. Safe to run twice.
do $$
declare src text; fixed text;
begin
  select pg_get_functiondef('app_auth.read_perms(text)'::regprocedure) into src;
  if src like '%''prices.sell''%' then raise notice 'already applied'; return; end if;
  fixed := replace(src, $a$when 'productPrices'     then array['prices.view']$a$, $a$when 'productPrices'     then array['prices.view','prices.sell','prices.cost']$a$);
  if fixed = src then raise exception 'Stop: the expected line was not found. Nothing was changed.'; end if;
  execute fixed;
  raise notice 'done: sell-only and cost-only roles can now read prices';
end $$;
