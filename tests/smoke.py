#!/usr/bin/env python3
"""Dockline smoke tests — run the real app in a headless browser, in demo mode (no cloud, no login).

    python3 tests/smoke.py              # everything
    python3 tests/smoke.py --only tidy  # one group: pages | tidy | libs

1. pages  — opens every page with sample data and fails on an uncaught error, a console error,
            a page that renders nothing, or a "no access" screen.
2. tidy   — regression test: "Tidy vessel names" must not come back after it has run
            (it did for vessels merged in "Same vessel, spelt differently").
3. libs   — the Excel / zip / drag-to-reorder libraries load only when a feature needs them (not on every page load),
            load once, fail with a readable message, and can be retried; pages still work if one can't load.

Needs: pip install playwright   +   Chrome or Chromium on the machine (set CHROME=/path to pick one).
Exit code 0 = all passed, 1 = something failed.
"""
import argparse, asyncio, functools, http.server, os, re, shutil, socketserver, sys, threading
from playwright.async_api import async_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# every page that opens without needing a specific record id
PAGES = ['', 'orders', 'order/new', 'splitter', 'qcheck', 'products', 'table', 'mapcheck', 'warehouses',
         'warehouse', 'stock', 'stock/all', 'deliveries', 'boxtypes', 'receiving', 'batches', 'reliability',
         'suppliers', 'invoices', 'money', 'prices', 'history', 'insights', 'forecast', 'lastyear', 'activity',
         'team', 'settings', 'productsetup', 'duplicates', 'mergemany']

# console noise that comes from the machine/network running the test, not from the app
IGNORED = re.compile(r'Failed to load resource|net::ERR|ERR_(INTERNET|NAME|CONNECTION|BLOCKED)|favicon|Failed to fetch dynamically|Refused to (load|execute)', re.I)


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a, **k):      # keep the test output readable
        pass


