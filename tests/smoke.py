#!/usr/bin/env python3
"""Dockline smoke tests — run the real app in a headless browser, in demo mode (no cloud, no login).

    python3 tests/smoke.py              # everything
    python3 tests/smoke.py --only tidy  # one group: pages | tidy | libs | settings

1. pages  — opens every page with sample data and fails on an uncaught error, a console error,
            a page that renders nothing, or a "no access" screen.
2. tidy   — regression test: "Tidy vessel names" must not come back after it has run
            (it did for vessels merged in "Same vessel, spelt differently").
3. libs   — the Excel / zip / drag-to-reorder libraries load only when a feature needs them (not on every page load),
            load once, fail with a readable message, and can be retried; pages still work if one can't load.
4. settings — Settings → App version (shows the version, checks for a newer one, "Refresh app files" re-downloads every
            css/js file and reloads) and the count of imported rows still waiting to be sent.

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


REQUESTS = []     # (path, cache-control, pragma) of everything the test server was asked for


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a, **k):      # keep the test output readable
        pass

    def do_GET(self):
        REQUESTS.append((self.path.split('?')[0], self.headers.get('Cache-Control') or '', self.headers.get('Pragma') or ''))
        super().do_GET()


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
        pcs:   calc({name:'COCA COLA 300 ML', unit:'CAN'}, '24 PCS*300 ML', '15.51'),
        plain: calc({name:'RICE', unit:'KG'}, 'KG', '10', {qty:'10'}),
      };
    }""")
    check(r['can']['g'] == '3636' and not r['can']['issue'], 'unit CAN: 10 cases x 24 x 15.15 = 3636 automatically', r['can'])
    check(r['cs']['basis'] == 'case' and r['cs']['g'] == '3636', 'unit CASE: billed per whole pack, 10 x 363.60', r['cs'])
    check(r['name']['g'] == '3636', 'no unit but name carries the piece size: per piece', r['name'])
    check(r['none']['issue'] == 'Pack choice needed', 'cannot be told: the line asks instead of guessing', r['none'])
    check(r['pcs']['g'] == '3722.4' and not r['pcs']['issue'], '"24 PCS*300 ML" is read as a pack of 24: 10 x 24 x 15.51 = 3722.40', r['pcs'])
    check(r['plain']['g'] == '100' and not r['plain']['issue'], 'a plain KG line is unaffected', r['plain'])
    await browser.close()
    return failed


# ---------------------------------------------------------------- 5. product table: markup cell
async def test_markup(pw, url):
    errors = []
    browser, page, net = await fresh_page(pw, url, errors)
    failed = 0
    def check(ok, label, detail=''):
        nonlocal failed
        print(f"  {'PASS' if ok else 'FAIL'}  markup/{label}" + ('' if ok else f'   ({detail})'))
        failed += (not ok)
    await page.evaluate("async()=>{ location.hash='#/table'; await render(); }")
    await page.wait_for_timeout(500)
    row = page.locator('tr:has(input[data-f="__markup"])').first
    cost, sell, mk = row.locator('input[data-f="costPrice"]'), row.locator('input[data-f="sellPrice"]'), row.locator('input[data-f="__markup"]')
    await cost.fill(''); await sell.fill('52.35'); await page.wait_for_timeout(150)
    await mk.focus(); await page.keyboard.type('1'); await page.keyboard.type('0')        # focus(), not click(): the row restyles after the sell price is typed and a click could land on a neighbour cell
    modal_while_typing = await page.locator('#modal-root *').count()
    check(modal_while_typing == 0, 'no pop-up while the number is still being typed', modal_while_typing)
    await page.keyboard.press('Tab')
    await page.locator('#pt_mk_ok').wait_for(timeout=8000)           # the pop-up shows once the cell is left (waits instead of guessing a delay)
    txt = await page.locator('#modal-root').inner_text()
    check('47.59' in txt and '52.35' in txt, 'pop-up appears when you finish: offers cost 47.59, sell stays 52.35', txt[:120])
    await page.locator('#pt_mk_ok').click(); await page.wait_for_timeout(300)
    sell_after = await row.locator('input[data-f="sellPrice"]').input_value()
    cost_after = await row.locator('input[data-f="costPrice"]').input_value()
    check(sell_after == '52.35' and cost_after == '47.59', 'sell price untouched, chosen cost saved', f'sell={sell_after} cost={cost_after}')
    await cost.fill(''); await sell.fill('110')
    await page.wait_for_timeout(150); await mk.focus(); await mk.fill('10'); await page.keyboard.press('Tab')
    await page.wait_for_function("(document.querySelector('input[data-f=\"costPrice\"]')||{}).value==='100'", timeout=8000)
    check(await row.locator('input[data-f="costPrice"]').input_value() == '100', 'exact case still fills the cost (110 at 10% -> 100)')
    check(not errors, 'no page errors', errors[:1])
    await browser.close()
    return failed


