const QI = {'check': '<path d="M20 6 9 17l-5-5"/>', 'edit': '<path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>', 'truck': '<path d="M1 3h15v13H1zM16 8h4l3 3v5h-7z"/><circle cx="5.5" cy="18.5" r="2"/><circle cx="18.5" cy="18.5" r="2"/>', 'skip': '<path d="m5 4 10 8-10 8zM19 5v14"/>', 'swap': '<path d="M17 3l4 4-4 4M21 7H8M7 21l-4-4 4-4M3 17h13"/>', 'swap2': '<path d="M17 3l4 4-4 4M21 7H8a5 5 0 0 0-5 5M7 21l-4-4 4-4M3 17h13a5 5 0 0 0 5-5"/>', 'cal': '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>', 'box': '<path d="M21 8 12 3 3 8v8l9 5 9-5zM3 8l9 5 9-5M12 13v8"/>', 'go': '<path d="m9 6 6 6-6 6"/>'};
QI.info='<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>'; QI.minus='<path d="M5 12h14"/>'; QI.plus='<path d="M12 5v14M5 12h14"/>';
const qIc = k=>`<svg class="qi" viewBox="0 0 24 24">${QI[k]}</svg>`;
/* ==================================== PICKING ==================================== */
/* Some items (fish, poultry…) never pass through the warehouse — the driver collects
   them straight from the supplier. They count as handled for the order, but are NOT
   deducted from stock (applyStockDeductions only counts completed/modified/substituted),
   because nothing physically left our shelves. */
function markFromSupplier(it, product){
  const vals = resolveAddedValues(it, product);
  it.status = 'from_supplier';
  it.actualQty = vals.actualQty;
  it.actualUnit = vals.actualUnit;
}
function resolveAddedValues(it, product){
  const conv = computeUnitConversion(it.requestedUnit, product && product.unit, it.requestedQty);
  if(conv) return { actualQty: round2(conv.convertedQty), actualUnit: product.unit };
  return { actualQty: it.requestedQty, actualUnit: it.requestedUnit };
}
/* Sort items exactly as they appeared in the imported file. The Sr. column
   alone isn't reliable for this — some sheets restart it partway through
   (multiple sections each numbered from 1), which scrambles a numeric sort.
   importIndex is the row's actual position at import time and is always
   monotonic; older orders imported before this field existed fall back to
   parsing the Sr. column, same as before. */
function importOrderCompare(a, b){
  const ai = a.importIndex ?? parseFloat(a.sr) ?? 0;
  const bi = b.importIndex ?? parseFloat(b.sr) ?? 0;
  return ai - bi;
}
/* the nearest already-resolved item that comes right before `current` in the
   order's real sequence (same scope as whatever the person is picking through) —
   backs the "← Previous" button so they can jump back to something they already
   picked/modified/etc. and see exactly what happened with it */
function findPreviousItem(scopeItems, current, orderObj){
  const resolved = scopeItems.filter(it=>
    it.id!==current.id &&
    it.status!=='pending' &&
    !(orderObj && (orderObj.postponed||[]).includes(it.id)) &&
    importOrderCompare(it, current) < 0
  );
  if(!resolved.length) return null;
  resolved.sort(importOrderCompare);
  return resolved[resolved.length-1];
}
/* the order's own wording is what should be shown while picking — the matched
   database product name is only supporting context, not the headline */
function matchDoubt(it){ return it.productId && it.productName && it.excelDesc ? mapRisk(it.excelDesc, it.productName) : {level:0}; }
function matchNote(it){
  const n = matchNote0(it); const d = matchDoubt(it);
  return n && d.level===2 ? '⚠ '+n+' — check this is right' : n;
}
function matchNote0(it){
  if(it.qtyAdjusted) return `Vessel asked for ${it.excelQty} ${it.excelUnit||''} — rounded to whole packs`.replace(/ +/g,' ') + (it.productId && it.productName && normalize(it.productName) !== normalize(it.excelDesc) ? ` · Matched to: ${it.productName}` : '');
  if(it.productId && it.productName && normalize(it.productName) !== normalize(it.excelDesc)) return `Matched to: ${it.productName}`;
  return '';
}
function itemStatusLabel(it, order){
  const isPostponed = (order.postponed||[]).includes(it.id);
  if(isPostponed) return {label:'Postponed', cls:'b-picked_later'};
  if(it.status==='completed') return {label:'Picked', cls:'b-completed'};
  if(it.status==='not_available') return {label:'Cancelled', cls:'b-not_available'};
  if(it.status==='from_supplier') return {label:'From supplier', cls:'b-from_supplier'};
  if(it.status==='pending') return {label:'Pending', cls:'b-pending'};
  return {label: it.status.charAt(0).toUpperCase()+it.status.slice(1), cls:'b-'+it.status};
}
/* what actually happened with an already-resolved item, for the "go back and check"
   view (Previous button / All items / search) — shows the recorded outcome, not
   just what was originally ordered */
function resolvedOutcomeLines(it, st){
  if(!st || st.label==='Pending' || st.label==='Postponed') return [];
  const lines = [];
  if(it.status==='substituted'){
    const rs = replacementsOf(it);
    if(rs.length>1) rs.forEach(r=> lines.push(`Substituted with: <b>${esc(r.name||'—')}</b> — ${r.qty} × ${esc(r.unit||'')}`));
    else {
      lines.push(`Substituted with: <b>${esc(it.replacementName||'—')}</b>`);
      if(it.actualQty!=null) lines.push(`Picked: ${it.actualQty} × ${esc(it.actualUnit||'')}`);
    }
  } else if(it.status==='modified'){
    lines.push(`Picked: <b>${it.actualQty} × ${esc(it.actualUnit||'')}</b> (ordered ${it.requestedQty} × ${esc(it.requestedUnit||'')})`);
  } else if(it.status==='completed'){
    lines.push(`Picked as ordered: ${it.actualQty} × ${esc(it.actualUnit||'')}`);
  } else if(it.status==='not_available'){
    lines.push(`Marked not available.`);
  } else if(it.status==='from_supplier'){
    lines.push(`Taken from supplier by driver: ${it.actualQty ?? it.requestedQty} × ${esc(it.actualUnit||it.requestedUnit||'')}`);
  }
  if(it.notes) lines.push(`Notes: ${esc(it.notes)}`);
  return lines;
}
function resolvedOutcomeHtml(it, st){
  const lines = resolvedOutcomeLines(it, st);
  if(!lines.length) return '';
  return `<div class="card" style="margin:10px 0; padding:10px 14px; background:var(--panel-2, rgba(0,0,0,.03));">
    ${lines.map(l=>`<p class="subtle" style="margin:2px 0;">${l}</p>`).join('')}
  </div>`;
}
/* one compact line for list rows (search results, All items) — same facts as
   resolvedOutcomeHtml but inline, since those views shouldn't need an extra tap
   just to see what actually happened to an already-resolved item */
