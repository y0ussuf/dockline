#!/bin/sh
# Usage: tools/check-version.sh [base-ref]      (default base: origin/main)
# Guards the release rule: whenever css/, js/ or demo/ change, APP_VERSION in index.html must change too,
# and every ?v= tag must match it. Otherwise phones keep running cached files and never see the
# "A newer version of Dockline is available" banner (they end up clearing site data to get the fix).
# Fix a failure with:  tools/bump-version.sh YYYY-MM-DD.N
set -e
BASE="${1:-origin/main}"
cd "$(dirname "$0")/.."

ver_of() { sed -n "s/.*const APP_VERSION = '\([^']*\)'.*/\1/p"; }
ver=$(ver_of < index.html)
[ -n "$ver" ] || { echo "FAIL: APP_VERSION not found in index.html"; exit 1; }

bad=$(grep -oE '(css|js|demo)/[^"?]*\?v=[^"]*' index.html | grep -v "?v=$ver\$" || true)
if [ -n "$bad" ]; then
  echo "FAIL: these ?v= tags do not match APP_VERSION ($ver):"; echo "$bad"
  echo "Run: tools/bump-version.sh $ver"; exit 1
fi

changed=$(git diff --name-only "$BASE"...HEAD -- css js demo)
if [ -n "$changed" ]; then
  old=$(git show "$BASE:index.html" | ver_of)
  if [ "$old" = "$ver" ]; then
    echo "FAIL: these files changed but APP_VERSION is still $ver:"; echo "$changed"
    echo "Run: tools/bump-version.sh <a new version, e.g. $(date +%Y-%m-%d).N>"; exit 1
  fi
fi
echo "version check OK ($ver)"
