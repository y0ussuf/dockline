/* ======================================================================
   DOCKLINE — Ship Provisioning & Warehouse Picking
   Core workflow build: Products / Warehouses & Sections / Excel Import
   + Matching / Sorting / Picking Mode. Data is local-first (IndexedDB).
   ====================================================================== */

/* ---------------------------- tiny utils ---------------------------- */
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const $ = (sel, el = document) => el.querySelector(sel);
const esc = (s) => (s == null ? '' : String(s)).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const todayISO = () => new Date().toISOString().slice(0, 10);
const fmtDate = (iso) => { if(!iso) return '—'; const d=new Date(iso); return isNaN(d)?iso:d.toLocaleDateString('en-GB',{day:'2-digit',month:'short',year:'numeric'}); };

/* ------------------------------ order destination ------------------------------
   A free-text "where is this order actually going" flag (Suez Port, Alex Port, …) —
   added after a real near-miss where an order almost went out to the wrong port. It's
   plain text rather than a fixed list, since ports vary, but every screen that shows
   an order renders it as a colored badge (color picked deterministically from the
   text itself) so the same destination always looks the same at a glance, and two
   different destinations are never easy to confuse for each other. */
const DEST_PALETTE = [
  {bg:'#DCEEFB', fg:'#0B5394'}, {bg:'#FDE8D7', fg:'#B35B00'}, {bg:'#E4F2E9', fg:'#1F7A4D'},
  {bg:'#F3E1F5', fg:'#7A2E8A'}, {bg:'#FBE7E2', fg:'#A6333B'}, {bg:'#FBF0DB', fg:'#8A6B00'},
  {bg:'#E0F7F5', fg:'#0B7A72'}
];
function destColor(dest){
  let hash = 0;
  for(let i=0;i<dest.length;i++) hash = (hash*31 + dest.charCodeAt(i)) >>> 0;
  return DEST_PALETTE[hash % DEST_PALETTE.length];
}
function destinationBadge(dest, size){
  if(!dest) return '';
  const c = destColor(dest);
  const sz = size==='lg' ? 'font-size:.95rem; padding:6px 14px;' : '';
  return `<span class="badge" style="background:${c.bg}; color:${c.fg}; ${sz}">📍 ${esc(dest)}</span>`;
}

/* ------------------------ expiry: exact date vs. shelf life ------------------------
   Most shelf-stable products aren't labeled with an expiry date at all — they're
   labeled "60 days", "3 months", "1 year" from the production date. This lets
   whoever's filling in a product (or an order's dates) pick whichever matches what's
   actually printed on the item, instead of always doing the date math themselves.
   Whichever mode is used, the computed result is written into a normal hidden/visible
   <input type="date">, so every existing save handler that reads that field's .value
   keeps working unchanged. */
function addDuration(dateStr, amount, unit){
  const d = dateStr ? new Date(dateStr+'T00:00:00') : new Date();
  if(isNaN(d)) return '';
  if(unit==='days') d.setDate(d.getDate()+amount);
  else if(unit==='weeks') d.setDate(d.getDate()+Math.round(amount*7));
  else if(unit==='months') d.setMonth(d.getMonth()+amount);
  else if(unit==='years') d.setFullYear(d.getFullYear()+amount);
  else return '';
  // local date components, not toISOString() — that reflects UTC, which silently
  // shifts the date by a day near midnight for any timezone ahead of UTC
  const y = d.getFullYear(), m = String(d.getMonth()+1).padStart(2,'0'), day = String(d.getDate()).padStart(2,'0');
  return `${y}-${m}-${day}`;
}
function expiryFieldHtml(prefix, opts){
  opts = opts || {};
  const mode = opts.mode === 'shelf' ? 'shelf' : 'date';
  const unit = opts.shelfUnit || 'months';
  return `
    <div class="field">
      <label>Expiry date</label>
      <div class="tag-row" id="${prefix}_mode" style="margin-bottom:8px;">
        <button type="button" class="chip ${mode==='date'?'active':''}" data-mode="date">Exact date</button>
        <button type="button" class="chip ${mode==='shelf'?'active':''}" data-mode="shelf">Shelf life from production</button>
      </div>
      <input type="date" id="${prefix}_edate" value="${esc(opts.expiryDate||'')}" style="${mode==='shelf'?'display:none;':''}">
      <div id="${prefix}_shelf_wrap" class="row2" style="${mode==='date'?'display:none;':''}">
        <input type="number" id="${prefix}_shelf_amount" min="0" step="any" value="${opts.shelfAmount??''}" placeholder="e.g. 60">
        <select id="${prefix}_shelf_unit">
          <option value="days" ${unit==='days'?'selected':''}>Day(s)</option>
          <option value="weeks" ${unit==='weeks'?'selected':''}>Week(s)</option>
          <option value="months" ${unit==='months'?'selected':''}>Month(s)</option>
          <option value="years" ${unit==='years'?'selected':''}>Year(s)</option>
        </select>
      </div>
      <p class="subtle" id="${prefix}_shelf_preview" style="margin:6px 0 0;"></p>
    </div>`;
}
/* call once right after the modal containing expiryFieldHtml(prefix, ...) is shown.
   prodDateInputId, if given, is the id of that same form's production-date input —
   shelf life is computed from it (falling back to today if it's blank). */
