/* ============================ INSIGHTS: VESSEL PROFILES ============================
   One page per vessel (identified by NAME — IMO numbers change on these sheets): how often it orders,
   when it's due, what its usual basket is, and what has changed lately. Same idea as the product
   analysis: plain statistics, every sentence explainable, thresholds in one block. "Now" is the date
   of the latest imported order. */
const VESSEL_RULES = {
  minOrders: 3,          // fewer orders than this = no rhythm to judge
  overdueFactor: 1.5,    // later than 1.5x its usual gap = overdue
  quietFactor: 3,        // later than 3x its usual gap (and 60+ days) = gone quiet
  quietMinDays: 60,
  stapleShare: 0.5,      // in at least half of its orders = a staple of its basket
  droppedShare: 0.6,     // "used to order it in 60%+ of orders…"
  recentOrders: 3,       // "…but not in any of its last 3 orders" = dropped
  shrinkRatio: 0.5,      // staple now ordered at half its usual quantity or less
  sizeShift: 0.6         // the whole order has got 40% smaller (items per order)
};
function _fmtQty(n){ return (Math.round(n*10)/10).toLocaleString(); }
const VESSEL_BADGE = {
  active:   {label:'Active',        cls:'b-completed',     rank:3},
  overdue:  {label:'Overdue',       cls:'b-modified',      rank:1},
  quiet:    {label:'Gone quiet',    cls:'b-not_available', rank:0},
  unknown:  {label:'Not enough history', cls:'b-pending',  rank:4}
};

/* dates: this vessel's order dates (YYYY-MM-DD); returns its rhythm and status */
function vesselRhythm(dates, anchor){
  const R = VESSEL_RULES;
  const ds = [...new Set(dates)].sort();
  const out = {orders: dates.length, first: ds[0], last: ds[ds.length-1], gap:null, sinceLast:null, expectedNext:null, daysToNext:null, status:'unknown'};
  out.sinceLast = Math.round((new Date(anchor)-new Date(out.last))/86400000);
  if(ds.length >= R.minOrders){
    const gaps = []; for(let i=1;i<ds.length;i++) gaps.push((new Date(ds[i])-new Date(ds[i-1]))/86400000);
    out.gap = Math.round(_median(gaps));
    out.expectedNext = new Date(new Date(out.last).getTime() + out.gap*86400000).toISOString().slice(0,10);
    out.daysToNext = Math.round((new Date(out.expectedNext)-new Date(anchor))/86400000);
    if(out.sinceLast > Math.max(R.quietMinDays, R.quietFactor*out.gap)) out.status = 'quiet';
    else if(out.sinceLast > R.overdueFactor*out.gap) out.status = 'overdue';
    else out.status = 'active';
  }
  return out;
}

