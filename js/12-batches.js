/* ============================ BATCH / LOT TRACKING ============================
   A product with "Track batches" on keeps its stock as a set of batches, each with its own remaining
   quantity, batch no., production and expiry date. The product's `stockQty` stays the TOTAL everywhere in
   the app; batches are the breakdown of that total. Whenever stock changes by a path that doesn't know
   about batches (manual edit, correction) the breakdown is reconciled: extra stock goes to an "Opening
   stock" batch, a shortfall comes off the earliest-expiry batches first. Finishing an order takes stock
   from batches automatically, earliest expiry first (FEFO) unless a batch was chosen on the pick screen.
   ============================================================================ */
const BATCH_EPS = 0.005;
const rq = (r)=>new Promise((res,rej)=>{ r.onsuccess=()=>res(r.result); r.onerror=()=>rej(r.error); });
const batchTracked = (p)=>!!(p && p.trackBatches && isStockTracked(p));

async function batchTxn(stores, fn){
  const db = await dbp;
  stores.forEach(markDirty);
  const t = db.transaction(stores, 'readwrite');
  const done = new Promise((res,rej)=>{
    t.oncomplete = ()=>{ stores.forEach(markDirty); res(); };
    t.onerror = ()=>rej(t.error);
    t.onabort = ()=>rej(t.error || new Error('Not saved'));
  });
  let out;
  try{ out = await fn(t); }
  catch(e){ try{ t.abort(); }catch(_){} await done.catch(()=>{}); throw e; }
  await done;
  return out;
}
function newCh(){ return {put:new Map(), del:new Set(), items:new Map(), prods:new Map()}; }
function flushCh(ch){
  ch.put.forEach((b,id)=>queueSync('batches', id, 'put'));
  ch.del.forEach(id=>queueSync('batches', id, 'del'));
  ch.items.forEach((o,id)=>queueSync('orderItems', id, 'put'));
  ch.prods.forEach((o,id)=>queueSync('products', id, 'put'));
}

/* picking order: undated stock (e.g. opening stock) first, then earliest expiry, then oldest delivery */
function fefoSort(a,b){
  const ea=a.expiryDate||'', eb=b.expiryDate||'';
  if(!ea!==!eb) return ea ? 1 : -1;
  if(ea!==eb) return ea<eb ? -1 : 1;
  return (a.receivedAt||'').localeCompare(b.receivedAt||'');
}
function fefoList(list){ return list.filter(b=>b.qtyRemaining>BATCH_EPS).sort(fefoSort); }

function _take(list, need, allocs, ch, bos, preferId){
  const order = fefoList(list);
  if(preferId){ const i = order.findIndex(b=>b.id===preferId); if(i>0) order.unshift(order.splice(i,1)[0]); }
  for(const b of order){
    if(need<=BATCH_EPS) break;
    const t = Math.min(b.qtyRemaining, need);
    b.qtyRemaining = round2(b.qtyRemaining - t); need = round2(need - t);
    if(allocs) allocs.push({batchId:b.id, batchNo:b.batchNo||'', expiryDate:b.expiryDate||'', qty:t});
    bos.put(b); ch.put.set(b.id, b);
  }
  return need;
}
function _reconcileList(bos, p, list, ch){
  if(!batchTracked(p)){ list.forEach(b=>{ bos.delete(b.id); ch.del.add(b.id); }); list.length = 0; return; }
  const sum = round2(list.reduce((s,b)=>s+b.qtyRemaining, 0));
  const diff = round2(parseFloat(p.stockQty) - sum);
  if(Math.abs(diff) < BATCH_EPS) return;
  if(diff > 0){
    let ob = list.find(b=>b.kind==='opening');
    if(ob){ ob.qtyRemaining = round2(ob.qtyRemaining+diff); ob.qtyReceived = round2(ob.qtyReceived+diff); }
    else{
      ob = {id:uid(), productId:p.id, productName:p.name, batchNo:'', productionDate:'', expiryDate:'', qtyReceived:diff, qtyRemaining:diff,
            supplierId:'', supplierName:'', invoiceId:'', receivedAt:todayISO(), kind:'opening', createdAt:new Date().toISOString()};
      list.push(ob);
    }
    bos.put(ob); ch.put.set(ob.id, ob);
  } else _take(list, -diff, null, ch, bos);
}
async function _batchesByProduct(bos){
  const m = new Map();
  for(const b of await rq(bos.getAll())){ if(!m.has(b.productId)) m.set(b.productId, []); m.get(b.productId).push(b); }
  return m;
}