function wireExpiryField(prefix, prodDateInputId){
  const modeBar = $('#'+prefix+'_mode');
  const dateInput = $('#'+prefix+'_edate');
  const shelfWrap = $('#'+prefix+'_shelf_wrap');
  const amountInput = $('#'+prefix+'_shelf_amount');
  const unitSelect = $('#'+prefix+'_shelf_unit');
  const preview = $('#'+prefix+'_shelf_preview');
  if(!modeBar || !dateInput) return;

  function currentProdDate(){
    const prodInput = prodDateInputId ? $('#'+prodDateInputId) : null;
    return (prodInput && prodInput.value) || todayISO();
  }
  function recompute(){
    const amount = parseFloat(amountInput.value);
    if(!isNaN(amount) && amount>=0){
      const computed = addDuration(currentProdDate(), amount, unitSelect.value);
      dateInput.value = computed;
      preview.textContent = computed ? `= ${fmtDate(computed)}` : '';
    } else {
      preview.textContent = '';
    }
  }
  modeBar.onclick = (e)=>{
    const b = e.target.closest('[data-mode]'); if(!b) return;
    modeBar.querySelectorAll('.chip').forEach(c=>c.classList.toggle('active', c===b));
    if(b.dataset.mode==='date'){
      dateInput.style.display=''; shelfWrap.style.display='none'; preview.textContent='';
    } else {
      dateInput.style.display='none'; shelfWrap.style.display='flex';
      recompute();
    }
  };
  amountInput.oninput = recompute;
  unitSelect.onchange = recompute;
  if(prodDateInputId){
    const prodInput = $('#'+prodDateInputId);
    if(prodInput) prodInput.addEventListener('change', recompute);
  }
  // current mode's active chip decides whether we need an initial compute
  if(modeBar.querySelector('.chip.active')?.dataset.mode==='shelf') recompute();
}
function expiryModeOf(prefix){
  return $('#'+prefix+'_mode')?.querySelector('.chip.active')?.dataset.mode || 'date';
}

function normalize(s){
  return (s||'').toString().toLowerCase().trim().replace(/[^a-z0-9]+/g,' ').replace(/\s+/g,' ').trim();
}
function levRatio(a,b){
  if(a===b) return 1;
  const al=a.length, bl=b.length;
  if(!al||!bl) return 0;
  const dp = Array.from({length:al+1},(_,i)=>[i,...Array(bl).fill(0)]);
  for(let j=0;j<=bl;j++) dp[0][j]=j;
  for(let i=1;i<=al;i++) for(let j=1;j<=bl;j++)
    dp[i][j] = a[i-1]===b[j-1] ? dp[i-1][j-1] : 1+Math.min(dp[i-1][j],dp[i][j-1],dp[i-1][j-1]);
  return 1 - dp[al][bl]/Math.max(al,bl);
}
function similarity(a,b){
  const na=normalize(a), nb=normalize(b);
  if(!na||!nb) return 0;
  if(na===nb) return 1;
  const ta=new Set(na.split(' ')), tb=new Set(nb.split(' '));
  const inter=[...ta].filter(x=>tb.has(x)).length;
  const union=new Set([...ta,...tb]).size;
  const jac = union? inter/union : 0;
  return Math.max(jac, levRatio(na,nb));
}