/* orders: this vessel's historyOrders; lines: its historyLines; productsById; anchor */
function analyzeVessel(orders, lines, productsById, anchor){
  const R = VESSEL_RULES;
  const sorted = [...orders].sort((a,b)=>a.orderDate.localeCompare(b.orderDate));
  const rhythm = vesselRhythm(sorted.map(o=>o.orderDate), anchor);
  const lineKey = l => l.productId || ('x:'+l.descKey);
  const nameOfLine = l => l.productId ? ((productsById.get(l.productId)||{}).name || l.excelDesc) : l.excelDesc;
  const unitOfLine = l => l.baseOk ? l.baseUnit : (l.unit||'');

  // per order: what was in it
  const byOrder = new Map(sorted.map(o=>[o.id, new Map()]));
  for(const l of lines){
    const m = byOrder.get(l.historyOrderId); if(!m) continue;
    const e = m.get(lineKey(l)) || {name:nameOfLine(l), unit:unitOfLine(l), qty:0, usable:l.baseOk};
    e.qty += l.baseOk ? l.baseQty : l.qty; m.set(lineKey(l), e);
  }
  const orderItems = sorted.map(o=>({date:o.orderDate, items:byOrder.get(o.id)}));
  const n = orderItems.length;

  // basket: how often each product appears, and its usual quantity
  const prod = new Map();
  orderItems.forEach((oi,idx)=>{
    for(const [k,e] of oi.items){
      const p = prod.get(k) || {key:k, name:e.name, unit:e.unit, hits:0, qtys:[], idxs:[]};
      p.hits++; p.qtys.push(e.qty); p.idxs.push(idx); prod.set(k,p);
    }
  });
  const basket = [...prod.values()].map(p=>({...p, share:p.hits/n, usual:_median(p.qtys)})).sort((a,b)=>b.share-a.share || b.usual-a.usual);
  const staples = basket.filter(p=>p.share>=R.stapleShare);

  // changes
  const changes = [];
  const lastN = Math.min(R.recentOrders, Math.floor(n/2));
  if(n >= R.minOrders+R.recentOrders && lastN>0){
    const cutoffIdx = n - lastN;
    for(const p of basket){
      const before = p.idxs.filter(i=>i<cutoffIdx).length / cutoffIdx;
      const after = p.idxs.filter(i=>i>=cutoffIdx).length;
      if(before >= R.droppedShare && after===0)
        changes.push({sev:'warning', text:`Stopped ordering ${p.name} — it was in ${Math.round(before*100)}% of earlier orders, but none of the last ${lastN}.`});
      else if(before >= R.stapleShare && after>0){
        const qBefore = _median(p.qtys.filter((q,i)=>p.idxs[i]<cutoffIdx));
        const qAfter = _median(p.qtys.filter((q,i)=>p.idxs[i]>=cutoffIdx));
        if(qBefore>0 && qAfter <= R.shrinkRatio*qBefore)
          changes.push({sev:'warning', text:`${p.name}: usual quantity fell from ${_fmtQty(qBefore)} to ${_fmtQty(qAfter)} ${p.unit}.`});
        else if(qBefore>0 && qAfter >= qBefore/R.shrinkRatio)
          changes.push({sev:'note', text:`${p.name}: usual quantity grew from ${_fmtQty(qBefore)} to ${_fmtQty(qAfter)} ${p.unit}.`});
      }
    }
    // whole-order size (number of different items per order)
    const sizes = orderItems.map(o=>o.items.size);
    const sBefore = _median(sizes.slice(0,cutoffIdx)), sAfter = _median(sizes.slice(cutoffIdx));
    if(sBefore>0 && sAfter <= R.sizeShift*sBefore)
      changes.unshift({sev:'warning', text:`Orders are getting smaller overall: usually ${Math.round(sBefore)} different items, lately ${Math.round(sAfter)}. If everything shrinks together, the vessel itself has changed (crew, route, laid up) rather than just its menu.`});
    else if(sBefore>0 && sAfter >= sBefore/R.sizeShift)
      changes.unshift({sev:'note', text:`Orders are getting bigger overall: usually ${Math.round(sBefore)} different items, lately ${Math.round(sAfter)}.`});
  }
  if(rhythm.status==='quiet') changes.unshift({sev:'warning', text:`No order for ${rhythm.sinceLast} days; it normally orders about every ${rhythm.gap} days. It may have changed supplier, route or been laid up.`});
  else if(rhythm.status==='overdue') changes.unshift({sev:'warning', text:`Overdue: last ordered ${rhythm.sinceLast} days ago, normally about every ${rhythm.gap} days.`});

  return {rhythm, orders:orderItems, basket, staples, changes, orderCount:n, medianItems:_median(orderItems.map(o=>o.items.size))};
}

