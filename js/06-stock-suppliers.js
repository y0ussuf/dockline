/* ==================================== STOCK ==================================== */
function openStockEditModal(product, onSaved){
  showModal(`
    <h3>Stock — ${esc(product.name)}</h3>
    <p class="subtle">Leave "Stock on hand" blank to stop tracking this product again.</p>
    <div class="row2">
      <div class="field"><label>Stock on hand</label><input type="number" id="stk_qty" step="any" placeholder="not tracked" value="${product.stockQty===''||product.stockQty==null?'':esc(product.stockQty)}"></div>
      <div class="field"><label>Low stock limit</label><input type="number" id="stk_limit" step="any" placeholder="0" value="${product.lowStockLimit===''||product.lowStockLimit==null?'':esc(product.lowStockLimit)}"></div>
    </div>
    <div style="display:flex; gap:10px; margin-top:10px;">
      <button class="btn btn-signal" id="stk_save" style="flex:1;">Save</button>
      <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
    </div>`);
  $('#stk_save').onclick = async ()=>{
    product.stockQty = $('#stk_qty').value.trim()==='' ? '' : parseFloat($('#stk_qty').value);
    product.lowStockLimit = $('#stk_limit').value.trim()==='' ? '' : parseFloat($('#stk_limit').value);
    await put('products', product);
    closeModal();
    onSaved();
  };
}

/* ==================================== WAREHOUSE MANAGEMENT (hub) ====================================
   A landing page for warehouse-side tools, kept separate from the picking/ordering flow on purpose —
   this is where stock levels live today, and where supplier bills and anything else warehouse-related
   get added over time, each as its own card/sub-page, without cluttering Orders/Products/History. */
route('warehouse', async ()=>{
  const [productsAll, warehouses, sections, suppliersAll, receiptsAll] = await Promise.all([
    getAll('products'), getAll('warehouses'), getAll('sections'), getAll('suppliers'), getAll('productReceipts')
  ]);
  const whMap = Object.fromEntries(warehouses.map(w=>[w.id,w]));
  const secMap = Object.fromEntries(sections.map(s=>[s.id,s]));
  const products = productsAll.filter(p=>p.active);
  const tracked = products.filter(isStockTracked);
  const low = tracked.filter(isLowStock);
  const shortfalls = await openShortfalls();
  const sortedSuppliers = suppliersAll.slice().sort((a,b)=>a.name.localeCompare(b.name));

  $('#main').innerHTML = `
    <div class="topbar"><h1>Warehouse management</h1></div>
    <p class="subtle" style="margin-top:-10px; margin-bottom:22px;">Tools for running the warehouse itself — stock levels today, more coming as you need them.</p>
    <div class="grid-stats" style="margin-bottom:26px;">
      <div class="stat"><b>${low.length}</b><div class="lbl">Low stock items</div></div>
      <div class="stat"><b>${tracked.length}</b><div class="lbl">Products tracked</div></div>
      <div class="stat"><b>${shortfalls.length}</b><div class="lbl">Unresolved box shortfalls</div></div>
      <div class="stat"><b>${receiptsAll.length}</b><div class="lbl">Receiving entries logged</div></div>
    </div>
    <div class="card" style="margin-bottom:16px;">
      <div style="display:flex; align-items:center; gap:16px; flex-wrap:wrap;">
        <div style="flex:1; min-width:220px;">
          <div class="section-title" style="margin-bottom:4px;">Stock levels</div>
          <p class="subtle" style="margin:0;">See what's low, update quantities, and start tracking new products. Stock reduces automatically whenever an order finishes.</p>
        </div>
        <div style="display:flex; gap:10px; flex-wrap:wrap;">
          <a href="#/stock" class="btn btn-signal">⚠ View low stock (${low.length})</a>
          <a href="#/stock/all" class="btn btn-ghost">Manage all stock</a>
        </div>
      </div>
    </div>
    <div class="card" style="margin-bottom:16px;">
      <div style="display:flex; align-items:center; gap:16px; flex-wrap:wrap;">
        <div style="flex:1; min-width:220px;">
          <div class="section-title" style="margin-bottom:4px;">Supplier deliveries</div>
          <p class="subtle" style="margin:0;">Reconcile fish/meat/pork boxes received from suppliers against what actually went out with each order. Confirming the sent count is required before that order can finish.</p>
        </div>
        <div style="display:flex; gap:10px; flex-wrap:wrap;">
          <button class="btn btn-signal" id="hubLogDelivery">+ Log a delivery</button>
          <a href="#/deliveries" class="btn ${shortfalls.length?'btn-danger':'btn-ghost'}">${shortfalls.length?`⚠ ${shortfalls.length} unresolved`:'View deliveries'}</a>
          <a href="#/boxtypes" class="btn btn-ghost">Box types</a>
          <a href="#/reliability" class="btn btn-ghost">📊 Supplier reliability</a>
        </div>
      </div>
    </div>
    <div class="card" style="margin-bottom:16px;">
      <div style="display:flex; align-items:center; gap:16px; flex-wrap:wrap;">
        <div style="flex:1; min-width:220px;">
          <div class="section-title" style="margin-bottom:4px;">Product receiving</div>
          <p class="subtle" style="margin:0;">Log quantities of products received from suppliers — e.g. 1000 pcs of tuna shredded — and keep a running history of it. Not invoices or prices, just how much came in, from who, and when.</p>
        </div>
        <div style="display:flex; gap:10px; flex-wrap:wrap;">
          <button class="btn btn-signal" id="hubLogReceipt">+ Log received stock</button>
          <a href="#/receiving" class="btn btn-ghost">View history</a>
        </div>
      </div>
    </div>
    <div class="card">
      <div style="display:flex; align-items:center; gap:16px; flex-wrap:wrap;">
        <div style="flex:1; min-width:220px;">
          <div class="section-title" style="margin-bottom:4px;">Low stock report</div>
          <p class="subtle" style="margin:0;">Download an Excel sheet of everything currently low, grouped by the supplier who restocks it — so you know exactly who to call.</p>
        </div>
        <div style="display:flex; gap:10px; flex-wrap:wrap;">
          <a href="#/stock" class="btn btn-ghost">${low.length ? `⬇ Export ${low.length} low item${low.length===1?'':'s'}` : 'View stock'}</a>
        </div>
      </div>
    </div>`;
  $('#hubLogDelivery').onclick = ()=>{
    openOrderPicker((order)=>{ location.hash = `#/order/${order.id}/boxes`; render(); });
  };
  $('#hubLogReceipt').onclick = ()=>{
    openProductPicker(null, products, whMap, secMap, (picked)=>{
      openLogReceiptDetailsModal(picked, sortedSuppliers, ()=>{ location.hash = '#/receiving'; render(); });
    });
  };
});