function resolvedOutcomeInline(it, st){
  const lines = resolvedOutcomeLines(it, st);
  return lines.length ? lines.join(' · ') : '';
}

/* re-sync an order item's snapshot fields (warehouse/section/sort position) after
   its underlying product was just edited — needed when a product is completed
   (or corrected) mid-order, not just at initial import matching */
async function resyncItemSnapshot(it, product){
  const [warehouses, sections] = await Promise.all([getAll('warehouses'), getAll('sections')]);
  const wh = warehouses.find(w=>w.id===product.warehouseId);
  const sec = sections.find(s=>s.id===product.sectionId);
  it.warehouseId = product.warehouseId || '';
  it.warehouseName = wh ? wh.name : '';
  it.sectionName = sec ? sec.name : '';
  it.sortKey = [wh ? wh.priority : 9999, sec ? sec.priority : 9999, product.priority ?? 9999];
  it.productName = product.name;
  await put('orderItems', it);
}

/* Points an order line at a different product (wrong/old match). Updates the line's name,
   warehouse, section and picking position. If the order is already finished its stock was
   already deducted from the OLD product, so the picked quantity is moved over to the new one.
   Returns {moved, qty, oldName} so the caller can tell the person what happened. */
async function relinkOrderItem(itemId, newProduct){
  const it = await getOne('orderItems', itemId);
  const order = await getOne('orders', it.orderId);
  const oldProduct = it.productId ? await getOne('products', it.productId) : null;
  let moved = false;
  const counts = (it.status==='completed' || it.status==='modified') && typeof it.actualQty==='number' && !isNaN(it.actualQty);
  if(order && order.stockApplied && counts){
    if(oldProduct && isStockTracked(oldProduct)){
      await restoreAllocs(it);
      oldProduct.stockQty = round2(parseFloat(oldProduct.stockQty) + it.actualQty);
      await put('products', oldProduct); moved = true;
    }
    if(isStockTracked(newProduct)){
      newProduct.stockQty = round2(parseFloat(newProduct.stockQty) - it.actualQty);
      await put('products', newProduct); moved = true;
    }
    await reconcileBatches([oldProduct && oldProduct.id, newProduct.id]);
    it.batchAllocs = null;
  }
  it.batchChoice = '';
  it.productId = newProduct.id;
  it.matchType = 'confirmed';
  await resyncItemSnapshot(it, newProduct);
  return {moved, qty: it.actualQty, oldName: oldProduct ? oldProduct.name : '', newName: newProduct.name};
}

/* shared "pick a different product for this line" flow (item popup + finished-order summary) */
async function changeItemProduct(itemId, onDone){
  const it = await getOne('orderItems', itemId);
  const order = await getOne('orders', it.orderId);
  const [products, warehouses, sections] = await Promise.all([getAll('products'), getAll('warehouses'), getAll('sections')]);
  const whMap = Object.fromEntries(warehouses.map(w=>[w.id,w]));
  const secMap = Object.fromEntries(sections.map(s=>[s.id,s]));
  openProductPicker(it, products, whMap, secMap, (picked)=>{
    if(picked.id===it.productId){ onDone(); return; }
    const go = async ()=>{
      const r = await relinkOrderItem(itemId, picked);
      if(r.moved) showAlert(`Moved ${r.qty} from “${r.oldName}” to “${r.newName}” in stock.`, 'Stock corrected');
      onDone();
    };
    if(order.stockApplied && (it.status==='completed'||it.status==='modified')){
      showConfirm(`This order is already finished, so its stock was taken off “${it.productName}”. Switch this line to “${picked.name}” and move ${it.actualQty} of stock across?`, go);
    } else go();
  });
}

function openDateModal(it, onSaved){
  showModal(`<h3>Production / expiry date — ${esc(it.productName)}</h3>
    <p class="subtle">For fresh or same-day items. This is recorded for this order only — the product's own database record is untouched.</p>
    <div class="field"><label>Production date</label><input type="date" id="d_prod" value="${it.actualProductionDate || todayISO()}"></div>
    ${expiryFieldHtml('d', {expiryDate: it.actualExpiryDate || '', mode: it.actualExpiryMode, shelfAmount: it.actualExpiryShelfAmount, shelfUnit: it.actualExpiryShelfUnit})}
    <div style="display:flex; gap:10px; margin-top:10px;">
      <button class="btn btn-signal" id="d_save" style="flex:1;">Save dates</button>
      <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
    </div>`);
  wireExpiryField('d', 'd_prod');
  $('#d_save').onclick = async ()=>{
    it.actualProductionDate = $('#d_prod').value;
    it.actualExpiryDate = $('#d_edate').value;
    it.actualExpiryMode = expiryModeOf('d');
    it.actualExpiryShelfAmount = $('#d_shelf_amount').value ? parseFloat($('#d_shelf_amount').value) : '';
    it.actualExpiryShelfUnit = $('#d_shelf_unit').value;
    await put('orderItems', it);
    closeModal();
    onSaved();
  };
}

