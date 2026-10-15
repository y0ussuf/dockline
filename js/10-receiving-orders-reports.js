/* ==================================== PRODUCT RECEIVING ====================================
   A running history of quantities received from suppliers — "got 1000 pcs of tuna shredded" —
   kept as its own log. Deliberately separate from Supplier deliveries (box-count reconciliation
   per order) and not an invoicing/pricing feature at all: just product, quantity, supplier and
   date, with every entry kept even if it's later deleted-and-corrected (the delete path reverses
   the stock change it made, it doesn't just vanish silently). */
route('receiving', async ()=>{
  window.__receivingSearch = window.__receivingSearch || '';
  const [productsAll, warehouses, sections, suppliersAll] = await Promise.all([
    getAll('products'), getAll('warehouses'), getAll('sections'), getAll('suppliers')
  ]);
  const whMap = Object.fromEntries(warehouses.map(w=>[w.id,w]));
  const secMap = Object.fromEntries(sections.map(s=>[s.id,s]));
  const products = productsAll.filter(p=>p.active);
  const sortedSuppliers = suppliersAll.slice().sort((a,b)=>a.name.localeCompare(b.name));

  async function draw(){
    const all = await getAll('productReceipts');
    let list = all.slice().sort((a,b)=>(b.receivedAt||'').localeCompare(a.receivedAt||'') || (b.id||'').localeCompare(a.id||''));
    if(window.__receivingSearch){
      const q = normalize(window.__receivingSearch);
      list = list.filter(r=>normalize(r.productName).includes(q) || normalize(r.supplierName).includes(q));
    }
    $('#main').innerHTML = `
      <a href="#/warehouse" class="subtle" style="display:inline-block; margin-bottom:10px; text-decoration:none;">‹ Warehouse management</a>
      <div class="topbar"><h1>Product receiving</h1>
        <button class="btn btn-signal" id="prLog">+ Log received stock</button>
      </div>
      <p class="subtle" style="margin-top:-10px;">Quantities of products received from suppliers, kept as a running history — not invoices or prices, just how much came in, from who, and when.</p>
      <div class="field" style="max-width:360px;"><input type="text" id="prSearch" placeholder="Search by product or supplier…" value="${esc(window.__receivingSearch)}"></div>
      <div class="card" id="prList">
        ${list.length ? list.map(r=>`
          <div class="list-row">
            <div class="thumb">📥</div>
            <div style="flex:1; min-width:0;">
              <b>${esc(r.productName)}</b>
              <div class="subtle">${r.qty}${r.unit?' '+esc(r.unit):''} · from ${esc(r.supplierName)||'—'} · ${esc(r.receivedAt)||''}${r.note?' · '+esc(r.note):''}</div>
            </div>
            <button class="iconbtn" data-del="${r.id}" title="Delete this entry">✕</button>
          </div>`).join('') : `<div class="empty"><div class="ic">📥</div>${window.__receivingSearch ? 'No entries match.' : 'Nothing logged yet. Use "+ Log received stock" whenever a delivery comes in.'}</div>`}
      </div>`;

    $('#prLog').onclick = ()=>{
      openProductPicker(null, products, whMap, secMap, (picked)=>{
        openLogReceiptDetailsModal(picked, sortedSuppliers, ()=>{ draw(); });
      });
    };
    let prDebounce;
    $('#prSearch').oninput = e=>{
      const val = e.target.value;
      clearTimeout(prDebounce);
      prDebounce = setTimeout(()=>{ window.__receivingSearch = val; draw(); }, 180);
    };
    $('#prList').querySelectorAll('[data-del]').forEach(b=>b.onclick=()=>{
      const rec = list.find(x=>x.id===b.dataset.del);
      showConfirm(`Delete this entry — ${rec.qty}${rec.unit?' '+esc(rec.unit):''} of ${esc(rec.productName)}? If that product's stock is tracked, the quantity will be taken back out of stock on hand.`, async ()=>{
        const product = await getOne('products', rec.productId);
        if(product && isStockTracked(product)){
          product.stockQty = round2(parseFloat(product.stockQty) - rec.qty);
          await put('products', product);
        }
        await del('productReceipts', rec.id);
        draw();
      }, {danger:true, yesLabel:'Delete entry'});
    });
  }
  await draw();
});

/* Sends the manager a report while the order is still open. Marks the order partially picked
   so the crew sees it too; the final report (same file name) simply replaces it later. */
async function exportPartialReport(orderId){
  const o = await getOne('orders', orderId);
  if(!o.partialSince){ o.partialSince = new Date().toISOString(); await put('orders', o); }
  await exportOrderExcel(orderId);
}