# ---------------------------------------------------------------- 6. invoice price -> product
async def test_invprice(pw, url):
    errors = []
    browser, page, net = await fresh_page(pw, url, errors)
    failed = 0
    def check(ok, label, detail=''):
        nonlocal failed
        print(f"  {'PASS' if ok else 'FAIL'}  invprice/{label}" + ('' if ok else f'   ({detail})'))
        failed += (not ok)
    r = await page.evaluate("""async () => {
      const mkp = (id, over) => Object.assign({id, name:'T '+id, unit:'PCS', supplierId:'', warehouseId:'', sectionId:'', priority:1, active:true, costPrice:'', sellPrice:''}, over||{});
      for (const p of [mkp('t1'), mkp('t2', {sellPrice:'9'}), mkp('t3'), mkp('t4', {unit:'KG'})]) await put('products', p);
      const byProd = new Map();
      const L = (pid, over) => Object.assign({id:uid(), productId:pid, desc:'x', qty:'2', unit:'PCS', price:'', include:true, ref:null, pack:null}, over||{});
      const inv = {number:'', priceBasis:'sell', lines:[L('t1',{price:'12.5'}), L('t1'), L('t2',{price:'11'}), L('t3',{price:'7', lump:'Meat'}), L('t4',{price:'5', unit:'PCS'})]};
      for (let i = 0; i < inv.lines.length; i++) await priceToProduct(inv, i, byProd);
      const g = async id => (await getOne('products', id)).sellPrice;
      return {t1: await g('t1'), second: inv.lines[1].price, t2: await g('t2'), t3: await g('t3'), t4: await g('t4'), note4: (inv.lines[4].savedNote||{}).text||'', hist: ((await getOne('products','t1')).priceHistory||[]).length};
    }""")
    check(r['t1'] == '12.5', 'a price typed on the invoice is saved on a product that had none', r)
    check(r['second'] == '12.5', 'another line of the same product is filled in too', r)
    check(r['t2'] == '9', 'an existing product price is never overwritten', r)
    check(r['t3'] == '', 'lines priced as a whole (lump) never write to the product', r)
    check(r['t4'] == '' and 'Not saved' in r['note4'], 'a different unit is not saved, and the line says so', r)
    check(r['hist'] == 1, 'the change is recorded in the price history', r)
    check(not errors, 'no page errors', errors[:1])
    await browser.close()
    return failed


# ---------------------------------------------------------------- 7. size differs between the picked unit and the product
async def test_sizes(pw, url):
    errors = []
    browser, page, net = await fresh_page(pw, url, errors)
    failed = 0
    def check(ok, label, detail=''):
        nonlocal failed
        print(f"  {'PASS' if ok else 'FAIL'}  sizes/{label}" + ('' if ok else f'   ({detail})'))
        failed += (not ok)
    r = await page.evaluate("""() => {
      const mk = (name, unit, over) => { const sz = parseSize(name); return Object.assign({qty:'50', unit, price:'797.5', include:true, ref:null, pack:null, productId:'p', desc:'Cashew', priceUnit:'KG',
        nameSize: sz ? {qty:sz.qty, unit:sz.unit} : null}, over||{}); };
      const inv = {roundMode:'ask'};
      const flag = l => lineIssues(l, inv, null).some(m => m.startsWith('Size differs'));
      const tot = l => Dec.str(invoiceTotals({lines:[l], taxOn:false, roundMode:'ask'}).total);
      const byref = mk('CASHEW RAW 1 KG', 'TIN 150 gm'); byref.ref = {qty:'1', unit:'kg'};
      return {cashew: flag(mk('CASHEW RAW 1 KG', 'TIN 150 gm')), same: flag(mk('FLOUR 500 GM', 'PKT 500 GM')), bare: flag(mk('SUGAR 50 KG', 'KG')),
              noSize: flag(mk('COCA COLA', 'CAN')), byref: tot(byref), byrefFlag: flag(byref), asis: tot(mk('CASHEW RAW 1 KG', 'TIN 150 gm', {perPiece:true}))};
    }""")
    check(r['cashew'], 'TIN 150 gm on a "1 KG" product is flagged (blocking)', r)
    check(not r['same'] and not r['bare'] and not r['noSize'], 'same size, bare KG and size-less products are not flagged', r)
    check(r['byref'] == '5981.25' and not r['byrefFlag'], 'bill by weight: 50 x 150 gm at 797.5 per kg = 5981.25', r)
    check(r['asis'] == '39875', 'bill per tin as is stays possible when chosen', r)
    check(not errors, 'no page errors', errors[:1])
    await browser.close()
    return failed