async function storeHubScreen(orderId){
  const order = await getOne('orders', orderId);
  const items = (await getAll('orderItems')).filter(it=>it.orderId===orderId);
  const byId = Object.fromEntries(items.map(it=>[it.id, it]));
  const pendingIds = (order.queue||[]).filter(id=>byId[id] && byId[id].status==='pending');
  const pickMode = await getPickingMode();

  if(!pendingIds.length){
    location.hash = `#/order/${orderId}/postponed`;
    return;
  }

  const groups = new Map(); // warehouseId -> {name, count}
  for(const id of pendingIds){
    const it = byId[id];
    const key = it.warehouseId || 'none';
    if(!groups.has(key)) groups.set(key, {name: it.warehouseName || 'Unassigned', count:0});
    groups.get(key).count++;
  }
  const totalAll = items.filter(it=>it.status!=='not_available').length;
  const doneAll = totalAll - pendingIds.length - (order.postponed||[]).length;

  const slw = await shelfLifeWarnings(items);
  $('#main').innerHTML = `
    <div class="topbar"><h1>Pick by store</h1></div>
    <p class="subtle" style="margin-top:-10px;">${esc(order.vessel)} · ${esc(order.orderNumber)} — ${doneAll} of ${totalAll} items picked overall.</p>
    ${shelfLifeBannerHtml(slw)}
    <div class="card" style="margin-bottom:16px; display:flex; align-items:center; gap:12px; flex-wrap:wrap;">
      <span class="subtle" style="font-weight:700;">Heading to:</span>
      ${order.destination ? destinationBadge(order.destination, 'lg') : '<span class="subtle">No destination set</span>'}
      <button class="btn btn-ghost btn-sm" id="hubEditDest" style="margin-left:auto;">✎ ${order.destination?'Change':'Set destination'}</button>
    </div>
    <div class="card" style="margin-bottom:16px;">
      ${[...groups.entries()].map(([whId,g])=>`
        <div class="list-row">
          <div class="thumb">▥</div>
          <div style="flex:1;"><b>${whDot(whId)}${esc(g.name)}</b><div class="subtle">${g.count} item${g.count===1?'':'s'} remaining</div></div>
          <a href="#/order/${orderId}/pick/${whId}" class="btn btn-signal btn-sm">Start</a>
        </div>`).join('')}
    </div>
    <div class="card" style="margin-bottom:16px;">
      <div class="section-title" style="margin-bottom:8px;">Picking style</div>
      <div class="tag-row" id="modeToggle" style="margin-bottom:0;">
        <button class="chip ${pickMode==='single'?'active':''}" data-mode="single">One at a time</button>
        <button class="chip ${pickMode==='batch'?'active':''}" data-mode="batch">Multiple at once (${BATCH_SIZE})</button>
      </div>
    </div>
    <div style="display:flex; gap:10px; flex-wrap:wrap;">
      <button class="btn btn-ghost btn-sm" id="hubAddItem">+ Add item (client added this after)</button>
      <button class="btn btn-ghost btn-sm" id="hubSearch">🔍 Search &amp; pick an item</button>
      <a href="#/order/${orderId}/items" class="btn btn-ghost btn-sm">📋 View all items</a>
      <button class="btn btn-ghost btn-sm" id="hubPartial">⬇ Partial report</button>
      <a href="#/order/${orderId}/pick/all" class="btn btn-ghost btn-sm">Go through all stores in priority order instead</a>
      <a href="#/order/${orderId}/postponed" class="btn btn-ghost btn-sm">Postponed (${(order.postponed||[]).length})</a>
      <a href="#/order/${orderId}/boxes" class="btn btn-ghost btn-sm">📦 Supplier deliveries</a>
      <a href="#/orders" class="btn btn-ghost btn-sm">⏸ Save &amp; pause</a>
    </div>`;
  $('#hubPartial').onclick = async ()=>{ await exportPartialReport(orderId); storeHubScreen(orderId); };
  $('#hubSearch').onclick = ()=> openSearchPick(orderId, ()=>storeHubScreen(orderId));
  $('#hubEditDest').onclick = ()=> openDestinationModal(order, ()=>storeHubScreen(orderId));
  $('#hubAddItem').onclick = ()=> openAddItemModal(orderId, ()=>storeHubScreen(orderId));
  $('#modeToggle').onclick = async e=>{
    const b = e.target.closest('[data-mode]'); if(!b) return;
    await setPickingMode(b.dataset.mode);
    storeHubScreen(orderId);
  };
}

/* ------------------------- search & jump to any item ------------------------- */
function openSearchPick(orderId, onReturn){
  showModal(`
    <h3>Search order items</h3>
    <div class="field"><input type="text" id="sp_q" placeholder="Search by product name or Sr. number…" autofocus></div>
    <div id="sp_results" style="max-height:380px; overflow:auto;"></div>
    <button class="btn btn-ghost" style="margin-top:10px;" onclick="closeModal()">Close</button>`);

  async function draw(q){
    const order = await getOne('orders', orderId);
    // search ALL items, not just pending ones — this is also how someone finds an
    // already-modified/substituted item to go back and check what happened to it
    const items = (await getAll('orderItems')).filter(it=>it.orderId===orderId);
    const nq = normalize(q);
    const qTrim = q.trim();
    const filtered = !nq ? items : items.filter(it=>
      normalize(it.excelDesc).includes(nq) || normalize(it.productName||'').includes(nq) ||
      (qTrim && String(it.sr||'').toLowerCase().includes(qTrim.toLowerCase()))
    );
    filtered.sort((a,b)=>importOrderCompare(a,b));
    $('#sp_results').innerHTML = filtered.length ? filtered.slice(0,60).map(it=>{
      const st = itemStatusLabel(it, order);
      const outcome = resolvedOutcomeInline(it, st);
      return `<div class="list-row" data-pick="${it.id}" style="cursor:pointer;">
        <div class="thumb">📦</div>
        <div style="flex:1;">
          <b>${it.sr?`Sr. ${esc(it.sr)} · `:''}${esc(it.excelDesc)}</b>
          <div class="subtle">${it.requestedQty} ${esc(it.requestedUnit)} · ${esc(it.warehouseName||'Unassigned')}${matchNote(it)?' · '+esc(matchNote(it)):''}</div>
          ${outcome ? `<div class="subtle">${outcome}</div>` : ''}
        </div>
        <span class="badge ${st.cls}">${st.label}</span>
      </div>`;
    }).join('') : `<p class="subtle">No matching items.</p>`;
    $('#sp_results').querySelectorAll('[data-pick]').forEach(row=>row.addEventListener('click', ()=>{
      closeModal();
      openItemActionModal(orderId, row.dataset.pick, onReturn);
    }));
  }
  $('#sp_q').oninput = e=>draw(e.target.value);
  draw('');
}

async function unpostpone(orderId, itemId){
  const order = await getOne('orders', orderId);
  if(order.postponed && order.postponed.includes(itemId)){
    order.postponed = order.postponed.filter(x=>x!==itemId);
    await put('orders', order);
  }
}

