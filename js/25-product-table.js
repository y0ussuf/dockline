/* ==================================== PRODUCT TABLE ====================================
   One spreadsheet-style page with every product's facts: unit, supplier, cost, markup, sell price, stock,
   low-stock limit, pack size, active… Edit a cell, press Enter to jump to the next row, review the highlighted
   changes and save them in one go. Prices are kept exactly as typed (never rounded). Every save is written
   to a change log (who, when, old → new) and can be undone. Where products are stored (warehouse / section)
   is managed on the Products page, not here. */

const PT_COLS = [
  {k:'unit',     label:'Unit'},
  {k:'supplier', label:'Supplier',        f:'supplierId',    kind:'select'},
  {k:'cost',     label:'Cost (EGP)',      f:'costPrice',     kind:'dec'},
  {k:'markup',   label:'Markup %',        kind:'markup'},
  {k:'sell',     label:'Sell (EGP)',      f:'sellPrice',     kind:'dec'},
  {k:'updated',  label:'Price updated',   kind:'ro'},
  {k:'ref',      label:'Prices are for',  f:'priceRef',      kind:'ref'},
  {k:'perunit',  label:'Per 1 unit',      kind:'ro'},
  {k:'stock',    label:'Stock on hand',   f:'stockQty',      kind:'qty'},
  {k:'limit',    label:'Low-stock limit', f:'lowStockLimit', kind:'qty'},
  {k:'pack',     label:'Pack size',       f:'packSize',      kind:'qty'},
  {k:'expiry',   label:'Expiry',          kind:'ro'},
  {k:'perorder', label:'Bought per order',kind:'ro'},
  {k:'active',   label:'Active',          f:'active',        kind:'bool'}
];
const PT_DEFAULT = ['unit','cost','markup','sell','ref','perunit','stock','limit'];
const PT_COMPACT = ['cost','sell','stock'];
const PT_FIELD_LABEL = {priceRef:'prices are for', costPrice:'cost', sellPrice:'sell price', stockQty:'stock', lowStockLimit:'low-stock limit', packSize:'pack size', supplierId:'supplier', active:'active'};

const ptEq = (a,b)=> JSON.stringify(a==null||a===''?null:a)===JSON.stringify(b==null||b===''?null:b);
const ptRefText = r=> r && r.qty ? `${r.qty} ${r.unit||''}`.trim() : '';
/* exact a ÷ b as a Dec when it ends; otherwise {approx:true, text} to 4 decimals (display only) */
function ptDivide(a, b){
  if(!a || !b || b.n<=0n) return null;
  const num = a.n*(10n**BigInt(b.s)), den = b.n*(10n**BigInt(a.s));
  for(let k=0; k<=12; k++){ const t = num*(10n**BigInt(k)); if(t%den===0n) return {exact:true, text:Dec.fmt({n:t/den, s:k}, 2)}; }
  const sc = 10n**4n, v = (num*sc)/den; return {exact:false, text:'≈ '+Dec.fmt({n:v, s:4}, 2)};
}
function ptPerUnit(sell, ref){
  const s = Dec.parse(sell), q = ref && Dec.parse(ref.qty); if(!s || !q || !ref.unit) return '';
  const a = ptDivide(s, q); if(!a) return '';
  let out = `${a.text} /${ref.unit}`;
  if(ref.unit==='ml' || ref.unit==='g'){ const b = ptDivide(Dec.mul(s, Dec.parse('1000')), q); if(b) out += ` · ${b.text} /${ref.unit==='ml'?'l':'kg'}`; }
  return out;
}
const PT_PRICE_COLS = new Set(['cost','markup','sell','ref','perunit','updated']);
/* when a product's price last changed: the newest price-history entry (null = it has a price but no recorded change) */
const ptLastPriceAt = p=>{ const h = p.priceHistory; return h && h.length ? h[h.length-1].at : null; };
const PT_SOURCE = from=> !from ? '' : from==='edit' ? 'Product form' : from==='product table' ? 'Product Table' : /^sheet /.test(from) ? 'Price sheet · '+from.slice(6) : from;
const ptColOk = c => !PT_PRICE_COLS.has(c.k) || (c.k==='cost' ? seesCost() : c.k==='sell'||c.k==='perunit' ? seesSell() : c.k==='markup' ? seesBothPrices() : can('prices.view'));
/* may this person change this field here? (fields are locked, not hidden, when they may only look) */
function ptCanEdit(f){
  if(f==='costPrice'||f==='sellPrice'||f==='priceRef'||f==='__markup') return can('prices.edit') && seesBothPrices();
  if(f==='stockQty'||f==='lowStockLimit') return can('stock.edit');
  return can('products.edit');
}
function ptWho(){ return (AUTH && AUTH.email) ? AUTH.email.split('@')[0] : 'this device'; }