# ---------------------------------------------------------------- 8. Settings: app version + what is waiting to send
async def test_settings(pw, url):
    failed = 0

    def check(ok, label, detail=''):
        nonlocal failed
        print(f"  {'PASS' if ok else 'FAIL'}  settings/{label}" + ('' if ok else f'   ({detail})'))
        failed += (not ok)

    errors = []
    browser, page, net = await fresh_page(pw, url, errors)
    await page.evaluate("async()=>{ location.hash='#/settings'; await render(); }")
    await page.wait_for_timeout(300)
    s = await page.evaluate("({shown: (document.querySelector('#verNow')||{}).textContent, real: APP_VERSION, buttons: !!(document.querySelector('#verCheck') && document.querySelector('#verRefresh'))})")
    check(s['shown'] == s['real'] and s['buttons'], 'shows-the-version', str(s))

    async def status():
        await page.wait_for_function("document.querySelector('#verStatus').textContent.trim() !== '' && document.querySelector('#verStatus').textContent.trim() !== 'Checking…'", timeout=8000)
        return (await page.inner_text('#verStatus')).strip()

    await page.click('#verCheck')
    st = await status()
    banner = await page.evaluate("document.querySelector('#updateBanner').classList.contains('show')")
    check('latest version' in st and not banner, 'up-to-date', f'{st!r}, banner: {banner}')

    html = open(os.path.join(ROOT, 'index.html'), encoding='utf-8').read()
    newer = re.sub(r"const APP_VERSION\s*=\s*'[^']*'", "const APP_VERSION = '9999-01-01.1'", html)
    mode = {'v': 'newer'}

    async def index_check(route):
        if mode['v'] == 'newer': await route.fulfill(status=200, content_type='text/html', body=newer)
        else: await route.abort()
    await page.route(re.compile(r'/index\.html\?_='), index_check)

    await page.evaluate("document.querySelector('#verStatus').textContent=''")
    await page.click('#verCheck')
    st = await status()
    banner = await page.evaluate("document.querySelector('#updateBanner').classList.contains('show')")
    check('9999-01-01.1' in st and 'newer version' in st and banner, 'newer-version-found', f'{st!r}, banner: {banner}')

    mode['v'] = 'offline'
    await page.evaluate("document.querySelector('#verStatus').textContent=''")
    await page.click('#verCheck')
    st = await status()
    check("Couldn't check" in st, 'check-fails-politely-when-offline', repr(st))
    await page.unroute(re.compile(r'/index\.html\?_='), index_check)

    expected_js = await page.evaluate("[...document.querySelectorAll('script[src]')].filter(e=>new URL(e.src).pathname.startsWith('/js/')).length")
    expected_css = await page.evaluate("[...document.querySelectorAll('link[rel=stylesheet][href]')].filter(e=>new URL(e.href).pathname.startsWith('/css/')).length")
    REQUESTS.clear()
    async with page.expect_navigation(timeout=20000):
        await page.click('#verRefresh')
    await page.wait_for_timeout(300)
    # files the server was asked to send fresh (what fetch(..., {cache:'reload'}) asks for)
    fresh = {'js': {r[0] for r in REQUESTS if r[0].startswith('/js/') and ('no-cache' in r[1] or 'no-cache' in r[2])},
             'css': {r[0] for r in REQUESTS if r[0].startswith('/css/') and ('no-cache' in r[1] or 'no-cache' in r[2])}}
    check(len(fresh['js']) >= expected_js and len(fresh['css']) >= expected_css and expected_js > 20, 'refresh-redownloads-every-file-and-reloads',
          f'js re-fetched {len(fresh["js"])}/{expected_js}, css {len(fresh["css"])}/{expected_css}')
    await browser.close()

    # imported past-order rows that have not been sent yet are counted
    errors = []
    browser, page, net = await fresh_page(pw, url, errors)
    c = await page.evaluate("""async()=>{
      const o = (i, synced)=>({id:'o'+i, fileName:'f'+i, vesselName:'V'+i, vesselKey:'v'+i, imo:'', orderDate:'2026-01-0'+i, fingerprint:'fp'+i, lineCount:1, importedAt:'2026-01-01T00:00:00Z', synced});
      const l = (i, synced)=>({id:'l'+i, historyOrderId:'o1', vesselKey:'v1', orderDate:'2026-01-01', excelDesc:'x', descKey:'x', qty:1, unit:'KG', productId:null, skipped:true, baseOk:true, synced});
      await bulkPut('historyOrders', [o(1,false), o(2,false), o(3,false), o(4,true), o(5,true)]);
      await bulkPut('historyLines',  [l(1,false), l(2,true), l(3,true), l(4,true)]);
      return await pendingSyncCounts();
    }""")
    check(c['history'] == 4 and isinstance(c['queue'], int), 'counts-imported-rows-waiting-to-send', str(c))
    await browser.close()
    return failed


