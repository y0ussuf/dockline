/* ============================ INSIGHTS: DEMAND FORECAST ============================
   A bottom-up forecast: for every vessel that is likely to order within the next N days, take its
   usual basket (what it orders, how often, and how much) and add the baskets up per product.
   "Expected" = usual quantity × how often the vessel includes that product, × the number of orders
   it is likely to place in the window. Vessels that have gone quiet are NOT counted (they're listed
   separately, with what they used to bring). Nothing here is learned — every number can be traced to
   a vessel's recent orders (its last 5). "Now" is the latest imported order date. */
const FORECAST_RULES = {
  recentWindow: 5,       // a vessel's last 5 orders describe what it orders now
  minShare: 0.25,        // a product counts if it was in at least a quarter of those
  overdueDueInDays: 7    // an overdue vessel is assumed to order within about a week
};
window.__fcDays = window.__fcDays || 30;

function buildForecast(hOrders, hLines, productsById, anchor, days){
  const R = FORECAST_RULES;
  const ordersByV = new Map(), linesByV = new Map();
  for(const o of hOrders) (ordersByV.get(o.vesselKey) || ordersByV.set(o.vesselKey, []).get(o.vesselKey)).push(o);
  for(const l of hLines) (linesByV.get(l.vesselKey) || linesByV.set(l.vesselKey, []).get(l.vesselKey)).push(l);
  const names = new Map();
  const nameCount = new Map();
  for(const o of hOrders){ const m = nameCount.get(o.vesselKey) || new Map(); m.set(o.vesselName,(m.get(o.vesselName)||0)+1); nameCount.set(o.vesselKey,m); }
  for(const [k,m] of nameCount) names.set(k, [...m.entries()].sort((a,b)=>b[1]-a[1])[0][0]);

  const counted = [], notCounted = [], tooLittle = [];
  const expected = new Map(); // productId → {qty, vessels:Set}
  const quietShare = new Map(); // productId → qty the quiet vessels would have brought
  for(const [key, vOrders] of ordersByV){
    const a = analyzeVessel(vOrders, linesByV.get(key)||[], productsById, anchor);
    const r = a.rhythm;
    // judged on the vessel's most recent orders, so a product it stopped ordering, or now orders in
    // much smaller amounts, is forecast at today's level and not its old one
    const W = Math.min(a.orderCount, R.recentWindow), cut = a.orderCount - W;
    const basket = a.basket.filter(p=>!p.key.startsWith('x:')).map(p=>{
      const recentQtys = p.qtys.filter((q,i)=>p.idxs[i]>=cut);
      return {...p, share: recentQtys.length/W, usual: _median(recentQtys.slice(-3))};
    }).filter(p=>p.share>=R.minShare);
    if(r.status==='unknown'){ tooLittle.push({key, name:names.get(key), orders:r.orders}); continue; }
    // how many orders land inside the window
    const dueIn = r.status==='overdue' ? Math.min(R.overdueDueInDays, days) : Math.max(0, r.daysToNext);
    const nOrders = (r.status==='quiet') ? 0 : (dueIn>days ? 0 : 1 + Math.floor((days-dueIn)/Math.max(r.gap,1)));
    const entry = {key, name:names.get(key), status:r.status, gap:r.gap, dueIn, nOrders, basketSize:basket.length};
    if(r.status==='quiet'){
      // what these vessels used to bring per 30 days, so the loss is visible
      for(const p of basket){
        const per30 = p.usual * p.share * (30/Math.max(r.gap,1));
        quietShare.set(p.key, (quietShare.get(p.key)||0)+per30);
      }
      notCounted.push(entry); continue;
    }
    if(nOrders===0){ entry.nOrders=0; counted.push(entry); continue; }
    counted.push(entry);
    for(const p of basket){
      const e = expected.get(p.key) || {qty:0, vessels:new Set(), unit:p.unit};
      e.qty += p.usual * p.share * nOrders; e.vessels.add(key); expected.set(p.key, e);
    }
  }
  // what actually happened in the same-length window just before now, and a year before, for scale
  const A = new Date(anchor).getTime(), D = 86400000;
  const recent = new Map(), lastYear = new Map();
  for(const l of hLines){
    if(!l.productId || !l.baseOk) continue;
    const age = (A - new Date(l.orderDate).getTime())/D;
    if(age>=0 && age<days) recent.set(l.productId, (recent.get(l.productId)||0)+l.baseQty);
    if(age>=365 && age<365+days) lastYear.set(l.productId, (lastYear.get(l.productId)||0)+l.baseQty);
  }
  const first = hOrders.map(o=>o.orderDate).sort()[0];
  const hasYear = (A - new Date(first).getTime())/D >= 365+days;
  return {expected, quietShare, counted, notCounted, tooLittle, recent, lastYear, hasYear};
}