/* Brings the batches of these products back in line with their stock total (see header). */
async function reconcileBatches(productIds){
  const ids = [].concat(productIds).filter(Boolean);
  if(!ids.length) return;
  const ch = newCh();
  await batchTxn(['products','batches'], async t=>{
    const bos = t.objectStore('batches'), pos = t.objectStore('products');
    const by = await _batchesByProduct(bos);
    for(const id of ids){
      const p = await rq(pos.get(id));
      if(!p){ (by.get(id)||[]).forEach(b=>{ bos.delete(b.id); ch.del.add(b.id); }); continue; }
      _reconcileList(bos, p, by.get(id)||[], ch);
    }
  });
  flushCh(ch);
}

/* Takes a finished order's picked quantities off stock, and off batches (earliest expiry first unless the
   picker chose a batch). The batches used are remembered on the line (batchAllocs). One all-or-nothing write. */
async function applyStockDeductions(items){
  const lines = [];
  for(const it of items){
    if(it.status==='completed' || it.status==='modified'){
      if(it.productId) lines.push({productId:it.productId, qty:it.actualQty, holder:it, choice:it.batchChoice||''});
    } else if(it.status==='substituted'){
      const arr = Array.isArray(it.replacements) && it.replacements.length ? it.replacements : null;
      for(const r of replacementsOf(it)) if(r.productId) lines.push({productId:r.productId, qty:r.qty, holder: arr ? r : null, item:it});
    }
  }
  const touched = lines.filter(l=>typeof l.qty==='number' && !isNaN(l.qty));
  if(!touched.length) return;
  const ch = newCh();
  await batchTxn(['products','batches','orderItems'], async t=>{
    const pos = t.objectStore('products'), bos = t.objectStore('batches'), ios = t.objectStore('orderItems');
    const by = await _batchesByProduct(bos);
    const prods = new Map();
    for(const l of touched){
      if(!prods.has(l.productId)) prods.set(l.productId, await rq(pos.get(l.productId)));
      const p = prods.get(l.productId);
      if(!p || !isStockTracked(p)) continue;
      p.stockQty = round2(parseFloat(p.stockQty) - l.qty);
      ch.prods.set(p.id, p);
      if(batchTracked(p)){
        const list = by.get(p.id) || (by.set(p.id, []), by.get(p.id));
        const allocs = [];
        _take(list, l.qty, allocs, ch, bos, l.choice);
        if(l.holder){ l.holder.batchAllocs = allocs; const it = l.item || l.holder; ch.items.set(it.id, it); }
      }
    }
    ch.prods.forEach(p=>{ pos.put(p); if(batchTracked(p)) _reconcileList(bos, p, by.get(p.id)||[], ch); });
    ch.items.forEach(it=>ios.put(it));
  });
  flushCh(ch);
}

/* gives a finished line's quantities back to the batches they came from (when a line is re-linked) */
async function restoreAllocs(it){
  const allocs = it.batchAllocs; if(!allocs || !allocs.length) return;
  const ch = newCh();
  await batchTxn(['batches'], async t=>{
    const bos = t.objectStore('batches');
    for(const a of allocs){
      const b = await rq(bos.get(a.batchId));
      if(b){ b.qtyRemaining = round2(b.qtyRemaining + a.qty); bos.put(b); ch.put.set(b.id, b); }
    }
  });
  flushCh(ch);
}