route('table', async ()=>{
  const [all, suppliers, whs] = await Promise.all([getAll('products'), getAll('suppliers'), getAll('warehouses')]);
  const products = all.filter(p=>!p.mergedInto);
  const prodById = new Map(products.map(p=>[p.id,p])), supById = new Map(suppliers.map(s=>[s.id,s])), whMap = new Map(whs.map(w=>[w.id,w]));
  suppliers.sort((a,b)=>a.name.localeCompare(b.name));
  let visible = PT_DEFAULT.slice();
  try{ const v = JSON.parse(localStorage.getItem('dk_pt_cols')||'null'); if(Array.isArray(v) && v.length) visible = v.filter(k=>PT_COLS.some(c=>c.k===k)); }catch(e){}
  let q = '', filter = 'all', supFilter = '', sortK = 'name', sortDir = 1;
  let staleDays = 30; try{ staleDays = parseInt(localStorage.getItem('dk_pt_stale')) || 30; }catch(e){}
  const isStale = p=>{ if(!(Dec.parse(eff(p,'costPrice')) || Dec.parse(eff(p,'sellPrice')))) return false; const a = ptLastPriceAt(p); return !a || (Date.now() - new Date(a).getTime()) > staleDays*864e5; };
  const pending = new Map();           // productId -> {field: newValue}
  const last = new Map(), lastMk = new Map();              // productId -> 'markup' | 'sell' : which of the two was typed last
  const sel = new Set();
  const logStore = await getOne('sharedSettings','tableLog');

  /* ---- values as they are now (saved value, or the pending change on top of it) ---- */
  const eff = (p,f)=> (pending.get(p.id) && f in pending.get(p.id)) ? pending.get(p.id)[f] : p[f];
  const isChanged = (p,f)=> !!(pending.get(p.id) && f in pending.get(p.id));
  const same = (a,b)=> (typeof a==='object' || typeof b==='object') ? ptEq(a,b) : String(a==null?'':a)===String(b==null?'':b);
  function setPending(p, f, v){
    let m = pending.get(p.id);
    if(same(p[f], v)){ if(m){ delete m[f]; if(!Object.keys(m).length) pending.delete(p.id); } return; }
    if(!m){ m = {}; pending.set(p.id, m); }
    m[f] = v;
  }
  const markupOf = p=> Dec.markupText(eff(p,'costPrice'), eff(p,'sellPrice'));
  const decOk = t=> t==='' || !!Dec.parse(t);
  const flags = p=>{
    if(!seesBothPrices()) return [];
    const c = Dec.parse(eff(p,'costPrice')), s = Dec.parse(eff(p,'sellPrice')), out = [];
    if(!c && !s) out.push('No price yet'); else if(!c) out.push('No cost price'); else if(!s) out.push('No sell price');
    if(c && s && Dec.cmp(s,c)<0) out.push('Sell price is below cost');
    if((c && Dec.cmp(c,Dec.ZERO)===0) || (s && Dec.cmp(s,Dec.ZERO)===0)) out.push('A price is 0');
    return out;
  };
  const stockP = p=>({stockQty:eff(p,'stockQty'), lowStockLimit:eff(p,'lowStockLimit')});

  /* ---- which rows are shown, in what order ---- */
  function rows(){
    const nq = normalize(q);
    let list = products.filter(p=>{
      if(p.active===false && !isChanged(p,'active') && filter!=='inactive') return false;
      if(filter==='inactive' && eff(p,'active')!==false) return false;
      if(nq && !normalize(p.name).includes(nq)) return false;
      if(supFilter && eff(p,'supplierId')!==supFilter) return false;
      if(filter==='noprice'){ if(seesBothPrices()){ const f = flags(p); if(!f.some(x=>/No (cost|sell )?price/.test(x))) return false; } else if((seesSell() && Dec.parse(eff(p,'sellPrice'))) || (seesCost() && Dec.parse(eff(p,'costPrice')))) return false; }
      else if(filter==='hasprice'){ if(!((!seesCost() || Dec.parse(eff(p,'costPrice'))) && (!seesSell() || Dec.parse(eff(p,'sellPrice'))))) return false; }
      else if(filter==='below'){ if(!flags(p).some(x=>/below cost/.test(x))) return false; }
      else if(filter==='stale'){ if(!isStale(p)) return false; }
      else if(filter==='low'){ if(!isLowStock(stockP(p))) return false; }
      else if(filter==='nostock'){ if(isStockTracked(stockP(p))) return false; }
      else if(filter==='perorder'){ if(!isPerOrderProduct(p, whMap)) return false; }
      else if(filter==='changed'){ if(!pending.has(p.id)) return false; }
      return true;
    });
    const val = p=>{
      switch(sortK){
        case 'name': return normalize(p.name);
        case 'cost': { const d = Dec.parse(eff(p,'costPrice')); return d ? Number(d.n)/10**d.s : null; }
        case 'sell': { const d = Dec.parse(eff(p,'sellPrice')); return d ? Number(d.n)/10**d.s : null; }
        case 'markup': { const t = parseFloat(markupOf(p)); return isNaN(t) ? null : t; }
        case 'stock': { const t = parseFloat(eff(p,'stockQty')); return isNaN(t) ? null : t; }
        case 'limit': { const t = parseFloat(eff(p,'lowStockLimit')); return isNaN(t) ? null : t; }
        case 'pack': { const t = parseFloat(eff(p,'packSize')); return isNaN(t) ? null : t; }
        case 'updated': return ptLastPriceAt(p) || null;
        case 'unit': return normalize(p.unit||'');
        case 'supplier': return normalize((supById.get(eff(p,'supplierId'))||{}).name||'');
        default: return normalize(p.name);
      }
    };
    const keyed = list.map(p=>({p, k:val(p), n:normalize(p.name)}));      // work out each sort key once, not on every comparison
    keyed.sort((a,b)=>{ const x = a.k, y = b.k; if(x===y) return a.n<b.n ? -1 : a.n>b.n ? 1 : 0; if(x===null) return 1; if(y===null) return -1; return (x<y?-1:1)*sortDir; });
    return keyed.map(o=>o.p);
  }

  /* ---- drawing ---- */
  const inp = (p,f,kind,extra)=>{
    const ch = isChanged(p,f);
    return `<input class="pt-in ${ch?'chg':''}" data-p="${p.id}" data-f="${f}" data-kind="${kind}" inputmode="decimal" value="${esc(eff(p,f)??'')}" ${extra||''}>`;
  };
  function cellHtml(p, c){
    switch(c.k){
      case 'unit': return `<td class="pt-ro">${esc(p.unit||'')}</td>`;
      case 'supplier': return `<td><select class="pt-in pt-sel ${isChanged(p,'supplierId')?'chg':''}" data-p="${p.id}" data-f="supplierId" data-kind="select"><option value="">—</option>${suppliers.map(s=>`<option value="${s.id}" ${s.id===eff(p,'supplierId')?'selected':''}>${esc(s.name)}</option>`).join('')}</select></td>`;
      case 'cost': return `<td>${inp(p,'costPrice','dec','placeholder="—"')}</td>`;
      case 'sell': return `<td>${inp(p,'sellPrice','dec','placeholder="—"')}</td>`;
      case 'markup': return `<td><input class="pt-in ${(isChanged(p,'costPrice')||isChanged(p,'sellPrice'))?'chg':''}" data-p="${p.id}" data-f="__markup" data-kind="markup" inputmode="decimal" placeholder="—" value="${esc(markupOf(p))}"></td>`;
      case 'ref': { const r = eff(p,'priceRef') || {qty:'', unit:''}; const ch = isChanged(p,'priceRef');
        return `<td style="white-space:nowrap;"><input class="pt-in pt-ref ${ch?'chg':''}" style="width:64px;" data-p="${p.id}" data-f="priceRef" data-part="qty" data-kind="ref" inputmode="decimal" placeholder="—" value="${esc(r.qty)}"> <select class="pt-in pt-sel ${ch?'chg':''}" style="width:68px;" data-p="${p.id}" data-f="priceRef" data-part="unit" data-kind="ref">${['','ml','l','g','kg'].map(u=>`<option value="${u}" ${r.unit===u?'selected':''}>${u||'—'}</option>`).join('')}</select></td>`; }
      case 'updated': { const a = ptLastPriceAt(p), has = Dec.parse(eff(p,'costPrice')) || Dec.parse(eff(p,'sellPrice')); return `<td class="pt-ro">${a ? esc(fmtDate(a.slice(0,10))) : (has ? 'no record' : '')}</td>`; }
      case 'perunit': return `<td class="pt-ro" data-pu="${p.id}">${esc(ptPerUnit(eff(p,'sellPrice'), eff(p,'priceRef')))}</td>`;
      case 'stock': return p.trackBatches ? `<td class="pt-ro" title="This product's stock comes from its batches">🔒 ${esc(p.stockQty??'')}</td>` : `<td>${inp(p,'stockQty','qty','placeholder="not tracked"')}</td>`;
      case 'limit': return `<td>${inp(p,'lowStockLimit','qty','placeholder="—"')}</td>`;
      case 'pack': return `<td>${inp(p,'packSize','pack','placeholder="—"')}</td>`;
      case 'expiry': return `<td class="pt-ro">${p.expiryDate ? esc(fmtDate(p.expiryDate)) : ''}</td>`;
      case 'perorder': return `<td class="pt-ro">${isPerOrderProduct(p, whMap) ? 'Yes' : '—'}</td>`;
      case 'active': return `<td style="text-align:center;"><input type="checkbox" class="pt-chk" data-p="${p.id}" data-f="active" data-kind="bool" ${eff(p,'active')!==false?'checked':''}></td>`;
    }
    return '<td></td>';
  }
  const cols = ()=>PT_COLS.filter(c=>visible.includes(c.k) && ptColOk(c));
  function rowHtml(p){
    const fl = flags(p);
    return `<tr data-row="${p.id}" class="${fl.length?'pt-warn':''} ${eff(p,'active')===false?'pt-off':''}">
      <td class="pt-name"><div class="pt-nm"><label><input type="checkbox" class="pt-sel-r" data-sel="${p.id}" ${sel.has(p.id)?'checked':''}><span>${esc(p.name)}${fl.length?` <span class="pt-flag" title="${esc(fl.join(' · '))}">${ico('triangle-alert')}</span>`:''}</span></label>${can('prices.view') && (p.priceHistory||[]).length ? `<button class="pt-hbtn" data-hist="${p.id}" title="Price history" aria-label="Price history">${ico('history')}</button>` : ''}</div></td>
      ${cols().map(c=>cellHtml(p,c)).join('')}</tr>`;
  }
  const sortable = new Set(['updated','unit','supplier','cost','markup','sell','stock','limit','pack']);
  function tableHtml(list){
    if(!list.length) return `<div class="empty"><div class="ic">${ico('table-2')}</div>No products match.</div>`;
    return `<table class="pt"><thead><tr><th class="pt-name"><button data-sort="name">Product ${sortK==='name'?ico(sortDir>0?'chevron-up':'chevron-down'):''}</button></th>
      ${cols().map(c=>`<th>${sortable.has(c.k)?`<button data-sort="${c.k}">${c.label} ${sortK===c.k?ico(sortDir>0?'chevron-up':'chevron-down'):''}</button>`:c.label}</th>`).join('')}</tr></thead>
      <tbody>${list.map(rowHtml).join('')}</tbody></table>`;
  }
  const FILTERS = [['all','All']].concat(can('prices.view') ? [['hasprice','Has price'],['noprice','No price']] : []).concat(seesBothPrices() ? [['below','Below cost'],['stale','Not updated lately']] : []).concat([['low','Low stock'],['nostock','No stock count'],['perorder','Bought per order'],['inactive','Inactive'],['changed','Changed']]);
  $('#main').innerHTML = `
    <div class="topbar"><h1>Product Table</h1>
      <div class="tb-actions">${can('prices.edit') ? '<button class="btn btn-ghost" id="pt_import">⬆ Import prices</button>' : ''}<button class="btn btn-ghost" id="pt_cols">▥ Columns</button><button class="btn btn-ghost" id="pt_export">⬇ Export</button>${seesBothPrices() ? '<button class="btn btn-ghost" id="pt_hist">🕘 History</button>' : ''}</div></div>
    <p class="subtle" style="margin-top:-8px;">Every product's facts in one table. Type in a cell and press <b>Enter</b> to go to the next row. Changes are highlighted and only saved when you tap <b>Save</b>. Prices are kept exactly as typed.</p>
    <div class="pt-tools"><input type="search" id="pt_q" placeholder="Search products…" autocomplete="off">
      <select id="pt_sup"><option value="">All suppliers</option>${suppliers.map(s=>`<option value="${s.id}">${esc(s.name)}</option>`).join('')}</select></div>
    <div class="tag-row" id="pt_filters"></div>
    <div class="subtle" id="pt_stalenote" hidden style="margin:4px 0;">Products whose price hasn't changed in <select id="pt_stale" style="width:auto; display:inline-block; padding:4px 8px;">${[7,14,30,60,90].map(d=>`<option value="${d}" ${d===staleDays?'selected':''}>${d}</option>`).join('')}</select> days (or has no recorded change).</div>
    <div class="pt-count subtle" id="pt_count"></div>
    <div class="pt-wrap" id="pt_wrap" data-noicon></div>
    <div class="mg-bar pt-bulk" id="pt_bulk" hidden></div>
    <div class="mg-bar pt-save" id="pt_save" hidden></div>`;

  function counts(){ const c = {}; for(const [k] of FILTERS) c[k] = 0; products.forEach(p=>{ c.all++; if(p.active===false) c.inactive++; const fl = flags(p); if(fl.some(x=>/No (cost|sell )?price/.test(x))) c.noprice++; if(Dec.parse(eff(p,'costPrice')) && Dec.parse(eff(p,'sellPrice'))) c.hasprice++; if(fl.some(x=>/below cost/.test(x))) c.below++; if(can('prices.view') && isStale(p)) c.stale++; if(isLowStock(stockP(p))) c.low++; if(!isStockTracked(stockP(p))) c.nostock++; if(isPerOrderProduct(p, whMap)) c.perorder++; if(pending.has(p.id)) c.changed++; }); c.all = products.filter(p=>p.active!==false).length; return c; }
  let cTimer = null, cDirty = true;
  function drawFilters(now){ if(!now && !cDirty){ return; } if(!now){ clearTimeout(cTimer); cTimer = setTimeout(()=>drawFilters(true), 150); return; } cDirty = false; const c = counts(); setHtml($('#pt_filters'), FILTERS.map(([k,l])=>`<button class="chip ${filter===k?'active':''}" data-f="${k}">${l}${k==='all'?'':` (${c[k]})`}</button>`).join('')); }
  let lastFilterDrawn = null;
  const setHtml = (el, h)=>{ if(el.__h!==h){ el.innerHTML = h; el.__h = h; } };   // same content: leave the buttons alone, or a tap that blurs a cell could miss them
  function drawBars(){
    const n = pending.size, fields = [...pending.values()].reduce((a,m)=>a+Object.keys(m).length, 0);
    const bar = $('#pt_save'); bar.hidden = !n;
    setHtml(bar, n ? `<span>${fields} change${fields===1?'':'s'} in ${n} product${n===1?'':'s'}</span><button class="btn btn-ghost btn-sm" id="pt_discard">Discard</button><button class="btn btn-signal" id="pt_do_save">Save</button>` : '');
    const canB = {markup:can('prices.edit')&&can('prices.view'), supplier:can('products.edit'), limit:can('stock.edit')};
    const bulk = $('#pt_bulk'); bulk.hidden = !sel.size;
    setHtml(bulk, sel.size ? `<span>${sel.size} selected</span>${canB.markup?'<button class="btn btn-ghost btn-sm" data-bulk="markup">Set markup %</button>':''}${canB.supplier?'<button class="btn btn-ghost btn-sm" data-bulk="supplier">Set supplier</button>':''}${canB.limit?'<button class="btn btn-ghost btn-sm" data-bulk="limit">Set low-stock limit</button>':''}<button class="btn btn-ghost btn-sm" data-bulk="clear">Clear</button>` : '');
    document.body.classList.toggle('pt-two-bars', !!n && !!sel.size);
    cDirty = true; drawFilters(filter!==lastFilterDrawn); lastFilterDrawn = filter;
    const sn = $('#pt_stalenote'); if(sn) sn.hidden = filter!=='stale';
  }
  /* Only the first rows are drawn; more are added as you scroll (1,300 rows of editable cells is what made the page slow). */
  const CHUNK = 80; let curList = [], shown = CHUNK;
  const lockCells = root=>root.querySelectorAll('.pt-in, .pt-chk').forEach(el=>{ if(!ptCanEdit(el.dataset.f)) el.disabled = true; });
  const countText = ()=>{ $('#pt_count').textContent = `${Math.min(shown, curList.length) < curList.length ? 'Showing '+Math.min(shown, curList.length)+' of ' : ''}${curList.length} product${curList.length===1?'':'s'}${curList.length!==products.length?` (of ${products.length})`:''}`; };
  function showMore(){
    if(shown >= curList.length) return false;
    const tb = $('#pt_wrap tbody'); if(!tb) return false;
    const from = shown; shown += CHUNK;
    tb.insertAdjacentHTML('beforeend', curList.slice(from, shown).map(rowHtml).join(''));
    lockCells(tb); countText(); return true;
  }
  function draw(keepScroll, reset){
    const w = $('#pt_wrap'), st = keepScroll ? [w.scrollLeft, w.scrollTop] : null;
    curList = rows(); if(reset!==false && !keepScroll) shown = CHUNK;
    if(keepScroll) shown = Math.max(shown, CHUNK);
    w.innerHTML = tableHtml(curList.slice(0, shown)); lockCells(w); countText();
    if(st){ w.scrollLeft = st[0]; w.scrollTop = st[1]; } else { w.scrollTop = 0; }
    drawBars();
  }
  draw();
  $('#pt_wrap').addEventListener('scroll', ()=>{ const w = $('#pt_wrap'); if(w.scrollHeight - w.scrollTop - w.clientHeight < 600) showMore(); }, {passive:true});

  /* ---- editing ---- */
  const wrap = $('#pt_wrap');
  const rowEl = pid=> wrap.querySelector(`tr[data-row="${pid}"]`);
  function refreshRow(p){            // update the cells of one row without losing the cursor
    const tr = rowEl(p.id); if(!tr) return;
    const set = (f, v)=>{ const el = tr.querySelector(`[data-f="${f}"]`); if(el && el!==document.activeElement) el.value = v; };
    set('costPrice', eff(p,'costPrice')??''); set('sellPrice', eff(p,'sellPrice')??''); set('__markup', markupOf(p));
    tr.querySelectorAll('.pt-in[data-f]').forEach(el=>{ const f = el.dataset.f; el.classList.toggle('chg', f==='__markup' ? (isChanged(p,'costPrice')||isChanged(p,'sellPrice')) : isChanged(p,f)); });
    const pu = tr.querySelector('[data-pu]'); if(pu) pu.textContent = ptPerUnit(eff(p,'sellPrice'), eff(p,'priceRef'));
    const fl = flags(p); tr.classList.toggle('pt-warn', !!fl.length);
    const nm = tr.querySelector('.pt-name label span'); if(nm) nm.innerHTML = esc(p.name) + (fl.length ? ` <span class="pt-flag" title="${esc(fl.join(' · '))}">${ico('triangle-alert')}</span>` : '');
  }
  wrap.addEventListener('input', e=>{
    const el = e.target.closest('.pt-in'); if(!el || el.tagName==='SELECT') return;
    const p = prodById.get(el.dataset.p), f = el.dataset.f, kind = el.dataset.kind, t = el.value.trim();
    let ok = true;
    if(kind==='dec'){
      ok = decOk(t); el.classList.toggle('bad', !ok);
      if(ok){
        const norm = t==='' ? '' : Dec.str(Dec.parse(t));
        // like the product form: a changed cost keeps whichever of markup / sell was typed last
        if(f==='costPrice' && last.get(p.id)==='markup' && lastMk.get(p.id) && norm){ const mk = lastMk.get(p.id); const sv = Dec.sellFromMarkup(norm, mk); setPending(p,'costPrice',norm); if(sv!==null) setPending(p,'sellPrice',sv); }
        else { setPending(p, f, norm); if(f==='sellPrice') last.set(p.id,'sell'); }
      }
    } else if(kind==='markup'){
      ok = decOk(t); el.classList.toggle('bad', !ok);
      if(ok && t!==''){ last.set(p.id,'markup'); lastMk.set(p.id,t); const sv = Dec.sellFromMarkup(eff(p,'costPrice'), t); if(sv!==null) setPending(p,'sellPrice',sv); }
    } else if(kind==='ref'){
      const tr = rowEl(p.id), qEl = tr.querySelector('[data-part=qty]'), uEl = tr.querySelector('[data-part=unit]');
      const qt = qEl.value.trim().replace(/,/g,''); ok = qt==='' || (!!Dec.parse(qt) && Dec.cmp(Dec.parse(qt), Dec.ZERO)>0 && /^\d*\.?\d+$/.test(qt));
      qEl.classList.toggle('bad', !ok);
      if(ok){ setPending(p,'priceRef', qt==='' ? null : {qty:Dec.str(Dec.parse(qt)), unit:uEl.value}); }
    } else if(kind==='qty' || kind==='pack'){
      ok = t==='' || (/^\d*\.?\d+$/.test(t.replace(/,/g,'')) && (kind!=='pack' || parseFloat(t)>0)); el.classList.toggle('bad', !ok);
      if(ok) setPending(p, f, t==='' ? '' : parseFloat(t.replace(/,/g,'')));
    }
    if(ok){
      if(kind==='markup'){ const tr = rowEl(p.id); const s = tr.querySelector('[data-f="sellPrice"]'); if(s) s.value = eff(p,'sellPrice')??''; }
      refreshRow(p); if(kind==='markup') { /* keep what was typed in the markup cell */ }
      drawBars();
    }
  });
  wrap.addEventListener('change', e=>{
    const el = e.target;
    if(el.matches('.pt-sel-r')){ el.checked ? sel.add(el.dataset.sel) : sel.delete(el.dataset.sel); drawBars(); return; }
    if(!el.matches('.pt-in[data-f], .pt-chk')) return;
    const p = prodById.get(el.dataset.p), f = el.dataset.f;
    if(el.dataset.kind==='ref'){
      const tr = rowEl(p.id), qt = tr.querySelector('[data-part=qty]').value.trim().replace(/,/g,'');
      if(qt!=='' && Dec.parse(qt) && /^\d*\.?\d+$/.test(qt)) setPending(p,'priceRef',{qty:Dec.str(Dec.parse(qt)), unit:tr.querySelector('[data-part=unit]').value});
      tr.querySelectorAll('[data-f=priceRef]').forEach(x=>x.classList.toggle('chg', isChanged(p,'priceRef'))); refreshRow(p);
    }
    else if(el.dataset.kind==='select'){ setPending(p, f, el.value); el.classList.toggle('chg', isChanged(p,f)); }
    else if(el.dataset.kind==='bool'){ setPending(p, f, el.checked); }
    drawBars();
  });
  wrap.addEventListener('keydown', e=>{
    const el = e.target.closest('.pt-in'); if(!el || e.key!=='Enter') return; e.preventDefault();
    const all = [...wrap.querySelectorAll(`.pt-in[data-f="${el.dataset.f}"]${el.dataset.part?`[data-part="${el.dataset.part}"]`:''}`)], i = all.indexOf(el), nx = all[i + (e.shiftKey ? -1 : 1)];
    let n2 = nx; if(!n2 && !e.shiftKey && showMore()){ const all2 = [...wrap.querySelectorAll(`.pt-in[data-f="${el.dataset.f}"]${el.dataset.part?`[data-part="${el.dataset.part}"]`:''}`)]; n2 = all2[all2.indexOf(el)+1]; }
    if(n2){ n2.focus(); if(n2.select) n2.select(); n2.scrollIntoView({block:'nearest'}); }
  });
  wrap.addEventListener('focusin', e=>{ const el = e.target; if(el.matches && el.matches('input.pt-in')) setTimeout(()=>{ try{ el.select(); }catch(_){} }, 0); });
  wrap.addEventListener('click', e=>{
    const hb = e.target.closest('[data-hist]'); if(hb){ ptHistoryModal(prodById.get(hb.dataset.hist), supById); return; }
    const b = e.target.closest('[data-sort]'); if(!b) return;
    const k = b.dataset.sort; if(sortK===k) sortDir = -sortDir; else { sortK = k; sortDir = 1; } draw(true);
  });
  let qTimer = null; $('#pt_q').oninput = e=>{ q = e.target.value; clearTimeout(qTimer); qTimer = setTimeout(()=>draw(), 180); };
  $('#pt_stale').onchange = e=>{ staleDays = parseInt(e.target.value)||30; try{ localStorage.setItem('dk_pt_stale', String(staleDays)); }catch(_){} draw(true); };
  $('#pt_sup').onchange = e=>{ supFilter = e.target.value; draw(); };
  $('#pt_filters').onclick = e=>{ const b = e.target.closest('[data-f]'); if(!b) return; filter = b.dataset.f; draw(); };
  const imp = $('#pt_import'); if(imp) imp.onclick = ()=>{ const go = ()=>{ location.hash = '#/prices'; }; pending.size ? showConfirm('You have unsaved changes in this table. Leave without saving them?', go, {yesLabel:'Leave'}) : go(); };
  $('#pt_cols').onclick = ()=>{
    showModal(`<h3>Columns</h3><div class="subtle" style="margin-bottom:8px;">Product name is always shown.</div>
      ${PT_COLS.filter(ptColOk).map(c=>`<label class="lk-sw"><input type="checkbox" data-col="${c.k}" ${visible.includes(c.k)?'checked':''}><span>${c.label}</span></label>`).join('')}
      <div style="display:flex; gap:8px; flex-wrap:wrap; margin-top:12px;"><button class="btn btn-ghost btn-sm" id="pt_c_def">Standard</button><button class="btn btn-ghost btn-sm" id="pt_c_cmp">Compact (phone)</button><button class="btn btn-ghost btn-sm" id="pt_c_all">All</button><span style="flex:1"></span><button class="btn btn-signal" onclick="closeModal()">Done</button></div>`);
    const apply = ()=>{ try{ localStorage.setItem('dk_pt_cols', JSON.stringify(visible)); }catch(e){} draw(true); };
    const sync = ()=>document.querySelectorAll('[data-col]').forEach(c=>c.checked = visible.includes(c.dataset.col));
    document.querySelectorAll('[data-col]').forEach(c=>c.onchange = ()=>{ visible = PT_COLS.filter(x=>x.k===c.dataset.col ? c.checked : visible.includes(x.k)).map(x=>x.k); apply(); });
    $('#pt_c_def').onclick = ()=>{ visible = PT_DEFAULT.slice(); sync(); apply(); };
    $('#pt_c_cmp').onclick = ()=>{ visible = PT_COMPACT.slice(); sync(); apply(); };
    $('#pt_c_all').onclick = ()=>{ visible = PT_COLS.map(c=>c.k); sync(); apply(); };
  };

  /* ---- bulk actions on the ticked rows ---- */
  $('#pt_bulk').onclick = e=>{
    const b = e.target.closest('[data-bulk]'); if(!b) return;
    const picked = [...sel].map(id=>prodById.get(id)).filter(Boolean), kind = b.dataset.bulk;
    if(kind==='clear'){ sel.clear(); draw(true); return; }
    if(kind==='markup'){
      showModal(`<h3>Set markup % on ${picked.length} product${picked.length===1?'':'s'}</h3><p class="subtle">Sell price = cost + this percentage, worked out exactly (nothing rounded). Products without a cost price are skipped.</p>
        <div class="field"><label>Markup %</label><input type="text" inputmode="decimal" id="pt_b_val" placeholder="e.g. 5"></div>
        <div style="display:flex; gap:10px;"><button class="btn btn-signal" id="pt_b_go" style="flex:1;">Apply</button><button class="btn btn-ghost" onclick="closeModal()">Cancel</button></div>`);
      $('#pt_b_go').onclick = ()=>{
        const m = $('#pt_b_val').value.trim(); if(!Dec.parse(m)){ showAlert('Type the markup as a plain number, like 5 or 7.5.'); return; }
        let done = 0, skipped = 0;
        picked.forEach(p=>{ const sv = Dec.sellFromMarkup(eff(p,'costPrice'), m); if(sv===null){ skipped++; return; } setPending(p,'sellPrice',sv); last.set(p.id,'markup'); lastMk.set(p.id,m); done++; });
        closeModal(); draw(true); if(skipped) showAlert(`${done} updated. ${skipped} skipped because they have no cost price.`, 'Markup applied');
      };
    } else if(kind==='supplier'){
      showModal(`<h3>Set supplier on ${picked.length} product${picked.length===1?'':'s'}</h3>
        <div class="field"><label>Supplier</label><select id="pt_b_val"><option value="">— none —</option>${suppliers.map(s=>`<option value="${s.id}">${esc(s.name)}</option>`).join('')}</select></div>
        <div style="display:flex; gap:10px;"><button class="btn btn-signal" id="pt_b_go" style="flex:1;">Apply</button><button class="btn btn-ghost" onclick="closeModal()">Cancel</button></div>`);
      $('#pt_b_go').onclick = ()=>{ const v = $('#pt_b_val').value; picked.forEach(p=>setPending(p,'supplierId',v)); closeModal(); draw(true); };
    } else if(kind==='limit'){
      showModal(`<h3>Set low-stock limit on ${picked.length} product${picked.length===1?'':'s'}</h3>
        <div class="field"><label>Low-stock limit</label><input type="text" inputmode="decimal" id="pt_b_val" placeholder="e.g. 5"></div>
        <div style="display:flex; gap:10px;"><button class="btn btn-signal" id="pt_b_go" style="flex:1;">Apply</button><button class="btn btn-ghost" onclick="closeModal()">Cancel</button></div>`);
      $('#pt_b_go').onclick = ()=>{ const t = $('#pt_b_val').value.trim(); if(t!=='' && !/^\d*\.?\d+$/.test(t)){ showAlert('Type a plain number, or leave it empty.'); return; } picked.forEach(p=>setPending(p,'lowStockLimit', t===''?'':parseFloat(t))); closeModal(); draw(true); };
    }
  };

  /* ---- saving, history, undo ---- */
  $('#pt_save').onclick = async e=>{
    if(e.target.closest('#pt_discard')){ showConfirm('Discard all unsaved changes?', ()=>{ pending.clear(); last.clear(); draw(true); }, {yesLabel:'Discard'}); return; }
    if(!e.target.closest('#pt_do_save')) return;
    if(wrap.querySelector('.pt-in.bad')){ showAlert('Some cells hold something that is not a valid number (marked red). Fix or clear them first.'); return; }
    for(const [pid,ch] of pending){ if(ch.priceRef && !ch.priceRef.unit){ showAlert(`Pick a unit (ml, l, g or kg) for “Prices are for” on ${prodById.get(pid).name}, or clear the quantity.`); return; } }
    const btn = $('#pt_do_save'); btn.disabled = true; btn.textContent = 'Saving…';
    try{
      const entry = {id:'pt-'+Date.now(), at:new Date().toISOString(), by:ptWho(), items:[], undone:false};
      for(const [pid, ch] of pending){
        const p = await getOne('products', pid); if(!p) continue;
        const rec = {id:pid, name:p.name, changes:{}};
        for(const [f,v] of Object.entries(ch)){ rec.changes[f] = [p[f] ?? '', v]; p[f] = v; }
        if('costPrice' in ch || 'sellPrice' in ch) p.priceHistory = [...(p.priceHistory||[]), {at:entry.at, cost:p.costPrice||'', sell:p.sellPrice||'', from:'product table'}].slice(-50);
        await put('products', p); prodById.set(pid, p);
        const i = products.findIndex(x=>x.id===pid); if(i>=0) products[i] = p;
        entry.items.push(rec);
      }
      const store = await getOne('sharedSettings','tableLog') || {id:'tableLog', entries:[]};
      store.entries = [entry, ...store.entries].slice(0, 100); await put('sharedSettings', store);
      pending.clear(); last.clear(); draw(true);
      showAlert(`${entry.items.length} product${entry.items.length===1?'':'s'} updated. You can undo this from History.`, 'Saved');
    }catch(err){ showAlert('Saving did not finish: '+(err.message||err)); btn.disabled = false; btn.textContent = 'Save'; }
  };
  const fmtVal = (f,v)=> f==='priceRef' ? (ptRefText(v)||'—') : f==='supplierId' ? ((supById.get(v)||{}).name || '—') : f==='active' ? (v===false?'off':'on') : (v===''||v==null ? '—' : v);
  const hb0 = $('#pt_hist'); if(hb0) hb0.onclick = async ()=>{
    const store = await getOne('sharedSettings','tableLog'), entries = (store && store.entries || []).slice(0, 25);
    showModal(`<h3>Recent changes</h3><div style="max-height:60vh; overflow:auto;">${entries.length ? entries.map(en=>`<div class="pt-h ${en.undone?'undone':''}">
      <div style="display:flex; gap:8px; align-items:center;"><b style="flex:1;">${fmtDate(en.at.slice(0,10))} · ${esc(en.by||'')} · ${en.items.length} product${en.items.length===1?'':'s'}${en.undone?' <span class="subtle">(undone)</span>':''}</b>${en.undone?'':`<button class="btn btn-ghost btn-sm" data-pt-undo="${en.id}">Undo</button>`}</div>
      <details><summary class="subtle">Show details</summary>${en.items.map(it=>`<div class="subtle"><b>${esc(it.name)}</b>: ${Object.entries(it.changes).map(([f,[o,n]])=>`${PT_FIELD_LABEL[f]||f} ${esc(fmtVal(f,o))} → ${esc(fmtVal(f,n))}`).join(' · ')}</div>`).join('')}</details></div>`).join('') : '<p class="subtle">Nothing saved from this table yet.</p>'}</div>
      <button class="btn btn-signal" style="margin-top:12px;" onclick="closeModal()">Close</button>`);
    document.querySelectorAll('[data-pt-undo]').forEach(b=>b.onclick = ()=>showConfirm('Undo this save? Each value goes back unless it was changed again afterwards.', async ()=>{
      const r = await ptUndo(b.dataset.ptUndo); closeModal();
      for(const it of r.restored){ const p = await getOne('products', it); if(p){ prodById.set(it,p); const i = products.findIndex(x=>x.id===it); if(i>=0) products[i]=p; } }
      draw(true); showAlert(`${r.n} value${r.n===1?'':'s'} restored${r.skipped?`, ${r.skipped} left as they are because they were changed again later`:''}.`, 'Undone');
    }, {yesLabel:'Undo'}));
  };

  /* ---- export what is shown ---- */
  $('#pt_export').onclick = async ()=>{
    const list = rows(), cs = cols();
    const wb = new ExcelJS.Workbook(); wb.creator = 'Dockline'; const ws = wb.addWorksheet('Products');
    ws.columns = [{header:'Product', width:48}].concat(cs.map(c=>({header:c.label, width:c.kind==='dec'||c.kind==='markup' ? 14 : 16})));
    ws.getRow(1).font = {bold:true}; ws.views = [{state:'frozen', ySplit:1, xSplit:1}];
    for(const p of list){
      const vals = cs.map(c=>{
        switch(c.k){
          case 'unit': return p.unit||''; case 'supplier': return (supById.get(eff(p,'supplierId'))||{}).name || '';
          case 'cost': { const d = Dec.parse(eff(p,'costPrice')); return d ? Number(Dec.str(d)) : ''; }
          case 'sell': { const d = Dec.parse(eff(p,'sellPrice')); return d ? Number(Dec.str(d)) : ''; }
          case 'markup': return markupOf(p); case 'stock': return eff(p,'stockQty')===''||eff(p,'stockQty')==null ? '' : Number(eff(p,'stockQty'));
          case 'limit': return eff(p,'lowStockLimit')===''||eff(p,'lowStockLimit')==null ? '' : Number(eff(p,'lowStockLimit'));
          case 'pack': return eff(p,'packSize')===''||eff(p,'packSize')==null ? '' : Number(eff(p,'packSize'));
          case 'expiry': return p.expiryDate||''; case 'perorder': return isPerOrderProduct(p, whMap) ? 'Yes' : '';
          case 'updated': return ptLastPriceAt(p) ? ptLastPriceAt(p).slice(0,10) : ''; case 'ref': return ptRefText(eff(p,'priceRef')); case 'perunit': return ptPerUnit(eff(p,'sellPrice'), eff(p,'priceRef'));
          case 'active': return eff(p,'active')===false ? 'No' : 'Yes';
        }
        return '';
      });
      const row = ws.addRow([p.name].concat(vals));
      cs.forEach((c,i)=>{ if(c.kind==='dec') row.getCell(i+2).numFmt = '#,##0.00########'; });
    }
    const buf = await wb.xlsx.writeBuffer();
    await saveFile(`products-${new Date().toISOString().slice(0,10)}.xlsx`, new Blob([buf], {type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}));
  };
  /* leaving with unsaved changes is easy to do by accident */
  if(ptBeforeUnload) window.removeEventListener('beforeunload', ptBeforeUnload);
  window.addEventListener('beforeunload', ptBeforeUnload = e=>{ if(pending.size){ e.preventDefault(); e.returnValue = ''; } });
});
let ptBeforeUnload = null;