route('forecast', async ()=>{
  const days = window.__fcDays;
  const [{hOrders, hLines}, products] = await Promise.all([insightsData(), getAll('products')]);
  if(!hOrders.length){ location.hash='#/insights'; return; }
  const anchor = hOrders.map(o=>o.orderDate).filter(Boolean).sort().pop();
  const byId = new Map(products.map(p=>[p.id,p]));
  const f = buildForecast(hOrders, hLines, byId, anchor, days);
  const rows = [...f.expected.entries()].filter(([pid])=>byId.has(pid)).map(([pid,e])=>{
    const p = byId.get(pid), tracked = isStockTracked(p), stock = tracked ? parseFloat(p.stockQty) : null;
    return {pid, name:p.name, unit:e.unit, qty:e.qty, vessels:e.vessels.size, recent:f.recent.get(pid)||0, lastYear:f.hasYear ? (f.lastYear.get(pid)||0) : null,
      tracked, stock, short: tracked ? Math.max(0, e.qty - stock) : null};
  }).sort((a,b)=>b.qty-a.qty);
  const lost = [...f.quietShare.entries()].filter(([pid])=>byId.has(pid)).sort((a,b)=>b[1]-a[1]).slice(0,10);
  const dueNow = f.counted.filter(c=>c.nOrders>0).sort((a,b)=>a.dueIn-b.dueIn);
  const fq = _fmtQty;
  const chip = d=>`<button class="chip ${days===d?'active':''}" data-days="${d}">Next ${d} days</button>`;

  $('#main').innerHTML = `
    <div class="topbar"><h1>Demand forecast</h1><a href="#/insights" class="btn btn-ghost btn-sm">← Insights</a></div>
    <p class="subtle" style="margin-top:-10px;">What to expect vessels to ask for, built from each vessel's own usual basket and rhythm. As of ${fmtDate(anchor)} (the latest imported order).</p>
    <div class="tag-row" id="fc_days" style="margin-bottom:16px;">${chip(30)}${chip(60)}${chip(90)}</div>
    <div class="grid-stats">
      <div class="stat"><b>${dueNow.length}</b><div class="lbl">Vessels likely to order</div></div>
      <div class="stat"><b>${dueNow.reduce((s,c)=>s+c.nOrders,0)}</b><div class="lbl">Orders expected</div></div>
      <div class="stat"><b>${f.notCounted.length}</b><div class="lbl">Gone quiet (not counted)</div></div>
      <div class="stat"><b>${rows.filter(r=>r.short>0).length}</b><div class="lbl">Products that may run short</div></div>
    </div>
    <h3 class="section-title">Expected demand by product</h3>
    <p class="subtle" style="margin-top:-8px;">“Same period before” is what vessels actually asked for in the ${days} days up to ${fmtDate(anchor)}${f.hasYear?', and “a year ago” in the same stretch last year':''}. A big gap between expected and before is worth a question.</p>
    <div class="card tbl-wrap" style="margin-bottom:26px;"><table class="tbl">
      <thead><tr><th>Product</th><th class="num">Expected</th><th class="num">Same period before</th>${f.hasYear?'<th class="num">A year ago</th>':''}<th class="num">Vessels</th><th class="num">In stock</th><th></th></tr></thead>
      <tbody>${rows.slice(0,50).map(r=>`<tr>
        <td><a href="#/insights/product/${r.pid}" style="text-decoration:none; color:inherit;"><b>${esc(r.name)}</b> <span class="subtle">›</span></a></td>
        <td class="num"><b>${fq(r.qty)}</b> ${esc(r.unit)}</td><td class="num">${fq(r.recent)}</td>${f.hasYear?`<td class="num">${fq(r.lastYear)}</td>`:''}
        <td class="num">${r.vessels}</td><td class="num">${r.tracked ? fq(r.stock) : '<span class="subtle">not tracked</span>'}</td>
        <td>${r.short>0 ? `<span class="badge b-not_available" title="Expected demand is more than the stock on hand">short by ~${fq(r.short)}</span>` : ''}</td></tr>`).join('') || '<tr><td colspan="7" class="subtle">No vessel is expected to order in this window.</td></tr>'}</tbody>
    </table>${rows.length>50?`<p class="subtle" style="padding:8px 10px;">Showing the 50 biggest of ${rows.length}.</p>`:''}</div>
    <h3 class="section-title">Vessels expected to order</h3>
    <div class="card tbl-wrap" style="margin-bottom:26px;"><table class="tbl">
      <thead><tr><th>Vessel</th><th>Status</th><th class="num">Next order</th><th class="num">Orders in window</th><th class="num">Usual items</th></tr></thead>
      <tbody>${dueNow.map(c=>`<tr><td><a href="#/insights/vessel/${encodeURIComponent(c.key)}" style="text-decoration:none; color:inherit;"><b>${esc(c.name)}</b> <span class="subtle">›</span></a></td>
        <td><span class="badge ${VESSEL_BADGE[c.status].cls}">${VESSEL_BADGE[c.status].label}</span></td>
        <td class="num">${c.status==='overdue' ? 'any day' : 'in ~'+c.dueIn+' d'}</td><td class="num">${c.nOrders}</td><td class="num">${c.basketSize}</td></tr>`).join('') || '<tr><td colspan="5" class="subtle">None.</td></tr>'}</tbody>
    </table></div>
    ${f.notCounted.length ? `<h3 class="section-title">Not counted — gone quiet</h3>
    <p class="subtle" style="margin-top:-8px;">${f.notCounted.length} vessel${f.notCounted.length===1?'':'s'} that used to order regularly and haven't lately. If they came back, these products would see more demand:</p>
    <div class="card" style="margin-bottom:26px;">
      <p style="margin:4px 0 10px;">${f.notCounted.slice(0,12).map(c=>`<a href="#/insights/vessel/${encodeURIComponent(c.key)}" class="badge b-modified" style="text-decoration:none; margin:2px;">${esc(c.name)}</a>`).join(' ')}${f.notCounted.length>12?` <span class="subtle">+${f.notCounted.length-12} more</span>`:''}</p>
      ${lost.length ? `<div class="subtle">They used to bring about, per 30 days: ${lost.map(([pid,q])=>`<b>${esc(byId.get(pid).name)}</b> ${fq(q)} ${esc(canonicalUnitOf(byId.get(pid)))}`).join(' · ')}</div>` : ''}
    </div>` : ''}
    <p class="subtle">This is a guide built from past behaviour, not a promise: vessels can skip an order, change supplier or change route. Vessels with fewer than 3 orders (${f.tooLittle.length}) are left out because there's no pattern to read yet.</p>`;
  $('#fc_days').onclick = e=>{ const b = e.target.closest('[data-days]'); if(!b) return; window.__fcDays = +b.dataset.days; routes['forecast']([]); };
});
