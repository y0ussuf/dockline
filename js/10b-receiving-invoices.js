/* ============================ PRODUCT RECEIVING — DELIVERY INVOICES ============================
   One delivery = one supplier + several product lines (No., description, quantity, unit, production
   date, expiry date, batch/lot no.). Header lives in `receivingInvoices`; each line is a
   `productReceipts` record carrying `invoiceId`. Saving adds every line's quantity to the product's
   stock (only for products with stock tracking switched on) in ONE database transaction, so a delivery
   is either saved completely or not at all. Older single entries (no invoiceId) are still listed.
   ================================================================================================ */

/* How much a received line changes the product's stock. Returns {delta} or {error}. */
function stockDeltaFor(product, qty, unit){
  if(!product) return {error:'This product no longer exists.'};
  if(!isStockTracked(product)) return {delta:0};
  const u = (unit||'').trim(), pu = (product.unit||'').trim();
  if(!u || !pu || normalize(u)===normalize(pu)) return {delta:round2(qty)};
  const c = computeUnitConversion(u, pu, qty);
  if(c && isFinite(c.convertedQty)) return {delta:round2(c.convertedQty)};
  return {error:`“${product.name}” is received in ${u} but its stock is counted in ${pu}. Use ${pu} as the unit.`};
}

async function saveDelivery(header, lines){
  const db = await dbp;
  const changed = new Map();
  await new Promise((resolve,reject)=>{
    const stores = ['products','productReceipts','receivingInvoices'];
    stores.forEach(markDirty);
    const t = db.transaction(stores,'readwrite');
    const prodOs = t.objectStore('products');
    const pending = new Map();
    let i = 0;
    const fail = (msg)=>{ try{ t.abort(); }catch(e){} reject(new Error(msg)); };
    t.oncomplete = ()=>{ stores.forEach(markDirty); resolve(); };
    t.onerror = ()=>reject(t.error);
    t.onabort = ()=>reject(t.error || new Error('Not saved'));
    function next(){
      if(i>=lines.length){
        t.objectStore('receivingInvoices').put(header);
        lines.forEach(l=>t.objectStore('productReceipts').put(l));
        pending.forEach(p=>{ prodOs.put(p); changed.set(p.id,p); });
        return;
      }
      const l = lines[i++];
      const r = prodOs.get(l.productId);
      r.onsuccess = ()=>{
        const p = pending.get(l.productId) || r.result;
        const d = stockDeltaFor(p, l.qty, l.unit);
        if(d.error) return fail(d.error);
        l.stockDelta = d.delta;
        if(d.delta){ p.stockQty = round2(parseFloat(p.stockQty)+d.delta); pending.set(p.id,p); }
        next();
      };
    }
    next();
  });
  queueSync('receivingInvoices', header.id, 'put');
  lines.forEach(l=>queueSync('productReceipts', l.id, 'put'));
  changed.forEach((p,id)=>queueSync('products', id, 'put'));
}

async function deleteDelivery(invoiceId){
  const db = await dbp;
  const done = {lines:[], products:[]};
  await new Promise((resolve,reject)=>{
    const stores = ['products','productReceipts','receivingInvoices'];
    stores.forEach(markDirty);
    const t = db.transaction(stores,'readwrite');
    t.oncomplete = ()=>{ stores.forEach(markDirty); resolve(); };
    t.onerror = ()=>reject(t.error);
    t.onabort = ()=>reject(t.error||new Error('Not deleted'));
    const rOs = t.objectStore('productReceipts'), pOs = t.objectStore('products');
    rOs.getAll().onsuccess = (e)=>{
      const lines = e.target.result.filter(r=>r.invoiceId===invoiceId);
      done.lines = lines.map(l=>l.id);
      const prods = new Map(); let left = 0;
      const finish = ()=>{
        for(const l of lines){
          const p = prods.get(l.productId);
          const d = parseFloat(l.stockDelta!=null ? l.stockDelta : l.qty);
          if(p && isStockTracked(p) && d){ p.stockQty = round2(parseFloat(p.stockQty)-d); }
        }
        prods.forEach(p=>{ if(p){ pOs.put(p); done.products.push(p.id); } });
        lines.forEach(l=>rOs.delete(l.id));
        t.objectStore('receivingInvoices').delete(invoiceId);
      };
      const ids = [...new Set(lines.map(l=>l.productId))];
      if(!ids.length) return finish();
      left = ids.length;
      ids.forEach(id=>{ pOs.get(id).onsuccess = (ev)=>{ prods.set(id, ev.target.result); if(--left===0) finish(); }; });
    };
  });
  done.lines.forEach(id=>queueSync('productReceipts', id, 'del'));
  queueSync('receivingInvoices', invoiceId, 'del');
  done.products.forEach(id=>queueSync('products', id, 'put'));
}

