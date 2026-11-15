#!/usr/bin/env python3
"""Dockline smoke tests — run the real app in a headless browser, in demo mode (no cloud, no login).

    python3 tests/smoke.py              # everything
    python3 tests/smoke.py --only tidy  # one group: pages | tidy

1. pages  — opens every page with sample data and fails on an uncaught error, a console error,
            a page that renders nothing, or a "no access" screen.
2. tidy   — regression test: "Tidy vessel names" must not come back after it has run
            (it did for vessels merged in "Same vessel, spelt differently").

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


async def fresh_page(pw, url, errors):
    exe = os.environ.get('CHROME') or shutil.which('google-chrome') or shutil.which('chromium') or shutil.which('chromium-browser')
    browser = await pw.chromium.launch(executable_path=exe, args=['--no-sandbox']) if exe else await pw.chromium.launch(args=['--no-sandbox'])
    ctx = await browser.new_context(viewport={'width': 1300, 'height': 900})   # a new context = an empty database
    page = await ctx.new_page()
    # Sortable (drag-to-reorder) is loaded from a CDN. If this machine can't reach it, stand in a no-op so the pages that
    # use it still render; the real library replaces the stand-in when it does load (so on GitHub it is the real one).
    await page.add_init_script("""window.Sortable = window.Sortable || (function(){
        const S = function(){ return {destroy(){}, option(){}, toArray(){ return []; }}; };     // works with `new Sortable(el, opts)`
        S.__stub = true; S.create = function(){ return new S(); }; S.mount = function(){};
        return S; })();""")
    page.on('pageerror', lambda e: errors.append(f'uncaught: {e}'))
    page.on('console', lambda m: errors.append(f'console.error: {m.text}') if m.type == 'error' and not IGNORED.search(m.text) else None)
    await page.goto(url)
    await page.locator('#authDemo').click()                                     # demo mode: sample app, nothing is saved to the cloud
    await page.wait_for_function("typeof routes==='object' && document.querySelector('#main') && document.querySelector('#main').children.length>0", timeout=20000)
    return browser, page


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
    browser, page = await fresh_page(pw, url, errors)
    if await page.evaluate("!!(window.Sortable && window.Sortable.__stub)"):
        print('  note: the Sortable library (CDN) could not be loaded here, so a stand-in is used; drag-to-reorder is not exercised')
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
        browser, page = await fresh_page(pw, url, errors)
        await page.evaluate(seed_tidy(scn))
        before = await page.evaluate(PENDING)
        if before: await page.evaluate(APPLY)
        after = await page.evaluate(PENDING)
        ok = before == expected_before and after == 0 and not errors
        print(f"  {'PASS' if ok else 'FAIL'}  tidy/{scn:<9} {what}" + ('' if ok else f'   (to tidy before: {before}, after: {after}{", errors: " + errors[0][:100] if errors else ""})'))
        failed += (not ok)
        await browser.close()
    return failed


async def main():
    ap = argparse.ArgumentParser(); ap.add_argument('--only', choices=['pages', 'tidy'])
    args = ap.parse_args()
    srv, url = serve()
    failed = 0
    async with async_playwright() as pw:
        if args.only in (None, 'pages'):
            print('pages (demo mode, sample data):'); failed += await test_pages(pw, url)
        if args.only in (None, 'tidy'):
            print('tidy vessel names:'); failed += await test_tidy(pw, url)
    srv.shutdown()
    print('\n' + ('ALL PASSED' if not failed else f'{failed} FAILED'))
    sys.exit(1 if failed else 0)


asyncio.run(main())