route('stock', async (parts)=>{
  const [productsAll, warehouses, sections, suppliersAll] = await Promise.all([getAll('products'), getAll('warehouses'), getAll('sections'), getAll('suppliers')]);
  const whMap = Object.fromEntries(warehouses.map(w=>[w.id,w]));
  const secMap = Object.fromEntries(sections.map(s=>[s.id,s]));
  const supMap = new Map(suppliersAll.map(s=>[s.id,s]));
  const products = productsAll.filter(p=>p.active);

  window.__stockFilter = window.__stockFilter || (parts[0]==='all' ? 'tracked' : 'low');
  window.__stockSearch = window.__stockSearch || '';

  function locationLabel(p){
    const sec = secMap[p.sectionId], wh = whMap[p.warehouseId];
    return [wh?wh.name:'', sec?sec.name:''].filter(Boolean).join(' / ') || 'Unassigned';
  }

  function draw(){
    const tracked = products.filter(isStockTracked);
    const low = tracked.filter(isLowStock);
    const untracked = products.filter(p=>!isStockTracked(p));
    let list = window.__stockFilter==='low' ? low : window.__stockFilter==='tracked' ? tracked : untracked;
    if(window.__stockSearch){
      const q = normalize(window.__stockSearch);
      list = list.filter(p=>normalize(p.name).includes(q));
    }
    list = list.slice().sort((a,b)=>{
      if(window.__stockFilter==='low'){
        const da = parseFloat(a.stockQty)-stockLimitOf(a), db = parseFloat(b.stockQty)-stockLimitOf(b);
        if(da!==db) return da-db;
      }
      return a.name.localeCompare(b.name);
    });

    $('#main').innerHTML = `
      <a href="#/warehouse" class="subtle" style="display:inline-block; margin-bottom:10px; text-decoration:none;">‹ Warehouse management</a>
      <div class="topbar"><h1>Stock</h1>
        <div style="display:flex; gap:10px; flex-wrap:wrap;">
          <button class="btn btn-ghost" id="stkExportLow" ${low.length?'':'disabled'}>⬇ Export low stock (${low.length})</button>
          <button class="btn btn-signal" id="stkTrackNew">+ Start tracking a product</button>
        </div>
      </div>
      <p class="subtle" style="margin-top:-10px;">Only products with a stock number entered are tracked — the rest are left exactly alone. Stock reduces automatically when an order finishes.</p>
      <div class="field" style="max-width:360px;"><input type="text" id="stkSearch" placeholder="Search…" value="${esc(window.__stockSearch)}"></div>
      <div class="tag-row">
        <button class="chip ${window.__stockFilter==='low'?'active':''}" data-f="low">⚠ Low stock (${low.length})</button>
        <button class="chip ${window.__stockFilter==='tracked'?'active':''}" data-f="tracked">All tracked (${tracked.length})</button>
        <button class="chip ${window.__stockFilter==='untracked'?'active':''}" data-f="untracked">Not tracked (${untracked.length})</button>
      </div>
      <div class="card" id="stkList">
        ${list.length ? list.map(p=>`
          <div class="list-row">
            <div class="thumb">${p.image?`<img src="${p.image}" loading="lazy" decoding="async">`:'📦'}</div>
            <div style="flex:1; min-width:0;">
              <div style="font-weight:700;">${esc(p.name)} ${isLowStock(p)?'<span class="badge b-lowstock">low stock</span>':''}</div>
              <div class="subtle">${esc(locationLabel(p))}${p.unit?' · '+esc(p.unit):''}</div>
            </div>
            ${isStockTracked(p) ? `
              <div style="text-align:right; margin-right:4px;">
                <div style="font-weight:700; font-family:var(--font-d);">${p.stockQty}</div>
                <div class="subtle" style="font-size:.72rem;">limit ${stockLimitOf(p)}</div>
              </div>` : ''}
            <button class="btn btn-ghost btn-sm" data-edit="${p.id}">${isStockTracked(p)?'Update':'Set stock'}</button>
          </div>`).join('') : `<div class="empty"><div class="ic">▣</div>${
            window.__stockFilter==='low' ? 'Nothing is low right now.' :
            window.__stockFilter==='tracked' ? 'No products are tracked yet — use "Start tracking a product" or set a stock number from a product’s edit form.' :
            'Every active product is tracked.'
          }</div>`}
      </div>`;

    $('#stkTrackNew').onclick = ()=>{
      openProductPicker(null, products, whMap, secMap, (picked)=>{
        openStockEditModal(picked, ()=>{ routes['stock']([]); });
      });
    };
    if(low.length) $('#stkExportLow').onclick = ()=> exportLowStockExcel(low, supMap);
    let stkDebounce;
    $('#stkSearch').oninput = e=>{
      const val = e.target.value;
      clearTimeout(stkDebounce);
      stkDebounce = setTimeout(()=>{ window.__stockSearch = val; draw(); }, 180);
    };
    $('#main').querySelector('.tag-row').onclick = e=>{
      const b = e.target.closest('[data-f]'); if(!b) return;
      window.__stockFilter = b.dataset.f;
      draw();
    };
    $('#stkList').querySelectorAll('[data-edit]').forEach(b=>b.onclick=()=>{
      const p = products.find(x=>x.id===b.dataset.edit);
      openStockEditModal(p, ()=>{ routes['stock']([]); });
    });
  }
  draw();
});