const DRAFT_KEY = 'dockline_receiving_draft';
function loadDraft(){ try{ return JSON.parse(localStorage.getItem(DRAFT_KEY)||'null'); }catch(e){ return null; } }
function saveDraft(d){ try{ localStorage.setItem(DRAFT_KEY, JSON.stringify(d)); }catch(e){} }
function clearDraft(){ try{ localStorage.removeItem(DRAFT_KEY); }catch(e){} }

route('receiving', async (parts)=>{
  if(parts[0]==='new') return newDeliveryScreen();
  if(parts[0]) return deliveryDetailScreen(parts[0]);
  return deliveryListScreen();
});

async function deliveryListScreen(){
  const [invoices, receipts] = await Promise.all([getAll('receivingInvoices'), getAll('productReceipts')]);
  const counts = {}; receipts.forEach(r=>{ if(r.invoiceId) counts[r.invoiceId]=(counts[r.invoiceId]||0)+1; });
  const legacy = receipts.filter(r=>!r.invoiceId);
  const entries = invoices.map(i=>({kind:'inv', date:i.receivedAt||'', ts:i.createdAt||'', i, n:counts[i.id]||i.lineCount||0}))
    .concat(legacy.map(r=>({kind:'old', date:r.receivedAt||'', ts:r.receivedAt||'', r})))
    .sort((a,b)=>(b.date.localeCompare(a.date))||(String(b.ts).localeCompare(String(a.ts))));
  const draft = loadDraft();
  $('#main').innerHTML = `
    <div class="topbar"><h1>Product receiving</h1></div>
    <div style="display:flex; gap:10px; flex-wrap:wrap; margin-bottom:14px;">
      <a href="#/receiving/new" class="btn btn-signal">+ New delivery</a>
      <a href="#/warehouse" class="btn btn-ghost">Back</a>
    </div>
    ${draft && draft.lines && draft.lines.length ? `<div class="card" style="border:1.5px solid var(--warn); margin-bottom:14px;">
      <b>Unfinished delivery</b> <span class="subtle">· ${draft.lines.length} item${draft.lines.length===1?'':'s'}${draft.supplierName?' · '+esc(draft.supplierName):''}</span>
      <div style="margin-top:8px; display:flex; gap:10px;"><a href="#/receiving/new" class="btn btn-ghost">Continue</a><button class="btn btn-ghost" id="rcDropDraft">Discard</button></div></div>` : ''}
    <div class="field"><input type="text" id="rcSearch" placeholder="Search supplier, invoice no. or product…"></div>
    <div id="rcList"></div>`;
  const dd = $('#rcDropDraft'); if(dd) dd.onclick = ()=>{ clearDraft(); deliveryListScreen(); };
  const prodByInv = {}; receipts.forEach(r=>{ if(r.invoiceId) (prodByInv[r.invoiceId]=prodByInv[r.invoiceId]||[]).push(normalize(r.productName)); });
  function draw(q){
    const nq = normalize(q);
    const rows = entries.filter(e=>{
      if(!nq) return true;
      if(e.kind==='inv') return normalize((e.i.supplierName||'')+' '+(e.i.invoiceNo||'')).includes(nq) || (prodByInv[e.i.id]||[]).some(n=>n.includes(nq));
      return normalize((e.r.productName||'')+' '+(e.r.supplierName||'')).includes(nq);
    });
    $('#rcList').innerHTML = rows.map(e=> e.kind==='inv' ? `
      <a class="list-row" href="#/receiving/${e.i.id}" style="text-decoration:none; color:inherit;">
        <div style="flex:1;"><b>${esc(e.i.supplierName||'Supplier')}</b>
          <div class="subtle">${fmtDate(e.i.receivedAt)}${e.i.invoiceNo?' · No. '+esc(e.i.invoiceNo):''}</div></div>
        <span class="badge">${e.n} item${e.n===1?'':'s'}</span></a>` : `
      <div class="list-row"><div style="flex:1;"><b>${esc(e.r.productName)}</b>
        <div class="subtle">${fmtDate(e.r.receivedAt)} · ${esc(e.r.supplierName||'')} · earlier single entry</div></div>
        <span class="badge">${esc(e.r.qty)} ${esc(e.r.unit||'')}</span>
        <button class="iconbtn" data-old="${e.r.id}" title="Delete">✕</button></div>`).join('')
      || `<p class="subtle">${entries.length?'Nothing matches.':'No deliveries yet. Tap “+ New delivery” when a supplier delivers.'}</p>`;
    $('#rcList').querySelectorAll('[data-old]').forEach(b=>b.onclick = ()=>{
      const r = legacy.find(x=>x.id===b.dataset.old);
      showConfirm(`Delete this entry? “${r.productName}” ${r.qty} ${r.unit||''} will be taken back off stock if it was tracked.`, async ()=>{
        const p = await getOne('products', r.productId);
        const d = parseFloat(r.stockDelta!=null ? r.stockDelta : r.qty);
        if(p && isStockTracked(p) && d){ p.stockQty = round2(parseFloat(p.stockQty)-d); await put('products', p); }
        await del('productReceipts', r.id);
        deliveryListScreen();
      });
    });
  }
  draw('');
  let t; $('#rcSearch').addEventListener('input', e=>{ clearTimeout(t); const v=e.target.value; t=setTimeout(()=>draw(v),400); });
}

