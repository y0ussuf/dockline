/* ============================ LAST YEAR AT THIS TIME ============================
   Looks at the same stretch of the calendar one year ago (today − 365 days, for the next N days) and adds up what vessels
   asked for per product in that stretch (imported past orders + orders finished on the site, read by insightsData()).
   Each product is then held against the stock on hand now:  red = stock under half of last year's demand,
   amber = under last year's demand, green = covered.  It is a hint, not a promise — demand this year can differ.
   Only products whose stock is tracked can be compared; quantities are in the product's own measure (kg / L / count). */
window.__lyDays = window.__lyDays || 30;
window.__lyMode = window.__lyMode || 'warn';   // warn | top | all

function lyWindow(days){
  const t = new Date(todayISO()+'T00:00:00Z'), D = 86400000;
  const iso = ms=> new Date(ms).toISOString().slice(0,10);
  const start = t.getTime() - 365*D;
  return {start: iso(start), end: iso(start + days*D), from: todayISO(), to: iso(t.getTime() + days*D)};   // [start, end) a year ago ↔ [from, to) coming up
}
async function lastYearWatch(days){
  const [{hOrders, hLines, badOrders}, products, perOrder] = await Promise.all([insightsData(), slimProducts(), perOrderIds()]);
  const w = lyWindow(days), byId = new Map(products.map(p=>[p.id,p]));
  const inWin = d=> d >= w.start && d < w.end;
  const haveOrders = hOrders.some(o=>inWin(o.orderDate));
  const agg = new Map();
  for(const l of hLines){
    if(!l.productId || !l.baseOk || !inWin(l.orderDate) || !byId.has(l.productId) || perOrder.has(l.productId)) continue;
    const a = agg.get(l.productId) || {qty:0, vessels:new Set(), orders:new Set(), unit:l.baseUnit};
    a.qty += l.baseQty; a.vessels.add(l.vesselKey); a.orders.add(l.historyOrderId); agg.set(l.productId, a);
  }
  // how much of that period the numbers really cover — lines not linked to a product, or whose unit cannot be converted, cannot be counted
  const winOrders = hOrders.filter(o=>inWin(o.orderDate)), winIds = new Set(winOrders.map(o=>o.id)), winLines = hLines.filter(l=>winIds.has(l.historyOrderId));
  const unm = new Map();
  for(const l of winLines){ if(!l.productId && !l.skipped){ const k = l.descKey||l.excelDesc; const u = unm.get(k) || {desc:l.excelDesc, n:0}; u.n++; unm.set(k,u); } }
  const cov = {orders:winOrders.length, vessels:new Set(winOrders.map(o=>o.vesselKey)).size, lines:winLines.length,
    counted: winLines.filter(l=>l.productId && l.baseOk && byId.has(l.productId) && !perOrder.has(l.productId)).length,
    unmatched: winLines.filter(l=>!l.productId && !l.skipped).length, unit: winLines.filter(l=>l.productId && !l.baseOk).length,
    total: hOrders.length, first: hOrders.map(o=>o.orderDate).filter(Boolean).sort()[0]||'', last: hOrders.map(o=>o.orderDate).filter(Boolean).sort().pop()||'',
    perMonth: (()=>{ const m = new Map(); for(const o of hOrders){ const k = String(o.orderDate||'').slice(0,7); if(k) m.set(k,(m.get(k)||0)+1); } return [...m.entries()].sort((a,b)=>a[0].localeCompare(b[0])); })(),
    topUnmatched: [...unm.values()].sort((a,b)=>b.n-a.n).slice(0,6), badDates: (badOrders||[]).length};
  const rows = [];
  for(const [pid,a] of agg){
    const p = byId.get(pid); if(!(a.qty>0)) continue;
    const tracked = isStockTracked(p), stock = tracked ? parseFloat(p.stockQty) : null;
    const sameUnit = !tracked || canonicalUnitOf(p)===a.unit;
    let level = tracked ? 'none' : 'nostock';            // nostock = the product has no stock record at all; none = cannot be compared (unit mismatch)
    if(tracked && sameUnit && isFinite(stock)) level = stock < a.qty*0.5 ? 'red' : stock < a.qty ? 'amber' : 'green';
    rows.push({pid, name:p.name, unit:a.unit, qty:a.qty, vessels:a.vessels.size, orders:a.orders.size, tracked, stock, level, gap: (level==='red'||level==='amber') ? a.qty-stock : 0});
  }
  const rank = {red:0, amber:1, nostock:2, green:3, none:4};
  rows.sort((a,b)=> rank[a.level]-rank[b.level] || b.gap-a.gap || b.qty-a.qty);
  return {rows, w, haveOrders, cov, red: rows.filter(r=>r.level==='red').length, amber: rows.filter(r=>r.level==='amber').length};
}