/* quick action card for a specific item, out of normal queue order */
async function openItemActionModal(orderId, itemId, onDone){
  const it = await getOne('orderItems', itemId);
  const order = await getOne('orders', orderId);
  const product = it.productId ? await getOne('products', it.productId) : null;
  const supplier = product && product.supplierId ? await getOne('suppliers', product.supplierId) : null;
  const conv = product ? computeUnitConversion(it.requestedUnit, product.unit, it.requestedQty) : null;
  const expiryToShow = it.actualExpiryDate ? fmtDate(it.actualExpiryDate) + ' (set for this order)' : (product && product.expiryDate ? fmtDate(product.expiryDate) : '—');
  const st = itemStatusLabel(it, order);
  showModal(`
    <h3>${esc(it.excelDesc)}</h3>
    ${lineChangedHtml(it)}
    <p style="margin-top:-8px;">${it.sr?`<span class="subtle">Sr. ${esc(it.sr)} · </span>`:''}<span class="badge ${st.cls}">${st.label}</span></p>
    ${matchNote(it) ? `<p class="subtle" style="margin-top:-4px;">${esc(matchNote(it))}</p>` : ''}
    ${conv ? `
      <p style="font-size:1.4rem; font-weight:700; color:var(--signal); margin-bottom:0;">${round2(conv.convertedQty)} × ${esc(product.unit)}</p>
      <p class="subtle" style="margin-top:2px;">Ordered as: ${it.requestedQty} × ${esc(it.requestedUnit)}</p>
    ` : `<p style="font-size:1.4rem; font-weight:700; margin-bottom:10px;">${it.requestedQty} × ${esc(it.requestedUnit||'')}</p>`}
    <div class="qa-meta"><span class="qa-chip">${esc(it.warehouseName||'Unassigned')}${it.sectionName?' / '+esc(it.sectionName):''}</span>${supplier?`<span class="qa-chip">${esc(supplier.name)}</span>`:''}<span class="qa-chip">Exp ${expiryToShow}</span></div>
    ${product && !product.warehouseId ? `<p style="margin:8px 0;"><span class="badge b-unmatched">needs setup</span></p>` : ''}
    ${resolvedOutcomeHtml(it, st)}
    <button class="qa-primary" id="qa_add">${qIc('check')}Product Added</button>
    <div class="qa-tiles">
      <button class="qa-tile" id="qa_modify">${qIc('edit')}Modify</button>
      <button class="qa-tile" id="qa_supplier">${qIc('truck')}From supplier</button>
      <button class="qa-tile" id="qa_later">${qIc('skip')}Pick later</button>
    </div>
    <div class="qa-lbl">This line</div>
    <div class="qa-list">
      <button class="qa-row warn" id="qa_editline">${qIc('swap2')}<span>Customer changed this line<small>Quantity, unit or a different product</small></span>${qIc('go')}</button>
      ${it.productId && order.status!=='completed' ? `<button class="qa-row" id="qa_relink">${qIc('swap')}<span>Wrong match? Change product</span>${qIc('go')}</button>` : ''}
      <button class="qa-row" id="qa_dates">${qIc('cal')}<span>Production / expiry date</span>${qIc('go')}</button>
      ${product ? `<button class="qa-row" id="qa_complete">${qIc('box')}<span>Edit product details</span>${qIc('go')}</button>` : ''}
    </div>
    <button class="qa-close" onclick="closeModal()">Close</button>`);
  function finish(){ closeModal(); onDone(); }
  $('#qa_add').onclick = async ()=>{
    const vals = resolveAddedValues(it, product);
    it.status='completed'; it.actualQty=vals.actualQty; it.actualUnit=vals.actualUnit; lookFeedback('ok');
    await put('orderItems', it);
    await unpostpone(orderId, it.id);
    finish();
  };
  $('#qa_later').onclick = async ()=>{
    const order = await getOne('orders', orderId);
    order.postponed = order.postponed || [];
    if(!order.postponed.includes(it.id)) order.postponed.push(it.id);
    order.queue = (order.queue||[]).filter(id=>id!==it.id);
    await put('orders', order);
    finish();
  };
  $('#qa_modify').onclick = ()=> openModifyModal(it, product, async ()=>{ await unpostpone(orderId, it.id); finish(); });
  $('#qa_supplier').onclick = async ()=>{
    markFromSupplier(it, product);
    await put('orderItems', it);
    await unpostpone(orderId, it.id);
    finish();
  };
  $('#qa_editline').onclick = ()=>{ closeModal(); openEditLineModal(it, onDone); };
  if($('#qa_relink')) $('#qa_relink').onclick = ()=>{ closeModal(); changeItemProduct(itemId, onDone); };
  $('#qa_dates').onclick = ()=> openDateModal(it, ()=> openItemActionModal(orderId, itemId, onDone));
  if($('#qa_complete')) $('#qa_complete').onclick = async ()=>{
    const [warehouses, sections, suppliers] = await Promise.all([getAll('warehouses'), getAll('sections'), getAll('suppliers')]);
    openProductForm(product, warehouses, sections, suppliers, async (savedProduct)=>{
      await resyncItemSnapshot(it, savedProduct);
      openItemActionModal(orderId, itemId, onDone);
    });
  };
}

async function afterPickAdvance(orderId, warehouseId){
  const order = await getOne('orders', orderId);
  const items = (await getAll('orderItems')).filter(it=>it.orderId===orderId);
  const byId = Object.fromEntries(items.map(it=>[it.id, it]));
  const globalPending = (order.queue||[]).filter(id=>byId[id] && byId[id].status==='pending');
  if(!globalPending.length){
    location.hash = `#/order/${orderId}/postponed`;
    return;
  }
  if(warehouseId){
    const scopedRemaining = globalPending.filter(id=>(byId[id].warehouseId||'none')===warehouseId);
    if(!scopedRemaining.length){
      location.hash = `#/order/${orderId}/pick`;
      render();
      return;
    }
  }
  location.hash = `#/order/${orderId}/pick/${warehouseId||'all'}`;
  render();
}