/* ------------------------- unit parsing & conversion -------------------------
   Pulls a numeric size + measurement unit out of messy free-text like
   "btl 300 ml", "Tinned 800 gm", "Tin 400 gm", or a bare "LTR"/"Kg" (implies
   magnitude 1 of that unit). Only volume<->volume or weight<->weight pairs
   are convertible; anything else (Piece, Dozen, Box, or unparseable text)
   is left alone rather than guessed at. */
const UNIT_FACTORS = {
  ml:1, milliliter:1, millilitre:1, milliliters:1, millilitres:1,
  cl:10, centiliter:10, centilitre:10, centiliters:10, centilitres:10,
  l:1000, ltr:1000, liter:1000, litre:1000, liters:1000, litres:1000,
  g:1, gm:1, gram:1, grams:1,
  kg:1000, kilogram:1000, kilograms:1000,
  oz:28.3495, ounce:28.3495, ounces:28.3495,
  lb:453.592, lbs:453.592, pound:453.592, pounds:453.592
};
const VOLUME_UNITS = new Set(['ml','milliliter','millilitre','milliliters','millilitres','cl','centiliter','centilitre','centiliters','centilitres','l','ltr','liter','litre','liters','litres']);
const UNIT_TOKEN_RE = /(\d+(?:\.\d+)?)\s*(milliliters?|millilitres?|centiliters?|centilitres?|liters?|litres?|kilograms?|ounces?|pounds?|ml|cl|ltr|l|g|gm|gram|grams|kg|oz|lbs?|lb)\b/i;

function parseUnitSize(raw){
  const s = (raw||'').toLowerCase().trim();
  if(!s) return {ok:false};
  const m = s.match(UNIT_TOKEN_RE);
  if(m){
    const num = parseFloat(m[1]);
    const tok = m[2].toLowerCase();
    const factor = UNIT_FACTORS[tok];
    if(factor==null) return {ok:false};
    return {ok:true, base:num*factor, type: VOLUME_UNITS.has(tok)?'volume':'weight'};
  }
  if(UNIT_FACTORS[s]!=null){
    return {ok:true, base:UNIT_FACTORS[s], type: VOLUME_UNITS.has(s)?'volume':'weight'};
  }
  return {ok:false};
}
/* returns null when no conversion is needed/possible; otherwise {convertedQty, sheetParsed, dbParsed} */
function computeUnitConversion(sheetUnit, dbUnit, qty){
  if(!sheetUnit || !dbUnit) return null;
  if(normalize(sheetUnit) === normalize(dbUnit)) return null;
  const sp = parseUnitSize(sheetUnit), dp = parseUnitSize(dbUnit);
  if(!sp.ok || !dp.ok || sp.type !== dp.type) return null;
  const convertedQty = qty * (sp.base / dp.base);
  return { convertedQty, sheetParsed:sp, dbParsed:dp };
}
function round2(n){ return Math.round(n*100)/100; }

/* ------------------------- warehouse stock tracking -------------------------
   Opt-in per product: a blank "stock on hand" means this product isn't tracked
   at all — it's invisible to every function below and nothing about it ever
   changes on its own. Only once a number (including 0) has been entered does
   it start being kept up to date as orders are picked, and start showing up
   as low once it's at or under its limit (default 0 if no limit was set). */
function isStockTracked(p){
  return p && p.stockQty !== '' && p.stockQty != null && !isNaN(parseFloat(p.stockQty));
}
function stockLimitOf(p){
  const n = parseFloat(p && p.lowStockLimit);
  return isNaN(n) ? 0 : n;
}
function isLowStock(p){
  if(!isStockTracked(p)) return false;
  return parseFloat(p.stockQty) <= stockLimitOf(p);
}
/* Deducts whatever was actually picked from each tracked product's stock, once,
   when an order finishes. Only "completed"/"modified" items count — they're the
   only statuses that mean real stock physically left the shelf for THIS product:
   a substitution was a different, unlinked item, and "not available"/postponed-
   then-dropped items never got picked at all. */
/* The products an item was substituted with: [{productId, name, qty, unit}]. A substitution can use
   several products, each with its own quantity (it.replacements). Older single-replacement items
   (replacementProductId / actualQty) are read through the same shape. */