# ---------------------------------------------------------------- 8. invoice editor: short pick, quantity, change product, add items
async def test_invedit(pw, url):
    errors = []
    browser, page, net = await fresh_page(pw, url, errors)
    failed = 0
    def check(ok, label, detail=''):
        nonlocal failed
        print(f"  {'PASS' if ok else 'FAIL'}  invedit/{label}" + ('' if ok else f'   ({detail})'))
        failed += (not ok)
    await page.evaluate("""async () => {
      const P = (id, name, unit, sell) => ({id, name, unit, supplierId:'', warehouseId:'', sectionId:'', priority:1, active:true, costPrice:'', sellPrice:sell});
      await put('products', P('ivp1','Cottage cheese 950 GM','PKT','212.5'));
      await put('products', P('ivp2','Food color blue','PKT','40'));
      await put('products', P('ivp3','Food color green','PKT','45'));
      await put('orderItems', {id:'ivi1', orderId:'ivo1', status:'picked', requestedQty:6, requestedUnit:'PKT', actualQty:5, actualUnit:'PKT', excelDesc:'COTTAGE CHEESE 6 X 950GM', productId:'ivp1', productName:'Cottage cheese 950 GM'});
      await put('orderItems', {id:'ivi2', orderId:'ivo1', status:'picked', requestedQty:40, requestedUnit:'PKT', actualQty:40, actualUnit:'PKT', excelDesc:'FOOD COLOR GREEN', productId:'ivp2', productName:'Food color blue'});
      const L = (id, itemId, productId, desc, qty, price, sysName) => ({id, itemId, productId, desc, qty, unit:'PKT', cost:'', sell:price, price, pack:null, priceUnit:'PKT', ref:null, nameSize:null, lump:'', discType:'', disc:'', include:true, substituted:false, ordered:desc, sysName, packBasis:'', doubt:''});
      await put('invoices', {id:'ivinv', orderId:'ivo1', type:'Provision', status:'draft', number:'', priceBasis:'sell', invoiceDate:'2026-11-18', taxOn:false, taxRate:'', taxLabel:'Tax', notes:'', lumps:[], createdAt:new Date().toISOString(),
        lines:[L('l1','ivi1','ivp1','COTTAGE CHEESE 6 X 950GM','5','212.5','Cottage cheese 950 GM'), L('l2','ivi2','ivp2','FOOD COLOR GREEN','40','40','Food color blue')]});
      location.hash = '#/invoice/ivinv';
    }""")
    await page.wait_for_selector('[data-qty="0"]', timeout=8000)
    txt = await page.locator('#iv_lines').inner_text()
    check('Ordered 6, picked 5' in txt and '1 short' in txt, 'short pick is flagged (ordered 6, picked 5)', txt[:200])
    check('Ordered 40' not in txt, 'a full pick is not flagged')
    check(await page.locator('.iv-kpis .wm-kpi').count() == 4, 'the draft shows the four summary tiles')
    check('EGP' in await page.locator('.pr-bar .bar-tot').inner_text(), 'the sticky bar shows the invoice total')
    kpi_total = (await page.locator('.iv-kpis .wm-kpi').nth(3).locator('b').inner_text()).strip()
    check(kpi_total == (await page.locator('.iv-sum .grand b').inner_text()).strip(), 'the total tile matches the total at the bottom', kpi_total)
    await page.locator('[data-qty="1"]').fill('28'); await page.locator('[data-qty="1"]').press('Tab')
    await page.wait_for_function("document.querySelector('#iv_lines').innerText.includes('Picked 40')", timeout=5000)
    tot = await page.locator('.iv-sum .grand').inner_text()
    check('1,120.00' in (await page.locator('#iv_lines').inner_text()), 'quantity 28 x 40 = 1,120.00 on the line', tot)
    await page.locator('[data-ok="qtyreset:1"]').click()
    await page.wait_for_function("!document.querySelector('#iv_lines').innerText.includes('Picked 40')", timeout=5000)
    check((await page.locator('[data-qty="1"]').input_value()) == '40', 'reset to picked puts 40 back')
    await page.locator('[data-ok="swap:1"]').click()
    await page.locator('#pp_q').fill('green'); await page.locator('[data-pp="ivp3"]').click()
    await page.wait_for_function("document.querySelector('[data-price=\"1\"]').value==='45'", timeout=5000)
    check('FOOD COLOR GREEN' in await page.locator('#iv_lines').inner_text(), 'changing the product re-prices the line (45) and keeps the order wording')
    await page.locator('#iv_add').click(); await page.locator('#ad_prod').click()
    await page.locator('#pp_q').fill('cottage'); await page.locator('[data-pp="ivp1"]').click()
    await page.locator('#ad_q').fill('3'); await page.locator('#ad_ok').click()
    await page.wait_for_selector('[data-qty="2"]', timeout=5000)
    check('Added on invoice' in await page.locator('#iv_lines').inner_text() and (await page.locator('[data-price="2"]').input_value()) == '212.5', 'an added product line comes with its price')
    await page.locator('#iv_add').click(); await page.locator('#ad_free').click()
    await page.locator('#ad_n').fill('Delivery fee'); await page.locator('#ad_q').fill('1'); await page.locator('#ad_p').fill('150.25'); await page.locator('#ad_ok').click()
    await page.wait_for_selector('[data-qty="3"]', timeout=5000)
    check((await page.locator('[data-price="3"]').input_value()) == '150.25', 'a free item keeps the price typed for it')
    await page.locator('[data-b="cost"]').click(); await page.wait_for_timeout(300)
    check((await page.locator('[data-price="3"]').input_value()) == '150.25', 'switching the price basis does not wipe a free item')
    check(not errors, 'no page errors', errors[:1])
    await browser.close()
    return failed