/* ==================================== ORDERS LIST ==================================== */
/* ==================================== SUPPLIERS ==================================== */
route('suppliers', async ()=>{
  const [suppliers, products] = await Promise.all([getAll('suppliers'), getAll('products')]);
  suppliers.sort((a,b)=>a.name.localeCompare(b.name));
  window.__supplierSearch = window.__supplierSearch || '';
  window.__expandedSupplier = window.__expandedSupplier || null;

  function productsFor(supId){ return products.filter(p=>p.supplierId===supId); }

  function draw(){
    const q = normalize(window.__supplierSearch);
    const list = suppliers.filter(s=>!q || normalize(s.name).includes(q));
    $('#main').innerHTML = `
      <div class="topbar"><h1>Suppliers</h1><button class="btn btn-signal" id="addSup">+ Add supplier</button></div>
      <div class="field" style="max-width:360px;"><input type="text" id="supSearch" placeholder="Search suppliers…" value="${esc(window.__supplierSearch)}"></div>
      <div class="card" id="supList">
        ${list.length ? list.map(s=>{
          const prods = productsFor(s.id);
          const expanded = window.__expandedSupplier===s.id;
          return `<div>
            <div class="list-row" data-suprow="${s.id}" style="cursor:pointer;">
              <div class="thumb">☏</div>
              <div style="flex:1; min-width:0;">
                <b>${esc(s.name)}</b>
                <div class="subtle">${prods.length} product${prods.length===1?'':'s'}${s.contactPerson?' · '+esc(s.contactPerson):''}${s.phone?' · '+esc(s.phone):''}</div>
              </div>
              <button class="iconbtn" data-editsup="${s.id}" title="Edit">✎</button>
              <button class="iconbtn" data-delsup="${s.id}" title="Delete">✕</button>
            </div>
            ${expanded ? `
              <div style="padding:6px 10px 16px 66px;">
                ${s.email||s.notes ? `<div class="subtle" style="margin-bottom:8px;">${s.email?'✉ '+esc(s.email):''}${s.email&&s.notes?' · ':''}${esc(s.notes||'')}</div>` : ''}
                ${prods.length ? prods.map(p=>`
                  <div class="list-row" style="padding:8px 0;">
                    <div class="thumb" style="width:34px; height:34px; font-size:1rem;">${p.image?`<img src="${p.image}" loading="lazy" decoding="async">`:'📦'}</div>
                    <div style="flex:1;">${esc(p.name)}<span class="subtle"> · ${esc(p.unit||'no unit')}</span></div>
                    <button class="btn btn-ghost btn-sm" data-gotoprod="${p.id}">Edit</button>
                  </div>`).join('') : `<p class="subtle">No products linked to this supplier yet.</p>`}
              </div>` : ''}
          </div>`;
        }).join('') : `<div class="empty"><div class="ic">☏</div>${suppliers.length? 'No suppliers match your search.' : 'No suppliers yet. Add one, or add a supplier from a product\u2019s edit form.'}</div>`}
      </div>`;

    let supDebounce;
    $('#supSearch').oninput = e=>{
      const val = e.target.value;
      clearTimeout(supDebounce);
      supDebounce = setTimeout(()=>{ window.__supplierSearch = val; draw(); }, 180);
    };
    $('#addSup').onclick = ()=>supplierForm(null);
    $('#supList').querySelectorAll('[data-suprow]').forEach(row=>row.addEventListener('click', e=>{
      if(e.target.closest('[data-editsup],[data-delsup],[data-gotoprod]')) return;
      const id = row.dataset.suprow;
      window.__expandedSupplier = window.__expandedSupplier===id ? null : id;
      draw();
    }));
    $('#supList').querySelectorAll('[data-editsup]').forEach(b=>b.addEventListener('click', e=>{
      e.stopPropagation();
      supplierForm(suppliers.find(s=>s.id===b.dataset.editsup));
    }));
    $('#supList').querySelectorAll('[data-delsup]').forEach(b=>b.addEventListener('click', e=>{
      e.stopPropagation();
      const sup = suppliers.find(s=>s.id===b.dataset.delsup);
      const linked = productsFor(sup.id);
      const msg = linked.length
        ? `Delete "${sup.name}"? ${linked.length} product${linked.length===1?'':'s'} using it will be set to "No supplier".`
        : `Delete "${sup.name}"?`;
      showConfirm(msg, async ()=>{
        for(const p of linked){ p.supplierId=''; await put('products', p); }
        await del('suppliers', sup.id);
        routes['suppliers']([]);
      }, {danger:true, yesLabel:'Delete supplier'});
    }));
    $('#supList').querySelectorAll('[data-gotoprod]').forEach(b=>b.addEventListener('click', e=>{
      e.stopPropagation();
      location.hash = '#/products';
      setTimeout(async ()=>{
        const p = await getOne('products', b.dataset.gotoprod);
        const [wh, sec, sup] = await Promise.all([getAll('warehouses'), getAll('sections'), getAll('suppliers')]);
        openProductForm(p, wh, sec, sup);
      }, 50);
    }));
  }

  function supplierForm(s){
    const editing = !!s;
    s = s || {id:uid(), name:'', contactPerson:'', phone:'', email:'', notes:''};
    showModal(`<h3>${editing?'Edit supplier':'Add supplier'}</h3>
      <div class="field"><label>Supplier name</label><input type="text" id="sp_name" value="${esc(s.name)}"></div>
      <div class="row2">
        <div class="field"><label>Contact person</label><input type="text" id="sp_contact" value="${esc(s.contactPerson)}"></div>
        <div class="field"><label>Phone</label><input type="text" id="sp_phone" value="${esc(s.phone)}"></div>
      </div>
      <div class="field"><label>Email</label><input type="text" id="sp_email" value="${esc(s.email)}"></div>
      <div class="field"><label>Notes</label><textarea id="sp_notes">${esc(s.notes)}</textarea></div>
      <div style="display:flex; gap:10px; margin-top:10px;">
        <button class="btn btn-signal" id="sp_save" style="flex:1;">Save</button>
        <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
      </div>`);
    $('#sp_save').onclick = async ()=>{
      const name = $('#sp_name').value.trim();
      if(!name){ showAlert('Supplier name is required.'); return; }
      const all = await getAll('suppliers');
      const clash = all.find(x=>x.id!==s.id && normalize(x.name)===normalize(name));
      if(clash){ showAlert(`A supplier named "${clash.name}" already exists.`); return; }
      s.name=name; s.contactPerson=$('#sp_contact').value.trim(); s.phone=$('#sp_phone').value.trim();
      s.email=$('#sp_email').value.trim(); s.notes=$('#sp_notes').value.trim();
      await put('suppliers', s);
      closeModal();
      routes['suppliers']([]);
    };
  }
  draw();
});