async function deliveryDetailScreen(id){
  const [inv, receipts] = await Promise.all([getOne('receivingInvoices', id), getAll('productReceipts')]);
  if(!inv){ location.hash='#/receiving'; return; }
  const lines = receipts.filter(r=>r.invoiceId===id).sort((a,b)=>(a.lineNo||0)-(b.lineNo||0));
  $('#main').innerHTML = `
    <div class="topbar"><h1>Delivery</h1></div>
    <div class="card" style="margin-bottom:14px;">
      <b style="font-size:1.1rem;">${esc(inv.supplierName||'')}</b>
      <div class="subtle">Received ${fmtDate(inv.receivedAt)}${inv.invoiceNo?' · Invoice / note no. '+esc(inv.invoiceNo):''}</div>
      ${inv.note?`<div style="margin-top:6px;">${esc(inv.note)}</div>`:''}
    </div>
    <div class="card" style="overflow-x:auto; margin-bottom:14px;">
      <table style="width:100%; border-collapse:collapse; font-size:.92rem;">
        <thead><tr style="text-align:left;"><th>No.</th><th>Description</th><th>Qty</th><th>Unit</th><th>Prod.</th><th>Expiry</th><th>Batch</th></tr></thead>
        <tbody>${lines.map((l,i)=>`<tr style="border-top:1px solid var(--line,#ddd);"><td>${l.lineNo||i+1}</td><td>${esc(l.productName)}</td><td>${esc(l.qty)}</td><td>${esc(l.unit||'')}</td><td>${l.productionDate?fmtDate(l.productionDate):'—'}</td><td>${l.expiryDate?fmtDate(l.expiryDate):'—'}</td><td>${esc(l.batchNo||'—')}</td></tr>`).join('')}</tbody>
      </table>
    </div>
    <p class="subtle">Quantities were added to stock for products that have stock tracking on.</p>
    <div style="display:flex; gap:10px;"><a href="#/receiving" class="btn btn-ghost">Back</a><button class="btn btn-danger" id="dvDel">Delete delivery</button></div>`;
  $('#dvDel').onclick = ()=>showConfirm('Delete this whole delivery? The quantities will be taken back off stock.', async ()=>{
    try{ await deleteDelivery(id); }catch(e){ showAlert('Could not delete: '+e.message); return; }
    location.hash='#/receiving'; render();
  });
}

