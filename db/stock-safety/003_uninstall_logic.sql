-- Optional, after 002: removes the trigger and functions but KEEPS every table and row (history stays readable).
begin;
drop trigger if exists zz_records_stock_guard on public.records;
drop function if exists public.records_stock_guard();
drop function if exists public.stock_apply(jsonb), public.stock_mirror(text[]), public.stock_status(), public.stock_resync_mirror(),
  public.stock_resolve_exception(bigint,text), public.stock_resolve_discrepancy(text,text), public.stock_reconcile(),
  public.stock_reconcile_record();
commit;
