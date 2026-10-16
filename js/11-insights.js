/* ==================================== INSIGHTS ====================================
   Analysis of past orders. The old order sheets (Excel) are imported in bulk into their own
   two local stores — historyOrders (one per sheet) and historyLines (one per line) — which are
   deliberately kept apart from the live orders/orderItems:
     • they never touch stock, picking, supplier reliability or any list on Home/Orders/History
     • they are NOT part of crew sync (SYNC_TABLES) — they live on the device that imported them
   What's recorded is what the vessel REQUESTED, never what was picked, and every quantity is
   converted into the product's own measure (kg / L, or a plain count) so different wordings of
   the same thing ("4 × 500 GM", "2 KG") add up. Vessels are identified by NAME (IMO numbers
   change on these sheets, so they're only kept as extra info). */

/* ------------------------------ small helpers ------------------------------ */
async function bulkPut(store, records){
  if(!records.length) return;
  const db = await dbp;
  await new Promise((resolve,reject)=>{
    const t = db.transaction(store,'readwrite');
    const os = t.objectStore(store);
    for(const r of records) os.put(r);
    t.oncomplete = resolve; t.onerror = ()=>reject(t.error); t.onabort = ()=>reject(t.error);
  });
}
async function clearStore(store){
  const db = await dbp;
  await new Promise((resolve,reject)=>{
    const t = db.transaction(store,'readwrite');
    t.objectStore(store).clear();
    t.oncomplete = resolve; t.onerror = ()=>reject(t.error);
  });
}
const _pad2 = n=>String(n).padStart(2,'0');
function _isoFromParts(y,m,d){
  y=+y; m=+m; d=+d;
  if(y<100) y += 2000;
  if(y<2010 || y>2040 || m<1 || m>12 || d<1 || d>31) return null;
  const dt = new Date(Date.UTC(y,m-1,d));
  if(dt.getUTCMonth()!==m-1) return null; // e.g. 31 Feb
  return `${y}-${_pad2(m)}-${_pad2(d)}`;
}
const _MONTHS = {jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,sept:9,oct:10,nov:11,dec:12,
  january:1,february:2,march:3,april:4,june:6,july:7,august:8,september:9,october:10,november:11,december:12};
/* Reads a date out of free text. Numeric dates are read day-first (dd/mm/yyyy); when both numbers
   could be a month it's flagged ambiguous so the preview can ask the person to double-check. */
function parseDateText(raw){
  const s = String(raw||'');
  let m = s.match(/(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})/);
  if(m){ const iso=_isoFromParts(m[1],m[2],m[3]); if(iso) return {iso, ambiguous:false}; }
  m = s.match(/(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{4}|\d{2})\b/);
  if(m){
    let d=+m[1], mo=+m[2];
    let ambiguous = d<=12 && mo<=12 && d!==mo;
    let evidence = d>12 ? 'dayfirst' : null; // a day above 12 proves the sheets write day first
    if(mo>12 && d<=12){ [d,mo]=[mo,d]; ambiguous=false; evidence='monthfirst'; } // clearly month-first
    const iso=_isoFromParts(m[3],mo,d); if(iso) return {iso, ambiguous, evidence};
  }
  m = s.match(/(\d{1,2})(?:st|nd|rd|th)?[\s-]+([A-Za-z]{3,9})\.?,?[\s-]+(\d{4})/);
  if(m && _MONTHS[m[2].toLowerCase()]){ const iso=_isoFromParts(m[3],_MONTHS[m[2].toLowerCase()],m[1]); if(iso) return {iso, ambiguous:false}; }
  m = s.match(/([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})/);
  if(m && _MONTHS[m[1].toLowerCase()]){ const iso=_isoFromParts(m[3],_MONTHS[m[1].toLowerCase()],m[2]); if(iso) return {iso, ambiguous:false}; }
  m = s.match(/(\d{4})(\d{2})(\d{2})/); // 20250312 (file names)
  if(m){ const iso=_isoFromParts(m[1],m[2],m[3]); if(iso) return {iso, ambiguous:false}; }
  return null;
}
/* looks in the lines above the table (vessel name / reference / date area), then the file name */
function findOrderDate(aoa, headerRowIndex, fileName){
  for(let r=0; r<headerRowIndex; r++){
    for(const cell of (aoa[r]||[])){
      if(cell instanceof Date && !isNaN(cell)){
        const d = new Date(cell.getTime()+12*3600*1000); // dodge time-zone drift at midnight
        const iso=_isoFromParts(d.getUTCFullYear(), d.getUTCMonth()+1, d.getUTCDate());
        if(iso) return {iso, ambiguous:false, source:'sheet'};
      } else if(typeof cell==='number' && cell>40000 && cell<56000){
        const d = new Date(Math.round((cell-25569)*86400000));
        const iso=_isoFromParts(d.getUTCFullYear(), d.getUTCMonth()+1, d.getUTCDate());
        if(iso) return {iso, ambiguous:false, source:'sheet'};
      } else if(typeof cell==='string' && cell.trim()){
        const p = parseDateText(cell); if(p) return {...p, source:'sheet'};
      }
    }
  }
  const f = parseDateText(String(fileName||'').replace(/\.[^.]+$/,''));
  return f ? {...f, source:'file name'} : null;
}
/* vessel name from the sheet: the existing reader first (it looks for the order code), otherwise
   the first short text line above the table that isn't a date */
function findVesselName(aoa, headerRowIndex, fileName){
  const found = extractVesselAndCodeFromSheet(aoa, headerRowIndex);
  if(found && found.vessel) return {vessel: found.vessel, code: found.code};
  for(let r=0; r<headerRowIndex; r++){
    const text = (aoa[r]||[]).map(c=>String(c==null?'':c).trim()).filter(Boolean).join(' ').trim();
    if(text && text.length<=60 && !parseDateText(text) && !ORDER_CODE_RE.test(text)) return {vessel:text, code: found?found.code:''};
  }
  return {vessel:'', code: found?found.code:(extractOrderCodeFromFilename(fileName)||{}).code||''};
}
/* "M/V Torm Diana", "MV TORM  DIANA" and "TORM DIANA" are one vessel */
function vesselKeyOf(name){
  let n = normalize(name);
  n = n.replace(/^(m v|m t|m s|m y|mv|mt|ms|my|ss|tb) /,'');
  return n.trim();
}

/* ------------------------------ units → base measure ------------------------------ */
/* the measure a product is counted in for analysis: 'kg', 'L', or its own count unit ('PKT', 'PCS'…) */
function canonicalUnitOf(product){
  const dp = product ? parseUnitSize(product.unit) : {ok:false};
  if(dp.ok) return dp.type==='weight' ? 'kg' : 'L';
  const u = normalize(product && product.unit).toUpperCase();
  return u || 'PCS';
}
function _unitWord(u){ return normalize(u).replace(/[0-9 ]/g,''); }
/* Converts what a line asked for into the product's base measure.
   Returns {baseQty, baseUnit, ok, note}. Anything that can't be converted safely is marked ok:false
   (shown as "needs review") instead of being guessed at. */
