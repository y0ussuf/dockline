/* ==================================== INSIGHTS: BUY CHECK ====================================
   "I'm thinking of buying these — is it a good idea?" Fill the Buy-check template (product, quantity, unit
   and optionally a price), upload it, and every line is set against what you hold and how fast each product
   really sells (the same demand figures as the rest of Insights): how long stock + purchase would last, whether
   that is too much or too little for the cover you want, what quantity would give that cover, and which
   products are running low but are not on the list.
   Read-only: nothing here touches stock, orders or Insights data, and nothing is saved. The result can be
   downloaded as an Excel file.
   Quantities are measured the same way as the rest of Insights (kg / L / the product's own count unit), and the
   stock on hand is compared in that same measure (as the product page's "buying a lot of this?" check does). */

const BUY_CHECK = {
  defaultMonths: 3,
  overFactor: 2,          // stock + purchase would last more than this × the wanted cover → "too much"
  shortFactor: 0.5,       // … less than this × the wanted cover → "may run short"
  missingBelowFactor: 0.5,// a product not on the list is flagged when its stock covers less than this × the wanted cover
  priceFlag: 0.10         // a price this far above the cost price on file is flagged
};
const BC_UNITS = ['KG','G','L','ML','PCS','PKT','CTN','BOX','BAG','TIN','BTL'];
const BC_VERDICT = {
  good:      {label:'Good amount',        cls:'b-completed',     rank:5},
  over:      {label:'Too much',           cls:'b-not_available', rank:1},
  short:     {label:'May run short',      cls:'b-modified',      rank:2},
  dead:      {label:'Nobody orders it lately', cls:'b-not_available', rank:0},
  thin:      {label:'Not enough history', cls:'b-pending',       rank:4},
  nohistory: {label:'No past orders',     cls:'b-pending',       rank:4},
  unit:      {label:'Check the unit',     cls:'b-unmatched',     rank:3},
  nomatch:   {label:'Not matched',        cls:'b-unmatched',     rank:3},
  skip:      {label:'Left out of Insights', cls:'b-pending',     rank:6}
};
const bcQ = n=> n==null || isNaN(n) ? '—' : (Math.round(n*10)/10).toLocaleString();

/* ---------------- the judgement: pure, so it can be tested on its own ----------------
   r = {product, perOrder, baseOk, buy (in the product's base measure), stock (number | null), a (analyzeProduct result | null)}
   T = months of cover wanted. Returns {key, cover, buyOnly, suggested, rate, note}. */
function buyAssess(r, T){
  const out = {key:'good', cover:null, buyOnly:null, suggested:null, rate:0, note:''};
  if(!r.product){ out.key='nomatch'; out.note='No product in your list matches this name.'; return out; }
  if(r.perOrder){ out.key='skip'; out.note='This product is bought per order (fresh / made to order), so Insights leaves it out.'; return out; }
  if(!r.baseOk){ out.key='unit'; out.note = r.unitNote || 'The unit does not fit how this product is counted.'; return out; }
  const a = r.a;
  if(!a || !a.orders || !a.orders.length){ out.key='nohistory'; out.note='This product has no past orders to compare with.'; return out; }
  const rate = a.recentRate>0 ? a.recentRate : (a.baseRate>0 ? a.baseRate : 0);
  out.rate = rate;
  const have = r.stock!=null ? Math.max(0, r.stock) : 0;
  if(a.status==='stopped' || !(rate>0)){
    out.key='dead'; out.rate = 0; out.note = a.status==='stopped' ? 'Nothing ordered in the last 90 days.' : 'No demand in the recent months.'; return out;
  }
  out.buyOnly = r.buy/rate;
  out.cover = (have + r.buy)/rate;
  out.suggested = Math.max(0, rate*T - have);
  if(a.status==='unknown'){ out.key='thin'; out.note='Only a short history, so treat the figures as rough.'; return out; }
  if(out.cover > BUY_CHECK.overFactor*T) out.key='over';
  else if(out.cover < BUY_CHECK.shortFactor*T) out.key='short';
  const warn = a.signals.find(s=>s.sev==='warning');
  if(warn && (out.key==='over' || ['declining','collapsed'].includes(a.status))) out.note = warn.text;
  else if(r.stock==null) out.note = 'Stock is not tracked for this product, so only the purchase is counted.';
  return out;
}

