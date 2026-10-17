#!/bin/bash
# Recreates a clean TEST database "$1" (default t1) on the local test PostgreSQL and applies stubs + migration 001.
set -e; export PGHOST=${PGHOST:-127.0.0.1} PGPORT=${PGPORT:-54329}; DB=${1:-t1}; D="$(cd "$(dirname "$0")/.." && pwd)"
psql -U postgres -q -c "drop database if exists $DB" 2>/dev/null
for r in authenticator pgadmin stock_owner anon authenticated service_role; do psql -U postgres -q -c "drop role if exists $r" 2>/dev/null || true; done
psql -U postgres -q -c "create database $DB"
psql -U postgres -d $DB -q -v ON_ERROR_STOP=1 -f $D/000_test_stubs.sql
psql -U postgres -q -c "alter database $DB owner to pgadmin"
psql -U pgadmin -d $DB -q -v ON_ERROR_STOP=1 -f $D/001_stock_safety.sql