function toBaseQty(qty, lineUnit, product){
  const sp = parseUnitSize(lineUnit);
  const dp = product ? parseUnitSize(product.unit) : {ok:false};
  const canon = canonicalUnitOf(product);
  if(sp.ok){
    const unit = sp.type==='weight' ? 'kg' : 'L';
    const baseQty = round2(qty * sp.base / 1000);
    if(!product) return {baseQty, baseUnit:unit, ok:true};
    return unit===canon ? {baseQty, baseUnit:unit, ok:true} : {baseQty, baseUnit:unit, ok:false, note:`ordered in ${lineUnit}, product is counted in ${product.unit}`};
  }
  // the line isn't a measurement ("PKT", "CTN", "PCS", blank…)
  if(dp.ok){
    // a pack of the product's own unit, e.g. line "PKT" against database unit "PKT 450 GM"
    const lw = _unitWord(lineUnit), pw = _unitWord(product.unit);
    if(lw && pw && (lw===pw || pw.startsWith(lw) || lw.startsWith(pw))){
      return {baseQty: round2(qty * dp.base / 1000), baseUnit: canon, ok:true};
    }
    return {baseQty: qty, baseUnit: normalize(lineUnit).toUpperCase()||'?', ok:false, note:`ordered in ${lineUnit||'no unit'}, product is measured in ${canon}`};
  }
  const lineWord = normalize(lineUnit).toUpperCase() || 'PCS';
  if(!product) return {baseQty: qty, baseUnit: lineWord, ok:true};
  return lineWord===canon || canon==='PCS' && !normalize(lineUnit)
    ? {baseQty: qty, baseUnit: canon, ok:true}
    : {baseQty: qty, baseUnit: lineWord, ok:false, note:`ordered in ${lineUnit||'no unit'}, product is counted in ${canon}`};
}

/* product matcher that loads the database once (matchExcelRow reloads it on every call) */
async function buildHistoryMatcher(){
  const [products, mappings] = await Promise.all([getAll('products'), getAll('mappings')]);
  const byId = new Map(products.map(p=>[p.id,p]));
  const mapByKey = new Map(mappings.map(m=>[m.excelDescNormalized, m]));
  const active = products.filter(p=>p.active);
  const byName = new Map(active.map(p=>[normalize(p.name), p]));
  const cache = new Map();
  return {
    products, byId,
    match(desc){
      const key = normalize(desc);
      if(cache.has(key)) return cache.get(key);
      let res = null;
      const m = mapByKey.get(key);
      if(m && byId.get(m.productId)) res = byId.get(m.productId);
      else if(byName.get(key)) res = byName.get(key);
      else {
        let best=null, bestScore=0;
        for(const p of active){ const sc = similarity(desc, p.name); if(sc>bestScore){ bestScore=sc; best=p; } }
        if(best && bestScore>=0.82) res = best;
      }
      cache.set(key, res);
      return res;
    }
  };
}

/* ------------------------------ parsing the sheets ------------------------------ */
async function parseHistorySheet(file){
  const out = {fileName:file.name, ok:false, error:'', vessel:'', code:'', imo:'', date:'', ambiguous:false, dateSource:'', lines:[], skippedLines:0};
  try{
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, {type:'array', cellDates:true});
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const aoa = XLSX.utils.sheet_to_json(sheet, {header:1, defval:'', blankrows:false});
    if(!aoa.length){ out.error='empty file'; return out; }
    const headerInfo = locateOrderHeaderRow(aoa);
    if(!headerInfo){ out.error='no "Description" column found'; return out; }
    const v = findVesselName(aoa, headerInfo.rowIndex, file.name);
    out.vessel = v.vessel; out.code = v.code; out.imo = v.code;
    const d = findOrderDate(aoa, headerInfo.rowIndex, file.name);
    if(d){ out.date=d.iso; out.ambiguous=d.ambiguous; out.dateSource=d.source; out.evidence=d.evidence||null; }
    const { kSr, kDesc, kQty, kUnit } = headerInfo;
    for(const row of aoa.slice(headerInfo.rowIndex+1)){
      const desc = String((kDesc!==-1 ? row[kDesc] : '') ?? '').trim();
      if(!desc) continue;
      const qty = parseFloat(kQty!==-1 ? row[kQty] : '');
      if(isNaN(qty) || qty<=0){ out.skippedLines++; continue; }
      out.lines.push({sr: kSr!==-1 ? String(row[kSr]??'').trim() : '', desc, qty, unit: kUnit!==-1 ? String(row[kUnit]??'').trim() : ''});
    }
    out.ok = out.lines.length>0;
    if(!out.ok) out.error = 'no lines with a quantity';
  }catch(e){ out.error = 'could not read this file'; }
  return out;
}

/* ============================== ROUTE: insights ============================== */
route('insights', async (parts)=>{
  if(parts[0]==='import') return historyImportScreen();
  if(parts[0]==='match') return historyMatchScreen();
  if(parts[0]==='product') return productInsightScreen(parts[1]);
  if(parts[0]==='vessel') return vesselProfileScreen(parts[1]);
  return insightsHome();
});

/* status → badge, shared by the Insights list ("Worth a look" and the products table) */
const ANALYSIS_BADGE = {
  stopped:  {label:'Stopped',   cls:'b-not_available', rank:0},
  collapsed:{label:'Collapsed', cls:'b-not_available', rank:1},
  declining:{label:'Declining', cls:'b-modified',      rank:2},
  new:      {label:'New',       cls:'b-completed',     rank:4},
  growing:  {label:'Growing',   cls:'b-completed',     rank:5},
  steady:   {label:'Steady',    cls:'b-completed',     rank:6},
  unknown:  {label:'Not enough history', cls:'b-pending', rank:7}
};

/* extra, stock-aware advice for the product page: how many months the stock covers at the current pace */
function stockAdviceFor(a, product){
  if(!isStockTracked(product)) return [];
  const stock = parseFloat(product.stockQty), unit = canonicalUnitOf(product);
  const cover = a.recentRate>0 ? stock/a.recentRate : null;
  const falling = ['stopped','collapsed','declining'].includes(a.status);
  const f = n=> (Math.round(n*10)/10).toLocaleString();
  if(falling && cover!=null && cover>=6) return [{sev:'warning', text:`Don't buy more for now: you hold ${f(stock)} ${unit}, about ${f(cover)} months at the current pace.`}];
  if(falling && cover==null && stock>0) return [{sev:'warning', text:`Nothing ordered recently but ${f(stock)} ${unit} is in stock — watch for dead stock.`}];
  if(a.status==='growing' && cover!=null && cover<=2) return [{sev:'warning', text:`Demand is rising and your stock covers only ${f(cover)} months — consider ordering.`}];
  return [];
}