async function postponedScreen(orderId){
  const order = await getOne('orders', orderId);
  const items = (await getAll('orderItems')).filter(it=>it.orderId===orderId);
  const byId = Object.fromEntries(items.map(it=>[it.id,it]));
  const postponed = (order.postponed||[]).filter(id=>byId[id]);

  if(!postponed.length){
    // "Postponed" is reachable as a link at any time during picking, not only once
    // the main queue is empty — so clearing it out here doesn't by itself mean the
    // whole order is done. Only finish the order once nothing is left pending
    // anywhere, in the main queue or here; otherwise send them back to keep picking.
    const stillPendingElsewhere = (order.queue||[]).some(id=>byId[id] && byId[id].status==='pending');
    if(stillPendingElsewhere){
      showAlert('Nothing postponed left to resolve, but there are still items waiting to be picked elsewhere in this order — continue with those.', 'Not finished yet');
      location.hash = `#/order/${orderId}/pick`;
      return;
    }
    // every logged delivery needs its sent-count confirmed before the order can finish
    const receipts = await getOrderBoxReceipts(orderId);
    const unconfirmed = unconfirmedBoxReceipts(receipts);
    if(unconfirmed.length){
      location.hash = `#/order/${orderId}/boxes/confirm`;
      render();
      return;
    }
    await finishOrder(orderId);
    return;
  }

  $('#main').innerHTML = `
    <div class="topbar"><h1>Postponed products</h1></div>
    <p class="subtle" style="margin-top:-10px;">${postponed.length} item${postponed.length===1?'':'s'} to resolve before finishing this order.</p>
    <div class="card" style="margin-bottom:16px;">
      <b>Manager needs the report before these arrive?</b>
      <div class="subtle" style="margin:4px 0 10px;">The report lists these as “To Follow”. The order stays open and shows as “partially picked” for the crew and on your Home screen until you finish it.</div>
      <div style="display:flex; gap:10px; flex-wrap:wrap;">
        <button class="btn btn-signal btn-sm" id="pRepExport">⬇ Partial report (Excel)</button>
        <button class="btn btn-ghost btn-sm" id="pRepPark">⏸ Mark partially picked &amp; leave</button>
      </div>
    </div>
    <div class="card" id="postList"></div>`;
  $('#pRepExport').onclick = ()=> exportPartialReport(orderId);
  $('#pRepPark').onclick = async ()=>{
    const o = await getOne('orders', orderId);
    if(!o.partialSince){ o.partialSince = new Date().toISOString(); await put('orders', o); }
    location.hash = '#/orders';
  };
  const list = $('#postList');
  list.innerHTML = postponed.map(id=>{
    const it = byId[id];
    return `<div class="list-row" data-id="${id}">
      <div class="thumb">📦</div>
      <div style="flex:1;"><b>${it.sr?`Sr. ${esc(it.sr)} · `:''}${esc(it.excelDesc)}</b><div class="subtle">${it.requestedQty} ${esc(it.requestedUnit)} · ${esc(it.warehouseName)} / ${esc(it.sectionName)}${matchNote(it)?' · '+esc(matchNote(it)):''}</div></div>
      <button class="iconbtn" data-dates="${id}" title="Set production/expiry date">📅</button>
      <button class="btn btn-success btn-sm" data-add="${id}">✓ Added</button>
      <button class="btn btn-ghost btn-sm" data-mod="${id}">Modify</button>
      <button class="btn btn-ghost btn-sm" data-fs="${id}">🚚 From supplier</button>
      <button class="btn btn-ghost btn-sm" data-na="${id}">Not available</button>
    </div>`;
  }).join('');

  async function resolve(id, patchFn){
    const it = byId[id];
    await patchFn(it);
    await put('orderItems', it);
    order.postponed = (order.postponed||[]).filter(x=>x!==id);
    await put('orders', order);
    postponedScreen(orderId);
  }
  list.querySelectorAll('[data-add]').forEach(b=>b.onclick=()=>resolve(b.dataset.add, async it=>{
    const product = it.productId ? await getOne('products', it.productId) : null;
    const vals = resolveAddedValues(it, product);
    it.status='completed'; it.actualQty=vals.actualQty; it.actualUnit=vals.actualUnit;
  }));
  list.querySelectorAll('[data-na]').forEach(b=>b.onclick=()=>resolve(b.dataset.na, it=>{ it.status='not_available'; }));
  list.querySelectorAll('[data-fs]').forEach(b=>b.onclick=()=>resolve(b.dataset.fs, async it=>{
    const product = it.productId ? await getOne('products', it.productId) : null;
    markFromSupplier(it, product);
  }));
  list.querySelectorAll('[data-dates]').forEach(b=>b.onclick=()=>{
    openDateModal(byId[b.dataset.dates], ()=>postponedScreen(orderId));
  });
  list.querySelectorAll('[data-mod]').forEach(b=>b.onclick=async ()=>{
    const it = byId[b.dataset.mod];
    const product = it.productId ? await getOne('products', it.productId) : null;
    openModifyModal(it, product, async ()=>{
      order.postponed = (order.postponed||[]).filter(x=>x!==b.dataset.mod);
      await put('orders', order);
      postponedScreen(orderId);
    });
  });
}

/* For when the client adds something to the order after it's already been imported and
   picking may have already started. The new line is slotted in at the end of the picking
   queue (so it shows up like any other pending item) and flagged as "added manually" —
   in the item list and in the exported report — so it's always clear it wasn't on the
   original sheet. A product must be picked (or created) for it, same as any import-matched
   item, since there's no later "resolve unmatched items" screen once picking has started. */