route('lastyear', async ()=>{
  const days = window.__lyDays, mode = window.__lyMode;
  const [{hOrders}] = await Promise.all([insightsData()]);
  if(!hOrders.length){ location.hash = '#/insights'; return; }
  const r = await lastYearWatch(days), fq = _fmtQty;
  const chip = d=>`<button class="chip ${days===d?'active':''}" data-days="${d}">${d} days</button>`;
  const badge = {red:['b-not_available','Well below'], amber:['b-modified','Below'], green:['b-completed','Covered'], nostock:['b-pending','No stock record'], none:['b-pending','Not compared']};
  const warnSet = r.rows.filter(x=>x.level==='red'||x.level==='amber'||x.level==='nostock');
  const list = mode==='all' ? r.rows : mode==='top' ? r.rows.slice().sort((a,b)=>b.qty-a.qty).slice(0,20) : warnSet;
  const shown = list.slice(0,60);
  $('#main').innerHTML = `
    <div class="topbar"><h1>Last year at this time</h1><a href="#/insights" class="btn btn-ghost btn-sm">← Insights</a></div>
    <p class="subtle" style="margin-top:-10px;">What vessels asked for between <b>${fmtDate(r.w.start)}</b> and <b>${fmtDate(r.w.end)}</b>, held against the stock you have now for the coming ${days} days (${fmtDate(r.w.from)} → ${fmtDate(r.w.to)}). A hint, not a promise.</p>
    <div class="tag-row" id="ly_days" style="margin-bottom:14px;">${chip(30)}${chip(60)}${chip(90)}</div>
    ${r.haveOrders ? '' : `<div class="bt-warn" style="margin-bottom:12px;">No orders were imported for that period last year, so there is nothing to compare. Import the old order sheets for ${esc(r.w.start.slice(0,7))} to see it.</div>`}
    <div class="card" style="margin-bottom:14px; ${r.cov.unmatched||r.cov.unit||r.cov.badDates?'border-color:var(--warn);':''}">
      <div class="section-title">What this is built from</div>
      <p style="margin:6px 0;"><b>${r.cov.orders}</b> past order${r.cov.orders===1?'':'s'} from <b>${r.cov.vessels}</b> vessel${r.cov.vessels===1?'':'s'} fall in that period, with <b>${r.cov.lines}</b> lines. <b>${r.cov.counted}</b> of them are counted below.</p>
      ${r.cov.unmatched ? `<p style="margin:6px 0;">⚠ <b>${r.cov.unmatched}</b> line${r.cov.unmatched===1?'':'s'} are <b>not linked to a product</b>, so they are left out${r.cov.topUnmatched.length?`: ${r.cov.topUnmatched.map(u=>`${esc(u.desc)} (${u.n})`).join(', ')}`:''}. <a href="#/insights/match">Link them</a> and the numbers will grow.</p>` : ''}
      ${r.cov.unit ? `<p style="margin:6px 0;">⚠ <b>${r.cov.unit}</b> line${r.cov.unit===1?'':'s'} have a unit that cannot be converted to the product's unit, so they are left out too. They are listed on the Insights page under the lines to review.</p>` : ''}
      ${r.cov.badDates ? `<p style="margin:6px 0;">⚠ <b>${r.cov.badDates}</b> past order${r.cov.badDates===1?' has':'s have'} a date that looks wrong and is left out of every Insights figure until it is fixed (Insights home shows which).</p>` : ''}
      <p class="subtle" style="margin:10px 0 4px;">All imported past orders: <b>${r.cov.total}</b>, dated ${r.cov.first?fmtDate(r.cov.first):'—'} → ${r.cov.last?fmtDate(r.cov.last):'—'}. Per month:</p>
      <div class="tag-row" style="gap:6px;">${r.cov.perMonth.map(([k,n])=>`<span class="chip ${k===r.w.start.slice(0,7)||k===r.w.end.slice(0,7)?'active':''}" style="cursor:default;">${k} · ${n}</span>`).join('')||'<span class="subtle">none</span>'}</div>
      ${!(r.cov.unmatched||r.cov.unit||r.cov.badDates) ? '<p class="subtle" style="margin:6px 0;">Every line in that period is counted.</p>' : ''}
    </div>
    <div class="grid-stats">
      <div class="stat"><b style="color:var(--danger)">${r.red}</b><div class="lbl">Well below last year</div></div>
      <div class="stat"><b style="color:var(--warn)">${r.amber}</b><div class="lbl">Below last year</div></div>
      <div class="stat"><b>${r.rows.filter(x=>x.level==='nostock').length}</b><div class="lbl">With no stock record</div></div>
      <div class="stat"><b>${r.rows.length}</b><div class="lbl">Products ordered then</div></div>
    </div>
    <div class="tag-row" style="margin:14px 0 10px;"><button class="chip ${mode==='warn'?'active':''}" id="ly_w">Warnings</button><button class="chip ${mode==='top'?'active':''}" id="ly_t">Most in demand</button><button class="chip ${mode==='all'?'active':''}" id="ly_a">All products</button></div>
    <div class="card tbl-wrap" style="margin-bottom:26px;"><table class="tbl">
      <thead><tr><th>Product</th><th class="num">Last year</th><th class="num">Vessels</th><th class="num">In stock now</th><th></th></tr></thead>
      <tbody>${shown.map(x=>`<tr>
        <td><a href="#/insights/product/${x.pid}" style="text-decoration:none; color:inherit;"><b>${esc(x.name)}</b> <span class="subtle">›</span></a></td>
        <td class="num"><b>${fq(x.qty)}</b> ${esc(x.unit)}</td><td class="num">${x.vessels}</td>
        <td class="num">${x.tracked ? fq(x.stock) : '<span class="subtle">none recorded</span>'}</td>
        <td style="white-space:nowrap;"><span class="badge ${badge[x.level][0]}">${badge[x.level][1]}</span>${x.gap>0?`<div class="subtle" style="font-size:.78rem; margin-top:3px;">short ~${fq(x.gap)} ${esc(x.unit)}</div>`:''}</td></tr>`).join('') || `<tr><td colspan="5" class="subtle">${mode!=='warn'?'Nothing to show.':'No warnings — your stock covers what was ordered at this time last year.'}</td></tr>`}</tbody>
    </table>${list.length>60?'<p class="subtle" style="padding:8px 10px;">Showing the first 60.</p>':''}</div>`;
  $('#ly_days').querySelectorAll('[data-days]').forEach(b=>b.onclick=()=>{ window.__lyDays = +b.dataset.days; routes['lastyear'](); });
  $('#ly_w').onclick = ()=>{ window.__lyMode = 'warn'; routes['lastyear'](); };
  $('#ly_t').onclick = ()=>{ window.__lyMode = 'top'; routes['lastyear'](); };
  $('#ly_a').onclick = ()=>{ window.__lyMode = 'all'; routes['lastyear'](); };
});

/* home page notice: filled in after the page is drawn so Home never waits for it */
async function lastYearHomeNotice(){
  try{
    if(!can('reports.view')) return;
    const slot = $('#lyNotice'); if(!slot) return;
    const hist = await cachedAll('historyOrders'); if(!hist.length) return;
    const r = await lastYearWatch(30), n = r.red + r.amber;
    if(!n || !$('#lyNotice')) return;
    const c = r.red ? 'var(--danger)' : 'var(--warn)';
    $('#lyNotice').innerHTML = `<a href="#/lastyear" class="btn btn-ghost" style="border-color:${c}; color:${c};">📆 ${n} product${n===1?'':'s'} below last year's level${r.red?` (${r.red} well below)`:''}</a>`;
  }catch(e){ console.warn('last-year notice', e); }
}

{ const _home = routes['home']; if(_home) routes['home'] = async function(...a){ const r = await _home.apply(this, a); lastYearHomeNotice(); return r; }; }