async function insightsHome(){
  const [hOrders, hLines, products] = await Promise.all([getAll('historyOrders'), getAll('historyLines'), getAll('products')]);
  const byId = new Map(products.map(p=>[p.id,p]));
  if(!hOrders.length){
    $('#main').innerHTML = `
      <div class="topbar"><h1>Insights</h1></div>
      <div class="card" style="max-width:640px;">
        <div class="section-title">Learn from past orders</div>
        <p class="subtle">Import your old order sheets (the same Excel files you use to start an order) and Dockline will show how demand for each product and each vessel has been changing — the first step toward knowing what to buy and what not to.</p>
        <p class="subtle">What the vessel <b>asked for</b> is what counts, not what was picked. Past orders are kept separate: they never touch your stock, your live orders or reports.</p>
        <a href="#/insights/import" class="btn btn-signal btn-lg" style="max-width:320px;">Import past orders</a>
      </div>`;
    return;
  }
  const dates = hOrders.map(o=>o.orderDate).filter(Boolean).sort();
  const anchor = dates[dates.length-1];
  const unmatchedKeys = new Set(hLines.filter(l=>!l.productId && !l.skipped).map(l=>l.descKey));
  const reviewLines = hLines.filter(l=>l.productId && !l.baseOk).length;

  // ---- vessels (grouped by name) ----
  const vessels = new Map();
  for(const o of hOrders){
    const v = vessels.get(o.vesselKey) || {key:o.vesselKey, names:new Map(), imos:new Set(), dates:[]};
    v.names.set(o.vesselName, (v.names.get(o.vesselName)||0)+1);
    if(o.imo) v.imos.add(o.imo);
    if(o.orderDate) v.dates.push(o.orderDate);
    vessels.set(o.vesselKey, v);
  }
  const vesselRows = [...vessels.values()].map(v=>{
    v.dates.sort();
    const name = [...v.names.entries()].sort((a,b)=>b[1]-a[1])[0][0];
    const rh = vesselRhythm(v.dates, anchor);
    return {key:v.key, name, orders:v.dates.length, first:v.dates[0], last:v.dates[v.dates.length-1], gap:rh.gap, status:rh.status, variants:v.names.size};
  }).sort((a,b)=> VESSEL_BADGE[a.status].rank-VESSEL_BADGE[b.status].rank || b.orders-a.orders);

  // ---- products: demand in base measure, last 90 days vs the 90 before ----
  const cut1 = new Date(new Date(anchor).getTime()-90*86400000).toISOString().slice(0,10);
  const cut2 = new Date(new Date(anchor).getTime()-180*86400000).toISOString().slice(0,10);
  const prod = new Map();
  for(const l of hLines){
    if(!l.productId || !l.baseOk) continue;
    const p = prod.get(l.productId) || {id:l.productId, unit:l.baseUnit, total:0, recent:0, prior:0, vessels:new Set(), orders:new Set()};
    p.total += l.baseQty; p.vessels.add(l.vesselKey); p.orders.add(l.historyOrderId);
    if(l.orderDate>cut1) p.recent += l.baseQty; else if(l.orderDate>cut2) p.prior += l.baseQty;
    prod.set(l.productId, p);
  }
  const prodRows = [...prod.values()].sort((a,b)=>b.total-a.total);
  const fmtQ = n=> (Math.round(n*10)/10).toLocaleString();
  const linesByProduct = new Map();
  for(const l of hLines){
    if(!l.productId || !l.baseOk) continue;
    (linesByProduct.get(l.productId) || linesByProduct.set(l.productId, []).get(l.productId)).push(l);
  }
  const analyses = new Map([...linesByProduct].filter(([pid])=>byId.has(pid)).map(([pid,ls])=>[pid, analyzeProduct(ls, anchor, dates[0])]));
  const watch = [...analyses.entries()]
    .filter(([,a])=> ['stopped','collapsed','declining'].includes(a.status) || a.signals.some(s=>s.sev==='warning'))
    .sort((x,y)=> ANALYSIS_BADGE[x[1].status].rank-ANALYSIS_BADGE[y[1].status].rank || y[1].baseRate-x[1].baseRate)
    .slice(0,15);
  const trendHtml = p=>{
    if(p.prior<=0 && p.recent<=0) return '<span class="subtle">no recent orders</span>';
    if(p.prior<=0) return '<span class="trend-up">new</span>';
    const ch = Math.round((p.recent-p.prior)/p.prior*100);
    if(Math.abs(ch)<10) return `<span class="subtle">${ch>0?'+':''}${ch}%</span>`;
    return `<span class="${ch>0?'trend-up':'trend-down'}">${ch>0?'+':''}${ch}%</span>`;
  };

  $('#main').innerHTML = `
    <div class="topbar"><h1>Insights</h1><a href="#/insights/import" class="btn btn-signal btn-sm">+ Import more orders</a></div>
    <div class="grid-stats">
      <div class="stat"><b>${hOrders.length}</b><div class="lbl">Past orders</div></div>
      <div class="stat"><b>${vesselRows.length}</b><div class="lbl">Vessels</div></div>
      <div class="stat"><b>${hLines.length.toLocaleString()}</b><div class="lbl">Order lines</div></div>
      <div class="stat"><b style="font-size:1.1rem;">${fmtDate(dates[0])} → ${fmtDate(anchor)}</b><div class="lbl">Period covered</div></div>
    </div>
    ${(unmatchedKeys.size || reviewLines) ? `<div style="display:flex; gap:10px; flex-wrap:wrap; margin-bottom:18px;">
      ${unmatchedKeys.size ? `<a href="#/insights/match" class="btn btn-ghost" style="border-color:var(--warn); color:var(--warn);">⚠ ${unmatchedKeys.size} product name${unmatchedKeys.size===1?'':'s'} not matched yet — match them</a>` : ''}
      ${reviewLines ? `<span class="subtle" style="align-self:center;">${reviewLines} line${reviewLines===1?'':'s'} in a unit that can't be converted — left out of the totals</span>` : ''}
    </div>` : ''}
    ${watch.length ? `<h3 class="section-title">⚠ Worth a look</h3>
    <p class="subtle" style="margin-top:-8px;">Products whose demand changed. Tap one to see why.</p>
    <div class="card" style="margin-bottom:26px;">${watch.map(([pid,a])=>{
      const top = (a.signals.find(x=>x.sev==='warning')||a.signals[0]||{}).text||'';
      return `<a href="#/insights/product/${pid}" class="list-row" style="text-decoration:none; color:inherit;">
        <div style="flex:1; min-width:0;"><b>${esc((byId.get(pid)||{}).name||'?')}</b><div class="subtle">${esc(top)}</div></div>
        <span class="badge ${ANALYSIS_BADGE[a.status].cls}">${ANALYSIS_BADGE[a.status].label}</span></a>`;}).join('')}</div>` : ''}
    <h3 class="section-title">Products — demand by what vessels asked for</h3>
    <p class="subtle" style="margin-top:-8px;">Quantities are in each product's own measure. Trend compares the 90 days up to ${fmtDate(anchor)} with the 90 days before.</p>
    <div class="card tbl-wrap"><table class="tbl">
      <thead><tr><th>Product</th><th class="num">Total asked</th><th class="num">Last 90 days</th><th class="num">Before that</th><th>Trend</th><th>Status</th><th class="num">Vessels</th></tr></thead>
      <tbody>${prodRows.slice(0,60).map(p=>`<tr>
        <td><a href="#/insights/product/${p.id}" style="font-weight:700; text-decoration:none; color:inherit;">${esc((byId.get(p.id)||{}).name||'?')} <span class="subtle">›</span></a></td>
        <td class="num">${fmtQ(p.total)} ${esc(p.unit)}</td>
        <td class="num">${fmtQ(p.recent)}</td><td class="num">${fmtQ(p.prior)}</td>
        <td>${trendHtml(p)}</td><td>${analyses.get(p.id) ? `<span class="badge ${ANALYSIS_BADGE[analyses.get(p.id).status].cls}">${ANALYSIS_BADGE[analyses.get(p.id).status].label}</span>` : ''}</td><td class="num">${p.vessels.size}</td></tr>`).join('') || '<tr><td colspan="7" class="subtle">Nothing matched yet.</td></tr>'}</tbody>
    </table>${prodRows.length>60?`<p class="subtle" style="padding:8px 10px;">Showing the 60 biggest of ${prodRows.length} products.</p>`:''}</div>
    <h3 class="section-title" style="margin-top:28px;">Vessels</h3>
    <div class="card tbl-wrap"><table class="tbl">
      <thead><tr><th>Vessel</th><th class="num">Orders</th><th>First</th><th>Last</th><th class="num">Usually every</th><th>Status</th></tr></thead>
      <tbody>${vesselRows.map(v=>`<tr><td><a href="#/insights/vessel/${encodeURIComponent(v.key)}" style="text-decoration:none; color:inherit;"><b>${esc(v.name)}</b> <span class="subtle">›</span></a>${v.variants>1?` <span class="subtle">· ${v.variants} spellings merged</span>`:''}</td>
        <td class="num">${v.orders}</td><td>${fmtDate(v.first)}</td><td>${fmtDate(v.last)}</td><td class="num">${v.gap!=null?v.gap+' days':'—'}</td><td><span class="badge ${VESSEL_BADGE[v.status].cls}">${VESSEL_BADGE[v.status].label}</span></td></tr>`).join('')}</tbody>
    </table></div>
    <div style="margin-top:24px;"><button class="btn btn-ghost btn-sm" id="histClear">🗑 Delete all imported past orders</button></div>`;
  $('#histClear').onclick = ()=> showConfirm('Delete every imported past order from this device? Your live orders, products and stock are not affected. You can import the sheets again later.', async ()=>{
    await clearStore('historyOrders'); await clearStore('historyLines');
    insightsHome();
  }, {danger:true, yesLabel:'Delete'});
}