async function openAddItemModal(orderId, onDone){
  showModal(`<h3>Add item to order</h3>
    <p class="subtle">For something the client added after this order was already imported.</p>
    <div class="field"><label>Description</label><input type="text" id="ai_desc" placeholder="e.g. Anise Star" autofocus></div>
    <div class="row2">
      <div class="field"><label>Quantity</label><input type="number" id="ai_qty" step="any" placeholder="e.g. 10"></div>
      <div class="field"><label>Unit</label><input type="text" id="ai_unit" placeholder="Kg, LTR, Tin 400 gm…"></div>
    </div>
    <div class="field"><label>Sr. (optional)</label><input type="text" id="ai_sr" placeholder="leave blank if unknown"></div>
    <div style="display:flex; gap:10px; margin-top:10px; flex-wrap:wrap;">
      <button class="btn btn-signal" id="ai_pickProd" style="flex:1; min-width:180px;">🔍 Pick product from database</button>
      <button class="btn btn-ghost" id="ai_newProd" style="flex:1; min-width:180px;">+ Create new product</button>
    </div>
    <button class="btn btn-ghost" style="width:100%; margin-top:10px;" onclick="closeModal()">Cancel</button>`);

  function readFields(){
    const desc = $('#ai_desc').value.trim();
    const qtyRaw = $('#ai_qty').value;
    const qty = parseFloat(qtyRaw);
    if(!desc){ showAlert('Enter a description.'); return null; }
    if(qtyRaw===''||isNaN(qty)||qty<=0){ showAlert('Enter a valid quantity.'); return null; }
    return {desc, qty, unit: $('#ai_unit').value.trim(), sr: $('#ai_sr').value.trim()};
  }

  async function createItem(fields, product){
    const [allItems, warehouses, sections] = await Promise.all([getAll('orderItems'), getAll('warehouses'), getAll('sections')]);
    const existingItems = allItems.filter(it=>it.orderId===orderId);
    const whMap = Object.fromEntries(warehouses.map(w=>[w.id,w]));
    const secMap = Object.fromEntries(sections.map(s=>[s.id,s]));
    const maxImportIndex = existingItems.reduce((m,it)=>Math.max(m, it.importIndex ?? 0), -1);
    const item = {
      id: uid(), orderId, sr: fields.sr, importIndex: maxImportIndex+1, excelDesc: fields.desc,
      excelQty: fields.qty, qtyFlag:'', excelUnit: fields.unit || product.unit || '',
      productId: product.id, productName: product.name,
      warehouseId: product.warehouseId || '', warehouseName: whMap[product.warehouseId]?.name || '',
      sectionName: secMap[product.sectionId]?.name || '',
      sortKey: [whMap[product.warehouseId]?.priority ?? 9999, secMap[product.sectionId]?.priority ?? 9999, product.priority ?? 9999],
      requestedQty: fields.qty, requestedUnit: fields.unit || product.unit || '',
      actualQty: null, actualUnit: '', status:'pending', matchType:'confirmed', replacementName:'', notes:'',
      actualProductionDate:'', actualExpiryDate:'', addedManually: true
    };
    await put('orderItems', item);
    const freshOrder = await getOne('orders', orderId);
    if(freshOrder.status==='picking'){
      freshOrder.queue = [...(freshOrder.queue||[]), item.id];
      await put('orders', freshOrder);
    }
    closeModal();
    onDone();
  }

  $('#ai_pickProd').onclick = async ()=>{
    const fields = readFields(); if(!fields) return;
    const [products, warehouses, sections] = await Promise.all([getAll('products'), getAll('warehouses'), getAll('sections')]);
    const whMap = Object.fromEntries(warehouses.map(w=>[w.id,w]));
    const secMap = Object.fromEntries(sections.map(s=>[s.id,s]));
    openProductPicker(null, products, whMap, secMap, (picked)=> createItem(fields, picked));
  };
  $('#ai_newProd').onclick = async ()=>{
    const fields = readFields(); if(!fields) return;
    const [warehouses, sections, suppliers] = await Promise.all([getAll('warehouses'), getAll('sections'), getAll('suppliers')]);
    const draftProduct = {id:uid(), name:fields.desc, unit:fields.unit||'', supplierId:'', warehouseId:'', sectionId:'', priority:999, active:true, notes:'', productionDate:'', expiryDate:'', image:''};
    openProductForm(draftProduct, warehouses, sections, suppliers, (savedProduct)=> createItem(fields, savedProduct));
  };
}