async function deleteOrderCascade(orderId){
  const items = (await getAll('orderItems')).filter(it=>it.orderId===orderId);
  for(const it of items) await del('orderItems', it.id);
  await del('orders', orderId);
}

route('orders', async ()=>{
  const orders = (await getAll('orders')).filter(o=>o.status!=='completed').sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
  $('#main').innerHTML = `
    <div class="topbar"><h1>Orders</h1><a href="#/order/new" class="btn btn-signal">+ New Order</a></div>
    <div class="card" id="ordersList">
      ${orders.length? orders.map(o=>`
        <div class="list-row">
          <div class="thumb">🚢</div>
          <div style="flex:1; min-width:0;"><b>${esc(o.vessel)}</b> <span class="subtle">· ${esc(o.orderNumber)}</span>
          <div class="subtle">IMO ${esc(o.imo)} · ${fmtDate(o.orderDate)}</div></div>
          ${destinationBadge(o.destination)}
          <span class="badge b-${o.status}">${o.status}</span>
          <a href="#/order/${o.id}/open" class="btn btn-ghost btn-sm">Continue</a>
          <button class="iconbtn" data-delorder="${o.id}" title="Delete order">✕</button>
        </div>`).join('') : `<div class="empty"><div class="ic">🚢</div>No open orders. Create one to get started.</div>`}
    </div>`;
  $('#ordersList').querySelectorAll('[data-delorder]').forEach(b=>b.onclick=()=>{
    showConfirm('Delete this order? This cannot be undone.', async ()=>{
      await deleteOrderCascade(b.dataset.delorder);
      routes['orders']([]);
    }, {danger:true, yesLabel:'Delete order'});
  });
});