/* A zip of order sheets (e.g. one month, or a whole year) is opened here in the browser and its
   .xlsx/.xls files are handled exactly like files picked one by one. Folders inside the zip are fine. */
async function expandPickedFiles(files, onProgress){
  const out = [];
  for(const f of files){
    if(!/\.zip$/i.test(f.name)){ out.push(f); continue; }
    if(typeof JSZip==='undefined'){ out.push({name:f.name, unreadable:'zip support not loaded — check your connection and reload'}); continue; }
    try{
      const zip = await JSZip.loadAsync(await f.arrayBuffer());
      const entries = Object.values(zip.files).filter(e=>
        !e.dir && /\.xlsx?$/i.test(e.name) && !/(^|\/)(__MACOSX|~\$)/.test(e.name) && !/(^|\/)~\$/.test(e.name));
      let i = 0;
      for(const e of entries){
        i++; if(onProgress) onProgress(`Opening ${f.name}: ${i} of ${entries.length}…`);
        const buf = await e.async('arraybuffer');
        const base = e.name.split('/').pop();
        const file = new File([buf], base);
        file.zipPath = e.name;
        out.push(file);
        if(i%20===0) await new Promise(r=>setTimeout(r,0));
      }
      if(!entries.length) out.push({name:f.name, unreadable:'no Excel files found inside this zip'});
    }catch(err){ out.push({name:f.name, unreadable:'could not open this zip'}); }
  }
  return out;
}