async function pickingItemScreen(orderId, warehouseId){
  const order = await getOne('orders', orderId);
  let items = (await getAll('orderItems')).filter(it=>it.orderId===orderId);
  const byId = Object.fromEntries(items.map(it=>[it.id, it]));
  let queue = (order.queue||[]).filter(id=>byId[id] && byId[id].status==='pending' && (!warehouseId || (byId[id].warehouseId||'none')===warehouseId));

  if(!queue.length){
    // nothing left in this scope — bounce to hub (or postponed if truly nothing left anywhere)
    await afterPickAdvance(orderId, warehouseId);
    return;
  }
  const scopeItems = items.filter(it=> it.status!=='not_available' && (!warehouseId || (it.warehouseId||'none')===warehouseId));
  const scopeTotal = scopeItems.length;
  const scopePostponed = (order.postponed||[]).filter(id=>byId[id] && (!warehouseId || (byId[id].warehouseId||'none')===warehouseId)).length;
  const scopeDone = scopeTotal - queue.length - scopePostponed;

  const curId = queue[0];
  const it = byId[curId];
  const product = it.productId ? await getOne('products', it.productId) : null;
  const supplier = product && product.supplierId ? await getOne('suppliers', product.supplierId) : null;
  const conv = product ? computeUnitConversion(it.requestedUnit, product.unit, it.requestedQty) : null;
  const expiryToShow = it.actualExpiryDate ? fmtDate(it.actualExpiryDate) + ' (set for this order)' : (product && product.expiryDate ? fmtDate(product.expiryDate) : '—');
  const storeLabel = warehouseId ? (it.warehouseName || 'Unassigned') : 'All stores';
  const prevItem = findPreviousItem(scopeItems, it, order);
  const batchInfo = product ? await pickBatchCardHtml(it, product) : {html:'', sug:null};

  $('#main').innerHTML = `
    <div class="pick-wrap">
      <div class="pick-progress">
        <span>${esc(storeLabel)} · Item ${scopeDone+1} of ${scopeTotal}${it.sr?' · Sr. '+esc(it.sr):''}</span>
        <div class="pick-bar"><div style="width:${Math.round((scopeDone)/scopeTotal*100)}%"></div></div>
      </div>
      <div style="display:flex; justify-content:space-between; margin-bottom:12px; gap:10px; flex-wrap:wrap;">
        <a href="#/order/${orderId}/pick" class="subtle" style="text-decoration:underline;">↩ Switch store</a>
        <a href="#/order/${orderId}/items" class="subtle" style="text-decoration:underline;">📋 All items</a>
        ${prevItem ? `<button class="btn btn-ghost btn-sm" id="pk_prev">← Previous</button>` : ''}
        <button class="btn btn-ghost btn-sm" id="pk_search">🔍 Search</button>
        <button class="btn btn-ghost btn-sm" id="pk_batchmode">☰ Pick multiple at once</button>
        <a href="#/order/${orderId}/postponed" class="subtle" style="text-decoration:underline;">Postponed (${(order.postponed||[]).length})</a>
      </div>
      <div class="pick-card">
        <div class="pick-thumb">${product&&product.image?`<img src="${product.image}" decoding="async">`:'📦'}</div>
        <h2 class="pick-name">${esc(it.excelDesc)}</h2>
        ${lineChangedHtml(it)}
        ${matchNote(it) ? `<p class="subtle" style="margin-top:-8px;">${esc(matchNote(it))}</p>` : ''}
        ${conv ? `
          <div class="pick-qty">${round2(conv.convertedQty)} × ${esc(product.unit)}</div>
          <div class="subtle" style="margin-top:-10px; margin-bottom:14px;">Ordered as: ${it.requestedQty} × ${esc(it.requestedUnit)}</div>
        ` : `
          <div class="pick-qty">${it.requestedQty} × ${esc(it.requestedUnit||'')}</div>
        `}
        ${batchInfo.html}
        <div class="pick-meta">
          <div><b>Warehouse</b>${esc(it.warehouseName)||'—'}</div>
          <div><b>Section</b>${esc(it.sectionName)||'—'}</div>
          <div><b>Expiry</b>${expiryToShow}</div>
          <div><b>Supplier</b>${supplier?esc(supplier.name):'—'}</div>
        </div>
        <div style="margin:4px 0 12px; display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
          ${product && !product.warehouseId ? `<span class="badge b-unmatched">needs setup</span>` : ''}
          ${product ? `<button class="btn btn-ghost btn-sm" id="pk_complete">✎ Edit product details</button>` : ''}
        </div>
        <button class="btn btn-ghost btn-sm" id="pk_editline" style="margin-bottom:6px;">✎ Customer changed this line</button>
        <button class="btn btn-ghost btn-sm" id="pk_dates" style="margin-bottom:6px;">📅 Set production / expiry date</button>
        <div class="pick-actions">
          <button class="btn btn-success btn-lg" id="pk_added">✓ Product Added</button>
          <button class="btn btn-ghost btn-lg" id="pk_modify">✎ Modify</button>
          <button class="btn btn-ghost btn-lg" id="pk_supplier">🚚 From Supplier</button>
          <button class="btn btn-ghost btn-lg" id="pk_later">⏭ Pick Later</button>
        </div>
      </div>
      <div style="text-align:center; margin-top:16px;">
        <a href="#/orders" class="btn btn-ghost btn-sm">⏸ Save &amp; pause — continue later</a>
        <p class="subtle" style="margin-top:8px;">Every action saves instantly — closing the app or leaving mid-order is safe.</p>
      </div>
    </div>`;

  $('#pk_search').onclick = ()=> openSearchPick(orderId, ()=>{ location.hash = `#/order/${orderId}/pick/${warehouseId||'all'}`; render(); });
  $('#pk_batchmode').onclick = async ()=>{ await setPickingMode('batch'); location.hash = `#/order/${orderId}/pick/${warehouseId||'all'}`; render(); };
  if($('#pk_prev')) $('#pk_prev').onclick = ()=> openItemActionModal(orderId, prevItem.id, ()=>{ location.hash = `#/order/${orderId}/pick/${warehouseId||'all'}`; render(); });
  if(product) bindPickBatch(it, product, batchInfo, ()=>{ location.hash = `#/order/${orderId}/pick/${warehouseId||'all'}`; render(); });
  $('#pk_editline').onclick = ()=> openEditLineModal(it, ()=>{ render(); });
  $('#pk_dates').onclick = ()=> openDateModal(it, ()=>{ location.hash = `#/order/${orderId}/pick/${warehouseId||'all'}`; render(); });
  if($('#pk_complete')) $('#pk_complete').onclick = async ()=>{
    const [warehouses, sections, suppliers] = await Promise.all([getAll('warehouses'), getAll('sections'), getAll('suppliers')]);
    openProductForm(product, warehouses, sections, suppliers, async (savedProduct)=>{
      await resyncItemSnapshot(it, savedProduct);
      location.hash = `#/order/${orderId}/pick/${warehouseId||'all'}`; render();
    });
  };
  $('#pk_added').onclick = async ()=>{
    const vals = resolveAddedValues(it, product);
    it.status='completed'; it.actualQty=vals.actualQty; it.actualUnit=vals.actualUnit; lookFeedback('ok');
    await put('orderItems', it);
    await advance();
  };
  $('#pk_later').onclick = async ()=>{
    order.postponed = order.postponed || [];
    order.postponed.push(it.id);
    order.queue = (order.queue||[]).filter(id=>id!==it.id);
    await put('orders', order);
    await advance();
  };
  $('#pk_modify').onclick = ()=> openModifyModal(it, product, async ()=>{ await advance(); });
  $('#pk_supplier').onclick = async ()=>{
    markFromSupplier(it, product);
    await put('orderItems', it);
    await advance();
  };

  async function advance(){
    await afterPickAdvance(orderId, warehouseId);
  }
}

