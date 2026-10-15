/* ============================ SUPPLIER BOX DELIVERIES ============================
   Separate from Stock (which tracks catalog SKUs) — this tracks physical boxes/
   cartons of fish, meat, pork etc. received from a supplier FOR a specific order,
   reconciled against how many actually went out with that order. Two counts, two
   moments: logged when received, confirmed again (independently) when the order
   is finished, so a box going missing between the two gets caught instead of
   relying on one person's memory. A shortfall doesn't block anything by itself —
   only the confirmation step itself is mandatory — and stays visible on the
   Warehouse Mgmt "Supplier deliveries" list until someone resolves it.
   ==================================================================================== */
async function getOrderBoxReceipts(orderId){
  const all = await getAll('boxReceipts');
  return all.filter(r=>r.orderId===orderId).sort((a,b)=>(a.receivedAt||'').localeCompare(b.receivedAt||''));
}
/* every box receipt still needs its "what actually got sent" count entered before
   the order can finish — this is the gate postponedScreen checks */
function unconfirmedBoxReceipts(receipts){ return receipts.filter(r=>r.dispatchedQty==null); }

/* Lines whose product no longer matches what the saved mapping says today — i.e. the mapping was
   changed after the order was imported. Finishing would take their stock off the old product. */
async function findMappingDrift(orderId){
  const [items, mappings, products] = await Promise.all([getAll('orderItems'), getAll('mappings'), getAll('products')]);
  const byId = new Map(products.map(p=>[p.id,p]));
  const out = [];
  for(const it of items){
    if(it.orderId!==orderId || !it.productId) continue;
    if(!['completed','modified','from_supplier'].includes(it.status)) continue;
    const m = mappings.find(x=>x.excelDescNormalized===normalize(it.excelDesc));
    const want = m && byId.get(m.productId);
    if(want && want.id!==it.productId) out.push({it, want, have: byId.get(it.productId)});
  }
  return out;
}

async function finishOrder(orderId, skipCheck){
  if(!skipCheck){
    const drift = await findMappingDrift(orderId);
    if(drift.length){
      showModal(`<h3>⚠ Product mapping changed</h3>
        <p class="subtle">${drift.length} item${drift.length===1?' is':'s are'} linked to a product that your mappings no longer point to. If you finish now, stock will come off the old product.</p>
        <div style="max-height:260px; overflow:auto; margin:10px 0;">${drift.map(d=>`<div class="list-row"><div style="flex:1;"><b>${esc(d.it.excelDesc)}</b><div class="subtle">now linked to “${esc(d.have?d.have.name:d.it.productName)}” → mapping says “${esc(d.want.name)}”</div></div></div>`).join('')}</div>
        <div style="display:flex; flex-direction:column; gap:10px;">
          <button class="btn btn-signal" id="dr_fix">Switch to the new products &amp; finish</button>
          <button class="btn btn-ghost" id="dr_anyway">Finish anyway (keep old products)</button>
          <button class="btn btn-ghost" id="dr_cancel">Cancel — let me review the items</button>
        </div>`);
      $('#dr_fix').onclick = async ()=>{
        for(const d of drift) await relinkOrderItem(d.it.id, d.want);
        closeModal(); finishOrder(orderId, true);
      };
      $('#dr_anyway').onclick = ()=>{ closeModal(); finishOrder(orderId, true); };
      $('#dr_cancel').onclick = ()=>{ closeModal(); location.hash = `#/order/${orderId}/items`; render(); };
      return;
    }
  }
  const order = await getOne('orders', orderId);
  const items = (await getAll('orderItems')).filter(it=>it.orderId===orderId);
  if(!order.stockApplied){
    await applyStockDeductions(items);
    order.stockApplied = true;
  }
  order.partialSince = null;
  order.status='completed'; order.completedAt = new Date().toISOString();
  await put('orders', order);
  location.hash = `#/order/${orderId}/summary`;
  render();
}

/* Quick "+ New type…" flow used inline from the delivery-logging form — saves a
   row to the boxTypes list and hands it back so the calling line can select it
   immediately, without leaving the delivery screen. */