/* ============================== IMPORT SCREEN ============================== */
async function historyImportScreen(){
  $('#main').innerHTML = `
    <div class="topbar"><h1>Import past orders</h1></div>
    <div class="card" style="max-width:720px;">
      <p class="subtle" style="margin-top:0;">Choose Excel sheets, or <b>zip files</b> of them (for example one zip per month or per year — you can pick several zips at once). You'll see what was found — vessel, date, number of lines — before anything is saved.</p>
      <input type="file" id="hi_files" accept=".xlsx,.xls,.zip" multiple>
      <p class="subtle" id="hi_status" style="margin-top:10px;"></p>
    </div>
    <div id="hi_preview"></div>`;
  let parsed = [];
  $('#hi_files').onchange = async e=>{
    const picked = [...e.target.files];
    if(!picked.length) return;
    parsed = [];
    $('#hi_status').textContent = 'Opening files…';
    const files = await expandPickedFiles(picked, msg=>{ $('#hi_status').textContent = msg; });
    for(let i=0;i<files.length;i++){
      $('#hi_status').textContent = `Reading sheet ${i+1} of ${files.length}…`;
      if(files[i].unreadable){ parsed.push({fileName:files[i].name, ok:false, error:files[i].unreadable, lines:[]}); continue; }
      const r = await parseHistorySheet(files[i]);
      if(files[i].zipPath) r.fileName = files[i].zipPath;
      parsed.push(r);
      if(i%10===0) await new Promise(r=>setTimeout(r,0)); // keep the page responsive
    }
    // One date like 25/03/2025 proves the sheets write the day first, which settles every
    // other day/month-looking date in the batch — so only flag them if the batch contradicts itself.
    const dayFirst = parsed.some(p=>p.evidence==='dayfirst'), monthFirst = parsed.some(p=>p.evidence==='monthfirst');
    if(dayFirst && !monthFirst) parsed.forEach(p=>{ p.ambiguous = false; });
    // sheets that need a look go to the top
    parsed.sort((a,b)=> (b.ok?(!b.date||b.ambiguous?1:0):2) - (a.ok?(!a.date||a.ambiguous?1:0):2));
    $('#hi_status').textContent = '';
    drawPreview();
  };
  function drawPreview(){
    const good = parsed.filter(p=>p.ok), bad = parsed.filter(p=>!p.ok);
    $('#hi_preview').innerHTML = `
      <div class="card" style="margin-top:18px;">
        <div class="section-title">${good.length} sheet${good.length===1?'':'s'} ready${bad.length?` · ${bad.length} could not be read`:''}</div>
        <p class="subtle" style="margin-top:-6px;">${good.filter(p=>!p.date||p.ambiguous).length ? `<b>${good.filter(p=>!p.date||p.ambiguous).length}</b> need a look and are listed first. ` : 'Everything has a vessel and a date. '}Fix any vessel name or date that looks wrong. Sheets already imported before are skipped automatically.</p>
        <div class="tbl-wrap"><table class="tbl">
          <thead><tr><th></th><th>File</th><th>Vessel</th><th>Date</th><th class="num">Lines</th></tr></thead>
          <tbody>${parsed.map((p,i)=>`<tr>
            <td>${p.ok?`<input type="checkbox" data-inc="${i}" checked style="width:auto;">`:''}</td>
            <td class="subtle" style="max-width:200px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${esc(p.fileName)}">${esc(p.fileName)}</td>
            ${p.ok ? `<td><input type="text" data-vessel="${i}" value="${esc(p.vessel)}" placeholder="vessel name" style="min-width:150px;"></td>
            <td><input type="date" data-date="${i}" value="${esc(p.date)}">${!p.date?' <span class="badge b-unmatched">no date</span>':p.ambiguous?' <span class="badge b-modified" title="Day and month could be swapped — please check">check</span>':''}</td>
            <td class="num">${p.lines.length}${p.skippedLines?` <span class="subtle">(+${p.skippedLines} w/o qty)</span>`:''}</td>`
            : `<td colspan="3"><span class="badge b-not_available">${esc(p.error)}</span></td>`}
          </tr>`).join('')}</tbody>
        </table></div>
        <button class="btn btn-signal btn-lg" id="hi_go" style="max-width:340px; margin-top:16px;">Import selected sheets</button>
      </div>`;
    $('#hi_preview').querySelectorAll('[data-vessel]').forEach(el=>el.oninput=()=>{ parsed[+el.dataset.vessel].vessel = el.value; });
    $('#hi_preview').querySelectorAll('[data-date]').forEach(el=>el.onchange=()=>{ parsed[+el.dataset.date].date = el.value; parsed[+el.dataset.date].ambiguous=false; });
    $('#hi_go').onclick = runImport;
  }
  async function runImport(){
    const chosen = [...$('#hi_preview').querySelectorAll('[data-inc]')].filter(c=>c.checked).map(c=>parsed[+c.dataset.inc]);
    const missing = chosen.filter(p=>!p.vessel.trim() || !p.date);
    if(missing.length){ showAlert(`${missing.length} selected sheet${missing.length===1?' is':'s are'} missing a vessel name or a date. Fill them in (or untick them) first.`); return; }
    $('#hi_go').disabled = true;
    const matcher = await buildHistoryMatcher();
    const existing = await getAll('historyOrders');
    const seen = new Set(existing.map(o=>o.fingerprint));
    const newOrders = [], newLines = [];
    let skippedDup = 0;
    for(const p of chosen){
      const vesselKey = vesselKeyOf(p.vessel);
      const fingerprint = [vesselKey, p.date, p.code, p.lines.length, round2(p.lines.reduce((s,l)=>s+l.qty,0))].join('|');
      if(seen.has(fingerprint)){ skippedDup++; continue; }
      seen.add(fingerprint);
      const oid = uid();
      newOrders.push({id:oid, fileName:p.fileName, vesselName:p.vessel.trim(), vesselKey, imo:p.imo||'', orderDate:p.date, fingerprint, lineCount:p.lines.length, importedAt:new Date().toISOString()});
      for(const l of p.lines){
        const product = matcher.match(l.desc);
        const b = toBaseQty(l.qty, l.unit, product);
        newLines.push({id:uid(), historyOrderId:oid, vesselKey, orderDate:p.date, excelDesc:l.desc, descKey:normalize(l.desc),
          qty:l.qty, unit:l.unit, productId: product?product.id:null, baseQty:b.baseQty, baseUnit:b.baseUnit, baseOk:b.ok, skipped:false});
      }
    }
    await bulkPut('historyOrders', newOrders);
    await bulkPut('historyLines', newLines);
    const unmatched = new Set(newLines.filter(l=>!l.productId).map(l=>l.descKey)).size;
    showAlert(`Imported ${newOrders.length} order${newOrders.length===1?'':'s'} (${newLines.length.toLocaleString()} lines).${skippedDup?` ${skippedDup} already imported before were skipped.`:''}${unmatched?` ${unmatched} product name${unmatched===1?'':'s'} still need matching to your products.`:''}`, 'Import complete');
    location.hash = unmatched ? '#/insights/match' : '#/insights';
  }
}

/* ============================== MATCH SCREEN ============================== */
/* One line per distinct product name that isn't matched yet (not per order line) — pick the product
   once and every past line with that name is updated. Choices are saved as mappings, so they also
   help when importing live orders. */
