-- ROLLBACK, STAGE B — "release" (FOR REVIEW). Run as the admin role ONLY after stage A and after every row of
-- stock_legacy_writes has been reviewed and acknowledged with stock_internal.stock_admin_ack_legacy_writes('<what you decided>').
-- The function REFUSES to run while unacknowledged legacy writes exist. It then: copies the final authoritative balances into
-- records (so legacy devices start from the right numbers), keeps stock operations frozen, stamps rolled_back_at, switches the guard off.
-- All ledger tables stay exactly as they are. Nothing is corrected automatically.
select stock_internal.stock_admin_control(p_mode => 'off', p_note => 'rollback stage B');