function openNewBoxTypeModal(onSaved){
  showModal(`<h3>New box type</h3>
    <div class="field"><label>Name</label><input type="text" id="nbt_name" placeholder="e.g. Ice boxes" autofocus></div>
    <div style="display:flex; gap:10px; margin-top:10px;">
      <button class="btn btn-signal" id="nbt_save" style="flex:1;">Save</button>
      <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
    </div>`);
  $('#nbt_save').onclick = async ()=>{
    const name = $('#nbt_name').value.trim();
    if(!name){ showAlert('Enter a name for this box type.'); return; }
    const type = {id:uid(), name};
    await put('boxTypes', type);
    closeModal();
    onSaved(type);
  };
}

/* Quick "+ New supplier…" flow used inline from the delivery-logging form, same
   idea as openNewBoxTypeModal — just a name is enough here; full contact details
   (if wanted) can still be filled in later from the Suppliers page. */
function openNewSupplierModal(onSaved){
  showModal(`<h3>New supplier</h3>
    <div class="field"><label>Name</label><input type="text" id="nsp_name" placeholder="e.g. Aegean Traders" autofocus></div>
    <div style="display:flex; gap:10px; margin-top:10px;">
      <button class="btn btn-signal" id="nsp_save" style="flex:1;">Save</button>
      <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
    </div>`);
  $('#nsp_save').onclick = async ()=>{
    const name = $('#nsp_name').value.trim();
    if(!name){ showAlert('Enter a supplier name.'); return; }
    const sup = {id:uid(), name, contactPerson:'', phone:'', email:'', notes:''};
    await put('suppliers', sup);
    closeModal();
    onSaved(sup);
  };
}

/* "Product receiving" — a running history of stock physically received from suppliers
   (e.g. 1000 pcs of tuna shredded), deliberately NOT an invoice/pricing feature — just
   quantity, supplier and date, kept for the record. Shown after a product has already
   been chosen via openProductPicker, same two-step flow as openStockEditModal.
   When the product being logged has stock tracking switched on, the received quantity
   is added straight onto its "stock on hand" (reusing the existing opt-in Stock feature);
   when it isn't tracked, this is purely a history trail and nothing else changes.
   `initial` lets the form survive a detour through "+ New supplier…" without losing
   whatever was already typed. */