async function newDeliveryScreen(){
  const [products, warehouses, sections, suppliersRaw] = await Promise.all([slimProducts(), getAll('warehouses'), getAll('sections'), getAll('suppliers')]);
  const suppliers = suppliersRaw.slice().sort((a,b)=>a.name.localeCompare(b.name));
  const whMap = Object.fromEntries(warehouses.map(w=>[w.id,w])), secMap = Object.fromEntries(sections.map(s=>[s.id,s]));
  const prodMap = new Map(products.map(p=>[p.id,p]));
  const d0 = loadDraft();
  const S = d0 && d0.lines ? d0 : {supplierId:'', supplierName:'', receivedAt:todayISO(), invoiceNo:'', note:'', lines:[]};
  S.lines.forEach(l=>{ if(!l.key) l.key = uid(); });
  const NEW = '__newsup__';

  function persist(){ const s = suppliers.find(x=>x.id===S.supplierId); S.supplierName = s?s.name:''; saveDraft(S); }
  function stockHint(l){
    const p = prodMap.get(l.productId); if(!p) return `<span style="color:var(--danger,#c00);">Product no longer exists</span>`;
    if(!isStockTracked(p)) return `<span class="subtle">Stock not tracked — history only</span>`;
    const q = parseFloat(l.qty); if(isNaN(q)||q<=0) return `<span class="subtle">Stock now ${esc(p.stockQty)} ${esc(p.unit||'')}</span>`;
    const d = stockDeltaFor(p, q, l.unit);
    if(d.error) return `<span style="color:var(--danger,#c00);">⚠ ${esc(d.error)}</span>`;
    return `<span class="subtle">Stock ${esc(p.stockQty)} → <b>${round2(parseFloat(p.stockQty)+d.delta)}</b> ${esc(p.unit||'')}</span>`;
  }
  function autoExpiry(l){
    const p = prodMap.get(l.productId);
    if(!l.expiryTouched && p && p.expiryMode==='shelf' && l.productionDate && p.expiryShelfAmount)
      l.expiryDate = addDuration(l.productionDate, parseFloat(p.expiryShelfAmount), p.expiryShelfUnit||'months');
  }
  function lineHtml(l,i){ return `<div class="card" data-k="${l.key}" style="margin-bottom:12px;">
      <div style="display:flex; align-items:center; gap:8px; margin-bottom:8px;">
        <span class="badge">No. ${i+1}</span><b style="flex:1;">${esc(l.productName)}</b>
        <button class="iconbtn" data-act="change" title="Change product">✎</button>
        <button class="iconbtn" data-act="rm" title="Remove">✕</button></div>
      <div class="row2">
        <div class="field"><label>Quantity</label><input type="number" step="any" inputmode="decimal" data-f="qty" value="${esc(l.qty)}"></div>
        <div class="field"><label>Unit</label><input type="text" data-f="unit" value="${esc(l.unit)}"></div>
      </div>
      <div class="row2">
        <div class="field"><label>Production date</label><input type="date" data-f="productionDate" value="${esc(l.productionDate||'')}"></div>
        <div class="field"><label>Expiry date</label><input type="date" data-f="expiryDate" value="${esc(l.expiryDate||'')}"></div>
      </div>
      <div class="field"><label>Batch / lot no.</label><input type="text" data-f="batchNo" value="${esc(l.batchNo||'')}"></div>
      <div data-hint>${stockHint(l)}</div></div>`; }
  function drawLines(){
    $('#dvLines').innerHTML = S.lines.map(lineHtml).join('') || `<p class="subtle">No items yet — tap “+ Add item”.</p>`;
    $('#dvLines').querySelectorAll('[data-k]').forEach(card=>{
      const l = S.lines.find(x=>x.key===card.dataset.k);
      card.querySelectorAll('[data-f]').forEach(inp=>inp.addEventListener('input', ()=>{
        const f = inp.dataset.f; l[f] = inp.value;
        if(f==='expiryDate') l.expiryTouched = true;
        if(f==='productionDate'){ autoExpiry(l); const e = card.querySelector('[data-f=expiryDate]'); if(e && !l.expiryTouched) e.value = l.expiryDate||''; }
        card.querySelector('[data-hint]').innerHTML = stockHint(l);
        persist();
      }));
      card.querySelector('[data-act=rm]').onclick = ()=>{ S.lines = S.lines.filter(x=>x!==l); persist(); drawLines(); };
      card.querySelector('[data-act=change]').onclick = ()=>pick(p=>{ applyProduct(l,p); persist(); drawLines(); });
    });
  }
  function applyProduct(l,p){ l.productId=p.id; l.productName=p.name; l.unit=p.unit||''; autoExpiry(l); }
  function pick(cb){ openProductPicker(null, products, whMap, secMap, cb); }
  function supOpts(){ return `<option value="">Select supplier…</option>`+suppliers.map(s=>`<option value="${s.id}" ${s.id===S.supplierId?'selected':''}>${esc(s.name)}</option>`).join('')+`<option value="${NEW}">+ New supplier…</option>`; }

  $('#main').innerHTML = `
    <div class="topbar"><h1>New delivery</h1></div>
    <div class="card" style="margin-bottom:14px;">
      <div class="field"><label>Supplier</label><select id="dvSup">${supOpts()}</select></div>
      <div class="row2">
        <div class="field"><label>Date received</label><input type="date" id="dvDate" value="${esc(S.receivedAt)}"></div>
        <div class="field"><label>Invoice / delivery note no.</label><input type="text" id="dvNo" value="${esc(S.invoiceNo)}"></div>
      </div>
      <div class="field"><label>Note (optional)</label><input type="text" id="dvNote" value="${esc(S.note)}"></div>
    </div>
    <div class="section-title">Items</div>
    <div id="dvLines"></div>
    <button class="btn btn-ghost" id="dvAdd" style="margin-bottom:16px;">+ Add item</button>
    <div style="display:flex; gap:10px; flex-wrap:wrap;">
      <button class="btn btn-signal" id="dvSave" style="flex:1;">Save delivery</button>
      <button class="btn btn-ghost" id="dvCancel">Cancel</button>
    </div>`;
  drawLines();
  $('#dvSup').onchange = e=>{
    if(e.target.value===NEW){
      e.target.value = S.supplierId;
      openNewSupplierModal(sup=>{ suppliers.push(sup); suppliers.sort((a,b)=>a.name.localeCompare(b.name)); S.supplierId = sup.id; persist(); $('#dvSup').innerHTML = supOpts(); });
      return;
    }
    S.supplierId = e.target.value; persist();
  };
  $('#dvDate').oninput = e=>{ S.receivedAt = e.target.value; persist(); };
  $('#dvNo').oninput = e=>{ S.invoiceNo = e.target.value; persist(); };
  $('#dvNote').oninput = e=>{ S.note = e.target.value; persist(); };
  $('#dvAdd').onclick = ()=>pick(p=>{
    const l = {key:uid(), qty:'', unit:'', productionDate:'', expiryDate:'', batchNo:''};
    applyProduct(l,p); S.lines.push(l); persist(); drawLines();
    const last = $('#dvLines').lastElementChild; const q = last && last.querySelector('[data-f=qty]'); if(q) q.focus();
  });
  $('#dvCancel').onclick = ()=>{
    if(!S.lines.length){ clearDraft(); location.hash='#/receiving'; return; }
    showConfirm('Leave without saving? Your entries are kept as an unfinished delivery.', ()=>{ location.hash='#/receiving'; });
  };
  let saving = false;
  $('#dvSave').onclick = async ()=>{
    if(saving) return;
    if(!S.supplierId) return showAlert('Select a supplier.');
    if(!S.lines.length) return showAlert('Add at least one item.');
    for(let i=0;i<S.lines.length;i++){
      const l = S.lines[i], n = i+1, q = parseFloat(l.qty);
      if(isNaN(q)||q<=0) return showAlert(`Item ${n} (${l.productName}): enter the quantity received.`);
      if(l.productionDate && l.expiryDate && l.expiryDate<l.productionDate) return showAlert(`Item ${n} (${l.productName}): expiry date is before the production date.`);
      const d = stockDeltaFor(prodMap.get(l.productId), q, l.unit);
      if(d.error) return showAlert(`Item ${n}: ${d.error}`);
    }
    saving = true; $('#dvSave').disabled = true;
    const sup = suppliers.find(s=>s.id===S.supplierId);
    const invId = uid();
    const header = {id:invId, supplierId:S.supplierId, supplierName:sup?sup.name:'', receivedAt:S.receivedAt||todayISO(), invoiceNo:S.invoiceNo.trim(), note:S.note.trim(), createdAt:new Date().toISOString(), lineCount:S.lines.length};
    const lines = S.lines.map((l,i)=>({id:uid(), invoiceId:invId, lineNo:i+1, productId:l.productId, productName:l.productName,
      supplierId:header.supplierId, supplierName:header.supplierName, qty:round2(parseFloat(l.qty)), unit:(l.unit||'').trim(),
      receivedAt:header.receivedAt, note:'', productionDate:l.productionDate||'', expiryDate:l.expiryDate||'', batchNo:(l.batchNo||'').trim()}));
    try{ await saveDelivery(header, lines); }
    catch(e){ saving=false; $('#dvSave').disabled=false; return showAlert('Not saved — nothing was changed. '+e.message); }
    clearDraft();
    location.hash = '#/receiving/'+invId;
  };
}