/* ---------------- reading the filled template ---------------- */
const BC_HEAD = {
  product: ['product','description','item','name','productname','itemdescription','desc'],
  qty:     ['quantity','qty','qnty'],
  unit:    ['unit','uom'],
  price:   ['unitprice','price','rate','cost'],
  note:    ['suppliernotes','supplier','notes','note','remarks']
};
const _bcKey = v=> String(v==null ? '' : v).toLowerCase().replace(/[^a-z]/g,'');
function bcFindHeader(aoa){
  for(let i=0;i<Math.min(aoa.length,15);i++){
    const idx = {};
    (aoa[i]||[]).forEach((c,j)=>{ const k=_bcKey(c); if(!k) return; for(const f in BC_HEAD) if(idx[f]==null && BC_HEAD[f].includes(k)) idx[f]=j; });
    if(idx.product!=null && idx.qty!=null) return Object.assign({row:i}, idx);
  }
  return null;
}
async function parseBuySheet(file){
  const out = {fileName:file.name, rows:[], error:'', skipped:0};
  try{
    const buf = await file.arrayBuffer();
    try{ await ensureLib('xlsx'); }catch(err){ out.error = err.message; return out; }
    const wb = XLSX.read(buf, {type:'array'});
    const names = wb.SheetNames.slice().sort((a,b)=> (_bcKey(b)==='buylist') - (_bcKey(a)==='buylist'));   // "Buy list" first, then the others
    let aoa = null, h = null;
    for(const n of names){ const rows = sheetToRows(wb.Sheets[n]); const hh = bcFindHeader(rows); if(hh){ aoa = rows; h = hh; break; } }
    if(!h){ out.error = 'No "Product" and "Quantity" columns found. Use the Buy-check template.'; return out; }
    for(const row of aoa.slice(h.row+1)){
      const desc = String(row[h.product]==null ? '' : row[h.product]).trim();
      if(!desc) continue;
      const qty = parseFloat(String(row[h.qty]==null ? '' : row[h.qty]).replace(/,/g,''));
      if(isNaN(qty) || qty<=0){ out.skipped++; continue; }     // rows left without a quantity (e.g. a template filled with your products) are ignored
      const pr = h.price!=null ? parseFloat(String(row[h.price]==null ? '' : row[h.price]).replace(/,/g,'')) : NaN;
      out.rows.push({desc, qty, unit: h.unit!=null ? String(row[h.unit]==null ? '' : row[h.unit]).trim() : '', price: isNaN(pr) || pr<=0 ? null : pr, note: h.note!=null ? String(row[h.note]==null ? '' : row[h.note]).trim() : ''});
    }
    if(!out.rows.length) out.error = 'No rows with a quantity were found.';
  }catch(e){ out.error = 'Could not read this file.'; }
  return out;
}

/* ---------------- the template ---------------- */
async function bcDownloadTemplate(withProducts){
  if(!(await ensureLibOrAlert('exceljs'))) return;
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Buy list', {views:[{state:'frozen', ySplit:1}]});
  ws.columns = [{header:'Product', key:'p', width:46}, {header:'Quantity', key:'q', width:12}, {header:'Unit', key:'u', width:18}, {header:'Unit price', key:'pr', width:12}, {header:'Supplier / notes', key:'n', width:30}];
  const head = ws.getRow(1);
  head.font = {bold:true, color:{argb:'FFFFFFFF'}};
  head.eachCell(c=>{ c.fill = {type:'pattern', pattern:'solid', fgColor:{argb:'FF1F4E79'}}; });
  let n = 0;
  if(withProducts){
    const [products, perOrder] = await Promise.all([slimProducts(), perOrderIds()]);
    const list = products.filter(p=>p.active && !perOrder.has(p.id)).sort((a,b)=>String(a.name).localeCompare(String(b.name)));
    list.forEach(p=>ws.addRow({p:p.name, q:null, u:p.unit||'', pr:null, n:''}));
    n = list.length;
  }
  const last = Math.max(300, n+100);
  for(let r=2;r<=last+1;r++){
    ws.getCell('B'+r).dataValidation = {type:'decimal', operator:'greaterThanOrEqual', formulae:[0], allowBlank:true, showErrorMessage:true, errorTitle:'Quantity', error:'Enter a number.'};
    ws.getCell('C'+r).dataValidation = {type:'list', allowBlank:true, formulae:['"'+BC_UNITS.join(',')+'"'], showErrorMessage:false};   // a suggestion list only: "PKT 450 GM" and the like are fine too
  }
  const help = wb.addWorksheet('How to use');
  help.getColumn(1).width = 110;
  [
    'Buy-check template',
    '',
    '1. On the "Buy list" sheet write one product per row: its name, the quantity you are thinking of buying and the unit.',
    '2. Unit price and Supplier / notes are optional. With a price, the total of the list is shown and prices far above the cost price on file are flagged.',
    '3. Product names should match your product list. Names that do not are shown on the next screen so you can choose the product yourself.',
    '4. Rows without a quantity are ignored, so you can download the template with all your products and fill in only the ones you want.',
    '5. In Dockline open Insights → Buy check and upload this file.',
    '',
    'Units: KG, G, L, ML for weights and volumes; PCS, PKT, CTN, BOX… for counts. A pack size also works, e.g. "PKT 450 GM": 10 of them are counted as 4.5 kg.',
    'Example: Product "Basmati rice 5 KG" · Quantity 40 · Unit PKT · Unit price 3.20'
  ].forEach((t,i)=>{ const c = help.getCell('A'+(i+1)); c.value = t; c.alignment = {wrapText:true, vertical:'top'}; if(i===0) c.font = {bold:true, size:14}; });
  const buf = await wb.xlsx.writeBuffer();
  await saveFile(withProducts ? 'buy-check-template-with-products.xlsx' : 'buy-check-template.xlsx', new Blob([buf], {type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}));
}