/* put a save back: each value returns only if it still holds what that save wrote */
async function ptUndo(entryId){
  const store = await getOne('sharedSettings','tableLog'); const en = store && store.entries.find(e=>e.id===entryId);
  const res = {n:0, skipped:0, restored:[]};
  if(!en || en.undone) return res;
  for(const it of en.items){
    const p = await getOne('products', it.id); if(!p) continue;
    let touched = false;
    for(const [f,[oldV,newV]] of Object.entries(it.changes)){
      if(ptEq(p[f], newV)){ p[f] = (f==='priceRef' && !oldV) ? null : oldV; res.n++; touched = true; } else res.skipped++;
    }
    if(touched){ if('costPrice' in it.changes || 'sellPrice' in it.changes) p.priceHistory = (p.priceHistory||[]).filter(h=>!(h.from==='product table' && h.at===en.at));
      await put('products', p); res.restored.push(it.id); }
  }
  en.undone = true; await put('sharedSettings', store);
  return res;
}

/* a product's price history, newest first: every saved cost/sell price with when, and where the change came from */
function ptHistoryModal(p, supById){
  if(!p) return;
  const f = v=>{ const d = Dec.parse(v); return d ? Dec.fmt(d, 2) : '—'; };
  const arrow = (o,n)=>{ const a = Dec.parse(o), b = Dec.parse(n); if(!a || !b) return ''; const c = Dec.cmp(b,a); return c>0 ? ' <span class="pt-up">▲</span>' : c<0 ? ' <span class="pt-down">▼</span>' : ''; };
  const h = p.priceHistory || [];
  const rows = h.map((e,i)=>{ const prev = h[i-1]; return `<tr><td>${esc(fmtDate(e.at.slice(0,10)))}<div class="subtle">${esc(new Date(e.at).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'}))}</div></td>
      <td>${f(e.cost)}${prev?arrow(prev.cost, e.cost):''}</td><td>${f(e.sell)}${prev?arrow(prev.sell, e.sell):''}</td>
      <td class="subtle">${esc(PT_SOURCE(e.from))}${e.ref?` · per ${esc(e.ref.qty)} ${esc(e.ref.unit)}`:''}</td></tr>`; }).reverse().join('');
  showModal(`<h3>Price history</h3><p class="subtle" style="margin-top:-6px;">${esc(p.name)} · now ${f(p.costPrice)} cost / ${f(p.sellPrice)} sell</p>
    <div style="max-height:56vh; overflow:auto;"><table class="pt-hist"><thead><tr><th>When</th><th>Cost</th><th>Sell</th><th>Source</th></tr></thead><tbody>${rows || '<tr><td colspan="4" class="subtle">No changes recorded yet.</td></tr>'}</tbody></table></div>
    <button class="btn btn-signal" style="margin-top:12px;" onclick="closeModal()">Close</button>`);
}