/* ------------------------------ settings & status ------------------------------ */
async function getBatchSettings(){
  const s = await getOne('settings','batchSettings');
  return {minMonths: s && s.minMonths!=null && !isNaN(parseFloat(s.minMonths)) ? parseFloat(s.minMonths) : 2};
}
async function setBatchMinMonths(n){ await rawPut('settings', {id:'batchSettings', minMonths:n}); }
function daysUntil(iso){
  if(!iso) return null;
  const d = new Date(iso+'T00:00:00'), t = new Date(todayISO()+'T00:00:00');
  return Math.round((d-t)/86400000);
}
function expiryStatus(iso, minMonths){
  if(!iso) return 'none';
  const d = daysUntil(iso);
  if(d<0) return 'expired';
  const limit = addDuration(todayISO(), minMonths, 'months');
  return iso < limit ? 'soon' : 'ok';
}
function leftLabel(iso){
  const d = daysUntil(iso);
  if(d==null) return 'No expiry date';
  if(d<0) return `Expired ${-d} day${d===-1?'':'s'} ago`;
  if(d===0) return 'Expires today';
  if(d<60) return `${d} day${d===1?'':'s'} left`;
  return `${Math.round(d/30.4)} months left`;
}
function expBadge(iso, minMonths){
  const st = expiryStatus(iso, minMonths);
  const label = iso ? `${leftLabel(iso)}` : 'No expiry';
  return `<span class="exp-badge exp-${st}">${st==='expired'||st==='soon'?'⚠ ':''}${esc(label)}</span>`;
}

/* the batch that would be picked next for a product, plus whether it's inside the reminder window */
function pickSuggestion(batches, productId, choiceId, minMonths){
  const list = batches.filter(b=>b.productId===productId && b.qtyRemaining>BATCH_EPS).sort(fefoSort);
  if(!list.length) return null;
  const chosen = choiceId ? list.find(b=>b.id===choiceId) : null;
  const batch = chosen || list[0];
  return {batch, list, isChoice:!!chosen, status: expiryStatus(batch.expiryDate, minMonths)};
}
/* orders: items of an order that would currently be picked from a batch inside the reminder window */
async function shelfLifeWarnings(items){
  const [batches, settings] = await Promise.all([getAll('batches'), getBatchSettings()]);
  if(!batches.length) return {list:[], minMonths:settings.minMonths};
  const out = [];
  for(const it of items){
    if(!it.productId || ['completed','modified','substituted','not_available'].includes(it.status)) continue;
    const s = pickSuggestion(batches, it.productId, it.batchChoice, settings.minMonths);
    if(s && (s.status==='soon' || s.status==='expired')) out.push({it, batch:s.batch, status:s.status});
  }
  return {list:out, minMonths:settings.minMonths};
}
function shelfLifeBannerHtml(w){
  if(!w.list.length) return '';
  const shown = w.list.slice(0,8);
  return `<div class="bt-warn">
    <div class="bt-warn-h"><span class="bt-warn-ic">⏳</span><div><b>${w.list.length} item${w.list.length===1?'':'s'} with less than ${w.minMonths} month${w.minMonths===1?'':'s'} left</b>
    <div class="subtle">Check with the vessel before picking these.</div></div></div>
    ${shown.map(x=>`<div class="bt-warn-row"><span>${esc(x.it.productName||x.it.excelDesc)}</span>${expBadge(x.batch.expiryDate, w.minMonths)}</div>`).join('')}
    ${w.list.length>shown.length?`<div class="subtle" style="margin-top:6px;">+ ${w.list.length-shown.length} more</div>`:''}
    <a href="#/batches" class="bt-link">Open batches &amp; expiry →</a></div>`;
}