async function allItemsScreen(orderId){
  window.__itemsFilterStatus = window.__itemsFilterStatus || 'all';
  window.__itemsSearch = window.__itemsSearch || '';
  let order, items; // cached by draw(), reused by updateList() so typing doesn't re-hit the database or rebuild the search box itself

  /* only replaces the filter chips + item list — never touches the search input element,
     so it keeps focus and the on-screen keyboard open while the person is still typing */
  function updateList(){
    const statusCounts = {};
    items.forEach(it=>{
      const isPostponed = (order.postponed||[]).includes(it.id);
      const key = isPostponed ? 'postponed' : it.status;
      statusCounts[key] = (statusCounts[key]||0)+1;
    });

    const q = normalize(window.__itemsSearch);
    const qTrim = window.__itemsSearch.trim().toLowerCase();
    const filtered = items.filter(it=>{
      const isPostponed = (order.postponed||[]).includes(it.id);
      if(window.__itemsFilterStatus==='postponed'){ if(!isPostponed) return false; }
      else if(window.__itemsFilterStatus==='pending'){ if(!(it.status==='pending' && !isPostponed)) return false; }
      else if(window.__itemsFilterStatus!=='all'){ if(it.status!==window.__itemsFilterStatus) return false; }
      if(q || qTrim){
        const hit = normalize(it.excelDesc).includes(q) || (qTrim && String(it.sr||'').toLowerCase().includes(qTrim));
        if(!hit) return false;
      }
      return true;
    });

    const chip = (key, label, count)=> `<button class="chip ${window.__itemsFilterStatus===key?'active':''}" data-f="${key}">${label} (${count||0})</button>`;

    $('#ai_filters').innerHTML = `
      ${chip('all','All', items.length)}
      ${chip('pending','Pending', statusCounts.pending)}
      ${chip('completed','Picked', statusCounts.completed)}
      ${chip('modified','Modified', statusCounts.modified)}
      ${chip('substituted','Substituted', statusCounts.substituted)}
      ${chip('from_supplier','From supplier', statusCounts.from_supplier)}
      ${chip('postponed','Postponed', statusCounts.postponed)}
      ${chip('not_available','Cancelled', statusCounts.not_available)}`;
    $('#ai_list').innerHTML = filtered.length ? filtered.map(it=>{
      const st = itemStatusLabel(it, order);
      const note = matchNote(it);
      const outcome = resolvedOutcomeInline(it, st);
      return `<div class="list-row" data-open="${it.id}" style="cursor:pointer;">
        <div style="width:38px;" class="subtle">${esc(it.sr||'—')}</div>
        <div style="flex:1; min-width:0;">
          <b>${esc(it.excelDesc)}</b> ${it.addedManually?'<span class="badge b-modified">added manually</span>':''}
          <div class="subtle">${it.requestedQty} ${esc(it.requestedUnit)}${note?' · '+esc(note):''}</div>
          ${outcome ? `<div class="subtle">${outcome}</div>` : ''}
        </div>
        <span class="badge ${st.cls}">${st.label}</span>
      </div>`;
    }).join('') : `<div class="empty"><div class="ic">📋</div>No items match.</div>`;

    $('#ai_list').querySelectorAll('[data-open]').forEach(row=>row.addEventListener('click', ()=>{
      openItemActionModal(orderId, row.dataset.open, draw);
    }));
    $('#ai_filters').onclick = e=>{
      const b = e.target.closest('[data-f]'); if(!b) return;
      window.__itemsFilterStatus = b.dataset.f;
      updateList();
    };
  }

  async function draw(){
    order = await getOne('orders', orderId);
    items = (await getAll('orderItems')).filter(it=>it.orderId===orderId);
    items.sort((a,b)=>importOrderCompare(a,b));

    $('#main').innerHTML = `
      <div class="topbar"><h1>All items</h1><button class="btn btn-signal btn-sm" id="ai_addItem">+ Add item</button></div>
      <p class="subtle" style="margin-top:-10px;">${esc(order.vessel)} · ${esc(order.orderNumber)} — ${items.length} total. Tap any item to view or edit it.</p>
      <div class="field" style="max-width:360px;"><input type="text" id="ai_search" placeholder="Search by description or Sr…" value="${esc(window.__itemsSearch)}"></div>
      <div class="tag-row" id="ai_filters"></div>
      <div class="card" id="ai_list"></div>
      <div style="display:flex; gap:10px; flex-wrap:wrap; margin-top:16px;">
        <a href="#/order/${orderId}/pick" class="btn btn-ghost btn-sm">↩ Back to picking</a>
        <a href="#/orders" class="btn btn-ghost btn-sm">⏸ Save &amp; pause</a>
      </div>`;

    updateList();
    let searchDebounce;
    $('#ai_search').oninput = e=>{
      const val = e.target.value;
      clearTimeout(searchDebounce);
      searchDebounce = setTimeout(()=>{ window.__itemsSearch = val; updateList(); }, 180);
    };
    $('#ai_addItem').onclick = ()=> openAddItemModal(orderId, draw);
  }
  draw();
}


/* Delivery info (car license + driver) is only known once the order has actually left —
   never asked for during picking. Collected on first export, saved to the order so
   re-exporting the same order doesn't ask again, and editable any time after. */
function openDeliveryInfoModal(order, onDone){
  showModal(`<h3>Delivery details</h3>
    <p class="subtle">Who's taking this order out, and in which vehicle? Leave either blank if you don't know it yet — you can fill it in later and re-export.</p>
    <div class="field"><label>Driver name</label><input type="text" id="dv_driver" value="${esc(order.driverName||'')}" placeholder="e.g. Ahmed Hassan"></div>
    <div class="field"><label>Car license plate</label><input type="text" id="dv_car" value="${esc(order.carLicense||'')}" placeholder="e.g. ABC 1234"></div>
    <div style="display:flex; gap:10px; margin-top:10px;">
      <button class="btn btn-signal" id="dv_save" style="flex:1;">Save &amp; continue</button>
      <button class="btn btn-ghost" id="dv_skip">Skip for now</button>
    </div>`);
  $('#dv_save').onclick = async ()=>{
    order.driverName = $('#dv_driver').value.trim();
    order.carLicense = $('#dv_car').value.trim();
    await put('orders', order);
    closeModal();
    onDone();
  };
  $('#dv_skip').onclick = ()=>{ closeModal(); onDone(); };
}

/* Lets the destination be fixed after the fact too — not just at import — since a mix-up
   is sometimes only noticed partway through picking or even after. */
