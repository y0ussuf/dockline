#!/bin/sh
# Usage: tools/bump-version.sh 2026-10-16.1
# Updates APP_VERSION and every ?v= cache-buster in index.html together, so phones
# pick up changed css/js files (GitHub Pages caches them aggressively).
set -e
V="$1"; [ -n "$V" ] || { echo "usage: $0 <version>"; exit 1; }
cd "$(dirname "$0")/.."
sed -i "s/const APP_VERSION = '[^']*'/const APP_VERSION = '$V'/; s/\(\(css\|js\)\/[^\"?]*\)?v=[^\"]*/\1?v=$V/g" index.html
grep -c "?v=$V" index.html