/* ------------------------------ batch card on the pick screen ------------------------------ */
async function pickBatchCardHtml(it, product){
  if(!batchTracked(product)) return {html:'', sug:null};
  const [batches, st] = await Promise.all([getAll('batches'), getBatchSettings()]);
  const sug = pickSuggestion(batches, product.id, it.batchChoice, st.minMonths);
  if(!sug) return {html:`<div class="bt-pick"><div class="bt-pick-h">Batch</div><div class="subtle">No batch has stock left.</div></div>`, sug:null};
  const b = sug.batch;
  return {sug, minMonths:st.minMonths, html:`<div class="bt-pick bt-${sug.status}">
    <div class="bt-pick-h">${sug.isChoice?'Batch you chose':'Pick from this batch'}</div>
    <div style="display:flex; align-items:center; gap:10px; flex-wrap:wrap;">
      <div style="flex:1; min-width:140px;"><b>${b.batchNo?esc(b.batchNo):(b.kind==='opening'?'Opening stock':'No batch no.')}</b>
        <div class="subtle">${round2(b.qtyRemaining)} ${esc(product.unit||'')} left${b.expiryDate?' · exp '+fmtDate(b.expiryDate):''}</div></div>
      ${expBadge(b.expiryDate, st.minMonths)}
      ${sug.list.length>1?`<button class="btn btn-ghost btn-sm" id="pk_changebatch">Change batch</button>`:''}
    </div></div>`};
}
function bindPickBatch(it, product, info, onDone){
  const btn = $('#pk_changebatch'); if(!btn || !info.sug) return;
  btn.onclick = ()=>{
    showModal(`<h3>Choose batch</h3><p class="subtle" style="margin-top:-8px;">${esc(product.name)} — the earliest expiry is suggested first.</p>
      <div style="display:flex; flex-direction:column; gap:8px; max-height:50vh; overflow:auto;">
      ${info.sug.list.map((b,i)=>`<button class="bt-opt ${b.id===info.sug.batch.id?'on':''}" data-b="${b.id}">
        <span><b>${b.batchNo?esc(b.batchNo):(b.kind==='opening'?'Opening stock':'No batch no.')}</b>${i===0?' <span class="bt-first">earliest</span>':''}
        <span class="subtle" style="display:block;">${round2(b.qtyRemaining)} ${esc(product.unit||'')} left</span></span>${expBadge(b.expiryDate, info.minMonths)}</button>`).join('')}
      </div><button class="btn btn-ghost" style="margin-top:12px; width:100%;" onclick="closeModal()">Cancel</button>`);
    $('#modal-root').querySelectorAll('[data-b]').forEach(x=>x.onclick = async ()=>{
      const first = info.sug.list[0].id;
      it.batchChoice = x.dataset.b===first ? '' : x.dataset.b;
      await put('orderItems', it); closeModal(); onDone();
    });
  };
}

/* ------------------------------ screens ------------------------------ */
route('batches', async (parts)=>{
  if(parts[0]) return productBatchesScreen(parts[0]);
  return batchesOverviewScreen();
});

function batchTitle(b){ return b.batchNo ? esc(b.batchNo) : (b.kind==='opening' ? 'Opening stock' : 'No batch no.'); }