async function vesselProfileScreen(rawKey){
  const key = decodeURIComponent(rawKey||'');
  const [hOrders, hLines, products] = await Promise.all([getAll('historyOrders'), getAll('historyLines'), getAll('products')]);
  const mine = hOrders.filter(o=>o.vesselKey===key);
  if(!mine.length){ location.hash = '#/insights'; return; }
  const anchor = hOrders.map(o=>o.orderDate).filter(Boolean).sort().pop();
  const byId = new Map(products.map(p=>[p.id,p]));
  const a = analyzeVessel(mine, hLines.filter(l=>l.vesselKey===key), byId, anchor);
  const spellings = new Map(); mine.forEach(o=>spellings.set(o.vesselName,(spellings.get(o.vesselName)||0)+1));
  const name = [...spellings.entries()].sort((x,y)=>y[1]-x[1])[0][0];
  const imos = [...new Set(mine.map(o=>o.imo).filter(Boolean))];
  const st = VESSEL_BADGE[a.rhythm.status];
  const icon = {warning:'⚠', note:'ℹ', ok:'✓'};
  const nextTxt = a.rhythm.expectedNext
    ? (a.rhythm.daysToNext>=0 ? `about ${fmtDate(a.rhythm.expectedNext)} (in ~${a.rhythm.daysToNext} days)` : `was expected around ${fmtDate(a.rhythm.expectedNext)} (${-a.rhythm.daysToNext} days ago)`)
    : '—';
  const fmtUsual = p=> `${_fmtQty(p.usual)} ${esc(p.unit)}`;
  $('#main').innerHTML = `
    <div class="topbar"><h1>${esc(name)}</h1><a href="#/insights" class="btn btn-ghost btn-sm">← Insights</a></div>
    <p class="subtle" style="margin-top:-10px;"><span class="badge ${st.cls}">${st.label}</span> &nbsp;${a.orderCount} past order${a.orderCount===1?'':'s'}, ${fmtDate(a.rhythm.first)} → ${fmtDate(a.rhythm.last)}${spellings.size>1?` · ${spellings.size} spellings of the name merged`:''}${imos.length?` · order references seen: ${esc(imos.slice(0,4).join(', '))}${imos.length>4?'…':''}`:''}</p>
    <div class="grid-stats">
      <div class="stat"><b>${a.rhythm.gap!=null ? a.rhythm.gap+' d' : '—'}</b><div class="lbl">Usually orders every</div></div>
      <div class="stat"><b>${a.rhythm.sinceLast} d</b><div class="lbl">Since last order</div></div>
      <div class="stat"><b style="font-size:1.05rem;">${nextTxt}</b><div class="lbl">Next order expected</div></div>
      <div class="stat"><b>${Math.round(a.medianItems)}</b><div class="lbl">Items in a typical order</div></div>
    </div>
    <h3 class="section-title">What stands out</h3>
    <div class="card" style="margin-bottom:22px;">
      ${a.changes.length ? a.changes.map(c=>`<p style="margin:8px 0;"><b>${icon[c.sev]} ${c.sev==='warning'?'Warning':'Note'}</b> — ${esc(c.text)}</p>`).join('')
        : `<p class="subtle" style="margin:0;">${a.rhythm.status==='unknown' ? `Only ${a.orderCount} order${a.orderCount===1?'':'s'} so far — not enough to see a pattern.` : 'Nothing unusual — this vessel is ordering as it normally does.'}</p>`}
    </div>
    <h3 class="section-title">Usual basket</h3>
    <p class="subtle" style="margin-top:-8px;">What it orders in at least half of its orders, and the usual quantity. If the next order is due, this is roughly what to expect.</p>
    <div class="card tbl-wrap" style="margin-bottom:22px;"><table class="tbl">
      <thead><tr><th>Product</th><th class="num">In % of orders</th><th class="num">Usual quantity</th></tr></thead>
      <tbody>${a.staples.slice(0,30).map(p=>`<tr><td>${p.key.startsWith('x:')?esc(p.name):`<a href="#/insights/product/${p.key}" style="text-decoration:none; color:inherit;"><b>${esc(p.name)}</b> <span class="subtle">›</span></a>`}</td><td class="num">${Math.round(p.share*100)}%</td><td class="num">${fmtUsual(p)}</td></tr>`).join('') || '<tr><td colspan="3" class="subtle">No product appears in half of its orders yet.</td></tr>'}</tbody>
    </table>${a.staples.length>30?`<p class="subtle" style="padding:8px 10px;">Showing 30 of ${a.staples.length}.</p>`:''}</div>
    <h3 class="section-title">Order history</h3>
    <div class="card tbl-wrap"><table class="tbl">
      <thead><tr><th>Date</th><th class="num">Different items</th></tr></thead>
      <tbody>${[...a.orders].reverse().slice(0,40).map(o=>`<tr><td>${fmtDate(o.date)}</td><td class="num">${o.items.size}</td></tr>`).join('')}</tbody>
    </table>${a.orders.length>40?`<p class="subtle" style="padding:8px 10px;">Showing the latest 40 of ${a.orders.length}.</p>`:''}</div>
    <p class="subtle" style="margin-top:14px;">Read as a guide, not a prediction: vessels change supplier, route and menu without warning. The name is how vessels are told apart, so a renamed or misspelt vessel shows up as a separate one.</p>`;
}