async function historyMatchScreen(){
  const [hLines, products, warehouses, sections] = await Promise.all([getAll('historyLines'), getAll('products'), getAll('warehouses'), getAll('sections')]);
  const whMap = Object.fromEntries(warehouses.map(w=>[w.id,w]));
  const secMap = Object.fromEntries(sections.map(s=>[s.id,s]));
  const groups = new Map();
  for(const l of hLines){
    if(l.productId || l.skipped) continue;
    const g = groups.get(l.descKey) || {key:l.descKey, desc:l.excelDesc, count:0, vessels:new Set(), units:new Map()};
    g.count++; g.vessels.add(l.vesselKey); g.units.set(l.unit, (g.units.get(l.unit)||0)+1);
    groups.set(l.descKey, g);
  }
  const list = [...groups.values()].sort((a,b)=>b.count-a.count);
  if(!list.length){ location.hash = '#/insights'; return; }
  const page = list.slice(0,25);
  const active = products.filter(p=>p.active);
  $('#main').innerHTML = `
    <div class="topbar"><h1>Match product names</h1></div>
    <p class="subtle" style="margin-top:-10px;">${list.length} name${list.length===1?'':'s'} left, most-used first. Pick the product once and every past line with that name is updated. Your choices are remembered, so they also help future orders.</p>
    <div id="hm_list">${page.map(g=>{
      const cands = active.map(p=>({p, s:similarity(g.desc, p.name)})).sort((a,b)=>b.s-a.s).filter(c=>c.s>=0.35).slice(0,4);
      return `<div class="match-card warn" data-key="${esc(g.key)}">
        <div><b>${esc(g.desc)}</b><div class="subtle">${g.count} line${g.count===1?'':'s'} · ${g.vessels.size} vessel${g.vessels.size===1?'':'s'} · e.g. unit “${esc([...g.units.keys()][0]||'')}”</div></div>
        <div class="cand-list">
          ${cands.map(c=>`<button class="cand-btn" data-pick="${esc(g.key)}" data-pid="${c.p.id}">${esc(c.p.name)} <span class="subtle">· ${Math.round(c.s*100)}%</span></button>`).join('')}
          <button class="btn btn-ghost btn-sm" data-search="${esc(g.key)}">🔍 Search database…</button>
          <button class="btn btn-ghost btn-sm" data-skip="${esc(g.key)}">Leave out of analysis</button>
        </div>
      </div>`;}).join('')}</div>
    <div style="margin-top:16px;"><a href="#/insights" class="btn btn-ghost">Done for now</a></div>`;

  async function assign(key, product){
    const mappings = await getAll('mappings');
    if(!mappings.find(m=>m.excelDescNormalized===key)){
      const g = groups.get(key);
      await put('mappings', {id:uid(), excelDescNormalized:key, label:g.desc, productId:product.id});
    }
    const fresh = (await getAll('historyLines')).filter(l=>l.descKey===key && !l.productId);
    for(const l of fresh){
      const b = toBaseQty(l.qty, l.unit, product);
      l.productId = product.id; l.baseQty=b.baseQty; l.baseUnit=b.baseUnit; l.baseOk=b.ok;
    }
    await bulkPut('historyLines', fresh);
    historyMatchScreen();
  }
  $('#hm_list').querySelectorAll('[data-pick]').forEach(b=>b.onclick=()=> assign(b.dataset.pick, products.find(p=>p.id===b.dataset.pid)));
  $('#hm_list').querySelectorAll('[data-search]').forEach(b=>b.onclick=()=>{
    openProductPicker(null, products, whMap, secMap, picked=> assign(b.dataset.search, picked));
  });
  $('#hm_list').querySelectorAll('[data-skip]').forEach(b=>b.onclick=async ()=>{
    const fresh = (await getAll('historyLines')).filter(l=>l.descKey===b.dataset.skip && !l.productId);
    fresh.forEach(l=>{ l.skipped = true; });
    await bulkPut('historyLines', fresh);
    historyMatchScreen();
  });
}


/* ============================== PRODUCT ANALYSIS ============================== */
const ANALYSIS = {            // the knobs — tuned later against real data
  recentDays: 90,             // "now" window
  baselineDays: 270,          // the stretch before it that counts as "normal"
  minHistoryDays: 180,        // less history than this → "not enough history"
  collapsed: 0.4, declining: 0.75, growing: 1.4,   // recent monthly rate ÷ baseline monthly rate
  shrinkOrder: 0.5,           // typical order size fell below this share of before
  quietFactor: 2.5, quietMinDays: 60, regularMinOrders: 3,
  concentration: 0.5
};
const DAYMS = 86400000;
const _t = iso=> Date.parse(iso+'T00:00:00Z');
const _median = a=>{ if(!a.length) return 0; const s=[...a].sort((x,y)=>x-y), m=s.length>>1; return s.length%2 ? s[m] : (s[m-1]+s[m])/2; };
const _monthKey = iso=> iso.slice(0,7);
function _monthLabel(key){ const [y,m]=key.split('-'); return new Date(Date.UTC(+y,+m-1,1)).toLocaleString('en',{month:'short', year:'2-digit', timeZone:'UTC'}); }

/* Pure function: everything the product page shows comes from here.
   lines = this product's history lines (already limited to ones with a usable quantity),
   anchorISO = the latest order date in the history, histStartISO = the earliest. */