async function openDestinationModal(order, onDone){
  const pastDest = [...new Set((await getAll('orders')).map(x=>(x.destination||'').trim()).filter(Boolean))];
  const presets = ['Suez Port','Alexandria Port','Port Said','Damietta Port','Sokhna Port','Safaga Port'];
  const destOptions = [...new Set([...pastDest, ...presets])].sort();
  showModal(`<h3>Destination</h3>
    <p class="subtle">Where this order is actually heading — shown as a badge everywhere this order appears, so it's hard to miss.</p>
    <div class="field">
      <input type="text" id="dest_val" list="dest_list" value="${esc(order.destination||'')}" placeholder="e.g. Suez Port, Alexandria Port…">
      <datalist id="dest_list">${destOptions.map(d=>`<option value="${esc(d)}">`).join('')}</datalist>
      <div id="dest_preview" style="margin-top:8px;">${destinationBadge(order.destination||'')}</div>
    </div>
    <div style="display:flex; gap:10px; margin-top:10px;">
      <button class="btn btn-signal" id="dest_save" style="flex:1;">Save</button>
      <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
    </div>`);
  $('#dest_val').oninput = ()=>{ $('#dest_preview').innerHTML = destinationBadge($('#dest_val').value.trim()); };
  $('#dest_save').onclick = async ()=>{
    order.destination = $('#dest_val').value.trim();
    await put('orders', order);
    closeModal();
    onDone();
  };
}

async function orderSummary(orderId){
  const order = await getOne('orders', orderId);
  const items = (await getAll('orderItems')).filter(it=>it.orderId===orderId);
  const counts = {};
  items.forEach(it=>{ counts[it.status]=(counts[it.status]||0)+1; });
  $('#main').innerHTML = `
    <div class="topbar"><h1>Order summary</h1><button class="btn btn-signal btn-sm" id="exportXls">⬇ Export to Excel</button></div>
    <div class="card" style="margin-bottom:18px;">
      <div class="row2">
        <div><b>Vessel</b><div>${esc(order.vessel)}</div></div>
        <div><b>IMO</b><div>${esc(order.imo)||'—'}</div></div>
      </div>
      <div class="row2" style="margin-top:12px;">
        <div><b>Order</b><div>${esc(order.orderNumber)}</div></div>
        <div><b>Date</b><div>${fmtDate(order.orderDate)}</div></div>
      </div>
      <div style="margin-top:12px; display:flex; align-items:center; gap:10px; flex-wrap:wrap;">
        <div><b>Destination</b><div style="margin-top:4px;">${order.destination ? destinationBadge(order.destination) : '<span class="subtle">Not set</span>'}</div></div>
        <button class="btn btn-ghost btn-sm" id="editDestination" style="margin-left:auto;">✎ Edit</button>
      </div>
    </div>
    <div class="card" style="margin-bottom:18px; display:flex; justify-content:space-between; align-items:center; gap:10px; flex-wrap:wrap;">
      <div class="row2" style="flex:1;">
        <div><b>Driver</b><div>${esc(order.driverName)||'—'}</div></div>
        <div><b>Car license</b><div>${esc(order.carLicense)||'—'}</div></div>
      </div>
      <button class="btn btn-ghost btn-sm" id="editDelivery">✎ Edit delivery details</button>
    </div>
    ${order.status==='completed' ? `
    <div class="card" style="margin-bottom:18px; display:flex; justify-content:space-between; align-items:center; gap:10px; flex-wrap:wrap;">
      <div style="flex:1; min-width:200px;">
        <b>Dispatch</b>
        <div style="margin-top:4px;">${orderBadgeHtml(order)}${isAwaitingDispatch(order) && order.awaitingDispatchSince ? ` <span class="subtle">since ${fmtDate(order.awaitingDispatchSince)}</span>` : ''}${!isAwaitingDispatch(order) && order.sentAt ? ` <span class="subtle">sent ${fmtDate(order.sentAt)}</span>` : ''}</div>
        <div class="subtle" style="margin-top:4px;">${isAwaitingDispatch(order) ? 'Picked and waiting in the warehouse for the ship. Everyone sees it on Home and Orders.' : 'Mark it if this order is picked but still in the warehouse until the ship arrives.'}</div>
      </div>
      <button class="btn ${isAwaitingDispatch(order)?'btn-signal':'btn-ghost'} btn-sm" id="toggleDispatch">${isAwaitingDispatch(order) ? '✓ Mark as sent' : '⏳ Mark as picked, not sent'}</button>
    </div>` : ''}
    <div class="grid-stats">
      <div class="stat"><b>${items.length}</b><div class="lbl">Total products</div></div>
      <div class="stat"><b>${counts.completed||0}</b><div class="lbl">Completed</div></div>
      <div class="stat"><b>${counts.modified||0}</b><div class="lbl">Modified</div></div>
      <div class="stat"><b>${counts.substituted||0}</b><div class="lbl">Substituted</div></div>
      <div class="stat"><b>${counts.from_supplier||0}</b><div class="lbl">From supplier</div></div>
      <div class="stat"><b>${counts.not_available||0}</b><div class="lbl">Not available</div></div>
    </div>
    <div class="card">
      ${items.slice().sort((a,b)=>importOrderCompare(a,b)).map(it=>`
        <div class="list-row">
          <div style="width:50px;" class="subtle">${esc(it.sr||'—')}</div>
          <div style="flex:1;"><b>${esc(it.excelDesc)}</b> ${it.addedManually?'<span class="badge b-modified">added manually</span>':''}${matchNote(it)?`<div class="subtle">${esc(matchNote(it))}</div>`:''}${it.actualExpiryDate?`<div class="subtle">exp ${fmtDate(it.actualExpiryDate)}${it.actualProductionDate?' · prod '+fmtDate(it.actualProductionDate):''} (set for this order)</div>`:''}</div>
          <div class="subtle" style="width:120px;">${it.requestedQty} ${esc(it.requestedUnit)}</div>
          <div class="subtle" style="width:120px;">${it.actualQty ?? '—'} ${esc(it.actualUnit||'')}</div>
          <span class="badge b-${it.status}">${it.status.replace('_',' ')}</span>
        </div>`).join('')}
    </div>
    <div style="display:flex; gap:10px; flex-wrap:wrap; margin-top:16px;">
      <a href="#/orders" class="btn btn-ghost">Back to Orders</a>
      <a href="#/order/${orderId}/boxes" class="btn btn-ghost">📦 Supplier deliveries</a>
    </div>`;
  if($('#toggleDispatch')) $('#toggleDispatch').onclick = async ()=>{
    const fresh = await getOne('orders', orderId);
    if(fresh.awaitingDispatch){
      fresh.awaitingDispatch = false;
      fresh.sentAt = new Date().toISOString();
    } else {
      fresh.awaitingDispatch = true;
      fresh.awaitingDispatchSince = new Date().toISOString();
      delete fresh.sentAt;
    }
    await put('orders', fresh);
    orderSummary(orderId);
  };
  $('#editDelivery').onclick = ()=> openDeliveryInfoModal(order, ()=>orderSummary(orderId));
  $('#editDestination').onclick = ()=> openDestinationModal(order, ()=>orderSummary(orderId));
  $('#exportXls').onclick = async ()=>{
    // only interrupt for driver/car the first time — once set (or explicitly skipped
    // and still blank), re-exporting just goes straight through
    const fresh = await getOne('orders', orderId);
    if(!fresh.driverName && !fresh.carLicense && !fresh.deliveryInfoAsked){
      fresh.deliveryInfoAsked = true;
      await put('orders', fresh);
      openDeliveryInfoModal(fresh, ()=> exportOrderExcel(orderId));
    } else {
      exportOrderExcel(orderId);
    }
  };
}