function openLogReceiptDetailsModal(product, suppliers, onSaved, initial){
  initial = initial || {};
  const NEW_SUP_VALUE = '__newsup__';
  const today = new Date().toISOString().slice(0,10);
  function supplierOptionsHtml(selectedId){
    return `<option value="">Select supplier…</option>`
      + suppliers.map(s=>`<option value="${s.id}" ${s.id===selectedId?'selected':''}>${esc(s.name)}</option>`).join('')
      + `<option value="${NEW_SUP_VALUE}">+ New supplier…</option>`;
  }
  showModal(`<h3>Log received stock</h3>
    <p class="subtle" style="margin-top:-10px;">${esc(product.name)}</p>
    <div class="row2">
      <div class="field"><label>Quantity received</label><input type="number" id="rr_qty" step="any" placeholder="e.g. 1000" value="${initial.qty!=null?esc(initial.qty):''}" autofocus></div>
      <div class="field"><label>Unit</label><input type="text" id="rr_unit" value="${esc(initial.unit!=null?initial.unit:(product.unit||''))}" placeholder="pcs, kg…"></div>
    </div>
    <div class="field"><label>Supplier</label><select id="rr_supplier">${supplierOptionsHtml(initial.supplierId||'')}</select></div>
    <div class="field"><label>Date received</label><input type="date" id="rr_date" value="${initial.date||today}"></div>
    <div class="field"><label>Note (optional)</label><input type="text" id="rr_note" value="${esc(initial.note||'')}" placeholder="e.g. invoice #, batch, condition"></div>
    ${!isStockTracked(product) ? `<p class="subtle">This product isn't being stock-tracked, so this will just be logged to history — "stock on hand" won't change. Turn tracking on from Stock if you want it to.</p>` : ''}
    <div style="display:flex; gap:10px; margin-top:10px;">
      <button class="btn btn-signal" id="rr_save" style="flex:1;">Save</button>
      <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
    </div>`);
  $('#rr_supplier').onchange = e=>{
    if(e.target.value===NEW_SUP_VALUE){
      const snap = { qty:$('#rr_qty').value, unit:$('#rr_unit').value, date:$('#rr_date').value, note:$('#rr_note').value, supplierId:'' };
      openNewSupplierModal((sup)=>{
        suppliers.push(sup);
        suppliers.sort((a,b)=>a.name.localeCompare(b.name));
        snap.supplierId = sup.id;
        openLogReceiptDetailsModal(product, suppliers, onSaved, snap);
      });
    }
  };
  $('#rr_save').onclick = async ()=>{
    const qty = parseFloat($('#rr_qty').value);
    if(isNaN(qty) || qty<=0){ showAlert('Enter how much was received.'); return; }
    const supplierId = $('#rr_supplier').value;
    if(!supplierId || supplierId===NEW_SUP_VALUE){ showAlert('Select a supplier.'); return; }
    const supplier = suppliers.find(s=>s.id===supplierId);
    const unit = $('#rr_unit').value.trim();
    const receivedAt = $('#rr_date').value || today;
    const note = $('#rr_note').value.trim();
    const rec = {
      id: uid(), productId: product.id, productName: product.name,
      supplierId, supplierName: supplier ? supplier.name : '',
      qty: round2(qty), unit, receivedAt, note
    };
    await put('productReceipts', rec);
    const freshProduct = await getOne('products', product.id);
    if(freshProduct && isStockTracked(freshProduct)){
      freshProduct.stockQty = round2(parseFloat(freshProduct.stockQty) + qty);
      await put('products', freshProduct);
    }
    closeModal();
    onSaved(rec);
  };
}

