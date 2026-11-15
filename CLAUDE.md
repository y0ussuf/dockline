# Dockline — notes for Claude sessions

## Release rule: bump the version on every change to css/, js/ or demo/

The site is static (GitHub Pages) and browsers cache css/js. The `?v=` tags in `index.html` are what make a device
load changed files, and a new `APP_VERSION` is what makes the in-app "A newer version of Dockline is available"
banner appear. If a change ships without a new version, people keep running the old code (and end up clearing
site data to get a fix).

- Before committing: `tools/bump-version.sh YYYY-MM-DD.N` (N = next number for that day; the current one is on the
  `const APP_VERSION` line in `index.html`). It updates APP_VERSION and every `?v=` tag together.
- Check: `tools/check-version.sh origin/main` (CI runs the same check on every pull request).
- If two open branches both bump, the second one to merge conflicts on the version lines in `index.html`:
  rebase, then run the bump script again with the next number.

## Tests

`python3 tests/smoke.py` opens every page in a headless Chrome (demo mode, sample data) and runs the "Tidy vessel
names" regression test; CI runs it on every pull request. Run it before committing changes to css/ or js/. Needs
`pip install playwright` and Chrome/Chromium (set `CHROME=/path` to pick one). When you fix a bug, add a case to
`tests/smoke.py` that fails without the fix. If this machine can't reach the CDN, the test uses a stand-in for Sortable.
