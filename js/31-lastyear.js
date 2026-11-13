/* ============================ LAST YEAR AT THIS TIME ============================
   Purpose: when a month is coming, see what vessels asked for in that same calendar month a year ago, and whether today's
   stock would cover it. The month is the unit (default = the current month, one year back); any month can be picked.
   Quantities are added up per product from the imported past orders + orders finished on the site (insightsData()), then held
   against the stock on hand: red = stock under half of that month's demand, amber = under it, green = covered.
   A line only counts if it is linked to a product and its unit converts to the product's unit — the card on the page says
   how many lines were counted and how many were left out, and how many orders that month has compared with a normal month.
   When a month has too few orders to learn from, the page says so and Home shows no notice for it. A hint, not a promise. */
window.__lyMode = window.__lyMode || 'top';   // top | warn | all
window.__lyMonth = window.__lyMonth || '';

const lyMonthName = ym=> new Date(ym+'-01T00:00:00Z').toLocaleString('en',{month:'long', year:'numeric', timeZone:'UTC'});
function lyShift(ym, n){ const [y,m] = ym.split('-').map(Number), d = new Date(Date.UTC(y, m-1+n, 1)); return d.toISOString().slice(0,7); }
function lyDefaultMonth(){ const t = todayISO(); return lyShift(t.slice(0,7), -12); }   // this month, one year back
function lyRange(ym){ return {start: ym+'-01', end: lyShift(ym,1)+'-01'}; }
const lyMedian = a=>{ const s = a.slice().sort((x,y)=>x-y); return s.length ? (s.length%2 ? s[(s.length-1)/2] : (s[s.length/2-1]+s[s.length/2])/2) : 0; };

async function lastYearWatch(ym){
  const [{hOrders, hLines, badOrders}, products, perOrder] = await Promise.all([insightsData(), slimProducts(), perOrderIds()]);
  const w = lyRange(ym), byId = new Map(products.map(p=>[p.id,p]));
  const inWin = d=> d >= w.start && d < w.end;
  const agg = new Map();
  for(const l of hLines){
    if(!l.productId || !l.baseOk || !inWin(l.orderDate) || !byId.has(l.productId) || perOrder.has(l.productId)) continue;
    const a = agg.get(l.productId) || {qty:0, vessels:new Set(), unit:l.baseUnit};
    a.qty += l.baseQty; a.vessels.add(l.vesselKey); agg.set(l.productId, a);
  }
  // how much that month really covers
  const winOrders = hOrders.filter(o=>inWin(o.orderDate)), winIds = new Set(winOrders.map(o=>o.id)), winLines = hLines.filter(l=>winIds.has(l.historyOrderId));
  const unm = new Map();
  for(const l of winLines){ if(!l.productId && !l.skipped){ const k = l.descKey||l.excelDesc; const u = unm.get(k) || {desc:l.excelDesc, n:0}; u.n++; unm.set(k,u); } }
  const perMonth = new Map();
  for(const o of hOrders){ const k = String(o.orderDate||'').slice(0,7); if(k) perMonth.set(k,(perMonth.get(k)||0)+1); }
  const nowYm = todayISO().slice(0,7), recent = [];
  for(let i=1;i<=12;i++){ const c = perMonth.get(lyShift(nowYm,-i)); if(c) recent.push(c); }
  const typical = Math.round(lyMedian(recent));            // a normal month lately
  const cov = {orders:winOrders.length, vessels:new Set(winOrders.map(o=>o.vesselKey)).size, lines:winLines.length,
    counted: winLines.filter(l=>l.productId && l.baseOk && byId.has(l.productId) && !perOrder.has(l.productId)).length,
    unmatched: winLines.filter(l=>!l.productId && !l.skipped).length, unit: winLines.filter(l=>l.productId && !l.baseOk).length,
    topUnmatched: [...unm.values()].sort((a,b)=>b.n-a.n).slice(0,6), badDates: (badOrders||[]).length,
    perMonth: [...perMonth.entries()].sort((a,b)=>a[0].localeCompare(b[0])), typical};
  const reliable = cov.orders >= 5 && cov.orders >= typical*0.4;
  const rows = [];
  for(const [pid,a] of agg){
    const p = byId.get(pid); if(!(a.qty>0)) continue;
    const tracked = isStockTracked(p), stock = tracked ? parseFloat(p.stockQty) : null;
    const sameUnit = !tracked || canonicalUnitOf(p)===a.unit;
    let level = tracked ? 'none' : 'nostock';            // nostock = no stock record at all; none = cannot be compared (unit mismatch)
    if(tracked && sameUnit && isFinite(stock)) level = stock < a.qty*0.5 ? 'red' : stock < a.qty ? 'amber' : 'green';
    rows.push({pid, name:p.name, unit:a.unit, qty:a.qty, vessels:a.vessels.size, tracked, stock, level, gap:(level==='red'||level==='amber') ? a.qty-stock : 0});
  }
  const rank = {red:0, amber:1, nostock:2, green:3, none:4};
  rows.sort((a,b)=> rank[a.level]-rank[b.level] || b.gap-a.gap || b.qty-a.qty);
  return {rows, ym, w, cov, reliable, red: rows.filter(r=>r.level==='red').length, amber: rows.filter(r=>r.level==='amber').length};
}

