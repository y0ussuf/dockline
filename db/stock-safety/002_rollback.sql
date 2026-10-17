-- Rollback of enforcement (FOR REVIEW). Preserves ALL ledger history; drops nothing; loses no data.
-- Run as the admin role that ran 001. After it: stock_balances/stock_movements are frozen history, the
-- authoritative number is the mirrored "stockQty" in records again, and the old app's behaviour resumes.
begin;
set local role stock_owner;
update public.stock_control set frozen = true, frozen_reason = 'rollback in progress', updated_at = now();   -- A: stop new stock operations
select public.stock_mirror(null);                                                                          -- B: records <- final balances
update public.stock_control set mode = 'off', rolled_back_at = now(), updated_at = now(),                  -- C: stop rewriting stockQty
       frozen_reason = 'ROLLED BACK: ledger is read-only history; stock_balances is no longer authoritative';
commit;