# ---------------------------------------------------------------- 9. units: picked unit vs price unit
async def test_units(pw, url):
    errors = []
    browser, page, net = await fresh_page(pw, url, errors)
    failed = 0
    def check(ok, label, detail=''):
        nonlocal failed
        print(f"  {'PASS' if ok else 'FAIL'}  units/{label}" + ('' if ok else f'   ({detail})'))
        failed += (not ok)
    r = await page.evaluate("""() => {
      const L = (unit, priceUnit, qty, price, over) => Object.assign({qty, unit, priceUnit, price, productId:'p', include:true, ref:null, pack:null, unitCheck:true, facts:{}}, over||{});
      const c = l => { const x = lineCalc(l, l.price, 'ask'); return {g: Dec.str(x.gross), bq: x.billed ? Dec.str(x.billed.qty) : null, bu: x.billed ? x.billed.unit : null, issue: x.issue, ask: x.ask, partial: x.partial}; };
      const f23 = {pkt:{qty:'23', unit:'pc'}};
      return {
        broth: c(L('PKT 100 GM','KG','30','180')), brothOld: c(L('PKT 100 GM','KG','30','180',{unitCheck:false})),
        cashew: c(L('TIN 150 gm','KG','50','797.5')),
        samNo: c(L('PC','PKT','115','62')), samYes: c(L('PC','PKT','115','62',{facts:f23})),
        part: c(L('PC','PKT','118','62',{facts:f23})), floor: c(L('PC','PKT','118','62',{facts:f23, packRound:'floor'})), ceil: c(L('PC','PKT','118','62',{facts:f23, packRound:'ceil'})),
        alias1: c(L('PCS','PC','4','10')), alias2: c(L('KGS','KG','4','10')), alias3: c(L('PACKET','PKT','4','10')),
        pktKg: c(L('PKT','KG','30','180',{facts:{pkt:{qty:'100', unit:'gm'}}})), pktKgNo: c(L('PKT','KG','30','180')),
        bad: c(L('ML','KG','2','10')), caseP: c(L('CASE','PKT','3','50',{facts:{case:{qty:'12', unit:'pkt'}}})),
      };
    }""")
    check(r['broth']['g'] == '540' and r['broth']['bq'] == '3' and r['broth']['bu'] == 'KG', '30 x PKT 100 GM priced per KG = 3 KG x 180 = 540', r['broth'])
    check(r['brothOld']['g'] == '5400', 'a line without the unit check (an issued invoice) keeps its old numbers', r['brothOld'])
    check(r['cashew']['g'] == '5981.25' and r['cashew']['bq'] == '7.5', '50 TIN 150 gm priced per KG = 7.5 KG = 5981.25', r['cashew'])
    check(r['samNo']['issue'] == 'Unit conversion needed' and r['samNo']['ask']['big'] == 'pkt' and r['samNo']['ask']['smallLabel'] == 'PC', 'PC priced per PKT with no fact: asks how many PC in a PKT', r['samNo'])
    check(r['samYes']['g'] == '310' and r['samYes']['bq'] == '5' and r['samYes']['bu'] == 'PKT', '115 PC / 23 = 5 PKT x 62 = 310', r['samYes'])
    check(r['part']['issue'] == 'Partial pack' and r['part']['partial']['lo'] == '5' and r['part']['partial']['hi'] == '6', '118 PC is not a whole number of packs: asks', r['part'])
    check(r['floor']['g'] == '310' and r['ceil']['g'] == '372', 'partial pack: bill 5 = 310, bill 6 = 372', r)
    check(all(r[k]['g'] == v for k, v in [('alias1','40'),('alias2','40'),('alias3','40')]) and not any(r[k]['issue'] for k in ('alias1','alias2','alias3')), 'PCS/PC, KGS/KG, PACKET/PKT are the same unit (no question)', [r['alias1'], r['alias2'], r['alias3']])
    check(r['pktKg']['g'] == '540' and r['pktKgNo']['issue'] == 'Unit conversion needed', 'PKT priced per KG: uses "1 PKT = 100 gm", asks when unknown', [r['pktKg'], r['pktKgNo']])
    check(r['bad']['issue'] == 'Unit not comparable', 'ML picked, priced per KG: not comparable (blocks)', r['bad'])
    check(r['caseP']['g'] == '1800' and r['caseP']['bu'] == 'PKT', '3 CASE x 12 PKT x 50 = 1800', r['caseP'])
    await page.evaluate("""async () => {
      await put('products', {id:'up1', name:'Samosa', unit:'PKT', supplierId:'', warehouseId:'', sectionId:'', priority:1, active:true, costPrice:'', sellPrice:'62'});
      await put('orderItems', {id:'ui1', orderId:'uo1', status:'picked', requestedQty:115, requestedUnit:'PC', actualQty:115, actualUnit:'PC', excelDesc:'SAMOSA', productId:'up1'});
      await put('invoices', {id:'uinv', orderId:'uo1', type:'Provision', status:'draft', number:'', priceBasis:'sell', invoiceDate:'2026-11-18', taxOn:false, taxRate:'', taxLabel:'Tax', notes:'', lumps:[], createdAt:new Date().toISOString(),
        lines:[{id:'u1', itemId:'ui1', productId:'up1', desc:'SAMOSA', qty:'115', unit:'PC', cost:'', sell:'62', price:'62', pack:null, priceUnit:'PKT', ref:null, nameSize:null, lump:'', discType:'', disc:'', include:true, substituted:false, ordered:'SAMOSA', sysName:'Samosa', packBasis:'', doubt:''}]});
      location.hash = '#/invoice/uinv';
    }""")
    await page.wait_for_selector('[data-fact="0"]', timeout=8000)
    check(await page.locator('#iv_issue').is_disabled(), 'the line blocks issuing until the question is answered')
    await page.locator('[data-fact="0"]').fill('23'); await page.locator('[data-ok="fact:0"]').click()
    await page.wait_for_function("document.querySelector('#iv_lines').innerText.includes('310.00')", timeout=5000)
    txt = await page.locator('#iv_lines').inner_text()
    check('115 PC' in txt and '5 PKT' in txt, 'after answering: shows 115 PC ÷ 23 = 5 PKT x 62 = 310.00', txt[:300])
    saved = await page.evaluate("async () => ((await getOne('products','up1')).unitFacts||{}).pkt")
    check(saved and saved['qty'] == '23' and saved['unit'] == 'pc', 'the fact is saved on the product (asked once)', saved)
    check(not errors, 'no page errors', errors[:1])
    await browser.close()
    return failed


