-- ROLLBACK, STAGE A — "hold" (FOR REVIEW). Run as the admin role. Reversible; keeps all history; changes no balance.
--   * stops new stock operations (frozen) so the ledger cannot move while you decide
--   * switches the guard to 'transition': products that have a balance stay protected, and ANY legacy write is logged
-- Old/stale devices that push now do not silently overwrite anything: the authoritative value is kept and the attempt is logged.
select stock_internal.stock_admin_control(p_mode => 'transition', p_frozen => true, p_frozen_reason => 'rollback hold — review stock_legacy_writes',
                                          p_note => 'rollback stage A');