/* ---------------- everything the analysis needs, loaded once per upload ---------------- */
async function bcLoadContext(){
  const [data, products, perOrder, warehouses, matcher] = await Promise.all([insightsData(), slimProducts(), perOrderIds(), cachedAll('warehouses'), buildHistoryMatcher()]);
  const {hOrders, hLines} = data;
  const dates = hOrders.map(o=>o.orderDate).filter(Boolean).sort();
  const ctx = {hasHistory: hOrders.length>0, products, perOrder, matcher, warehouses, byId: new Map(products.map(p=>[p.id,p])),
    linesBy: new Map(), anchor: dates[dates.length-1], first: dates[0], memo: new Map(), expected: new Map()};
  for(const l of hLines){
    if(!l.productId || !l.baseOk) continue;
    (ctx.linesBy.get(l.productId) || ctx.linesBy.set(l.productId, []).get(l.productId)).push(l);
  }
  if(ctx.hasHistory){
    try{ const f = buildForecast(hOrders, hLines, ctx.byId, ctx.anchor, 30); ctx.expected = new Map([...f.expected].map(([pid,e])=>[pid, e.qty])); }catch(e){ /* the forecast is an extra; the rest still works */ }
  }
  return ctx;
}
function bcAnalysis(ctx, pid){
  if(ctx.memo.has(pid)) return ctx.memo.get(pid);
  const ls = ctx.linesBy.get(pid);
  const a = ls && ls.length ? analyzeProduct(ls, ctx.anchor, ctx.first) : null;
  ctx.memo.set(pid, a);
  return a;
}
/* one uploaded row → everything shown about it */
function bcBuildRow(ctx, raw, T){
  const product = raw.productId ? ctx.byId.get(raw.productId) : null;
  const row = {raw, product, perOrder: product ? ctx.perOrder.has(product.id) : false, baseOk:true, buy:raw.qty, unit:'', stock:null, a:null, unitNote:''};
  if(product){
    const b = toBaseQty(raw.qty, raw.unit, product);
    row.buy = b.baseQty; row.unit = b.baseUnit; row.baseOk = !!b.ok; row.unitNote = b.note || '';
    row.stock = isStockTracked(product) ? parseFloat(product.stockQty) : null;
    row.a = bcAnalysis(ctx, product.id);
    if(!row.unit) row.unit = canonicalUnitOf(product);
    row.expected = ctx.expected.get(product.id) ?? null;
    const cost = parseFloat(product.costPrice);
    row.priceHigh = raw.price!=null && cost>0 && raw.price > cost*(1+BUY_CHECK.priceFlag) ? Math.round((raw.price/cost-1)*100) : null;
  }
  Object.assign(row, buyAssess(row, T));
  return row;
}
/* tracked products that sell and are running low, yet are not on the list */
function bcMissing(ctx, rows, T){
  const onList = new Set(rows.filter(r=>r.product).map(r=>r.product.id));
  const out = [];
  for(const p of ctx.products){
    if(!p.active || onList.has(p.id) || ctx.perOrder.has(p.id) || !isStockTracked(p) || !ctx.linesBy.has(p.id)) continue;
    const a = bcAnalysis(ctx, p.id);
    if(!a || a.status==='stopped' || a.status==='unknown') continue;
    const rate = a.recentRate>0 ? a.recentRate : a.baseRate;
    if(!(rate>0)) continue;
    const stock = Math.max(0, parseFloat(p.stockQty)), cover = stock/rate;
    if(cover < BUY_CHECK.missingBelowFactor*T) out.push({product:p, stock, rate, cover, suggested:Math.max(0, rate*T-stock), unit:canonicalUnitOf(p), status:a.status});
  }
  return out.sort((x,y)=>x.cover-y.cover);
}