function analyzeProduct(lines, anchorISO, histStartISO){
  const A = ANALYSIS, anchor = _t(anchorISO);
  const byOrder = new Map();
  for(const l of lines){
    const o = byOrder.get(l.historyOrderId) || {date:l.orderDate, vessel:l.vesselKey, qty:0};
    o.qty += l.baseQty; byOrder.set(l.historyOrderId, o);
  }
  const orders = [...byOrder.values()].sort((a,b)=>a.date.localeCompare(b.date));
  const res = {orders, total: orders.reduce((s,o)=>s+o.qty,0), signals:[], status:'unknown'};
  // monthly series across the whole history period
  const months = [];
  { let y=+histStartISO.slice(0,4), m=+histStartISO.slice(5,7); const ey=+anchorISO.slice(0,4), em=+anchorISO.slice(5,7);
    while(y<ey || (y===ey && m<=em)){ months.push(`${y}-${_pad2(m)}`); m++; if(m>12){m=1;y++;} } }
  const monthly = Object.fromEntries(months.map(k=>[k,0]));
  orders.forEach(o=>{ monthly[_monthKey(o.date)] = (monthly[_monthKey(o.date)]||0)+o.qty; });
  res.months = months.map(k=>({key:k, label:_monthLabel(k), qty:round2(monthly[k]||0)}));

  const spanDays = (anchor - _t(histStartISO))/DAYMS;
  const recentStart = anchor - A.recentDays*DAYMS;
  const baseDays = Math.min(A.baselineDays, Math.max(0, spanDays - A.recentDays));
  const baseStart = recentStart - baseDays*DAYMS;
  const recent = orders.filter(o=>_t(o.date)>recentStart);
  const base = orders.filter(o=>_t(o.date)>baseStart && _t(o.date)<=recentStart);
  res.recentQty = recent.reduce((s,o)=>s+o.qty,0);
  res.baseQty = base.reduce((s,o)=>s+o.qty,0);
  res.recentRate = res.recentQty / (A.recentDays/30);                 // per 30 days
  res.baseRate = baseDays>0 ? res.baseQty / (baseDays/30) : 0;
  res.baseDays = baseDays;
  res.recentOrders = recent.length; res.baseOrders = base.length;
  res.vesselCount = new Set(orders.map(o=>o.vessel)).size;

  // vessels
  const vmap = new Map();
  for(const o of orders){ const v = vmap.get(o.vessel) || {key:o.vessel, orders:[], qty:0}; v.orders.push(o); v.qty+=o.qty; vmap.set(o.vessel,v); }
  res.vessels = [...vmap.values()].map(v=>{
    const ds = v.orders.map(o=>_t(o.date)).sort((a,b)=>a-b);
    const gaps = ds.slice(1).map((d,i)=>(d-ds[i])/DAYMS);
    const gap = gaps.length ? _median(gaps) : null;
    const sinceLast = (anchor - ds[ds.length-1])/DAYMS;
    const quiet = v.orders.length>=A.regularMinOrders && gap!=null && sinceLast > Math.max(A.quietMinDays, A.quietFactor*gap);
    return {key:v.key, orders:v.orders.length, qty:v.qty, share: res.total? v.qty/res.total : 0, gap: gap==null?null:Math.round(gap), sinceLast:Math.round(sinceLast), quiet};
  }).sort((a,b)=>b.qty-a.qty);

  // status
  const enough = orders.length>=4 && spanDays>=A.minHistoryDays && baseDays>=60;
  if(!enough){
    res.status='unknown';
    res.signals.push({sev:'note', text:`Not enough history to judge a trend yet (${orders.length} order${orders.length===1?'':'s'} over ${Math.round(spanDays/30)} months).`});
  } else if(recent.length===0 && base.length>=3){
    res.status='stopped';
    res.signals.push({sev:'warning', text:`Stopped being ordered: nothing in the last ${A.recentDays} days, after ${base.length} orders in the ${Math.round(baseDays/30)} months before.`});
  } else {
    res.ratio = res.baseRate>0 ? res.recentRate/res.baseRate : (res.recentRate>0 ? Infinity : 1);
    const pct = Math.round(Math.abs(1-res.ratio)*100);
    if(res.baseRate===0 && res.recentRate>0){ res.status='new'; res.signals.push({sev:'note', text:'New product: it was not ordered before the last 90 days.'}); }
    else if(res.ratio<A.collapsed){ res.status='collapsed'; res.signals.push({sev:'warning', text:`Demand has collapsed: about ${pct}% lower than its normal level.`}); }
    else if(res.ratio<A.declining){ res.status='declining'; res.signals.push({sev:'warning', text:`Demand is declining: about ${pct}% lower than its normal level.`}); }
    else if(res.ratio>A.growing){ res.status='growing'; res.signals.push({sev:'note', text:`Demand is growing: about ${pct}% higher than its normal level.`}); }
    else { res.status='steady'; res.signals.push({sev:'ok', text:'Demand is steady compared with its normal level.'}); }
    // order size
    const rm=_median(recent.map(o=>o.qty)), bm=_median(base.map(o=>o.qty));
    res.recentOrderSize=rm; res.baseOrderSize=bm;
    if(recent.length>=2 && base.length>=3 && bm>0 && rm < A.shrinkOrder*bm)
      res.signals.push({sev:'warning', text:`Orders are getting smaller: a typical order was ${round2(bm)}, lately ${round2(rm)}.`});
  }
  // vessels that used to order regularly and went quiet
  const quiet = res.vessels.filter(v=>v.quiet);
  if(quiet.length){
    const share = Math.round(quiet.reduce((s,v)=>s+v.share,0)*100);
    res.signals.push({sev:'warning', text:`${quiet.length} regular vessel${quiet.length===1?' has':'s have'} gone quiet (${share}% of all past demand): ${quiet.slice(0,4).map(v=>`${v.key.toUpperCase()} — usually every ~${v.gap} days, last ordered ${v.sinceLast} days ago`).join('; ')}${quiet.length>4?'…':''}.`});
  }
  const top = res.vessels[0];
  if(top && res.vessels.length>1 && top.share>A.concentration)
    res.signals.push({sev:'note', text:`${Math.round(top.share*100)}% of this product's demand comes from one vessel (${top.key.toUpperCase()}) — if it stops, this product follows.`});
  if(res.vessels.length===1) res.signals.push({sev:'note', text:'Only one vessel has ever ordered this.'});

  // worst recent quarter (monthly rate), for the deal check
  const last12 = res.months.slice(-12).map(m=>m.qty);
  let worst = null;
  for(let i=0;i+3<=last12.length;i++){ const r=(last12[i]+last12[i+1]+last12[i+2])/3; if(worst==null || r<worst) worst=r; }
  res.worstRate = worst==null ? res.recentRate : worst;
  return res;
}
/* how long a quantity would last at each pace; null = never (no demand at that pace) */
function monthsToSell(qty, rate){ return rate>0 ? qty/rate : null; }
function fmtMonths(m){ if(m==null) return 'never at this pace'; if(m<1) return `${Math.round(m*30)} days`; return `${(Math.round(m*10)/10)} months`; }

function monthlyChartSvg(months, avgRate, recentMonths){
  const W=720, H=240, L=48, R=12, T=14, B=34, n=months.length;
  const max = Math.max(1, ...months.map(m=>m.qty), avgRate||0);
  const pow = Math.pow(10, Math.floor(Math.log10(max))), nice = Math.ceil(max/pow*2)/2*pow; // 1, 1.5, 2 … × 10^k
  const top = Math.max(nice, max), x = i=> L + (W-L-R)*(i+0.5)/n, bw = Math.max(2, Math.min(26, (W-L-R)/n*0.62));
  const y = v=> T + (H-T-B)*(1 - v/top);
  const ticks = [0, top/2, top].map(v=>`<line x1="${L}" x2="${W-R}" y1="${y(v)}" y2="${y(v)}" stroke="var(--line)" stroke-width="1"/><text x="${L-6}" y="${y(v)+4}" text-anchor="end" font-size="11" fill="var(--ink-soft)">${Math.round(v*10)/10}</text>`).join('');
  const step = Math.ceil(n/10);
  const labels = months.map((m,i)=> i%step===0 || i===n-1 ? `<text x="${x(i)}" y="${H-12}" text-anchor="middle" font-size="11" fill="var(--ink-soft)">${m.label}</text>` : '').join('');
  const bars = months.map((m,i)=> m.qty>0 ? `<path d="M${x(i)-bw/2},${y(0)} V${y(m.qty)+4} q0,-4 4,-4 h${bw-8} q4,0 4,4 V${y(0)} Z" fill="var(--sea)"/>` : '').join('');
  const hit = months.map((m,i)=>`<rect class="mc-hit" data-i="${i}" x="${x(i)-(W-L-R)/n/2}" y="${T}" width="${(W-L-R)/n}" height="${H-T-B}" fill="transparent"><title>${m.label}: ${m.qty}</title></rect>`).join('');
  const rx = x(Math.max(0,n-recentMonths))-(W-L-R)/n/2;
  const band = `<rect x="${rx}" y="${T}" width="${W-R-rx}" height="${H-T-B}" fill="var(--sea)" opacity=".07"/><text x="${W-R-4}" y="${T+11}" text-anchor="end" font-size="11" fill="var(--ink-soft)">last 3 months</text>`;
  const avg = avgRate>0 ? `<line x1="${L}" x2="${W-R}" y1="${y(avgRate)}" y2="${y(avgRate)}" stroke="var(--ink-soft)" stroke-width="1.5" stroke-dasharray="5 4"/><text x="${L+4}" y="${y(avgRate)-5}" font-size="11" fill="var(--ink-soft)">normal level ${Math.round(avgRate*10)/10} / month</text>` : '';
  return `<svg viewBox="0 0 ${W} ${H}" style="width:100%; height:auto; display:block;" role="img" aria-label="Monthly demand">${band}${ticks}${bars}${avg}${labels}${hit}</svg>`;
}