async function pickingBatchScreen(orderId, warehouseId){
  const order = await getOne('orders', orderId);
  const items = (await getAll('orderItems')).filter(it=>it.orderId===orderId);
  const byId = Object.fromEntries(items.map(it=>[it.id, it]));
  let queue = (order.queue||[]).filter(id=>byId[id] && byId[id].status==='pending' && (!warehouseId || (byId[id].warehouseId||'none')===warehouseId));

  if(!queue.length){
    await afterPickAdvance(orderId, warehouseId);
    return;
  }

  const scopeItems = items.filter(it=> it.status!=='not_available' && (!warehouseId || (it.warehouseId||'none')===warehouseId));
  const scopeTotal = scopeItems.length;
  const scopePostponed = (order.postponed||[]).filter(id=>byId[id] && (!warehouseId || (byId[id].warehouseId||'none')===warehouseId)).length;
  const scopeDone = scopeTotal - queue.length - scopePostponed;

  const batchIds = queue.slice(0, BATCH_SIZE);
  const productsCache = {};
  for(const id of batchIds){
    const it = byId[id];
    if(it.productId && !productsCache[it.productId]) productsCache[it.productId] = await getOne('products', it.productId);
  }
  const storeLabel = warehouseId ? (byId[batchIds[0]].warehouseName || 'Unassigned') : 'All stores';
  const prevItem = findPreviousItem(scopeItems, byId[batchIds[0]], order);
  const anyTracked = Object.values(productsCache).some(batchTracked);
  const [allBatches, batchSt] = anyTracked ? await Promise.all([getAll('batches'), getBatchSettings()]) : [[], {minMonths:2}];
  const sugOf = (it, product)=> batchTracked(product) ? pickSuggestion(allBatches, product.id, it.batchChoice, batchSt.minMonths) : null;

  $('#main').innerHTML = `
    <div class="pick-wrap">
      <div class="pick-progress">
        <span>${esc(storeLabel)} · Items ${scopeDone+1}–${Math.min(scopeDone+batchIds.length, scopeTotal)} of ${scopeTotal}</span>
        <div class="pick-bar"><div style="width:${Math.round(scopeDone/scopeTotal*100)}%"></div></div>
      </div>
      <div style="display:flex; justify-content:space-between; margin-bottom:12px; gap:10px; flex-wrap:wrap;">
        <a href="#/order/${orderId}/pick" class="subtle" style="text-decoration:underline;">↩ Switch store</a>
        <a href="#/order/${orderId}/items" class="subtle" style="text-decoration:underline;">📋 All items</a>
        ${prevItem ? `<button class="btn btn-ghost btn-sm" id="pk_prev">← Previous</button>` : ''}
        <button class="btn btn-ghost btn-sm" id="pk_search">🔍 Search</button>
        <button class="btn btn-ghost btn-sm" id="pk_singlemode">○ Back to one at a time</button>
        <a href="#/order/${orderId}/postponed" class="subtle" style="text-decoration:underline;">Postponed (${(order.postponed||[]).length})</a>
      </div>
      <div class="card" id="batchList">
        ${batchIds.map(id=>{
          const it = byId[id];
          const product = it.productId ? productsCache[it.productId] : null;
          const conv = product ? computeUnitConversion(it.requestedUnit, product.unit, it.requestedQty) : null;
          const qtyNum = conv ? round2(conv.convertedQty) : it.requestedQty;
          const qtyUnit = conv ? product.unit : (it.requestedUnit||'');
          const metaBits = [
            conv ? `ordered ${it.requestedQty} × ${esc(it.requestedUnit)}` : '',
            it.sectionName ? esc(it.sectionName) : ''
          ].filter(Boolean).join(' · ');
          return `<div class="list-row batch-row">
            <input type="checkbox" class="batch-check" data-check="${id}">
            <div class="thumb">${product&&product.image?`<img src="${product.image}" loading="lazy" decoding="async">`:'📦'}</div>
            <div style="flex:1; min-width:0; cursor:pointer;" data-openitem="${id}">
              <div class="batch-name">${esc(it.excelDesc)}</div>
              <div class="batch-qty-box">${qtyNum}<span class="unit">${esc(qtyUnit)}</span></div>
              ${metaBits ? `<div class="subtle batch-meta">${metaBits}</div>` : ''}
              ${product ? batchMiniHtml(sugOf(it, product), product, batchSt.minMonths, id) : ''}
            </div>
          </div>`;
        }).join('')}
      </div>
      <div class="pick-actions" style="margin-top:14px;">
        <button class="btn btn-success btn-lg" id="batch_confirm" disabled>✓ Mark checked as picked (0)</button>
      </div>
      <p class="subtle" style="text-align:center; margin-top:10px;">Tap an item to modify it, substitute it, set dates, or pick it later instead — only the checked ones get marked picked.</p>
      <div style="text-align:center; margin-top:10px;">
        <a href="#/orders" class="btn btn-ghost btn-sm">⏸ Save &amp; pause</a>
      </div>
    </div>`;

  function refresh(){ location.hash = `#/order/${orderId}/pick/${warehouseId||'all'}`; render(); }

  function updateConfirmBtn(){
    const checked = $('#batchList').querySelectorAll('.batch-check:checked').length;
    const btn = $('#batch_confirm');
    btn.disabled = checked===0;
    btn.textContent = `✓ Mark checked as picked (${checked})`;
  }
  $('#batchList').querySelectorAll('.batch-check').forEach(cb=>cb.onchange = updateConfirmBtn);
  $('#batchList').querySelectorAll('[data-openitem]').forEach(row=>row.onclick = (e)=>{
    const chg = e.target.closest('[data-chbatch]');
    if(chg){
      e.stopPropagation();
      const it = byId[chg.dataset.chbatch], product = productsCache[it.productId];
      openBatchChooser(it, product, sugOf(it, product), batchSt.minMonths, refresh);
      return;
    }
    openItemActionModal(orderId, row.dataset.openitem, refresh);
  });
  $('#batch_confirm').onclick = async ()=>{
    const checkedIds = [...$('#batchList').querySelectorAll('.batch-check:checked')].map(cb=>cb.dataset.check);
    for(const id of checkedIds){
      const it = byId[id];
      const product = it.productId ? productsCache[it.productId] : null;
      const vals = resolveAddedValues(it, product);
      it.status='completed'; it.actualQty=vals.actualQty; it.actualUnit=vals.actualUnit; lookFeedback('ok');
      await put('orderItems', it);
    }
    refresh();
  };
  $('#pk_search').onclick = ()=> openSearchPick(orderId, refresh);
  $('#pk_singlemode').onclick = async ()=>{ await setPickingMode('single'); refresh(); };
  if($('#pk_prev')) $('#pk_prev').onclick = ()=> openItemActionModal(orderId, prevItem.id, refresh);
}