/* Condition → fill color template for the exported report. Kept as one table so the
   look stays consistent every time and is easy to re-tune in one place. ARGB hex
   (ExcelJS format): alpha + RRGGBB. Soft/pastel fills so the dark text stays readable
   and the sheet still prints fine in black & white. */
const REPORT_STATUS_STYLE = {
  'Picked':      {fill:'FFC6EFCE', font:'FF1E6B33'}, // green
  'Modified':    {fill:'FFFFF2CC', font:'FF9C6500'}, // yellow
  'Substituted': {fill:'FFFFE0B2', font:'FF9C5700'}, // orange
  'From Supplier': {fill:'FFD6E9F5', font:'FF1B5E85'}, // blue — collected by the driver straight from the supplier
  'Cancelled':   {fill:'FFF8CBCB', font:'FFA6333B'}, // red
  'Postponed':   {fill:'FFE2E2E2', font:'FF595959'}, // grey
  'To Follow':   {fill:'FFE4D9F7', font:'FF5B2E91'}, // purple — not picked yet, still to come (partial reports)
  'Pending':     {fill:'FFFFFFFF', font:'FF333333'}  // white/unstyled
};

function conditionLabel(it, order){
  if(it.status==='completed') return 'Picked';
  if(it.status==='modified') return 'Modified';
  if(it.status==='substituted') return 'Substituted';
  if(it.status==='not_available') return 'Cancelled';
  if(it.status==='from_supplier') return 'From Supplier';
  // an unfinished order's open items are "to follow" — that's what the reader of a partial report needs to see
  if(it.status==='pending') return order.status==='completed' ? 'Pending' : 'To Follow';
  return it.status;
}
/* True only when the order sheet's unit and the database's unit for this item
   are genuinely different measurements — not just worded differently. The sheet
   and the product database often describe the exact same package in different
   words ("KG" vs "1 kg", "PKT 450 GM" vs "450 GM"), which used to make every
   one of those items show up as a false "converted" note even though the
   picked quantity and the real-world size were identical. This parses both
   units with the same logic computeUnitConversion already uses and only calls
   it a real change when the picked quantity differs, or the units don't parse
   to the same base size. */