# ---------------------------------------------------------------- 10. picked unit vs price unit (weights, packs of pieces, missing unit)
async def test_units(pw, url):
    errors = []
    browser, page, net = await fresh_page(pw, url, errors)
    failed = 0
    def check(ok, label, detail=''):
        nonlocal failed
        print(f"  {'PASS' if ok else 'FAIL'}  units/{label}" + ('' if ok else f'   ({detail})'))
        failed += (not ok)
    r = await page.evaluate("""() => {
      const mk = over => Object.assign({id:'x', productId:'p', desc:'x', qty:'30', unit:'PKT 100 GM', price:'220', include:true, ref:null, pack:null, priceUnit:'KG', unitCheck:true, facts:{}, nameSize:null, sysName:''}, over);
      const run = l => { const c = lineCalc(l, l.price, 'ask'); return {gross:Dec.str(c.gross), issue:c.issue, warn:lineIssues(l, {roundMode:'ask', taxOn:false}, c)}; };
      return {
        stock: run(mk({})),
        stockNoUnitName: run(mk({priceUnit:'', sysName:'BROTH BEEF KG'})),
        stockNoUnit: run(mk({priceUnit:'', sysName:'BROTH'})),
        puff: run(mk({qty:'25', unit:'400 GM', priceUnit:'400 GM', price:'84'})),
        samosa: run(mk({qty:'115', unit:'PER PC', priceUnit:'23 PC', price:'110'})),
        samosaRef: run(mk({qty:'115', unit:'PER PC', priceUnit:'PC', price:'110', ref:{qty:'23', unit:'PC'}})),
        samosaPartial: run(mk({qty:'116', unit:'PC', priceUnit:'23 PC', price:'110'})),
        trays: run(mk({qty:'5', unit:'TRAY 23 PCS', priceUnit:'PC', price:'5'})),
        corn: run(mk({qty:'12', unit:'tin 400 gm', priceUnit:'', price:'47.1', sysName:'CORN KERNEL 400 GM', nameSize:{qty:'400', unit:'GM'}})),
        cornKg: run(mk({qty:'5', unit:'tin 200 gm', priceUnit:'', price:'47.1', sysName:'CORN KERNEL 400 GM', nameSize:{qty:'400', unit:'GM'}})),
        cartons: run(mk({qty:'3', unit:'12 PCS', priceUnit:'CTN', price:'100'})),
      };
    }""")
    check(r['stock']['gross'] == '660', '30 x PKT 100 GM priced per KG is 3 KG = 660', r['stock'])
    check(r['stockNoUnitName']['gross'] == '660', 'a product with no unit but "KG" in its name is priced per KG', r['stockNoUnitName'])
    check(r['stockNoUnit']['issue'] == 'Price unit needed', 'no unit anywhere: the line asks instead of billing 30 packs as 30 KG', r['stockNoUnit'])
    check(r['puff']['gross'] == '2100' and not r['puff']['warn'], '25 x 400 GM priced per 400 GM is 25 units, no warning', r['puff'])
    check(r['samosa']['gross'] == '550' and not r['samosa']['warn'], '115 PER PC priced per 23 PC is 5 packs = 550', r['samosa'])
    check(r['samosaRef']['gross'] == '550', 'the same when the product keeps "23 PC" as its price reference', r['samosaRef'])
    check(r['samosaPartial']['issue'] == 'Partial pack', '116 pieces is not a whole number of 23-piece packs: it asks', r['samosaPartial'])
    check(r['corn']['gross'] == '565.2' and not r['corn']['warn'], 'a tin of CORN KERNEL 400 GM with no unit: price is per tin, never per gram (12 x 47.1)', r['corn'])
    check(any(w.startswith('Size differs') for w in r['cornKg']['warn']) and r['cornKg']['gross'] == '235.5', 'picked as 200 GM against a 400 GM item with no unit: not turned into a per-gram price, the size check asks', r['cornKg'])
    check(r['cartons']['gross'] == '300' and not r['cartons']['issue'], 'a unit like "12 PCS" against CTN does not newly block the line', r['cartons'])
    check(r['trays']['gross'] == '575', '5 trays of 23 PCS priced per PC is 115 pieces', r['trays'])
    check(not errors, 'no page errors', errors[:1])
    await browser.close()
    return failed