def serve():
    handler = functools.partial(QuietHandler, directory=ROOT)
    srv = socketserver.TCPServer(('127.0.0.1', 0), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, f'http://127.0.0.1:{srv.server_address[1]}/index.html'


# The CDN libraries are replaced by tiny fakes, so the tests don't need internet and can also make a download fail.
FAKE_LIBS = {'xlsx': 'window.XLSX = {fake:true};', 'exceljs': 'window.ExcelJS = {fake:true};', 'jszip': 'window.JSZip = {fake:true};',
             'Sortable': 'window.Sortable = function(){ window.__sortables = (window.__sortables||0) + 1; };'}


async def fresh_page(pw, url, errors, fail=()):
    """Opens the app in demo mode in a brand-new browser (empty database). Returns (browser, page, net):
    net['hits'] lists every CDN library the page asked for; names in net['fail'] get a failed download."""
    exe = os.environ.get('CHROME') or shutil.which('google-chrome') or shutil.which('chromium') or shutil.which('chromium-browser')
    browser = await pw.chromium.launch(executable_path=exe, args=['--no-sandbox']) if exe else await pw.chromium.launch(args=['--no-sandbox'])
    ctx = await browser.new_context(viewport={'width': 1300, 'height': 900})   # a new context = an empty database
    net = {'hits': [], 'fail': set(fail)}

    async def cdn(route):
        u = route.request.url.lower()
        name = next((k for k in FAKE_LIBS if k.lower() in u), None)
        net['hits'].append(name or route.request.url)
        if name is None: await route.fulfill(status=404, body='')
        elif name in net['fail']: await route.abort()
        else: await route.fulfill(status=200, content_type='application/javascript', body=FAKE_LIBS[name])
    await ctx.route('https://cdnjs.cloudflare.com/**', cdn)

    page = await ctx.new_page()
    page.on('pageerror', lambda e: errors.append(f'uncaught: {e}'))
    page.on('console', lambda m: errors.append(f'console.error: {m.text}') if m.type == 'error' and not IGNORED.search(m.text) else None)
    await page.goto(url)
    await page.locator('#authDemo').click()                                     # demo mode: sample app, nothing is saved to the cloud
    await page.wait_for_function("typeof routes==='object' && document.querySelector('#main') && document.querySelector('#main').children.length>0", timeout=20000)
    return browser, page, net


# ---------------------------------------------------------------- 1. pages
SEED_PAGES = """async()=>{
  for(let i=1;i<=30;i++) await put('products',{id:'t'+i, name:'Test product '+i, active:true, stockQty: i<=10 ? 2 : 40, lowStockLimit: 5});
  for(let i=1;i<=3;i++) await put('productReceipts',{id:'r'+i, supplierId:'s1', date:'2026-11-0'+i, lines:[]});
  const orders = [];
  for(let i=1;i<=6;i++){ const name = i<=3 ? 'AL DANA' : 'KAI '+i; orders.push({id:'h'+i, fileName:'f'+i+'.xlsx', vesselName:name, vesselKey:vesselKeyOf(name), imo:'', orderDate:'2026-0'+i+'-10',
    fingerprint:[vesselKeyOf(name),'2026-0'+i+'-10','ORD'+i,1,5].join('|'), lineCount:1, importedAt:'2026-10-0'+i+'T10:00:00Z', synced:true}); }
  await bulkPut('historyOrders', orders);
  await bulkPut('historyLines', orders.map(o=>({id:'l'+o.id, historyOrderId:o.id, vesselKey:o.vesselKey, orderDate:o.orderDate, excelDesc:'x', descKey:'x', qty:5, unit:'KG', productId:'t1', skipped:false, baseOk:true})));
}"""


async def test_pages(pw, url):
    errors = []
    browser, page, net = await fresh_page(pw, url, errors)
    await page.evaluate(SEED_PAGES)
    failed = 0
    for p in PAGES:
        errors.clear()
        h = '#/' + p
        problem = None
        try:
            await page.evaluate("async(h)=>{ location.hash=h; await render(); }", h)
            await page.wait_for_timeout(250)
            info = await page.evaluate("({len:(document.querySelector('#main').innerText||'').trim().length, noAccess:/no access|not allowed/i.test(document.querySelector('#main').innerText||'')})")
            if info['len'] < 15: problem = 'page rendered nothing'
            elif info['noAccess']: problem = 'shows a "no access" screen'
        except Exception as e:
            problem = f'render() threw: {str(e).splitlines()[0][:160]}'
        await page.wait_for_timeout(300)   # always let the page's own hashchange render and background work finish, so an error is blamed on this page and not the next one
        if not problem and errors: problem = errors[0][:200]
        print(f"  {'PASS' if not problem else 'FAIL'}  {h:<18}" + (f'  {problem}' if problem else ''))
        failed += bool(problem)
    await browser.close()
    return failed


# ---------------------------------------------------------------- 2. tidy vessel names
def seed_tidy(scn):
    names = "'AL DANA CUSTOMER : ACME SHIPPING'" if scn in ('customer', 'both') else "'AL DANA'"
    alias = "await put('sharedSettings',{id:'vesselAliases', map:{'al dana':'al dana ii'}, notSame:[]});" if scn in ('merged', 'both') else ''
    return """async()=>{ %s
      const orders=[]; for(let i=1;i<=9;i++){ const n=%s; orders.push({id:'h'+i, fileName:'f'+i+'.xlsx', vesselName:n, vesselKey:vesselKeyOf(n), imo:'', orderDate:'2026-0'+i+'-10',
        fingerprint:[vesselKeyOf(n),'2026-0'+i+'-10','ORD'+i,1,5].join('|'), lineCount:1, importedAt:'2026-10-0'+i+'T10:00:00Z', synced:true}); }
      await bulkPut('historyOrders', orders);
      await bulkPut('historyLines', orders.map(o=>({id:'l'+o.id, historyOrderId:o.id, vesselKey:o.vesselKey, orderDate:o.orderDate, excelDesc:'x', descKey:'x', qty:5, unit:'KG', productId:null, skipped:true, baseOk:true})));
    }""" % (alias, names)


PENDING = "async()=>{ const d = await insightsData(); const p = planVesselTidy(d.hOrders); return p ? p.changes.length : 0; }"
APPLY = "async()=>{ const d = await insightsData(); const p = planVesselTidy(d.hOrders); return p ? await applyVesselTidy(p) : null; }"


async def test_tidy(pw, url):
    # (scenario, orders that need tidying before, what it covers)
    cases = [('merged', 0, 'clean names, vessel merged with another spelling -> nothing to tidy, ever'),
             ('customer', 9, 'real "CUSTOMER : x" tails -> tidied once, then gone'),
             ('both', 9, 'both at once -> tidied once, then gone')]
    failed = 0
    for scn, expected_before, what in cases:
        errors = []
        browser, page, net = await fresh_page(pw, url, errors)
        await page.evaluate(seed_tidy(scn))
        before = await page.evaluate(PENDING)
        if before: await page.evaluate(APPLY)
        after = await page.evaluate(PENDING)
        ok = before == expected_before and after == 0 and not errors
        print(f"  {'PASS' if ok else 'FAIL'}  tidy/{scn:<9} {what}" + ('' if ok else f'   (to tidy before: {before}, after: {after}{", errors: " + errors[0][:100] if errors else ""})'))
        failed += (not ok)
        await browser.close()
    return failed


# ---------------------------------------------------------------- 3. libraries load on demand
async def test_libs(pw, url):
    failed = 0

    def check(ok, label, detail=''):
        nonlocal failed
        print(f"  {'PASS' if ok else 'FAIL'}  libs/{label}" + ('' if ok else f'   ({detail})'))
        failed += (not ok)

    errors = []
    browser, page, net = await fresh_page(pw, url, errors)
    await page.wait_for_timeout(500)
    tags = await page.evaluate("document.querySelectorAll('script[src*=\"cdnjs\"]').length")
    loaded = await page.evaluate("['XLSX','ExcelJS','JSZip','Sortable'].filter(n=>typeof window[n]!=='undefined')")
    check(tags == 0 and not net['hits'] and not loaded, 'startup-downloads-nothing', f'cdn script tags: {tags}, requested: {net["hits"]}, defined: {loaded}')

    r = await page.evaluate("""async()=>{ await Promise.all([ensureLib('xlsx'), ensureLib('xlsx')]); await ensureLib('xlsx');
        return {ok: typeof XLSX!=='undefined', tags: document.querySelectorAll('script[src*="xlsx"]').length}; }""")
    check(r['ok'] and r['tags'] == 1 and net['hits'].count('xlsx') == 1, 'loads-once-on-demand', f'{r}, requests: {net["hits"].count("xlsx")}')

    net['fail'].add('jszip')
    msg = await page.evaluate("async()=>{ try{ await ensureLib('jszip'); return 'no error'; }catch(e){ return e.message; } }")
    missing = await page.evaluate("typeof JSZip==='undefined'")
    net['fail'].clear()
    retried = await page.evaluate("async()=>{ await ensureLib('jszip'); return typeof JSZip!=='undefined'; }")
    check('Could not load' in msg and 'connection' in msg and missing and retried and net['hits'].count('jszip') == 2, 'failed-download-can-be-retried', f'message: {msg!r}, retried: {retried}')

    net['fail'].add('exceljs')
    a = await page.evaluate("async()=>{ const ok = await ensureLibOrAlert('exceljs'); return {ok, text:(document.querySelector('#modal-root')||{}).innerText||''}; }")
    check(a['ok'] is False and 'Could not load the Excel export library' in a['text'], 'failure-shows-an-alert', str(a)[:160])
    net['fail'].clear()

    await page.evaluate("async()=>{ location.hash='#/warehouses'; await render(); }")
    await page.wait_for_timeout(500)
    s = await page.evaluate("({loaded: typeof Sortable!=='undefined', made: window.__sortables||0})")
    check(s['loaded'] and s['made'] >= 1 and 'Sortable' in net['hits'] and not errors, 'sortable-loads-with-its-page', f'{s}, errors: {errors[:1]}')
    await browser.close()

    errors = []
    browser, page, net = await fresh_page(pw, url, errors, fail=['Sortable'])
    bad = []
    for h in ('#/warehouses', '#/products'):
        await page.evaluate("async(h)=>{ location.hash=h; await render(); }", h)
        await page.wait_for_timeout(400)
        n = await page.evaluate("(document.querySelector('#main').innerText||'').trim().length")
        if n < 15: bad.append(h)
    check(not bad and not errors, 'pages-work-if-sortable-cannot-load', f'blank: {bad}, errors: {errors[:1]}')
    await browser.close()
    return failed


# ---------------------------------------------------------------- 4. pack pricing (cases x pieces)
async def test_packs(pw, url):
    errors = []
    browser, page, net = await fresh_page(pw, url, errors)
    failed = 0
    def check(ok, label, detail=''):
        nonlocal failed
        print(f"  {'PASS' if ok else 'FAIL'}  packs/{label}" + ('' if ok else f'   ({detail})'))
        failed += (not ok)
    r = await page.evaluate("""() => {
      const calc = (prod, unit, price, over) => {
        const pack = parsePack(unit), b = packBasisFor(prod, pack);
        const l = Object.assign({qty:'10', unit, price, ref:null, pack, packBasis:b.basis}, over||{});
        const c = lineCalc(l, price, 'ask'); return {g:Dec.str(c.gross), issue:c.issue, basis:b.basis};
      };
      return {
        can:   calc({name:'COCA COLA', unit:'CAN'}, 'CASE 24*300 ML', '15.15'),
        cs:    calc({name:'COCA COLA', unit:'CASE'}, 'CASE 24*300 ML', '363.6'),
        name:  calc({name:'COCA COLA 300 ML', unit:''}, 'CASE 24*300 ML', '15.15'),
        none:  calc({name:'COCA COLA', unit:''}, 'CASE 24*300 ML', '15.15'),
        plain: calc({name:'RICE', unit:'KG'}, 'KG', '10', {qty:'10'}),
      };
    }""")
    check(r['can']['g'] == '3636' and not r['can']['issue'], 'unit CAN: 10 cases x 24 x 15.15 = 3636 automatically', r['can'])
    check(r['cs']['basis'] == 'case' and r['cs']['g'] == '3636', 'unit CASE: billed per whole pack, 10 x 363.60', r['cs'])
    check(r['name']['g'] == '3636', 'no unit but name carries the piece size: per piece', r['name'])
    check(r['none']['issue'] == 'Pack choice needed', 'cannot be told: the line asks instead of guessing', r['none'])
    check(r['plain']['g'] == '100' and not r['plain']['issue'], 'a plain KG line is unaffected', r['plain'])
    await browser.close()
    return failed


async def main():
    ap = argparse.ArgumentParser(); ap.add_argument('--only', choices=['pages', 'tidy', 'libs', 'packs'])
    args = ap.parse_args()
    srv, url = serve()
    failed = 0
    async def run(title, group):
        nonlocal failed
        print(title)
        try:
            failed += await group
        except Exception as e:             # a group that crashes counts as a failure, with one readable line
            print(f"  FAIL  this group stopped early: {str(e).strip().splitlines()[0][:200]}")
            failed += 1

    async with async_playwright() as pw:
        if args.only in (None, 'pages'): await run('pages (demo mode, sample data):', test_pages(pw, url))
        if args.only in (None, 'tidy'): await run('tidy vessel names:', test_tidy(pw, url))
        if args.only in (None, 'libs'): await run('libraries load on demand:', test_libs(pw, url))
        if args.only in (None, 'packs'): await run('pack pricing:', test_packs(pw, url))
    srv.shutdown()
    print('\n' + ('ALL PASSED' if not failed else f'{failed} FAILED'))
    sys.exit(1 if failed else 0)


asyncio.run(main())