/* ---------------- the screen ---------------- */
let _bc = null;      // {ctx, raws, fileName, T, skipped}
function bcMonths(){ try{ const v = parseFloat(localStorage.getItem('bcMonths')); if(v>0) return v; }catch(e){} return BUY_CHECK.defaultMonths; }
function bcSaveMonths(v){ try{ localStorage.setItem('bcMonths', String(v)); }catch(e){} }

async function buyCheckScreen(){
  _bc = null;
  bcDrawStart();
}
function bcDrawStart(){
  $('#main').innerHTML = `
    <div class="topbar"><h1>Buy check</h1><a href="#/insights" class="btn btn-ghost btn-sm">← Insights</a></div>
    <p class="subtle" style="margin-top:-8px; max-width:720px;">Thinking of buying stock? List the products and quantities in the template and upload it. Dockline sets each line against what you hold and how fast it really sells, and tells you how long it would last, whether it is too much or too little, and what you may be forgetting.</p>
    <div class="card" style="max-width:640px; margin-bottom:16px;">
      <div class="sec-h"><span class="sec-ic" data-ico="download"></span><div class="section-title">1 · Get the template</div></div>
      <p class="subtle" style="margin-top:-6px;">Fill it once, use it every time. The second one comes with all your products already listed — you only type the quantities you want.</p>
      <div style="display:flex; gap:8px; flex-wrap:wrap;"><button class="btn btn-ghost" id="bc_t1"><span data-ico="download"></span> Empty template</button><button class="btn btn-ghost" id="bc_t2"><span data-ico="download"></span> Template with my products</button></div>
    </div>
    <div class="card" style="max-width:640px;">
      <div class="sec-h"><span class="sec-ic" data-ico="upload"></span><div class="section-title">2 · Upload your filled template</div></div>
      <div class="field"><label>Excel file (.xlsx)</label><input type="file" id="bc_file" accept=".xlsx,.xls"></div>
      <div class="field" style="max-width:240px;"><label>Cover I want (months)</label><input type="number" id="bc_months" min="0.5" step="0.5" value="${bcMonths()}"></div>
      <p class="subtle">How many months of sales you want a purchase to last. "Too much" and "May run short" are judged against this.</p>
      <button class="btn btn-signal btn-lg" id="bc_go">Analyse</button>
    </div>`;
  $('#bc_t1').onclick = ()=>bcDownloadTemplate(false).catch(e=>showAlert('Could not make the template: '+(e.message||e)));
  $('#bc_t2').onclick = ()=>bcDownloadTemplate(true).catch(e=>showAlert('Could not make the template: '+(e.message||e)));
  $('#bc_go').onclick = async ()=>{
    const f = $('#bc_file').files[0]; if(!f){ showAlert('Choose the filled template first.'); return; }
    const T = parseFloat($('#bc_months').value); if(!(T>0)){ showAlert('Enter how many months of cover you want.'); return; }
    bcSaveMonths(T);
    const btn = $('#bc_go'); btn.disabled = true; btn.textContent = 'Analysing…';
    try{
      const parsed = await parseBuySheet(f);
      if(parsed.error){ showAlert(parsed.error); return; }
      const ctx = await bcLoadContext();
      if(!ctx.hasHistory){ showAlert('There are no past orders to learn from yet. Import past orders in Insights first.'); return; }
      const raws = parsed.rows.map((r,i)=>{ const p = ctx.matcher.match(r.desc); return Object.assign({id:i}, r, {productId: p ? p.id : null}); });
      _bc = {ctx, raws, fileName:f.name, T, skipped:parsed.skipped};
      bcDrawResult();
    }catch(e){ showAlert('Something went wrong while analysing: '+(e.message||e)); }
    finally{ btn.disabled = false; btn.textContent = 'Analyse'; }
  };
}