# ---------------------------------------------------------------- 11. order report Excel layout (recorded, no real ExcelJS needed)
async def test_report(pw, url):
    errors = []
    browser, page, net = await fresh_page(pw, url, errors)
    failed = 0
    def check(ok, label, detail=''):
        nonlocal failed
        print(f"  {'PASS' if ok else 'FAIL'}  report/{label}" + ('' if ok else f'   ({detail})'))
        failed += (not ok)
    r = await page.evaluate("""async () => {
      const rows = [];
      const mkRow = vals => { const cells = vals.map(v => ({value:v})); const row = {values:vals, cells, number:rows.length+1, height:0,
        getCell: i => cells[i-1] || (cells[i-1] = {}), eachCell: (o, f) => (f||o)&&(typeof o==='function'?o:f) && cells.forEach(c => (typeof o==='function'?o:f)(c))}; rows.push(row); return row; };
      const ws = {columns:null, addRow: v => mkRow(v), mergeCells(){}, get lastRow(){ return rows[rows.length-1]; }};
      window.ExcelJS = {Workbook: function(){ this.addWorksheet = () => ws; this.xlsx = {writeBuffer: async () => new ArrayBuffer(1)}; }};
      let savedAs = ''; window.saveFile = async (name) => { savedAs = name; };
      await put('orders', {id:'ro1', vessel:'MV Test', imo:'PGH-ALL-31', orderNumber:'31', status:'completed', destination:'Port Said'});
      await put('orderItems', {id:'ri1', orderId:'ro1', sr:'1', excelDesc:'OLIVE OIL', excelQty:5, excelUnit:'LTR', status:'picked', actualQty:5, actualUnit:'LTR', notes:'-12 PKT cheese\\r\\n-24 PKT ham\\r\\n-6 PKT butter\\r\\n'});
      await put('orderItems', {id:'ri2', orderId:'ro1', sr:'2', excelDesc:'RICE', excelQty:1, excelUnit:'BAG', status:'picked', actualQty:1, actualUnit:'BAG', notes:''});
      await exportOrderExcel('ro1');
      const data = rows.find(x => x.values && x.values[1] === 'OLIVE OIL'), plain = rows.find(x => x.values && x.values[1] === 'RICE');
      const labels = rows.map(x => x.values && x.values[0]);
      return {found: !!data, al: data ? [1,2,3,4,5].map(i => (data.cells[i-1].alignment||{}).horizontal || '') : [], savedAs,
        notes: data ? data.cells[6].value : '', notesWrap: data ? !!(data.cells[6].alignment||{}).wrapText : false, noteH: data ? data.height : 0, plainH: plain ? plain.height : 0,
        title: String(rows[0].values[0]), hasSummary: labels.includes('Summary'), hasDest: labels.includes('Destination'), pageSetup: ws.pageSetup, footer: ws.headerFooter};
    }""")
    check(r['found'], 'the item row is written', r)
    check(r['found'] and r['al'][0] == 'center' and r['al'][2] == 'center' and r['al'][3] == 'center' and r['al'][4] == 'center', 'SR., QUANTITY, UNIT and CONDITION are centred', r)
    check(r['found'] and r['al'][1] == 'left', 'DESCRIPTION stays left-aligned', r)
    check(r['savedAs'] == 'PGH-ALL-31-report.xlsx', 'the file is named after the vessel code + report', r['savedAs'])
    check(r['notes'] == '-12 PKT cheese\n-24 PKT ham\n-6 PKT butter' and r['notesWrap'], 'NOTES keep every line and wrap, nothing hidden behind a click', r['notes'])
    check(r['noteH'] >= 48 and r['noteH'] > r['plainH'], 'the row is tall enough to show all three note lines', (r['noteH'], r['plainH']))
    check(r['title'].startswith('ORDER REPORT') and r['hasSummary'] and r['hasDest'], 'title banner, summary strip and destination row are there', r['title'])
    check(r['pageSetup']['orientation'] == 'landscape' and r['pageSetup']['fitToWidth'] == 1 and 'Page' in r['footer']['oddFooter'], 'prints landscape, one page wide, with page numbers', r['pageSetup'])
    check(not errors, 'no page errors', errors[:1])
    await browser.close()
    return failed


