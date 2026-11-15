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


async def main():
    ap = argparse.ArgumentParser(); ap.add_argument('--only', choices=['pages', 'tidy', 'libs', 'packs', 'markup', 'invprice', 'sizes', 'settings'])
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
        if args.only in (None, 'packs'): await run('pack pricing:', test_packs(pw, url))
        if args.only in (None, 'settings'): await run('settings (app version, waiting to send):', test_settings(pw, url))
    srv.shutdown()
    print('\n' + ('ALL PASSED' if not failed else f'{failed} FAILED'))
    sys.exit(1 if failed else 0)


asyncio.run(main())