route('lastyear', async ()=>{
  const {hOrders} = await insightsData();
  if(!hOrders.length){ location.hash = '#/insights'; return; }
  const ym = window.__lyMonth || lyDefaultMonth(), mode = window.__lyMode, dflt = lyDefaultMonth();
  const r = await lastYearWatch(ym), fq = _fmtQty, c = r.cov, mname = lyMonthName(ym);
  const badge = {red:['b-not_available','Well below'], amber:['b-modified','Below'], green:['b-completed','Covered'], nostock:['b-pending','No stock record'], none:['b-pending','Not compared']};
  const warnSet = r.rows.filter(x=>x.level==='red'||x.level==='amber'||x.level==='nostock');
  const list = mode==='all' ? r.rows : mode==='warn' ? warnSet : r.rows.slice().sort((a,b)=>b.qty-a.qty).slice(0,20);
  const shown = list.slice(0,60);
  $('#main').innerHTML = `
    <div class="topbar"><h1>Last year at this time</h1><a href="#/insights" class="btn btn-ghost btn-sm">← Insights</a></div>
    <p class="subtle" style="margin-top:-10px;">What vessels asked for in the same month a year ago, held against the stock you have now. A hint, not a promise.</p>
    <div class="ly-nav"><button class="btn btn-ghost btn-sm" id="ly_prev" aria-label="Previous month"><span data-ico="arrow-left"></span></button><b>${esc(mname)}</b><button class="btn btn-ghost btn-sm" id="ly_next" aria-label="Next month"><span data-ico="arrow-left" style="display:inline-flex; transform:scaleX(-1);"></span></button>
      ${ym!==dflt ? `<button class="chip" id="ly_reset">${esc(lyMonthName(dflt))}</button>` : ''}</div>
    ${r.reliable ? '' : `<div class="bt-warn" style="margin-bottom:12px;"><b>Too little history for ${esc(mname)}.</b> Only ${c.orders} past order${c.orders===1?'':'s'} ${c.orders===1?'was':'were'} imported for that month${c.typical?` (a normal month lately has about ${c.typical})`:''}, so the list below is incomplete. Pick a month with more orders, or import the missing sheets. Home shows no notice for a month like this.</div>`}
    <div class="card" style="margin-bottom:14px; ${c.unmatched||c.unit||c.badDates?'border-color:var(--warn);':''}">
      <div class="section-title">What ${esc(mname)} is built from</div>
      <p style="margin:6px 0;"><b>${c.orders}</b> past order${c.orders===1?'':'s'} from <b>${c.vessels}</b> vessel${c.vessels===1?'':'s'}, with <b>${c.lines}</b> lines. <b>${c.counted}</b> of them are counted below.</p>
      ${c.unmatched ? `<p style="margin:6px 0;"><span data-ico="triangle-alert"></span> <b>${c.unmatched}</b> line${c.unmatched===1?'':'s'} not linked to a product, so left out${c.topUnmatched.length?`: ${c.topUnmatched.map(u=>`${esc(u.desc)} (${u.n})`).join(', ')}`:''}. <a href="#/insights/match">Link them</a>.</p>` : ''}
      ${c.unit ? `<p style="margin:6px 0;"><span data-ico="triangle-alert"></span> <b>${c.unit}</b> line${c.unit===1?'':'s'} with a unit that cannot be converted to the product's unit, so left out. They are listed on the Insights page under the lines to review.</p>` : ''}
      ${c.badDates ? `<p style="margin:6px 0;"><span data-ico="triangle-alert"></span> <b>${c.badDates}</b> past order${c.badDates===1?' has':'s have'} a date that looks wrong and is left out of every Insights figure until it is fixed.</p>` : ''}
      <p class="subtle" style="margin:10px 0 6px;">Imported orders per month — tap a month to look at it:</p>
      <div class="tag-row" style="gap:6px;">${c.perMonth.map(([k,n])=>`<button class="chip ${k===ym?'active':''}" data-m="${k}">${k} · ${n}</button>`).join('')}</div>
    </div>
    <div class="grid-stats">
      <div class="stat"><b style="color:var(--danger)">${r.red}</b><div class="lbl">Well below that month</div></div>
      <div class="stat"><b style="color:var(--warn)">${r.amber}</b><div class="lbl">Below that month</div></div>
      <div class="stat"><b>${r.rows.filter(x=>x.level==='nostock').length}</b><div class="lbl">With no stock record</div></div>
      <div class="stat"><b>${r.rows.length}</b><div class="lbl">Products ordered then</div></div>
    </div>
    <div class="tag-row" style="margin:14px 0 10px;"><button class="chip ${mode==='top'?'active':''}" id="ly_t">Most in demand</button><button class="chip ${mode==='warn'?'active':''}" id="ly_w">Warnings</button><button class="chip ${mode==='all'?'active':''}" id="ly_a">All products</button></div>
    <div class="card tbl-wrap" style="margin-bottom:26px;"><table class="tbl">
      <thead><tr><th>Product</th><th class="num">${esc(mname.split(' ')[0])}</th><th class="num">In stock now</th></tr></thead>
      <tbody>${shown.map(x=>`<tr>
        <td><a href="#/insights/product/${x.pid}" style="text-decoration:none; color:inherit;"><b>${esc(x.name)}</b> <span class="subtle">›</span></a>
          <div style="margin-top:5px;"><span class="badge ${badge[x.level][0]}">${badge[x.level][1]}</span>${x.gap>0?` <span class="subtle" style="font-size:.78rem;">short ~${fq(x.gap)} ${esc(x.unit)}</span>`:''} <span class="subtle" style="font-size:.78rem;">· ${x.vessels} vessel${x.vessels===1?'':'s'}</span></div></td>
        <td class="num"><b>${fq(x.qty)}</b> ${esc(x.unit)}</td>
        <td class="num">${x.tracked ? fq(x.stock) : '<span class="subtle">none recorded</span>'}</td></tr>`).join('') || `<tr><td colspan="3" class="subtle">${mode==='warn'?'No warnings — your stock covers what was ordered in that month.':'Nothing to show for this month.'}</td></tr>`}</tbody>
    </table>${list.length>shown.length?`<p class="subtle" style="padding:8px 10px;">Showing the first ${shown.length}.</p>`:''}</div>`;
  const go = m=>{ window.__lyMonth = m; routes['lastyear'](); };
  $('#ly_prev').onclick = ()=> go(lyShift(ym,-1));
  $('#ly_next').onclick = ()=> go(lyShift(ym,1));
  if($('#ly_reset')) $('#ly_reset').onclick = ()=> go(dflt);
  $('#main').querySelectorAll('[data-m]').forEach(b=>b.onclick=()=> go(b.dataset.m));
  $('#ly_t').onclick = ()=>{ window.__lyMode = 'top'; routes['lastyear'](); };
  $('#ly_w').onclick = ()=>{ window.__lyMode = 'warn'; routes['lastyear'](); };
  $('#ly_a').onclick = ()=>{ window.__lyMode = 'all'; routes['lastyear'](); };
});

/* home page notice: filled in after the page is drawn so Home never waits for it. Only when that month has enough history to mean something. */
async function lastYearHomeNotice(){
  try{
    if(!can('reports.view')) return;
    if(!$('#lyNotice')) return;
    const hist = await cachedAll('historyOrders'); if(!hist.length) return;
    const r = await lastYearWatch(lyDefaultMonth()), n = r.red + r.amber;
    if(!r.reliable || !n || !$('#lyNotice')) return;
    const col = r.red ? 'var(--danger)' : 'var(--warn)';
    $('#lyNotice').innerHTML = `<a href="#/lastyear" class="btn btn-ghost" style="border-color:${col}; color:${col};"><span data-ico="history"></span> ${n} product${n===1?'':'s'} below what vessels ordered in ${esc(lyMonthName(r.ym))}${r.red?` (${r.red} well below)`:''}</a>`;
  }catch(e){ console.warn('last-year notice', e); }
}
{ const _home = routes['home']; if(_home) routes['home'] = async function(...a){ const r = await _home.apply(this, a); lastYearHomeNotice(); return r; }; }