function bcSummary(rows){
  const n = k=> rows.filter(r=>r.key===k).length;
  const prices = rows.filter(r=>r.raw.price!=null);
  return {total: rows.length, good:n('good'), over:n('over'), short:n('short'), dead:n('dead'),
    attention: n('thin')+n('nohistory')+n('unit')+n('nomatch')+n('skip'),
    value: prices.length ? prices.reduce((s,r)=>s+r.raw.qty*r.raw.price, 0) : null, priced: prices.length};
}

function bcDrawResult(){
  const {ctx, raws, T} = _bc;
  const rows = raws.map(r=>bcBuildRow(ctx, r, T));
  const missing = bcMissing(ctx, rows, T);
  const sum = bcSummary(rows);
  _bc.rows = rows; _bc.missing = missing;
  const anyPrice = sum.priced>0, anyExpected = rows.some(r=>r.expected!=null);
  const order = [...rows].sort((a,b)=>BC_VERDICT[a.key].rank-BC_VERDICT[b.key].rank || (b.cover||0)-(a.cover||0));
  const fmtP = n=> n==null ? '—' : (Math.round(n*100)/100).toLocaleString();
  const unmatched = rows.filter(r=>r.key==='nomatch');
  const rowHtml = r=>{
    const v = BC_VERDICT[r.key], p = r.product;
    const name = p ? `<a href="#/insights/product/${p.id}" style="text-decoration:none; color:inherit;"><b>${esc(p.name)}</b> <span class="subtle">›</span></a>${esc(p.name)!==esc(r.raw.desc) ? `<div class="subtle">${esc(r.raw.desc)}</div>` : ''}` : `<b>${esc(r.raw.desc)}</b>`;
    const lastsTxt = r.cover!=null ? `<b>${esc(fmtMonths(r.cover))}</b>` : '—';
    return `<tr>
      <td>${name}${r.note?`<div class="subtle" style="max-width:360px;">${esc(r.note)}</div>`:''}${r.priceHigh!=null?`<div class="subtle">Price is ${r.priceHigh}% above the cost price on file.</div>`:''}</td>
      <td class="num">${bcQ(r.raw.qty)} ${esc(r.raw.unit)}${p && r.baseOk && r.unit && normalize(r.raw.unit).toUpperCase()!==normalize(r.unit).toUpperCase() ? `<div class="subtle">= ${bcQ(r.buy)} ${esc(r.unit)}</div>` : ''}</td>
      <td class="num">${r.stock!=null ? bcQ(r.stock) : '<span class="subtle">not tracked</span>'}</td>
      <td class="num">${r.rate>0 ? bcQ(r.rate) : '—'}</td>
      <td class="num">${lastsTxt}</td>
      ${anyExpected ? `<td class="num">${r.expected!=null ? bcQ(r.expected) : '—'}</td>` : ''}
      <td><span class="badge ${v.cls}">${v.label}</span></td>
      <td class="num">${r.suggested!=null ? bcQ(r.suggested) : '—'}</td>
      ${anyPrice ? `<td class="num">${r.raw.price!=null ? fmtP(r.raw.qty*r.raw.price) : '—'}</td>` : ''}
    </tr>`;
  };
  $('#main').innerHTML = `
    <div class="topbar"><h1>Buy check</h1><div style="display:flex; gap:8px; flex-wrap:wrap;"><button class="btn btn-signal btn-sm" id="bc_export"><span data-ico="download"></span> Download as Excel</button><button class="btn btn-ghost btn-sm" id="bc_again">Start over</button></div></div>
    <p class="subtle" style="margin-top:-8px;">${esc(_bc.fileName)} · ${rows.length} line${rows.length===1?'':'s'}${_bc.skipped?` · ${_bc.skipped} row${_bc.skipped===1?'':'s'} without a quantity ignored`:''} · judged against <b>${bcQ(T)} month${T===1?'':'s'}</b> of cover · based on what vessels asked for, up to ${fmtDate(ctx.anchor)}
      <span style="margin-left:8px;">Cover: <input type="number" id="bc_t" min="0.5" step="0.5" value="${T}" style="width:80px; display:inline-block;"> months</span></p>
    <div class="wm-kpis ins-kpis">
      <div class="wm-kpi ok"><span class="wm-ic" data-ico="circle-check"></span><div class="wm-txt"><b>${sum.good}</b><div class="lbl">Good amount</div></div></div>
      <div class="wm-kpi ${sum.over?'bad':''}"><span class="wm-ic" data-ico="package"></span><div class="wm-txt"><b>${sum.over}</b><div class="lbl">Too much</div></div></div>
      <div class="wm-kpi ${sum.short?'bad':''}"><span class="wm-ic" data-ico="triangle-alert"></span><div class="wm-txt"><b>${sum.short}</b><div class="lbl">May run short</div></div></div>
      <div class="wm-kpi ${sum.dead?'bad':''}"><span class="wm-ic" data-ico="activity"></span><div class="wm-txt"><b>${sum.dead}</b><div class="lbl">Nobody orders lately</div></div></div>
      <div class="wm-kpi"><span class="wm-ic" data-ico="circle-help"></span><div class="wm-txt"><b>${sum.attention}</b><div class="lbl">Need a look</div></div></div>
      ${sum.value!=null ? `<div class="wm-kpi"><span class="wm-ic" data-ico="chart-column"></span><div class="wm-txt"><b>${fmtP(sum.value)}</b><div class="lbl">List total${sum.priced<rows.length?` (${sum.priced} of ${rows.length} priced)`:''}</div></div></div>` : ''}
    </div>
    ${unmatched.length ? `<div class="card" style="border-left:4px solid var(--warn); margin-bottom:16px;">
      <b>${unmatched.length} name${unmatched.length===1?'':'s'} couldn't be matched to a product</b>
      <p class="subtle" style="margin:4px 0 10px;">They are left out of the analysis until you choose the product.</p>
      ${unmatched.map(r=>`<div class="list-row"><div style="flex:1; min-width:0;"><b>${esc(r.raw.desc)}</b><div class="subtle">${bcQ(r.raw.qty)} ${esc(r.raw.unit)}</div></div><button class="btn btn-ghost btn-sm" data-assign="${r.raw.id}">Choose product…</button></div>`).join('')}
    </div>` : ''}
    <div class="card tbl-wrap" style="margin-bottom:18px;">
      <div class="sec-h" style="padding:0 10px;"><span class="sec-ic" data-ico="clipboard-list"></span><div class="section-title">Line by line</div></div>
      <table class="tbl"><thead><tr><th>Product</th><th class="num">You'd buy</th><th class="num">In stock</th><th class="num">Sells / month</th><th class="num">Stock + purchase lasts</th>${anyExpected?'<th class="num">Expected next 30 days</th>':''}<th>Verdict</th><th class="num">For ${bcQ(T)} mo. buy</th>${anyPrice?'<th class="num">Line total</th>':''}</tr></thead>
      <tbody>${order.map(rowHtml).join('')}</tbody></table>
      <p class="subtle" style="padding:0 10px;">Quantities are in each product's own measure (kg, L or its count unit). "Sells / month" is the pace of the last 3 months (the normal pace if that is zero). "For ${bcQ(T)} mo. buy" is the quantity that would give the cover you want, after what you already hold.</p>
    </div>
    <div class="card tbl-wrap">
      <div class="sec-h" style="padding:0 10px;"><span class="sec-ic" data-ico="triangle-alert"></span><div class="section-title">Running low but not on this list</div></div>
      ${missing.length ? `<table class="tbl"><thead><tr><th>Product</th><th class="num">In stock</th><th class="num">Sells / month</th><th class="num">Stock lasts</th><th class="num">For ${bcQ(T)} mo. buy</th></tr></thead>
      <tbody>${missing.slice(0,40).map(m=>`<tr><td><a href="#/insights/product/${m.product.id}" style="text-decoration:none; color:inherit;"><b>${esc(m.product.name)}</b> <span class="subtle">›</span></a>${['declining','collapsed'].includes(m.status)?' <span class="badge b-modified">demand falling</span>':''}</td><td class="num">${bcQ(m.stock)} ${esc(m.unit)}</td><td class="num">${bcQ(m.rate)}</td><td class="num"><b>${esc(fmtMonths(m.cover))}</b></td><td class="num">${bcQ(m.suggested)} ${esc(m.unit)}</td></tr>`).join('')}</tbody></table>${missing.length>40?`<p class="subtle" style="padding:0 10px;">…and ${missing.length-40} more (all are in the Excel download).</p>`:''}`
      : `<p class="subtle" style="padding:0 10px;">Nothing you track and sell is running low outside this list.</p>`}
      <p class="subtle" style="padding:0 10px;">Only products with stock tracking and enough history are checked here.</p>
    </div>`;
  $('#bc_again').onclick = ()=>buyCheckScreen();
  $('#bc_export').onclick = ()=>bcExport().catch(e=>showAlert('Could not make the Excel file: '+(e.message||e)));
  $('#bc_t').onchange = e=>{ const v = parseFloat(e.target.value); if(v>0){ _bc.T = v; bcSaveMonths(v); bcDrawResult(); } };
  document.querySelectorAll('[data-assign]').forEach(b=>b.onclick = ()=>{
    const whById = Object.fromEntries(ctx.warehouses.map(w=>[w.id,w]));
    openProductPicker(null, ctx.products, whById, {}, picked=>{
      const raw = _bc.raws.find(x=>x.id===+b.dataset.assign); if(!raw) return;
      raw.productId = picked.id; ctx.byId.set(picked.id, picked); bcDrawResult();
    });
  });
}

