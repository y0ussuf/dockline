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
`tests/smoke.py` that fails without the fix. The tests replace the CDN libraries with tiny fakes, so they need no internet.

## Libraries from the CDN load on demand

xlsx, exceljs, jszip and Sortable are NOT in `index.html`; `ensureLib('xlsx' | 'exceljs' | 'jszip' | 'sortable')` in
`js/01-core.js` loads each one the first time a feature needs it. Before using `XLSX`, `ExcelJS` or `JSZip` in new code,
`await ensureLib(...)` (or `ensureLibOrAlert(...)` in a handler that has no error handling of its own); use `makeSortable(el, opts)`
instead of `new Sortable(...)`. A new CDN library goes into `LAZY_LIBS`, not into a `<script>` tag in the page head.