function openModifyModal(it, product, onDone){
  const conv = product ? computeUnitConversion(it.requestedUnit, product.unit, it.requestedQty) : null;
  const prefillQty = conv ? round2(conv.convertedQty) : it.requestedQty;
  const prefillUnit = conv ? (product.unit||'') : it.requestedUnit;
  showModal(`<div class="mod-pop"><h3>Modify</h3>
    <p class="mod-sub">${esc(it.excelDesc)}${matchNote(it) ? ' · '+esc(matchNote(it)).replace(/^Matched to:\s*/i,'matched to ') : ''}</p>
    ${conv ? `<div class="mod-info">${qIc('info')}<div>Ordered as <b>${it.requestedQty} × ${esc(it.requestedUnit)}</b>, converted to <b>${prefillQty} × ${esc(prefillUnit)}</b>. Adjust below if needed.</div></div>` : ''}
    <div id="m_normalqty" style="display:${it.status==='substituted'?'none':''};">
      <div class="qa-lbl">What you picked</div>
      <div class="mod-grid">
        <div class="mod-qty"><button type="button" class="mod-step" id="m_minus" aria-label="Less">${qIc('minus')}</button><input type="number" id="m_qty" value="${prefillQty}" step="any" inputmode="decimal"><button type="button" class="mod-step" id="m_plus" aria-label="More">${qIc('plus')}</button></div>
        <input type="text" id="m_unit" value="${esc(prefillUnit)}" class="mod-unit" aria-label="Unit">
      </div>
    </div>
    <label class="mod-toggle" for="m_sub">${qIc('swap2')}<span>Substitute with a different product<small>Customer got something else instead</small></span><input type="checkbox" id="m_sub" ${it.status==='substituted'?'checked':''}><i class="mod-sw"></i></label>
    <div id="m_subwrap" style="display:${it.status==='substituted'?'block':'none'};">
      <div class="qa-lbl">Replacement products — each with its own quantity</div>
      <div id="m_subrows"></div>
      <button type="button" class="btn btn-ghost btn-sm" id="m_subadd" style="margin-bottom:12px;">+ Add another product</button>
    </div>
    <div class="qa-lbl">Dates</div>
    <div class="field"><label>Production date (optional)</label><input type="date" id="m_prod" value="${it.actualProductionDate||''}"></div>
    ${expiryFieldHtml('m', {expiryDate: it.actualExpiryDate || '', mode: it.actualExpiryMode, shelfAmount: it.actualExpiryShelfAmount, shelfUnit: it.actualExpiryShelfUnit})}
    <div class="qa-lbl">Notes</div>
    <div class="field"><textarea id="m_notes" rows="2" placeholder="Optional"></textarea></div>
    <div class="mod-bar">
      <button class="qa-primary mod-save" id="m_save">${qIc('check')}Save &amp; continue</button>
      <button class="mod-cancel" onclick="closeModal()">Cancel</button>
    </div></div>`);
  $('#m_minus').onclick = ()=>{ const v=parseFloat($('#m_qty').value)||0; $('#m_qty').value = Math.max(0, +(v-1).toFixed(6)); };
  $('#m_plus').onclick = ()=>{ const v=parseFloat($('#m_qty').value)||0; $('#m_qty').value = +(v+1).toFixed(6); };
  wireExpiryField('m', 'm_prod');
  // one row per replacement product: {productId, name, qty, unit}
  let subs = replacementsOf(it).map(r=>({productId:r.productId, name:r.name, qty:r.qty, unit:r.unit}));
  let pickerProducts=null, pickerWhMap=null, pickerSecMap=null;
  function drawSubs(){
    $('#m_subrows').innerHTML = subs.map((r,i)=>`
      <div class="card" style="padding:10px; margin-bottom:8px;">
        <button type="button" class="btn btn-ghost btn-sm" data-pick="${i}" style="width:100%; justify-content:flex-start; text-align:left;">${r.productId ? esc(r.name) : 'Tap to choose a product from the database…'}</button>
        <div style="display:flex; gap:8px; margin-top:8px; align-items:flex-end;">
          <div class="field" style="flex:1; margin:0;"><label>Quantity</label><input type="number" step="any" data-qty="${i}" value="${r.qty ?? ''}"></div>
          <div class="field" style="flex:1; margin:0;"><label>Unit</label><input type="text" data-unit="${i}" value="${esc(r.unit||'')}"></div>
          ${subs.length>1 ? `<button type="button" class="iconbtn" data-rm="${i}" title="Remove">✕</button>` : ''}
        </div>
      </div>`).join('');
    $('#m_subrows').querySelectorAll('[data-qty]').forEach(e=>e.oninput=()=>{ const v=parseFloat(e.value); subs[+e.dataset.qty].qty = isNaN(v)?'':v; });
    $('#m_subrows').querySelectorAll('[data-unit]').forEach(e=>e.oninput=()=>{ subs[+e.dataset.unit].unit = e.value; });
    $('#m_subrows').querySelectorAll('[data-rm]').forEach(e=>e.onclick=()=>{ subs.splice(+e.dataset.rm,1); drawSubs(); });
    $('#m_subrows').querySelectorAll('[data-pick]').forEach(e=>e.onclick=()=> pickFor(+e.dataset.pick));
  }
  if(!subs.length) subs.push({productId:'', name:'', qty:prefillQty, unit:prefillUnit});
  drawSubs();
  $('#m_subadd').onclick = ()=>{ subs.push({productId:'', name:'', qty:'', unit:''}); drawSubs(); };
  $('#m_sub').onchange = e=>{
    $('#m_subwrap').style.display = e.target.checked ? 'block' : 'none';
    $('#m_normalqty').style.display = e.target.checked ? 'none' : '';
  };
  async function pickFor(idx){
    if(!pickerProducts){
      const [products, warehouses, sections] = await Promise.all([getAll('products'), getAll('warehouses'), getAll('sections')]);
      pickerProducts = products;
      pickerWhMap = Object.fromEntries(warehouses.map(w=>[w.id,w]));
      pickerSecMap = Object.fromEntries(sections.map(s=>[s.id,s]));
    }
    openProductPicker(it, pickerProducts, pickerWhMap, pickerSecMap, (picked)=>{
      subs[idx].productId = picked.id; subs[idx].name = picked.name;
      if(!subs[idx].unit) subs[idx].unit = picked.unit || '';
      drawSubs();
      if(idx!==0) return; // the dates below describe the first replacement
      // prefill from the replacement's own catalog dates — still editable, since the
      // batch actually on the shelf can differ from what's on file for the product
      if(picked.productionDate) $('#m_prod').value = picked.productionDate;
      if(picked.expiryDate){
        const modeBar = $('#m_mode');
        if(modeBar){
          modeBar.querySelectorAll('.chip').forEach(c=>c.classList.toggle('active', c.dataset.mode==='date'));
          $('#m_edate').style.display = '';
          $('#m_shelf_wrap').style.display = 'none';
          $('#m_shelf_preview').textContent = '';
        }
        $('#m_edate').value = picked.expiryDate;
      }
    });
  }
  $('#m_save').onclick = async ()=>{
    const subbing = $('#m_sub').checked;
    if(subbing){
      if(subs.some(r=>!r.productId)){ showAlert('Choose which product from the database was actually used for every replacement line (or remove the empty one).'); return; }
      if(subs.some(r=> typeof r.qty!=='number' || !(r.qty>0))){ showAlert('Enter a quantity for every replacement product.'); return; }
    }
    const qty = parseFloat($('#m_qty').value);
    it.actualQty = isNaN(qty) ? prefillQty : qty;
    it.actualUnit = $('#m_unit').value.trim();
    if(subbing){ it.actualQty = subs[0].qty; it.actualUnit = (subs[0].unit||'').trim(); } // kept for older screens/reports
    it.notes = $('#m_notes').value.trim();
    it.actualProductionDate = $('#m_prod').value;
    it.actualExpiryDate = $('#m_edate').value;
    it.actualExpiryMode = expiryModeOf('m');
    it.actualExpiryShelfAmount = $('#m_shelf_amount').value ? parseFloat($('#m_shelf_amount').value) : '';
    it.actualExpiryShelfUnit = $('#m_shelf_unit').value;
    if(subbing){
      it.status='substituted';
      it.replacements = subs.map(r=>({productId:r.productId, name:r.name, qty:r.qty, unit:(r.unit||'').trim()}));
      it.replacementProductId = subs[0].productId;
      it.replacementName = subs.map(r=>r.name).join(' + ');
    } else {
      it.replacements = [];
      it.replacementProductId = '';
      it.replacementName = '';
      it.status = (it.actualQty !== it.requestedQty) ? 'modified' : 'completed';
    }
    await put('orderItems', it);
    closeModal();
    onDone();
  };
}