async function batchesOverviewScreen(){
  const [batches, products, st] = await Promise.all([getAll('batches'), slimProducts(), getBatchSettings()]);
  const pm = new Map(products.map(p=>[p.id,p]));
  const live = batches.filter(b=>b.qtyRemaining>BATCH_EPS && pm.has(b.productId));
  const expired = live.filter(b=>expiryStatus(b.expiryDate, st.minMonths)==='expired').sort(fefoSort);
  const soon = live.filter(b=>expiryStatus(b.expiryDate, st.minMonths)==='soon').sort(fefoSort);
  const needs = live.filter(b=>b.kind==='opening');
  const tracked = products.filter(p=>p.active && batchTracked(p)).sort((a,b)=>a.name.localeCompare(b.name));
  const rowB = (b)=>{ const p = pm.get(b.productId); return `<a class="bt-row" href="#/batches/${b.productId}">
      <div style="flex:1; min-width:0;"><b>${esc(p.name)}</b><div class="subtle">${batchTitle(b)} · ${round2(b.qtyRemaining)} ${esc(p.unit||'')}</div></div>${expBadge(b.expiryDate, st.minMonths)}</a>`; };
  $('#main').innerHTML = `
    <div class="topbar"><h1>Batches &amp; expiry</h1></div>
    <div class="bt-tiles">
      <div class="bt-tile bt-tile-red"><b>${expired.length}</b><span>Expired</span></div>
      <div class="bt-tile bt-tile-amber"><b>${soon.length}</b><span>Under ${st.minMonths} mo.</span></div>
      <div class="bt-tile bt-tile-blue"><b>${needs.length}</b><span>Need details</span></div>
    </div>
    <div class="bt-card" style="margin-bottom:16px;">
      <div class="bt-h">Shelf-life reminder</div>
      <p class="subtle" style="margin:0 0 10px;">Vessels usually want items with at least this much time left. You'll get a warning while picking when a batch is below it — nothing is skipped automatically.</p>
      <div class="bt-step"><button class="iconbtn" id="mmDown" aria-label="Less">−</button><div><b id="mmVal">${st.minMonths}</b> month${st.minMonths===1?'':'s'}</div><button class="iconbtn" id="mmUp" aria-label="More">+</button></div>
    </div>
    ${expired.length?`<div class="bt-h">Expired</div><div class="bt-list">${expired.map(rowB).join('')}</div>`:''}
    ${soon.length?`<div class="bt-h">Expiring within ${st.minMonths} month${st.minMonths===1?'':'s'}</div><div class="bt-list">${soon.map(rowB).join('')}</div>`:''}
    ${needs.length?`<div class="bt-h">Need batch details <span class="subtle" style="font-weight:500;">— stock without dates yet</span></div><div class="bt-list">${needs.map(rowB).join('')}</div>`:''}
    <div class="bt-h">Products with batch tracking</div>
    <div class="bt-list">${tracked.map(p=>{
      const bs = live.filter(b=>b.productId===p.id).sort(fefoSort), first = bs.find(b=>b.expiryDate);
      return `<a class="bt-row" href="#/batches/${p.id}"><div style="flex:1; min-width:0;"><b>${esc(p.name)}</b>
        <div class="subtle">${bs.length} batch${bs.length===1?'':'es'} · ${esc(p.stockQty)} ${esc(p.unit||'')}</div></div>${first?expBadge(first.expiryDate, st.minMonths):'<span class="exp-badge exp-none">No expiry</span>'}</a>`; }).join('')
      || `<p class="subtle">No product has batch tracking yet. Open a product and switch on <b>Track batches</b>.</p>`}</div>
    <div style="margin-top:16px;"><a href="#/warehouse" class="btn btn-ghost">Back</a></div>`;
  const setM = async n=>{ n = Math.max(1, Math.min(24, n)); await setBatchMinMonths(n); batchesOverviewScreen(); };
  $('#mmDown').onclick = ()=>setM(st.minMonths-1);
  $('#mmUp').onclick = ()=>setM(st.minMonths+1);
}