async function boxReceiptsScreen(orderId, forceConfirm){
  const order = await getOne('orders', orderId);
  if(!order){ location.hash='#/orders'; render(); return; }
  const receipts = await getOrderBoxReceipts(orderId);
  const unconfirmed = unconfirmedBoxReceipts(receipts);
  const confirmed = receipts.filter(r=>r.dispatchedQty!=null);
  let boxTypes = (await getAll('boxTypes')).sort((a,b)=>a.name.localeCompare(b.name));
  let suppliers = (await getAll('suppliers')).sort((a,b)=>a.name.localeCompare(b.name));
  // one blank line to start; "+ Add another type" grows this, matching how a
  // delivery actually arrives — several box types counted in one go
  let lines = [{key:uid(), boxTypeId: boxTypes[0]?.id||'', qty:''}];
  let selectedSupplierId = '';

  const NEW_SUP_VALUE = '__newsup__';
  function supplierOptionsHtml(){
    return `<option value="">Select supplier…</option>`
      + suppliers.map(s=>`<option value="${s.id}" ${s.id===selectedSupplierId?'selected':''}>${esc(s.name)}</option>`).join('')
      + `<option value="${NEW_SUP_VALUE}">+ New supplier…</option>`;
  }

  $('#main').innerHTML = `
    <div class="topbar"><h1>Supplier deliveries</h1></div>
    <p class="subtle" style="margin-top:-10px;">${esc(order.vessel)} · ${esc(order.orderNumber)}</p>
    ${forceConfirm && unconfirmed.length ? `
      <div class="card" style="border:1.5px solid var(--warn); background:var(--warn-bg); margin-bottom:18px;">
        <b>Confirm what was actually loaded before this order can be finished.</b>
        <p class="subtle" style="margin:6px 0 0;">Enter how many were sent out for each delivery below — anything short of what was received gets flagged for you to track down.</p>
      </div>` : ''}
    ${unconfirmed.length ? `
      <div class="section-title">Awaiting confirmation</div>
      <div id="rcUnconfirmed" style="margin-bottom:6px;"></div>` : ''}
    <div class="topbar" style="margin-bottom:10px;">
      <div class="section-title" style="margin:0;">Log a received delivery</div>
      <a href="#/boxtypes" class="subtle" style="text-decoration:underline;">Manage box types</a>
    </div>
    <div class="card" style="margin-bottom:20px;">
      <div class="field"><label>Received from</label><select id="rc_supplier">${supplierOptionsHtml()}</select></div>
      <p class="subtle" style="margin-top:0;">Add one line per box type in this delivery.</p>
      <div id="rcLines"></div>
      <button class="btn btn-ghost btn-sm" id="rcAddLine" style="margin:6px 0 14px;">+ Add another type</button>
      <div class="field"><label>Note (optional)</label><input type="text" id="rc_note" placeholder="reference, anything else useful"></div>
      <button class="btn btn-signal" id="rc_save" style="width:100%;">Log this delivery</button>
    </div>
    ${confirmed.length ? `
      <div class="section-title">Already confirmed</div>
      <div id="rcConfirmed" style="margin-bottom:6px;"></div>` : ''}
    <a href="#/order/${orderId}/open" class="btn btn-ghost btn-sm">‹ Back to order</a>`;

  $('#rc_supplier').onchange = e=>{
    if(e.target.value===NEW_SUP_VALUE){
      openNewSupplierModal((newSup)=>{
        suppliers.push(newSup);
        suppliers.sort((a,b)=>a.name.localeCompare(b.name));
        selectedSupplierId = newSup.id;
        $('#rc_supplier').innerHTML = supplierOptionsHtml();
      });
      e.target.value = selectedSupplierId; // revert until the modal resolves (or is cancelled)
    } else {
      selectedSupplierId = e.target.value;
    }
  };

  const NEW_TYPE_VALUE = '__new__';
  function typeOptionsHtml(selectedId){
    return boxTypes.map(t=>`<option value="${t.id}" ${t.id===selectedId?'selected':''}>${esc(t.name)}</option>`).join('')
      + `<option value="${NEW_TYPE_VALUE}">+ New type…</option>`;
  }
  function drawLines(){
    $('#rcLines').innerHTML = lines.map(l=>`
      <div class="row2" data-line="${l.key}" style="align-items:end; margin-bottom:8px;">
        <div class="field" style="margin-bottom:0;"><label>Box type</label>
          <select class="rcl-type" data-line="${l.key}">${boxTypes.length?typeOptionsHtml(l.boxTypeId):`<option value="${NEW_TYPE_VALUE}">+ New type…</option>`}</select>
        </div>
        <div class="field" style="margin-bottom:0; display:flex; gap:8px; align-items:end;">
          <div style="flex:1;"><label>Quantity</label><input type="number" class="rcl-qty" data-line="${l.key}" step="any" min="0" placeholder="e.g. 5" value="${l.qty}"></div>
          ${lines.length>1 ? `<button type="button" class="iconbtn" data-removeline="${l.key}" title="Remove this line">✕</button>` : ''}
        </div>
      </div>`).join('');
    $('#rcLines').querySelectorAll('.rcl-type').forEach(sel=>sel.onchange = ()=>{
      const line = lines.find(l=>l.key===sel.dataset.line);
      if(sel.value===NEW_TYPE_VALUE){
        openNewBoxTypeModal((newType)=>{
          boxTypes.push(newType);
          boxTypes.sort((a,b)=>a.name.localeCompare(b.name));
          line.boxTypeId = newType.id;
          drawLines();
        });
        sel.value = line.boxTypeId; // revert the dropdown until the modal resolves (or is cancelled)
      } else {
        line.boxTypeId = sel.value;
      }
    });
    $('#rcLines').querySelectorAll('.rcl-qty').forEach(inp=>inp.oninput = ()=>{
      const line = lines.find(l=>l.key===inp.dataset.line);
      line.qty = inp.value;
    });
    $('#rcLines').querySelectorAll('[data-removeline]').forEach(btn=>btn.onclick = ()=>{
      lines = lines.filter(l=>l.key!==btn.dataset.removeline);
      drawLines();
    });
  }
  drawLines();
  $('#rcAddLine').onclick = ()=>{
    lines.push({key:uid(), boxTypeId: boxTypes[0]?.id||'', qty:''});
    drawLines();
  };
  $('#rc_save').onclick = async ()=>{
    if(!selectedSupplierId){ showAlert('Select who this delivery was received from.'); return; }
    const valid = lines.filter(l=>l.boxTypeId && parseFloat(l.qty)>0);
    if(!valid.length){ showAlert('Enter at least one box type and quantity.'); return; }
    const supplier = suppliers.find(s=>s.id===selectedSupplierId);
    const note = $('#rc_note').value.trim();
    const receivedAt = new Date().toISOString();
    for(const l of valid){
      const type = boxTypes.find(t=>t.id===l.boxTypeId);
      await put('boxReceipts', {
        id:uid(), orderId, orderLabel:`${order.vessel} · ${order.orderNumber}`,
        boxTypeId: l.boxTypeId, boxTypeName: type?type.name:'(deleted type)',
        supplierId: selectedSupplierId, supplierName: supplier?supplier.name:'',
        receivedQty: parseFloat(l.qty), receivedAt,
        dispatchedQty: null, dispatchedAt: null,
        note, resolved:false
      });
    }
    boxReceiptsScreen(orderId, forceConfirm);
  };

  // one card per supplier — each delivery is checked against that supplier's
  // own paperwork, so grouping this way matches how it's actually verified
  function groupBySupplier(list){
    const groups = new Map();
    for(const r of list){
      const key = r.supplierId || '';
      if(!groups.has(key)) groups.set(key, {supplierName: r.supplierName || 'No supplier', items: []});
      groups.get(key).items.push(r);
    }
    return [...groups.values()].sort((a,b)=>a.supplierName.localeCompare(b.supplierName));
  }

  if(unconfirmed.length){
    const groups = groupBySupplier(unconfirmed);
    $('#rcUnconfirmed').innerHTML = groups.map(g=>`
      <div class="card" style="margin-bottom:14px;">
        <div class="section-title" style="margin-bottom:8px;">${esc(g.supplierName)}</div>
        ${g.items.map(r=>`
          <div class="list-row">
            <div class="thumb">📦</div>
            <div style="flex:1; min-width:0;">
              <b>${esc(r.boxTypeName)}</b>
              <div class="subtle">Received: ${r.receivedQty}${r.note?' · '+esc(r.note):''}</div>
            </div>
            <input type="number" class="rc-dispatch-input" data-rid="${r.id}" placeholder="sent" style="width:84px;" step="any" min="0">
            <button class="btn btn-signal btn-sm" data-confirm="${r.id}">Confirm</button>
          </div>`).join('')}
      </div>`).join('');
    $('#rcUnconfirmed').querySelectorAll('[data-confirm]').forEach(btn=>btn.onclick = async ()=>{
      const rid = btn.dataset.confirm;
      const input = $('#rcUnconfirmed').querySelector(`input[data-rid="${rid}"]`);
      const dispatched = parseFloat(input.value);
      if(isNaN(dispatched) || dispatched<0){ showAlert('Enter how many were actually sent out with the order.'); return; }
      const rec = receipts.find(r=>r.id===rid);
      rec.dispatchedQty = dispatched;
      rec.dispatchedAt = new Date().toISOString();
      await put('boxReceipts', rec);
      const remaining = unconfirmed.filter(r=>r.id!==rid);
      if(forceConfirm && remaining.length===0) await finishOrder(orderId);
      else boxReceiptsScreen(orderId, forceConfirm);
    });
  }
  if(confirmed.length){
    const groups = groupBySupplier(confirmed);
    $('#rcConfirmed').innerHTML = groups.map(g=>`
      <div class="card" style="margin-bottom:14px;">
        <div class="section-title" style="margin-bottom:8px;">${esc(g.supplierName)}</div>
        ${g.items.map(r=>{
          const short = round2(r.receivedQty - r.dispatchedQty);
          return `<div class="list-row">
            <div class="thumb">📦</div>
            <div style="flex:1; min-width:0;">
              <b>${esc(r.boxTypeName)}</b>
              <div class="subtle">Received ${r.receivedQty} · Sent ${r.dispatchedQty}${r.note?' · '+esc(r.note):''}</div>
            </div>
            ${short>0
              ? (r.resolved ? `<span class="badge b-picking">${short} resolved</span>` : `<button class="btn btn-danger btn-sm" data-resolve="${r.id}">⚠ ${short} missing — resolve</button>`)
              : `<span class="badge b-completed">OK</span>`}
          </div>`;
        }).join('')}
      </div>`).join('');
    $('#rcConfirmed').querySelectorAll('[data-resolve]').forEach(btn=>btn.onclick = ()=>{
      showConfirm('Mark this shortfall as resolved (found, or written off)?', async ()=>{
        const rec = receipts.find(r=>r.id===btn.dataset.resolve);
        rec.resolved = true;
        await put('boxReceipts', rec);
        boxReceiptsScreen(orderId, forceConfirm);
      });
    });
  }
}