async function bcExport(){
  if(!(await ensureLibOrAlert('exceljs'))) return;
  const {rows, missing, T, ctx} = _bc;
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Buy check', {views:[{state:'frozen', ySplit:1}]});
  ws.columns = [{header:'Product (as written)', width:36}, {header:'Matched product', width:36}, {header:'Quantity', width:11}, {header:'Unit', width:14}, {header:'Quantity in product measure', width:16}, {header:'Measure', width:9},
    {header:'In stock', width:11}, {header:'Sells / month', width:13}, {header:'Stock + purchase lasts (months)', width:16}, {header:'Expected next 30 days', width:14}, {header:'Verdict', width:24},
    {header:`Buy for ${T} months`, width:14}, {header:'Unit price', width:11}, {header:'Line total', width:12}, {header:'Notes', width:60}];
  const head = ws.getRow(1); head.font = {bold:true, color:{argb:'FFFFFFFF'}}; head.alignment = {wrapText:true, vertical:'middle'};
  head.eachCell(c=>{ c.fill = {type:'pattern', pattern:'solid', fgColor:{argb:'FF1F4E79'}}; });
  const fill = {good:'FFC6EFCE', over:'FFFFC7CE', short:'FFFFEB9C', dead:'FFFFC7CE'};
  const r1 = x=> x==null ? null : Math.round(x*10)/10;
  for(const r of rows){
    const row = ws.addRow([r.raw.desc, r.product ? r.product.name : '', r.raw.qty, r.raw.unit, r.product && r.baseOk ? r1(r.buy) : null, r.product ? r.unit : '',
      r.stock!=null ? r1(r.stock) : null, r.rate>0 ? r1(r.rate) : null, r.cover!=null ? r1(r.cover) : null, r.expected!=null ? r1(r.expected) : null, BC_VERDICT[r.key].label,
      r.suggested!=null ? r1(r.suggested) : null, r.raw.price, r.raw.price!=null ? Math.round(r.raw.qty*r.raw.price*100)/100 : null,
      [r.note, r.priceHigh!=null ? `Price is ${r.priceHigh}% above the cost price on file.` : '', r.raw.note].filter(Boolean).join(' ')]);
    if(fill[r.key]) row.getCell(11).fill = {type:'pattern', pattern:'solid', fgColor:{argb:fill[r.key]}};
  }
  const w2 = wb.addWorksheet('Running low, not on list', {views:[{state:'frozen', ySplit:1}]});
  w2.columns = [{header:'Product', width:40}, {header:'In stock', width:12}, {header:'Measure', width:10}, {header:'Sells / month', width:14}, {header:'Stock lasts (months)', width:16}, {header:`Buy for ${T} months`, width:16}, {header:'Demand', width:14}];
  const h2 = w2.getRow(1); h2.font = {bold:true, color:{argb:'FFFFFFFF'}};
  h2.eachCell(c=>{ c.fill = {type:'pattern', pattern:'solid', fgColor:{argb:'FF1F4E79'}}; });
  missing.forEach(m=>w2.addRow([m.product.name, r1(m.stock), m.unit, r1(m.rate), r1(m.cover), r1(m.suggested), m.status]));
  const buf = await wb.xlsx.writeBuffer();
  await saveFile(`buy-check-${todayISO()}.xlsx`, new Blob([buf], {type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}));
}