async function productBatchesScreen(productId){
  const [p, all, st] = await Promise.all([getOne('products', productId), getAll('batches'), getBatchSettings()]);
  if(!p){ location.hash='#/batches'; return; }
  const list = all.filter(b=>b.productId===productId && b.qtyRemaining>BATCH_EPS).sort(fefoSort);
  const unit = esc(p.unit||'');
  $('#main').innerHTML = `
    <div class="topbar"><h1>${esc(p.name)}</h1></div>
    <div class="bt-card" style="margin-bottom:16px;">
      <div style="display:flex; align-items:baseline; gap:8px; flex-wrap:wrap;"><span class="bt-big">${isStockTracked(p)?esc(p.stockQty):'—'}</span><span class="subtle">${unit} in stock</span></div>
      <div class="subtle">${batchTracked(p)?`${list.length} batch${list.length===1?'':'es'} · picked earliest expiry first`:'Batch tracking is off for this product.'}</div>
    </div>
    ${list.map((b,i)=>{ const pct = b.kind==='opening' ? 100 : Math.max(0, Math.min(100, b.qtyReceived>0 ? b.qtyRemaining/b.qtyReceived*100 : 0)); return `
      <div class="bt-card bt-item" data-b="${b.id}">
        <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
          <b style="flex:1; min-width:0;">${batchTitle(b)}</b>${i===0?'<span class="bt-first">picked first</span>':''}${expBadge(b.expiryDate, st.minMonths)}</div>
        <div class="bt-bar"><i style="width:${pct}%"></i></div>
        <div class="bt-meta"><span><b>${round2(b.qtyRemaining)}</b>${b.kind==='opening'?'':' of '+round2(b.qtyReceived)} ${unit} left</span>
          <span>${b.productionDate?'Prod '+fmtDate(b.productionDate):''}${b.expiryDate?' · Exp '+fmtDate(b.expiryDate):''}</span></div>
        <div class="subtle">${b.kind==='opening'?'Stock you already had before batch tracking':esc(b.supplierName||'')+(b.receivedAt?' · received '+fmtDate(b.receivedAt):'')}</div>
        <div style="display:flex; gap:8px; margin-top:10px; flex-wrap:wrap;">
          <button class="btn btn-ghost btn-sm" data-edit="${b.id}">✎ Edit details</button>
          ${b.kind==='opening'?`<button class="btn btn-signal btn-sm" data-split="${b.id}">Split into real batches</button>`:''}
          ${b.invoiceId?`<a class="btn btn-ghost btn-sm" href="#/receiving/${b.invoiceId}">Delivery</a>`:''}
        </div></div>`; }).join('') || `<p class="subtle">No batches with stock.</p>`}
    <div style="margin-top:8px;"><a href="#/batches" class="btn btn-ghost">Back</a></div>`;
  $('#main').querySelectorAll('[data-edit]').forEach(x=>x.onclick = ()=>openBatchEdit(all.find(b=>b.id===x.dataset.edit), ()=>productBatchesScreen(productId)));
  $('#main').querySelectorAll('[data-split]').forEach(x=>x.onclick = ()=>openSplitBatch(p, all.find(b=>b.id===x.dataset.split), ()=>productBatchesScreen(productId)));
}

function openBatchEdit(b, done){
  showModal(`<h3>Batch details</h3>
    <div class="field"><label>Batch / lot no.</label><input type="text" id="be_no" value="${esc(b.batchNo||'')}" autofocus></div>
    <div class="row2"><div class="field"><label>Production date</label><input type="date" id="be_p" value="${esc(b.productionDate||'')}"></div>
    <div class="field"><label>Expiry date</label><input type="date" id="be_e" value="${esc(b.expiryDate||'')}"></div></div>
    <div style="display:flex; gap:10px; margin-top:10px;"><button class="btn btn-signal" id="be_save" style="flex:1;">Save</button><button class="btn btn-ghost" onclick="closeModal()">Cancel</button></div>`);
  $('#be_save').onclick = async ()=>{
    const pd = $('#be_p').value, ed = $('#be_e').value;
    if(pd && ed && ed<pd) return showAlert('The expiry date is before the production date.');
    b.batchNo = $('#be_no').value.trim(); b.productionDate = pd; b.expiryDate = ed;
    await put('batches', b); closeModal(); done();
  };
}