/* all unresolved shortfalls across every order — the running list Warehouse Mgmt
   surfaces so a gap doesn't get forgotten once that day's order is long closed */
async function openShortfalls(){
  const all = await getAll('boxReceipts');
  return all.filter(r=>r.dispatchedQty!=null && !r.resolved && (r.receivedQty - r.dispatchedQty) > 0);
}
route('deliveries', async ()=>{
  const shortfalls = (await openShortfalls()).sort((a,b)=>(b.dispatchedAt||'').localeCompare(a.dispatchedAt||''));
  $('#main').innerHTML = `
    <a href="#/warehouse" class="subtle" style="display:inline-block; margin-bottom:10px; text-decoration:none;">‹ Warehouse management</a>
    <div class="topbar"><h1>Supplier deliveries</h1>
      <button class="btn btn-signal" id="delLogBtn">+ Log a delivery</button>
    </div>
    <p class="subtle" style="margin-top:-10px;">Boxes received from suppliers vs. what actually went out with each order.</p>
    <div class="section-title">Unresolved shortfalls (${shortfalls.length})</div>
    <div class="card" id="shortList">
      ${shortfalls.length ? shortfalls.map(r=>{
        const short = round2(r.receivedQty - r.dispatchedQty);
        return `<div class="list-row">
          <div class="thumb">⚠</div>
          <div style="flex:1; min-width:0;">
            <b>${esc(r.boxTypeName)} — ${short} missing</b>
            <div class="subtle">${esc(r.orderLabel||'')} · received ${r.receivedQty}, sent ${r.dispatchedQty}${r.supplierName?' · from '+esc(r.supplierName):''}${r.note?' · '+esc(r.note):''}</div>
          </div>
          <a href="#/order/${r.orderId}/boxes" class="btn btn-ghost btn-sm">Open order</a>
          <button class="btn btn-ghost btn-sm" data-resolve="${r.id}">Mark resolved</button>
        </div>`;
      }).join('') : `<div class="empty"><div class="ic">📦</div>Nothing unresolved right now.</div>`}
    </div>`;
  $('#shortList').querySelectorAll('[data-resolve]').forEach(btn=>btn.onclick=()=>{
    showConfirm('Mark this shortfall as resolved (found, or written off)?', async ()=>{
      const rec = await getOne('boxReceipts', btn.dataset.resolve);
      rec.resolved = true;
      await put('boxReceipts', rec);
      routes['deliveries']([]);
    });
  });
  $('#delLogBtn').onclick = ()=>{
    openOrderPicker((order)=>{ location.hash = `#/order/${order.id}/boxes`; render(); });
  };
});