function isRealUnitChange(it){
  if(round2(it.actualQty) !== round2(it.requestedQty)) return true;
  if(normalize(it.actualUnit) === normalize(it.requestedUnit)) return false;
  const rp = parseUnitSize(it.requestedUnit), ap = parseUnitSize(it.actualUnit);
  if(rp.ok && ap.ok && rp.type===ap.type && Math.abs(rp.base-ap.base) < 0.001) return false;
  return true;
}
function modNote(it){
  // items added by hand after the original sheet was imported (e.g. the client added
  // something mid-order) get flagged here so it's obvious, in-app and in the exported
  // report, which lines weren't on the original order
  const prefix = it.addedManually ? 'Added after import (not on original order). ' : '';
  if(it.status==='modified') return prefix + `Ordered ${it.requestedQty} × ${it.requestedUnit} — picked ${it.actualQty ?? ''} × ${it.actualUnit||''}`;
  if(it.status==='substituted') return prefix + `Substituted with "${it.replacementName||'—'}" — ${it.actualQty ?? ''} × ${it.actualUnit||''}`;
  if(it.status==='not_available') return prefix + 'Not available';
  if(it.status==='from_supplier') return prefix + 'Collected directly from the supplier by the driver';
  // "completed" items can still have been converted on the spot — e.g. ordered as 10 x 100gm
  // but the database product is kept in 200gm units, so it was auto-converted to 5 x 200gm and
  // picked as that. That conversion was only ever shown on-screen while picking; it never made
  // it into the exported report, which is the gap this fills. isRealUnitChange() is what keeps
  // this from also firing on items where nothing actually changed but the unit was just typed
  // differently in the sheet vs. the database.
  if(it.status==='completed' && it.actualQty!=null && it.requestedQty!=null && isRealUnitChange(it)){
    return prefix + `Ordered ${it.requestedQty} × ${it.requestedUnit} — converted to ${it.actualQty} × ${it.actualUnit||''} (database unit)`;
  }
  return prefix.trim();
}