/* turns part of the undated "Opening stock" into real batches (stock total doesn't change) */
function openSplitBatch(p, opening, done){
  const rows = [{}];
  const draw = ()=>{
    const used = round2(rows.reduce((s,r)=>s+(parseFloat(r.qty)||0),0));
    const left = round2(opening.qtyRemaining-used);
    showModal(`<h3>Split opening stock</h3>
      <p class="subtle" style="margin-top:-8px;">${esc(p.name)} — ${round2(opening.qtyRemaining)} ${esc(p.unit||'')} without dates. Describe the real batches; whatever you don't assign stays as opening stock.</p>
      ${rows.map((r,i)=>`<div class="bt-card" style="margin-bottom:10px; padding:12px;" data-r="${i}">
        <div class="row2"><div class="field"><label>Quantity</label><input type="number" step="any" inputmode="decimal" data-f="qty" value="${esc(r.qty||'')}"></div>
        <div class="field"><label>Batch no.</label><input type="text" data-f="batchNo" value="${esc(r.batchNo||'')}"></div></div>
        <div class="row2"><div class="field"><label>Production date</label><input type="date" data-f="productionDate" value="${esc(r.productionDate||'')}"></div>
        <div class="field"><label>Expiry date</label><input type="date" data-f="expiryDate" value="${esc(r.expiryDate||'')}"></div></div></div>`).join('')}
      <button class="btn btn-ghost btn-sm" id="sp_add">+ Add another batch</button>
      <div class="subtle" style="margin:10px 0; ${left<0?'color:var(--danger);':''}">Left as opening stock: <b>${left} ${esc(p.unit||'')}</b></div>
      <div style="display:flex; gap:10px;"><button class="btn btn-signal" id="sp_save" style="flex:1;">Save</button><button class="btn btn-ghost" onclick="closeModal()">Cancel</button></div>`);
    $('#modal-root').querySelectorAll('[data-r]').forEach(card=>{
      const r = rows[+card.dataset.r];
      card.querySelectorAll('[data-f]').forEach(inp=>inp.oninput = ()=>{ r[inp.dataset.f] = inp.value; });
    });
    $('#sp_add').onclick = ()=>{ rows.push({}); draw(); };
    $('#sp_save').onclick = async ()=>{
      const parts = rows.filter(r=>parseFloat(r.qty)>0);
      if(!parts.length) return showAlert('Enter a quantity for at least one batch.');
      for(const r of parts) if(r.productionDate && r.expiryDate && r.expiryDate<r.productionDate) return showAlert('An expiry date is before its production date.');
      const total = round2(parts.reduce((s,r)=>s+parseFloat(r.qty),0));
      if(total>opening.qtyRemaining+BATCH_EPS) return showAlert(`That's ${total} but only ${round2(opening.qtyRemaining)} is unassigned.`);
      const ch = newCh();
      try{
        await batchTxn(['batches'], async t=>{
          const bos = t.objectStore('batches');
          const cur = await rq(bos.get(opening.id));
          if(!cur || cur.qtyRemaining+BATCH_EPS<total) throw new Error('The stock changed in the meantime. Reopen this page and try again.');
          for(const r of parts){
            const q = round2(parseFloat(r.qty));
            const nb = {id:uid(), productId:p.id, productName:p.name, batchNo:(r.batchNo||'').trim(), productionDate:r.productionDate||'', expiryDate:r.expiryDate||'',
              qtyReceived:q, qtyRemaining:q, supplierId:'', supplierName:'', invoiceId:'', receivedAt:cur.receivedAt||todayISO(), kind:'manual', createdAt:new Date().toISOString()};
            bos.put(nb); ch.put.set(nb.id, nb);
          }
          cur.qtyRemaining = round2(cur.qtyRemaining-total); cur.qtyReceived = round2(Math.max(0,cur.qtyReceived-total));
          if(cur.qtyRemaining<=BATCH_EPS){ bos.delete(cur.id); ch.del.add(cur.id); } else { bos.put(cur); ch.put.set(cur.id, cur); }
        });
      }catch(e){ return showAlert(e.message); }
      flushCh(ch); closeModal(); done();
    };
  };
  draw();
}