/* ============================ SUPPLIER RELIABILITY REPORT ============================
   The box-shortfall reconciliation above (received vs. actually dispatched) already
   produces exactly the signal needed here — this just rolls it up per supplier instead
   of per order, so it's usable as "evidence" the next time a supplier needs pushing
   back on. Only CONFIRMED receipts count (dispatchedQty set) — an unconfirmed one isn't
   a verdict on the supplier yet, it just hasn't been checked. A supplier with zero
   confirmed deliveries has nothing to measure and is left out rather than shown as 0%. */
function supplierReliabilityStats(receipts){
  const bySupplier = new Map(); // supplierKey -> {name, deliveries, shortCount, shortUnits}
  const byCombo = new Map();    // supplierKey|boxTypeName -> {supplierName, boxTypeName, deliveries, shortCount, shortUnits}
  for(const r of receipts){
    if(r.dispatchedQty==null) continue; // not confirmed yet — not reliability data
    const supKey = r.supplierId || '';
    const supName = r.supplierName || 'No supplier';
    const short = round2(r.receivedQty - r.dispatchedQty);
    const isShort = short > 0;

    if(!bySupplier.has(supKey)) bySupplier.set(supKey, {supplierId:supKey, supplierName:supName, deliveries:0, shortCount:0, shortUnits:0});
    const s = bySupplier.get(supKey);
    s.deliveries++; if(isShort){ s.shortCount++; s.shortUnits = round2(s.shortUnits+short); }

    const comboKey = supKey+'|'+r.boxTypeName;
    if(!byCombo.has(comboKey)) byCombo.set(comboKey, {supplierName:supName, boxTypeName:r.boxTypeName||'(unnamed)', deliveries:0, shortCount:0, shortUnits:0});
    const c = byCombo.get(comboKey);
    c.deliveries++; if(isShort){ c.shortCount++; c.shortUnits = round2(c.shortUnits+short); }
  }
  const suppliers = [...bySupplier.values()].map(s=>({...s, rate: s.deliveries ? s.shortCount/s.deliveries : 0}));
  suppliers.sort((a,b)=> b.rate-a.rate || b.shortUnits-a.shortUnits || b.deliveries-a.deliveries);
  const combos = [...byCombo.values()].filter(c=>c.shortCount>0);
  combos.sort((a,b)=> b.shortUnits-a.shortUnits || b.shortCount-a.shortCount);
  return {suppliers, combos};
}
route('reliability', async ()=>{
  const receipts = await getAll('boxReceipts');
  const {suppliers, combos} = supplierReliabilityStats(receipts);
  const confirmedTotal = suppliers.reduce((n,s)=>n+s.deliveries,0);
  const shortTotal = suppliers.reduce((n,s)=>n+s.shortCount,0);
  const shortUnitsTotal = round2(suppliers.reduce((n,s)=>n+s.shortUnits,0));
  function rateBadge(rate){
    if(rate===0) return `<span class="badge b-completed">0%</span>`;
    if(rate < 0.15) return `<span class="badge b-modified">${Math.round(rate*100)}%</span>`;
    return `<span class="badge b-unmatched">${Math.round(rate*100)}%</span>`;
  }
  $('#main').innerHTML = `
    <a href="#/warehouse" class="subtle" style="display:inline-block; margin-bottom:10px; text-decoration:none;">‹ Warehouse management</a>
    <div class="topbar"><h1>Supplier reliability</h1></div>
    <p class="subtle" style="margin-top:-10px;">Built from confirmed supplier deliveries — boxes received vs. what actually went out with the order. Ranked by how often a supplier comes up short.</p>
    <div class="grid-stats">
      <div class="stat"><b>${suppliers.length}</b><div class="lbl">Suppliers with confirmed deliveries</div></div>
      <div class="stat"><b>${confirmedTotal}</b><div class="lbl">Confirmed deliveries</div></div>
      <div class="stat"><b>${shortTotal}</b><div class="lbl">Came up short</div></div>
      <div class="stat"><b>${shortUnitsTotal}</b><div class="lbl">Total units short</div></div>
    </div>
    <h3 class="section-title">Suppliers, ranked by shortfall rate</h3>
    <div class="card" style="margin-bottom:24px;">
      ${suppliers.length ? suppliers.map((s,i)=>`
        <div class="list-row">
          <div style="width:28px;" class="subtle">${i+1}</div>
          <div style="flex:1; min-width:0;">
            <b>${esc(s.supplierName)}</b>
            <div class="subtle">${s.deliveries} delivered · ${s.shortCount} short${s.shortUnits?' · '+s.shortUnits+' units missing total':''}</div>
          </div>
          ${rateBadge(s.rate)}
        </div>`).join('') : `<div class="empty"><div class="ic">☏</div>No confirmed deliveries yet — reliability data appears once box deliveries are logged and confirmed.</div>`}
    </div>
    ${combos.length ? `
      <h3 class="section-title">Worst supplier / box-type combos</h3>
      <p class="subtle" style="margin-top:-10px;">Where to focus if you only push back on one or two things.</p>
      <div class="card">
        ${combos.slice(0,10).map(c=>`
          <div class="list-row">
            <div class="thumb">⚠</div>
            <div style="flex:1; min-width:0;">
              <b>${esc(c.supplierName)} — ${esc(c.boxTypeName)}</b>
              <div class="subtle">${c.shortCount} of ${c.deliveries} deliveries short · ${c.shortUnits} units missing total</div>
            </div>
          </div>`).join('')}
      </div>` : ''}`;
});