/* ---- the customer changed an order line after the sheet was imported (other product, other quantity…) ----
   The line itself is edited and keeps a note of what the sheet originally said, so nobody has to remember it. */
function lineChangedHtml(it){
  if(!it.origDesc && it.origQty==null) return '';
  const was = [it.origDesc, it.origQty!=null && it.origQty!=='' ? `${it.origQty} ${it.origUnit||''}`.trim() : ''].filter(Boolean).join(' · ');
  return `<div class="pr-warn" style="margin:-4px 0 10px;">✎ Changed by the customer — the sheet said: <b>${esc(was)}</b>${it.changeNote?' · '+esc(it.changeNote):''}</div>`;
}
async function openEditLineModal(it, onDone){
  const order = await getOne('orders', it.orderId);
  let newProduct = null;   // chosen in this dialog
  const finished = order && order.stockApplied && (it.status==='completed' || it.status==='modified');
  const unitList = [...new Set([it.requestedUnit, 'KG','GM','LTR','ML','PCS','PKT','BOX','CTN','BTL','TIN','BAG'].filter(Boolean))];
  showModal(`<h3>Customer changed this line</h3>
    <p class="subtle" style="margin-top:-8px;">Now: <b>${esc(it.excelDesc)}</b> — ${esc(String(it.requestedQty))} ${esc(it.requestedUnit||'')}. The original line is remembered on the item.</p>
    <div class="field"><label>Different product?</label>
      <button type="button" class="btn btn-ghost" id="el_pick" style="width:100%; justify-content:flex-start; text-align:left;">Keep ${esc(it.productName||it.excelDesc)} — tap to choose another product</button></div>
    <div class="row2"><div class="field"><label>Quantity</label><input type="text" inputmode="decimal" id="el_qty" value="${esc(String(it.requestedQty))}"></div>
    <div class="field"><label>Unit</label><input type="text" id="el_unit" list="el_units" value="${esc(it.requestedUnit||'')}"><datalist id="el_units">${unitList.map(u=>`<option value="${esc(u)}">`).join('')}</datalist></div></div>
    <div class="field"><label>Note (optional)</label><input type="text" id="el_note" placeholder="e.g. asked by the chief cook" value="${esc(it.changeNote||'')}"></div>
    ${finished ? '<p class="subtle">This order is already finished. Changing the product moves the picked stock to the new product; changing the quantity here does not change what was picked.</p>' : ''}
    <div style="display:flex; gap:10px; margin-top:10px;"><button class="btn btn-signal" id="el_save" style="flex:1;">Save change</button><button class="btn btn-ghost" onclick="closeModal()">Cancel</button></div>`);
  $('#el_pick').onclick = async ()=>{
    const [products, warehouses, sections] = await Promise.all([getAll('products'), getAll('warehouses'), getAll('sections')]);
    const whMap = Object.fromEntries(warehouses.map(w=>[w.id,w])), secMap = Object.fromEntries(sections.map(s=>[s.id,s]));
    const keepQty = $('#el_qty').value, keepUnit = $('#el_unit').value, keepNote = $('#el_note').value;
    openProductPicker(it, products, whMap, secMap, picked=>{
      newProduct = picked; openEditLineModal(Object.assign({}, it, {requestedQty:keepQty, requestedUnit:keepUnit, changeNote:keepNote, __pre:picked}), onDone);
    });
  };
  if(it.__pre){ newProduct = it.__pre; const b = $('#el_pick'); b.innerHTML = `Now: <b>${esc(newProduct.name)}</b> — tap to choose another`; }
  $('#el_save').onclick = async ()=>{
    const q = $('#el_qty').value.trim().replace(/,/g,''), unit = $('#el_unit').value.trim();
    if(!/^\d*\.?\d+$/.test(q) || !(parseFloat(q)>0)) return showAlert('Type the new quantity as a plain number, like 12 or 2.5.');
    const cur = await getOne('orderItems', it.id);
    const p = newProduct && newProduct.id!==cur.productId ? newProduct : null;
    const qtyChanged = parseFloat(q)!==parseFloat(cur.requestedQty) || unit!==(cur.requestedUnit||'');
    if(!p && !qtyChanged && $('#el_note').value.trim()===(cur.changeNote||'')){ closeModal(); onDone(); return; }
    const go = async ()=>{
      if(cur.origDesc==null){ cur.origDesc = cur.excelDesc; cur.origQty = cur.requestedQty; cur.origUnit = cur.requestedUnit||''; }
      cur.requestedQty = parseFloat(q); cur.requestedUnit = unit; cur.changeNote = $('#el_note').value.trim(); cur.changedAt = new Date().toISOString(); cur.changedBy = (typeof actorName==='function' ? actorName() : '') || '';
      if(p){
        cur.excelDesc = p.name;
        await put('orderItems', cur);
        const r = await relinkOrderItem(cur.id, p);
        if(r.moved) showAlert(`Moved ${r.qty} from “${r.oldName}” to “${r.newName}” in stock.`, 'Stock corrected');
      } else await put('orderItems', cur);
      closeModal(); onDone();
    };
    if(p && finished) showConfirm(`This order is already finished. Switch this line to “${p.name}” and move ${cur.actualQty} of stock across?`, go); else go();
  };
}
