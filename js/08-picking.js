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
function matchNote(it){
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
    lines.push(`Substituted with: <b>${esc(it.replacementName||'—')}</b>`);
    if(it.actualQty!=null) lines.push(`Picked: ${it.actualQty} × ${esc(it.actualUnit||'')}`);
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

  $('#main').innerHTML = `
    <div class="topbar"><h1>Pick by store</h1></div>
    <p class="subtle" style="margin-top:-10px;">${esc(order.vessel)} · ${esc(order.orderNumber)} — ${doneAll} of ${totalAll} items picked overall.</p>
    <div class="card" style="margin-bottom:16px; display:flex; align-items:center; gap:12px; flex-wrap:wrap;">
      <span class="subtle" style="font-weight:700;">Heading to:</span>
      ${order.destination ? destinationBadge(order.destination, 'lg') : '<span class="subtle">No destination set</span>'}
      <button class="btn btn-ghost btn-sm" id="hubEditDest" style="margin-left:auto;">✎ ${order.destination?'Change':'Set destination'}</button>
    </div>
    <div class="card" style="margin-bottom:16px;">
      ${[...groups.entries()].map(([whId,g])=>`
        <div class="list-row">
          <div class="thumb">▥</div>
          <div style="flex:1;"><b>${esc(g.name)}</b><div class="subtle">${g.count} item${g.count===1?'':'s'} remaining</div></div>
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
      <a href="#/order/${orderId}/pick/all" class="btn btn-ghost btn-sm">Go through all stores in priority order instead</a>
      <a href="#/order/${orderId}/postponed" class="btn btn-ghost btn-sm">Postponed (${(order.postponed||[]).length})</a>
      <a href="#/order/${orderId}/boxes" class="btn btn-ghost btn-sm">📦 Supplier deliveries</a>
      <a href="#/orders" class="btn btn-ghost btn-sm">⏸ Save &amp; pause</a>
    </div>`;
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
    <p style="margin-top:-8px;">${it.sr?`<span class="subtle">Sr. ${esc(it.sr)} · </span>`:''}<span class="badge ${st.cls}">${st.label}</span></p>
    ${matchNote(it) ? `<p class="subtle" style="margin-top:-4px;">${esc(matchNote(it))}</p>` : ''}
    ${conv ? `
      <p style="font-size:1.4rem; font-weight:700; color:var(--signal); margin-bottom:0;">${round2(conv.convertedQty)} × ${esc(product.unit)}</p>
      <p class="subtle" style="margin-top:2px;">Ordered as: ${it.requestedQty} × ${esc(it.requestedUnit)}</p>
    ` : `<p style="font-size:1.4rem; font-weight:700; margin-bottom:10px;">${it.requestedQty} × ${esc(it.requestedUnit||'')}</p>`}
    <p class="subtle">${esc(it.warehouseName||'Unassigned')}${it.sectionName?' / '+esc(it.sectionName):''}${supplier?' · '+esc(supplier.name):''}</p>
    <p class="subtle">Expiry: ${expiryToShow}</p>
    ${product && !product.warehouseId ? `<p style="margin:8px 0;"><span class="badge b-unmatched">needs setup</span></p>` : ''}
    ${resolvedOutcomeHtml(it, st)}
    <div style="display:flex; flex-direction:column; gap:10px; margin-top:16px;">
      <button class="btn btn-success" id="qa_add">✓ Product Added</button>
      <button class="btn btn-ghost" id="qa_modify">✎ Modify</button>
      <button class="btn btn-ghost" id="qa_supplier">🚚 From Supplier</button>
      <button class="btn btn-ghost" id="qa_later">⏭ Pick Later</button>
      <button class="btn btn-ghost btn-sm" id="qa_dates">📅 Set production / expiry date</button>
      ${product ? `<button class="btn btn-ghost btn-sm" id="qa_complete">✎ Edit product details</button>` : ''}
      <button class="btn btn-ghost" onclick="closeModal()">Close without changes</button>
    </div>`);
  function finish(){ closeModal(); onDone(); }
  $('#qa_add').onclick = async ()=>{
    const vals = resolveAddedValues(it, product);
    it.status='completed'; it.actualQty=vals.actualQty; it.actualUnit=vals.actualUnit;
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
        ${matchNote(it) ? `<p class="subtle" style="margin-top:-8px;">${esc(matchNote(it))}</p>` : ''}
        ${conv ? `
          <div class="pick-qty">${round2(conv.convertedQty)} × ${esc(product.unit)}</div>
          <div class="subtle" style="margin-top:-10px; margin-bottom:14px;">Ordered as: ${it.requestedQty} × ${esc(it.requestedUnit)}</div>
        ` : `
          <div class="pick-qty">${it.requestedQty} × ${esc(it.requestedUnit||'')}</div>
        `}
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
    it.status='completed'; it.actualQty=vals.actualQty; it.actualUnit=vals.actualUnit;
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
  $('#batchList').querySelectorAll('[data-openitem]').forEach(row=>row.onclick = ()=>{
    openItemActionModal(orderId, row.dataset.openitem, refresh);
  });
  $('#batch_confirm').onclick = async ()=>{
    const checkedIds = [...$('#batchList').querySelectorAll('.batch-check:checked')].map(cb=>cb.dataset.check);
    for(const id of checkedIds){
      const it = byId[id];
      const product = it.productId ? productsCache[it.productId] : null;
      const vals = resolveAddedValues(it, product);
      it.status='completed'; it.actualQty=vals.actualQty; it.actualUnit=vals.actualUnit;
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
  showModal(`<h3>Modify — ${esc(it.excelDesc)}</h3>
    ${matchNote(it) ? `<p class="subtle" style="margin-top:-10px;">${esc(matchNote(it))}</p>` : ''}
    ${conv ? `<p class="subtle">Ordered as ${it.requestedQty} × ${esc(it.requestedUnit)} — converted to ${prefillQty} × ${esc(prefillUnit)} based on the product's database unit. Adjust below if needed.</p>` : ''}
    <div class="row2">
      <div class="field"><label>Actual quantity</label><input type="number" id="m_qty" value="${prefillQty}" step="any"></div>
      <div class="field"><label>Unit</label><input type="text" id="m_unit" value="${esc(prefillUnit)}"></div>
    </div>
    <div class="field"><label><input type="checkbox" id="m_sub" style="width:auto; margin-right:8px;" ${it.status==='substituted'?'checked':''}>Substitute with a different product</label></div>
    <div id="m_subwrap" style="display:${it.status==='substituted'?'block':'none'};">
      <div class="field">
        <label>Replacement product</label>
        <button type="button" class="btn btn-ghost" id="m_subpick" style="width:100%; justify-content:flex-start; text-align:left;">
          <span id="m_subpick_label">${it.replacementProductId ? esc(it.replacementName||'') : 'Tap to choose a product from the database…'}</span>
        </button>
      </div>
    </div>
    <div class="field"><label>Production date (optional)</label><input type="date" id="m_prod" value="${it.actualProductionDate||''}"></div>
    ${expiryFieldHtml('m', {expiryDate: it.actualExpiryDate || '', mode: it.actualExpiryMode, shelfAmount: it.actualExpiryShelfAmount, shelfUnit: it.actualExpiryShelfUnit})}
    <div class="field"><label>Notes</label><textarea id="m_notes"></textarea></div>
    <div style="display:flex; gap:10px; margin-top:10px;">
      <button class="btn btn-signal" id="m_save" style="flex:1;">Save &amp; continue</button>
      <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
    </div>`);
  wireExpiryField('m', 'm_prod');
  let chosenReplacement = it.replacementProductId ? {id:it.replacementProductId, name:it.replacementName||''} : null;
  let pickerProducts=null, pickerWhMap=null, pickerSecMap=null;
  $('#m_sub').onchange = e=>{ $('#m_subwrap').style.display = e.target.checked ? 'block' : 'none'; };
  $('#m_subpick').onclick = async ()=>{
    if(!pickerProducts){
      const [products, warehouses, sections] = await Promise.all([getAll('products'), getAll('warehouses'), getAll('sections')]);
      pickerProducts = products;
      pickerWhMap = Object.fromEntries(warehouses.map(w=>[w.id,w]));
      pickerSecMap = Object.fromEntries(sections.map(s=>[s.id,s]));
    }
    openProductPicker(it, pickerProducts, pickerWhMap, pickerSecMap, (picked)=>{
      chosenReplacement = {id:picked.id, name:picked.name};
      $('#m_subpick_label').textContent = picked.name;
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
  };
  $('#m_save').onclick = async ()=>{
    if($('#m_sub').checked && !chosenReplacement){
      showAlert('Choose which product from the database was actually used before saving.');
      return;
    }
    const qty = parseFloat($('#m_qty').value);
    it.actualQty = isNaN(qty) ? prefillQty : qty;
    it.actualUnit = $('#m_unit').value.trim();
    it.notes = $('#m_notes').value.trim();
    it.actualProductionDate = $('#m_prod').value;
    it.actualExpiryDate = $('#m_edate').value;
    it.actualExpiryMode = expiryModeOf('m');
    it.actualExpiryShelfAmount = $('#m_shelf_amount').value ? parseFloat($('#m_shelf_amount').value) : '';
    it.actualExpiryShelfUnit = $('#m_shelf_unit').value;
    if($('#m_sub').checked){
      it.status='substituted';
      it.replacementProductId = chosenReplacement.id;
      it.replacementName = chosenReplacement.name;
    } else {
      it.replacementProductId = '';
      it.replacementName = '';
      it.status = (it.actualQty !== it.requestedQty) ? 'modified' : 'completed';
    }
    await put('orderItems', it);
    closeModal();
    onDone();
  };
}