route('history', async ()=>{
  const orders = (await getAll('orders')).filter(o=>o.status==='completed').sort((a,b)=>(b.completedAt||'').localeCompare(a.completedAt||''));
  $('#main').innerHTML = `
    <div class="topbar"><h1>History</h1></div>
    <p class="subtle" style="margin-top:-10px;">Search/filter by ship, IMO, and date is coming in the next pass. Completed orders below.</p>
    <div class="card" id="historyList">
      ${orders.length? orders.map(o=>`
        <div class="list-row">
          <div class="thumb">✅</div>
          <div style="flex:1; min-width:0;"><b>${esc(o.vessel)}</b> <span class="subtle">· ${esc(o.orderNumber)} · IMO ${esc(o.imo)}</span>
          <div class="subtle">Completed ${fmtDate(o.completedAt)}</div></div>
          ${destinationBadge(o.destination)}
          <a href="#/order/${o.id}/summary" class="btn btn-ghost btn-sm">View</a>
          <button class="iconbtn" data-delorder="${o.id}" title="Delete order">✕</button>
        </div>`).join('') : `<div class="empty"><div class="ic">◔</div>Completed orders will appear here.</div>`}
    </div>`;
  $('#historyList').querySelectorAll('[data-delorder]').forEach(b=>b.onclick=()=>{
    showConfirm('Delete this completed order from history? This cannot be undone.', async ()=>{
      await deleteOrderCascade(b.dataset.delorder);
      routes['history']([]);
    }, {danger:true, yesLabel:'Delete order'});
  });
});

