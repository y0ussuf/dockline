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