# ---------------------------------------------------------------- 12. Settings / Products / Insights layout
async def test_polish(pw, url):
    errors = []
    browser, page, net = await fresh_page(pw, url, errors)
    failed = 0
    def check(ok, label, detail=''):
        nonlocal failed
        print(f"  {'PASS' if ok else 'FAIL'}  polish/{label}" + ('' if ok else f'   ({detail})'))
        failed += (not ok)
    async def go(h):
        await page.evaluate("async(h)=>{ location.hash='#/'+h; await render(); }", h)
        await page.wait_for_timeout(300)
    await go('settings')
    n = await page.locator('#main .sec-h .sec-ic svg').count()
    check(n >= 5, 'every Settings section has an icon tile', n)
    await go('products')
    check(await page.locator('.topbar #addProd').count() == 1 and await page.locator('.topbar .btn').count() == 1, 'Products: only "Add product" sits next to the title')
    check(await page.locator('.pg-tools .btn').count() == 4, 'Products: the four other tools are in their own row', await page.locator('.pg-tools .btn').count())
    await page.locator('#bulkImport').click(); await page.wait_for_timeout(200)
    check(await page.locator('#addProd').count() >= 1, 'Products: the tool buttons still work (bulk import opens)')
    await page.keyboard.press('Escape')
    await go('insights')
    check(await page.locator('.empty-card .sec-ic').count() == 1 and await page.locator('.empty-card a.btn').count() == 1, 'Insights: the empty state has its icon and a normal-size import button')
    seed = await page.evaluate("""async()=>{
      const prods=(await getAll('products')).filter(p=>!p.lump).slice(0,3); const name='MV TEST ONE';
      const orders=[], lines=[];
      for(let m=0;m<8;m++){ const date=new Date(2026,2+m,5).toISOString().slice(0,10); const o={id:'ph'+m, fileName:'f'+m+'.xlsx', code:'T-'+m, vesselName:name, vesselKey:vesselKeyOf(name), imo:'', orderDate:date, fingerprint:name+m, lineCount:3, importedAt:date+'T10:00:00Z', synced:true}; orders.push(o);
        prods.forEach((p,i)=>{ const qty=20+m*3+i; lines.push({id:'pl'+m+'_'+i, historyOrderId:o.id, vesselKey:o.vesselKey, orderDate:date, excelDesc:p.name.toUpperCase(), descKey:p.name.toLowerCase(), qty, unit:p.unit||'KG', productId:p.id, baseQty:qty, baseUnit:(p.unit||'KG').toUpperCase(), skipped:false, baseOk:true}); }); }
      await bulkPut('historyOrders', orders); await bulkPut('historyLines', lines); return [prods[0].id, vesselKeyOf(name)]; }""")
    await go('insights')
    check(await page.locator('.ins-kpis .wm-kpi .wm-ic svg').count() == 4, 'Insights with data: four icon tiles', await page.locator('.ins-kpis .wm-kpi .wm-ic svg').count())
    check(await page.locator('#pt_body .trend-pill, #pt_body .trend-flat, #pt_body .subtle').count() >= 1, 'Insights: trend cells render')
    await go('insights/product/' + seed[0])
    check(await page.locator('.mc-legend').count() == 1 and await page.locator('#pc_chart svg text').filter(has_text='normal').count() == 0, 'Product page: chart legend sits outside the chart (no label over the bars)')
    await page.locator('#pc_chart .mc-hit').nth(2).dispatch_event('click'); await page.wait_for_timeout(100)
    check(await page.locator('#pc_tip').is_visible(), 'Product page: tapping a bar shows its value')
    await go('insights/vessel/' + seed[1].replace(' ', '%20'))
    check(await page.locator('.ins-kpis .wm-kpi').count() == 4 and await page.locator('#va_pick').count() <= 1, 'Vessel page: icon tiles render')
    await page.set_viewport_size({'width':390,'height':800})
    await go('insights')
    check(await page.evaluate("document.documentElement.scrollWidth <= innerWidth + 1"), 'Insights on a phone: the page does not scroll sideways')
    await go('products')
    scroll = await page.evaluate("(()=>{const t=document.querySelector('.pg-tools'); return {sw:t.scrollWidth, cw:t.clientWidth, doc:document.documentElement.scrollWidth, win:innerWidth};})()")
    check(scroll['doc'] <= scroll['win'] + 1, 'Products on a phone: the page itself does not scroll sideways', scroll)
    check(not errors, 'no page errors', errors[:1])
    await browser.close()
    return failed


async def main():
    ap = argparse.ArgumentParser(); ap.add_argument('--only', choices=['pages', 'tidy', 'libs', 'packs', 'markup', 'invprice', 'sizes', 'settings', 'invedit', 'units', 'report', 'polish'])
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
        if args.only in (None, 'markup'): await run('product table markup:', test_markup(pw, url))
        if args.only in (None, 'invprice'): await run('invoice price -> product:', test_invprice(pw, url))
        if args.only in (None, 'sizes'): await run('size differs:', test_sizes(pw, url))
        if args.only in (None, 'invedit'): await run('invoice editor:', test_invedit(pw, url))
        if args.only in (None, 'units'): await run('units (picked vs price unit):', test_units(pw, url))
        if args.only in (None, 'report'): await run('order report excel:', test_report(pw, url))
        if args.only in (None, 'polish'): await run('settings / products / insights layout:', test_polish(pw, url))
        if args.only in (None, 'units'): await run('units:', test_units(pw, url))
        if args.only in (None, 'packs'): await run('pack pricing:', test_packs(pw, url))
        if args.only in (None, 'settings'): await run('settings (app version, waiting to send):', test_settings(pw, url))
    srv.shutdown()
    print('\n' + ('ALL PASSED' if not failed else f'{failed} FAILED'))
    sys.exit(1 if failed else 0)


asyncio.run(main())