function replacementsOf(it){
  if(Array.isArray(it.replacements) && it.replacements.length) return it.replacements;
  if(it.replacementProductId) return [{productId: it.replacementProductId, name: it.replacementName||'', qty: it.actualQty, unit: it.actualUnit||''}];
  return [];
}
async function applyStockDeductions(items){
  // a substituted item was physically picked as its replacement product(s), not the
  // originally-matched one, so stock comes off each product that was actually used
  const lines = [];
  for(const it of items){
    if(it.status==='completed' || it.status==='modified'){
      if(it.productId) lines.push({productId: it.productId, qty: it.actualQty});
    } else if(it.status==='substituted'){
      for(const r of replacementsOf(it)) if(r.productId) lines.push({productId: r.productId, qty: r.qty});
    }
  }
  const touched = lines.filter(l=> typeof l.qty==='number' && !isNaN(l.qty));
  if(!touched.length) return;
  const products = await getAll('products');
  const byId = new Map(products.map(p=>[p.id,p]));
  for(const l of touched){
    const p = byId.get(l.productId);
    if(!p || !isStockTracked(p)) continue;
    p.stockQty = round2(parseFloat(p.stockQty) - l.qty);
    await put('products', p);
  }
}

/* ------------------------------ storage ------------------------------ */
/* Bump this string every time the app is published (date + a counter for that day is enough,
   e.g. '2026-10-11.2'). It's how the update-check below tells a stale cached copy apart from
   the real latest version — see checkForUpdate() near boot() at the bottom of this file. */
// APP_VERSION now lives inline in index.html (so the update check can read it from the page itself)
const DB_NAME='dockline_db', DB_VER=8;
const STORES=['warehouses','sections','products','mappings','orders','orderItems','suppliers','settings','boxReceipts','boxTypes','productReceipts','historyOrders','historyLines'];
// internal-only stores used by the crew-sync layer below — never touched by app screens directly
const SYNC_STORES=['syncQueue','syncMeta'];
let dbp = new Promise((resolve,reject)=>{
  const req = indexedDB.open(DB_NAME, DB_VER);
  req.onupgradeneeded = e=>{
    const db=e.target.result;
    STORES.forEach(s=>{ if(!db.objectStoreNames.contains(s)) db.createObjectStore(s,{keyPath:'id'}); });
    SYNC_STORES.forEach(s=>{ if(!db.objectStoreNames.contains(s)) db.createObjectStore(s,{keyPath:'key'}); });
  };
  req.onsuccess = ()=>resolve(req.result);
  req.onerror = ()=>reject(req.error);
});
async function tx(store, mode, fn){
  const db = await dbp;
  return new Promise((resolve,reject)=>{
    const t = db.transaction(store, mode);
    const os = t.objectStore(store);
    const result = fn(os);
    t.oncomplete = ()=>resolve(result);
    t.onerror = ()=>reject(t.error);
  });
}
async function getAll(store){
  const db = await dbp;
  return new Promise((resolve,reject)=>{
    const req = db.transaction(store,'readonly').objectStore(store).getAll();
    req.onsuccess=()=>resolve(req.result||[]);
    req.onerror=()=>reject(req.error);
  });
}
async function getOne(store,id){
  const db = await dbp;
  return new Promise((resolve,reject)=>{
    const req = db.transaction(store,'readonly').objectStore(store).get(id);
    req.onsuccess=()=>resolve(req.result||null);
    req.onerror=()=>reject(req.error);
  });
}
// raw = local IndexedDB only, no sync bookkeeping. Used internally by the sync layer itself
// (applying a remote change must not re-queue it as a local change to push back out).
async function rawPut(store,obj){ await tx(store,'readwrite',os=>os.put(obj)); return obj; }
async function rawDel(store,id){ await tx(store,'readwrite',os=>os.delete(id)); }
async function put(store,obj){
  await rawPut(store,obj);
  if(typeof queueSync==='function' && SYNC_TABLES.includes(store)) queueSync(store,obj.id,'put');
  return obj;
}
async function del(store,id){
  await rawDel(store,id);
  if(typeof queueSync==='function' && SYNC_TABLES.includes(store)) queueSync(store,id,'del');
}