async function productInsightScreen(productId){
  const [product, hLines, hOrders, supers] = await Promise.all([getOne('products', productId), getAll('historyLines'), getAll('historyOrders'), Promise.resolve(null)]);
  if(!product || !hOrders.length){ location.hash='#/insights'; return; }
  const dates = hOrders.map(o=>o.orderDate).filter(Boolean).sort();
  const lines = hLines.filter(l=>l.productId===productId && l.baseOk);
  const a = analyzeProduct(lines, dates[dates.length-1], dates[0]);
  const unit = lines.length ? lines[0].baseUnit : canonicalUnitOf(product);
  const tracked = isStockTracked(product);
  const names = {}; hOrders.forEach(o=>{ names[o.vesselKey] = names[o.vesselKey] || o.vesselName; });
  const vName = k=> names[k] || k;
  const badge = {stopped:['b-not_available','Stopped'], collapsed:['b-not_available','Collapsed'], declining:['b-modified','Declining'], steady:['b-completed','Steady'], growing:['b-completed','Growing'], new:['b-completed','New'], unknown:['b-pending','Not enough history']}[a.status];
  const icon = {warning:'⚠', note:'ℹ', ok:'✓'};
  const fq = n=> (Math.round(n*10)/10).toLocaleString();
  $('#main').innerHTML = `
    <div class="topbar"><h1>${esc(product.name)}</h1><a href="#/insights" class="btn btn-ghost btn-sm">← Insights</a></div>
    <p style="margin-top:-8px;"><span class="badge ${badge[0]}">${badge[1]}</span> <span class="subtle">· measured in ${esc(unit)} · what vessels asked for, ${fmtDate(dates[0])} → ${fmtDate(dates[dates.length-1])}</span></p>
    <div class="grid-stats">
      <div class="stat"><b>${fq(a.recentRate)}</b><div class="lbl">${esc(unit)} / month lately</div></div>
      <div class="stat"><b>${a.baseDays>0 ? fq(a.baseRate) : '—'}</b><div class="lbl">${esc(unit)} / month normally</div></div>
      <div class="stat"><b>${a.orders.length}</b><div class="lbl">Orders in total</div></div>
      <div class="stat"><b>${a.vesselCount}</b><div class="lbl">Vessels</div></div>
    </div>
    <div class="card" style="margin-bottom:18px;">
      <div class="section-title">What stands out</div>
      ${[...stockAdviceFor(a, product), ...a.signals].map(s=>`<p style="margin:8px 0;"><b>${icon[s.sev]} ${s.sev==='warning'?'Warning':s.sev==='ok'?'OK':'Note'}</b> — ${esc(s.text)}</p>`).join('')}
    </div>
    <div class="card" style="margin-bottom:18px;">
      <div class="section-title">Demand per month (${esc(unit)})</div>
      <div id="pc_chart" style="position:relative;">${monthlyChartSvg(a.months, a.baseRate, 3)}<div id="pc_tip" style="display:none; position:absolute; pointer-events:none; background:var(--card); border:1px solid var(--line); border-radius:8px; padding:6px 10px; font-size:.85rem; box-shadow:0 2px 8px rgba(0,0,0,.15);"></div></div>
      <details style="margin-top:8px;"><summary class="subtle" style="cursor:pointer;">Show as a table</summary>
        <div class="tbl-wrap"><table class="tbl"><thead><tr><th>Month</th><th class="num">${esc(unit)}</th></tr></thead><tbody>${a.months.map(m=>`<tr><td>${m.label}</td><td class="num">${fq(m.qty)}</td></tr>`).join('')}</tbody></table></div>
      </details>
    </div>
    <div class="card" style="margin-bottom:18px;">
      <div class="section-title">Thinking of buying a lot of this?</div>
      <p class="subtle" style="margin-top:-6px;">${tracked ? `You hold <b>${fq(parseFloat(product.stockQty))} ${esc(unit)}</b> now.` : `Stock isn't tracked for this product, so only the quantity below is counted.`} Enter what you're considering buying:</p>
      <div style="display:flex; gap:10px; align-items:center; flex-wrap:wrap; margin-bottom:10px;"><input type="number" id="deal_qty" min="0" step="any" placeholder="quantity" style="max-width:160px;"><span>${esc(unit)}</span></div>
      <div id="deal_out" class="subtle">Type a quantity to see how long it would take to sell.</div>
    </div>
    <div class="card tbl-wrap">
      <div class="section-title" style="padding:0 10px;">Vessels that ordered it</div>
      <table class="tbl"><thead><tr><th>Vessel</th><th class="num">Orders</th><th class="num">Total (${esc(unit)})</th><th class="num">Share</th><th class="num">Usually every</th><th>Last ordered</th></tr></thead>
      <tbody>${a.vessels.map(v=>`<tr><td><b>${esc(vName(v.key))}</b>${v.quiet?' <span class="badge b-modified">gone quiet</span>':''}</td><td class="num">${v.orders}</td><td class="num">${fq(v.qty)}</td><td class="num">${Math.round(v.share*100)}%</td><td class="num">${v.gap!=null?v.gap+' days':'—'}</td><td>${v.sinceLast} days before the latest order</td></tr>`).join('')}</tbody></table>
    </div>`;
  // hover tooltip
  const chart = $('#pc_chart'), tip = $('#pc_tip');
  chart.querySelectorAll('.mc-hit').forEach(r=>{
    r.onmouseenter = ()=>{ const m = a.months[+r.dataset.i]; tip.textContent = `${m.label}: ${fq(m.qty)} ${unit}`; tip.style.display='block'; };
    r.onmousemove = e=>{ const b = chart.getBoundingClientRect(); tip.style.left = Math.min(b.width-150, e.clientX-b.left+10)+'px'; tip.style.top = (e.clientY-b.top-34)+'px'; };
    r.onmouseleave = ()=>{ tip.style.display='none'; };
  });
  // deal check
  $('#deal_qty').oninput = e=>{
    const buy = parseFloat(e.target.value);
    if(isNaN(buy) || buy<=0){ $('#deal_out').textContent = 'Type a quantity to see how long it would take to sell.'; return; }
    const have = tracked ? Math.max(0, parseFloat(product.stockQty)) : 0, total = have + buy;
    const rows = [['At the pace of the last 3 months', a.recentRate], ['At its normal pace', a.baseRate>0?a.baseRate:a.recentRate], ['At its slowest recent quarter', a.worstRate]];
    $('#deal_out').innerHTML = `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>${tracked?`Stock + purchase (${fq(total)} ${esc(unit)}) would last`:`Purchase would last`}</th><th class="num">Time to sell</th></tr></thead><tbody>${
      rows.map(([label,rate])=>`<tr><td>${label} <span class="subtle">(${fq(rate)} / month)</span></td><td class="num"><b>${fmtMonths(monthsToSell(total, rate))}</b></td></tr>`).join('')}</tbody></table></div>`;
  };
}