async function exportOrderExcel(orderId){
  const order = await getOne('orders', orderId);
  const items = (await getAll('orderItems')).filter(it=>it.orderId===orderId);
  const products = await getAll('products');
  const prodMap = new Map(products.map(p=>[p.id,p]));
  items.sort((a,b)=>importOrderCompare(a,b));

  const wb = new ExcelJS.Workbook();
  wb.creator = 'Dockline';
  wb.created = new Date();
  const ws = wb.addWorksheet('Order Report');

  const COLS = ['SR.','DESCRIPTION','QUANTITY','UNIT','CONDITION','MODIFICATION','NOTES','PRODUCTION DATE','EXPIRY DATE'];
  ws.columns = [
    {width:7},{width:46},{width:11},{width:15},{width:13},{width:42},{width:28},{width:15},{width:15}
  ];

  // --- info block ---
  const infoRow = (label, value)=>{
    const r = ws.addRow([label, value]);
    r.getCell(1).font = {bold:true};
  };
  infoRow('Vessel Name', order.vessel||'');
  infoRow('IMO Number', order.imo||'');
  infoRow('Order Number', order.orderNumber||'');
  infoRow('Order Date', order.orderDate ? fmtDate(order.orderDate) : '');
  if(order.destination){
    // destination gets its own loud, filled row rather than blending in with the other
    // plain info rows — the whole point is that it's impossible to miss at a glance
    const destRow = ws.addRow(['Destination', order.destination]);
    destRow.height = 22;
    destRow.eachCell({includeEmpty:true}, c=>{
      c.font = {bold:true, size:12, color:{argb:'FF7A2E00'}};
      c.fill = {type:'pattern', pattern:'solid', fgColor:{argb:'FFFFE0B2'}};
    });
  }
  const openCount = items.filter(it=>it.status==='pending').length;
  if(order.status!=='completed' && openCount){
    const pRow = ws.addRow(['Report status', `PARTIAL REPORT — ${openCount} item${openCount===1?'':'s'} still to follow (final report will replace this one)`]);
    pRow.height = 22;
    pRow.eachCell({includeEmpty:true}, c=>{
      c.font = {bold:true, size:12, color:{argb:'FF5B2E91'}};
      c.fill = {type:'pattern', pattern:'solid', fgColor:{argb:'FFE4D9F7'}};
    });
  }
  if(isAwaitingDispatch(order)){
    // picked but still in the warehouse waiting for the ship — loud blue row, same idea as Destination
    const dRow = ws.addRow(['Dispatch', 'PICKED — NOT SENT (waiting in warehouse for the ship)' + (order.awaitingDispatchSince ? ' · since ' + fmtDate(order.awaitingDispatchSince) : '')]);
    dRow.height = 22;
    dRow.eachCell({includeEmpty:true}, c=>{
      c.font = {bold:true, size:12, color:{argb:'FF1B5E85'}};
      c.fill = {type:'pattern', pattern:'solid', fgColor:{argb:'FFD6E9F5'}};
    });
  } else if(order.status==='completed' && order.sentAt){
    infoRow('Dispatch', 'Sent · ' + fmtDate(order.sentAt));
  }
  if(order.driverName) infoRow('Driver Name', order.driverName);
  if(order.carLicense) infoRow('Car License', order.carLicense);
  ws.addRow([]);

  // --- table header ---
  const headerRow = ws.addRow(COLS);
  headerRow.height = 22;
  headerRow.eachCell(c=>{
    c.font = {bold:true, color:{argb:'FFFFFFFF'}};
    c.fill = {type:'pattern', pattern:'solid', fgColor:{argb:'FF1B6B93'}};
    c.alignment = {vertical:'middle', horizontal:'center'};
    c.border = {bottom:{style:'thin', color:{argb:'FF0D4A66'}}};
  });
  const headerRowIdx = headerRow.number;
  ws.views = [{state:'frozen', ySplit: headerRowIdx}];

  // --- data rows, colored by condition ---
  for(const it of items){
    const product = it.productId ? prodMap.get(it.productId) : null;
    const prodDate = it.actualProductionDate || (product && product.productionDate) || '';
    const expDate = it.actualExpiryDate || (product && product.expiryDate) || '';
    const label = conditionLabel(it, order);
    const row = ws.addRow([
      it.sr || '',
      it.excelDesc || it.productName || '',
      it.excelQty,
      it.excelUnit || '',
      label,
      modNote(it),
      it.notes || '',
      prodDate ? fmtDate(prodDate) : '',
      expDate ? fmtDate(expDate) : ''
    ]);
    const style = REPORT_STATUS_STYLE[label] || REPORT_STATUS_STYLE['Pending'];
    row.eachCell({includeEmpty:true}, c=>{
      c.fill = {type:'pattern', pattern:'solid', fgColor:{argb: style.fill}};
      c.border = {bottom:{style:'hair', color:{argb:'FFD9D9D9'}}};
    });
    row.getCell(5).font = {bold:true, color:{argb: style.font}};
  }
  const lastRow = ws.lastRow.number;
  ws.autoFilter = {from:{row:headerRowIdx, column:1}, to:{row:lastRow, column:COLS.length}};

  // --- color key / legend, a couple of rows below the table ---
  ws.addRow([]);
  const legendTitleRow = ws.addRow(['Color key:']);
  legendTitleRow.getCell(1).font = {bold:true};
  for(const label of ['Picked','Modified','Substituted','From Supplier','Cancelled','To Follow']){
    const style = REPORT_STATUS_STYLE[label];
    const r = ws.addRow(['', label]);
    r.getCell(1).fill = {type:'pattern', pattern:'solid', fgColor:{argb: style.fill}};
    r.getCell(2).font = {color:{argb: style.font}};
  }

  const buffer = await wb.xlsx.writeBuffer();
  const blob = new Blob([buffer], {type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'});
  await saveFile(`${(order.orderNumber||'order').replace(/[^a-z0-9\-_]+/ig,'_')}-report.xlsx`, blob);
}

/* ==================================== LOW STOCK REPORT ====================================
   One sheet, grouped by the supplier who restocks each product — a supplier-name row,
   then that supplier's low items underneath it — so the output can be read down the page
   as a straight restocking checklist per call. Products with no supplier set (or whose
   supplier was deleted) fall into their own "Unassigned" group at the end rather than
   being silently dropped. */
async function exportLowStockExcel(lowProducts, supMap){
  const groups = new Map(); // supplierId ('' for unassigned) -> {name, products}
  for(const p of lowProducts){
    const sup = p.supplierId ? supMap.get(p.supplierId) : null;
    const key = sup ? sup.id : '';
    const name = sup ? sup.name : 'Unassigned';
    if(!groups.has(key)) groups.set(key, {name, products:[]});
    groups.get(key).products.push(p);
  }
  // real suppliers alphabetically first, "Unassigned" always last regardless of where it sorts by name
  const sorted = [...groups.entries()].sort((a,b)=>{
    if(a[0]==='') return 1;
    if(b[0]==='') return -1;
    return a[1].name.localeCompare(b[1].name);
  }).map(([,g])=>g);
  for(const g of sorted) g.products.sort((a,b)=>a.name.localeCompare(b.name));

  const wb = new ExcelJS.Workbook();
  wb.creator = 'Dockline';
  wb.created = new Date();
  const ws = wb.addWorksheet('Low Stock');
  const COLS = ['PRODUCT','AVAILABLE STOCK','UNIT','LOW STOCK LIMIT'];
  ws.columns = [{width:42},{width:16},{width:16},{width:16}];

  const titleRow = ws.addRow([`Low stock report — ${fmtDate(todayISO())}`]);
  titleRow.getCell(1).font = {bold:true, size:14};
  ws.addRow([]);

  for(const g of sorted){
    const supRow = ws.addRow([g.name]);
    supRow.height = 22;
    ws.mergeCells(supRow.number, 1, supRow.number, COLS.length);
    supRow.eachCell({includeEmpty:true}, c=>{
      c.font = {bold:true, size:12, color:{argb:'FFFFFFFF'}};
      c.fill = {type:'pattern', pattern:'solid', fgColor:{argb:'FF1B6B93'}};
      c.alignment = {vertical:'middle'};
    });
    const headerRow = ws.addRow(COLS);
    headerRow.eachCell(c=>{
      c.font = {bold:true};
      c.fill = {type:'pattern', pattern:'solid', fgColor:{argb:'FFEDEAE1'}};
      c.border = {bottom:{style:'thin', color:{argb:'FFDBD6C9'}}};
    });
    for(const p of g.products){
      const row = ws.addRow([p.name, parseFloat(p.stockQty), p.unit||'', stockLimitOf(p)]);
      row.eachCell({includeEmpty:true}, c=>{ c.border = {bottom:{style:'hair', color:{argb:'FFEDEAE1'}}}; });
      row.getCell(2).font = {bold:true, color:{argb:'FFC1432E'}}; // low stock number, called out same as everywhere else in the app
    }
    ws.addRow([]);
  }
  const buffer = await wb.xlsx.writeBuffer();
  const blob = new Blob([buffer], {type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'});
  await saveFile(`low-stock-report-${todayISO()}.xlsx`, blob);
}