/* The user-owned list of box types (Ice boxes, Chicken boxes, …) that Supplier
   deliveries is built from — plain add/rename/delete, like Suppliers. Renaming
   doesn't touch history (each receipt keeps its own boxTypeName snapshot);
   deleting just removes it from future selection. */
route('boxtypes', async ()=>{
  const types = (await getAll('boxTypes')).sort((a,b)=>a.name.localeCompare(b.name));
  const receipts = await getAll('boxReceipts');
  function usageCount(typeId){ return receipts.filter(r=>r.boxTypeId===typeId).length; }

  $('#main').innerHTML = `
    <a href="#/warehouse" class="subtle" style="display:inline-block; margin-bottom:10px; text-decoration:none;">‹ Warehouse management</a>
    <div class="topbar"><h1>Box types</h1><button class="btn btn-signal" id="btAdd">+ Add box type</button></div>
    <p class="subtle" style="margin-top:-10px;">These are the types you pick from when logging a supplier delivery — add as many as you actually use.</p>
    <div class="card" id="btList">
      ${types.length ? types.map(t=>`
        <div class="list-row">
          <div class="thumb">📦</div>
          <div style="flex:1; min-width:0;"><b>${esc(t.name)}</b><div class="subtle">${usageCount(t.id)} delivery line${usageCount(t.id)===1?'':'s'} logged</div></div>
          <button class="iconbtn" data-edit="${t.id}" title="Rename">✎</button>
          <button class="iconbtn" data-del="${t.id}" title="Delete">✕</button>
        </div>`).join('') : `<div class="empty"><div class="ic">📦</div>No box types yet. Add the ones you actually receive — ice boxes, chicken boxes, whatever makes sense for you.</div>`}
    </div>`;

  $('#btAdd').onclick = ()=> openNewBoxTypeModal(()=> routes['boxtypes']([]));
  $('#btList').querySelectorAll('[data-edit]').forEach(b=>b.onclick=()=>{
    const t = types.find(x=>x.id===b.dataset.edit);
    showModal(`<h3>Rename box type</h3>
      <div class="field"><label>Name</label><input type="text" id="bt_name" value="${esc(t.name)}" autofocus></div>
      <div style="display:flex; gap:10px; margin-top:10px;">
        <button class="btn btn-signal" id="bt_save" style="flex:1;">Save</button>
        <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
      </div>`);
    $('#bt_save').onclick = async ()=>{
      const name = $('#bt_name').value.trim();
      if(!name){ showAlert('Enter a name.'); return; }
      t.name = name;
      await put('boxTypes', t);
      closeModal();
      routes['boxtypes']([]);
    };
  });
  $('#btList').querySelectorAll('[data-del]').forEach(b=>b.onclick=()=>{
    const t = types.find(x=>x.id===b.dataset.del);
    const used = usageCount(t.id);
    const msg = used
      ? `Delete "${t.name}"? It won't be offered for new deliveries, but the ${used} delivery line${used===1?'':'s'} already logged with it keep their record.`
      : `Delete "${t.name}"?`;
    showConfirm(msg, async ()=>{
      await del('boxTypes', t.id);
      routes['boxtypes']([]);
    }, {danger:true, yesLabel:'Delete type'});
  });
});

