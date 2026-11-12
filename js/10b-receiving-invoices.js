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
  const changed = new Map(); const newBatches = [];
  await new Promise((resolve,reject)=>{
    const stores = ['products','productReceipts','receivingInvoices','batches'];
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
        if(d.delta){
          p.stockQty = round2(parseFloat(p.stockQty)+d.delta); pending.set(p.id,p);
          if(p.trackBatches){
            const b = {id:uid(), productId:p.id, productName:p.name, batchNo:l.batchNo||'', productionDate:l.productionDate||'', expiryDate:l.expiryDate||'',
              qtyReceived:d.delta, qtyRemaining:d.delta, supplierId:header.supplierId, supplierName:header.supplierName, invoiceId:header.id,
              receivedAt:header.receivedAt, kind:'delivery', createdAt:header.createdAt, packSize:l.packSize===''||l.packSize==null?'':parseFloat(l.packSize)};
            if(l.packLabel){
              b.packLabel = l.packLabel;
              if(l.packCost || l.packSell){ p.packPrices = Object.assign({}, p.packPrices); const e = Object.assign({}, p.packPrices[l.packLabel]||{}); if(l.packCost) e.cost = l.packCost; if(l.packSell) e.sell = l.packSell; p.packPrices[l.packLabel] = e; pending.set(p.id,p); }
            }
            t.objectStore('batches').put(b); newBatches.push(b); l.batchId = b.id;
          }
        }
        next();
      };
    }
    next();
  });
  queueSync('receivingInvoices', header.id, 'put');
  lines.forEach(l=>queueSync('productReceipts', l.id, 'put'));
  changed.forEach((p,id)=>queueSync('products', id, 'put'));
  newBatches.forEach(b=>queueSync('batches', b.id, 'put'));
}

async function deleteDelivery(invoiceId){
  const db = await dbp;
  const done = {lines:[], products:[], batches:[]};
  await new Promise((resolve,reject)=>{
    const stores = ['products','productReceipts','receivingInvoices','batches'];
    stores.forEach(markDirty);
    const t = db.transaction(stores,'readwrite');
    t.oncomplete = ()=>{ stores.forEach(markDirty); resolve(); };
    t.onerror = ()=>reject(t.error);
    t.onabort = ()=>reject(t.error||new Error('Not deleted'));
    const rOs = t.objectStore('productReceipts'), pOs = t.objectStore('products'), bOs = t.objectStore('batches');
    rOs.getAll().onsuccess = (e)=>{
      const lines = e.target.result.filter(r=>r.invoiceId===invoiceId);
      done.lines = lines.map(l=>l.id);
      bOs.getAll().onsuccess = (be)=>{
        const batches = be.target.result.filter(b=>b.invoiceId===invoiceId);
        const used = batches.find(b=>b.qtyRemaining < b.qtyReceived - 0.005);
        if(used){ try{ t.abort(); }catch(_){} reject(new Error('Part of this delivery has already been picked, so it can no longer be deleted.')); return; }
        batches.forEach(b=>{ bOs.delete(b.id); done.batches.push(b.id); });
        const prods = new Map();
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
        let left = ids.length;
        ids.forEach(id=>{ pOs.get(id).onsuccess = (ev)=>{ prods.set(id, ev.target.result); if(--left===0) finish(); }; });
      };
    };
  });
  done.lines.forEach(id=>queueSync('productReceipts', id, 'del'));
  done.batches.forEach(id=>queueSync('batches', id, 'del'));
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
  const [invoices, receipts, suppliers] = await Promise.all([
    getAll('receivingInvoices'),
    getAll('productReceipts'),
    getAll('suppliers')
  ]);
  const counts = {};
  const qtyByInv = {};
  receipts.forEach(r=>{
    if(r.invoiceId){
      counts[r.invoiceId] = (counts[r.invoiceId]||0) + 1;
      qtyByInv[r.invoiceId] = (qtyByInv[r.invoiceId]||0) + (parseFloat(r.qty)||0);
    }
  });

  const nowMonth = todayISO().slice(0,7);
  const thisMonthInvoices = invoices.filter(i=> (i.receivedAt||'').startsWith(nowMonth));
  const totalUnitsThisMonth = receipts
    .filter(r=> (r.receivedAt||'').startsWith(nowMonth))
    .reduce((sum, r)=> sum + (parseFloat(r.qty)||0), 0);
  const uniqueSuppliersCount = new Set(invoices.map(i=> i.supplierId).filter(Boolean)).size;

  const legacy = receipts.filter(r=>!r.invoiceId);
  const entries = invoices.map(i=>({kind:'inv', date:i.receivedAt||'', ts:i.createdAt||'', i, n:counts[i.id]||i.lineCount||0, totalQty:qtyByInv[i.id]||0}))
    .concat(legacy.map(r=>({kind:'old', date:r.receivedAt||'', ts:r.receivedAt||'', r, n:1, totalQty:parseFloat(r.qty)||0})))
    .sort((a,b)=>(b.date.localeCompare(a.date))||(String(b.ts).localeCompare(String(a.ts))));
  const draft = loadDraft();

  const supOptions = suppliers.slice().sort((a,b)=>a.name.localeCompare(b.name))
    .map(s=>`<option value="${s.id}">${esc(s.name)}</option>`).join('');

  $('#main').innerHTML = `
    <div class="topbar">
      <div>
        <h1>Goods Inward / Receiving</h1>
        <div class="subtle">Record inbound stock receipts, track batches & manage supplier delivery notes</div>
      </div>
      <div style="display:flex; gap:10px; flex-wrap:wrap;">
        <a href="#/receiving/new" class="btn btn-signal" id="rcNewBtn"><b>+</b> Receive Delivery</a>
        <a href="#/warehouse" class="btn btn-ghost">Warehouses</a>
      </div>
    </div>

    <!-- Receiving KPI Summary Strip -->
    <div class="rcv-kpi-grid">
      <div class="rcv-kpi-card">
        <div class="rcv-kpi-icon orange">🚚</div>
        <div class="rcv-kpi-info">
          <div class="rcv-kpi-val">${thisMonthInvoices.length}</div>
          <div class="rcv-kpi-lbl">Deliveries This Month</div>
        </div>
      </div>
      <div class="rcv-kpi-card">
        <div class="rcv-kpi-icon green">📦</div>
        <div class="rcv-kpi-info">
          <div class="rcv-kpi-val">${round2(totalUnitsThisMonth)}</div>
          <div class="rcv-kpi-lbl">Units Received (This Month)</div>
        </div>
      </div>
      <div class="rcv-kpi-card">
        <div class="rcv-kpi-icon blue">🏢</div>
        <div class="rcv-kpi-info">
          <div class="rcv-kpi-val">${uniqueSuppliersCount || suppliers.length}</div>
          <div class="rcv-kpi-lbl">Active Suppliers</div>
        </div>
      </div>
    </div>

    ${draft && draft.lines && draft.lines.length ? `
      <div class="card" style="border:1.5px solid var(--warn); background:var(--warn-bg); margin-bottom:18px; display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:12px;">
        <div>
          <b style="color:var(--warn); font-size:1.02rem;">⚠️ Unsaved Goods Inward Draft in Progress</b>
          <div class="subtle" style="margin-top:2px;">
            ${draft.lines.length} item line${draft.lines.length===1?'':'s'}${draft.supplierName?' · '+esc(draft.supplierName):''}${draft.invoiceNo?' · Doc #'+esc(draft.invoiceNo):''}
          </div>
        </div>
        <div style="display:flex; gap:8px;">
          <a href="#/receiving/new" class="btn btn-signal btn-sm">Resume Intake</a>
          <button class="btn btn-ghost btn-sm" id="rcDropDraft">Discard Draft</button>
        </div>
      </div>` : ''}

    <!-- Filtering & Search Tools -->
    <div class="rcv-filter-bar">
      <div class="search-box">
        <input type="text" id="rcSearch" placeholder="🔍 Search supplier, invoice #, batch #, or product…">
      </div>
      <select id="rcSupFilter">
        <option value="">All Suppliers</option>
        ${supOptions}
      </select>
      <select id="rcDateFilter">
        <option value="all">All Dates</option>
        <option value="month" selected>This Month (${nowMonth})</option>
        <option value="recent">Last 7 Days</option>
      </select>
    </div>

    <!-- Structured Delivery Register -->
    <div class="rcv-table-card">
      <div id="rcList"></div>
    </div>`;

  const dd = $('#rcDropDraft');
  if(dd) dd.onclick = ()=>{ clearDraft(); deliveryListScreen(); };

  const prodByInv = {};
  const batchByInv = {};
  receipts.forEach(r=>{
    if(r.invoiceId){
      (prodByInv[r.invoiceId] = prodByInv[r.invoiceId] || []).push(normalize(r.productName));
      if(r.batchNo) (batchByInv[r.invoiceId] = batchByInv[r.invoiceId] || []).push(normalize(r.batchNo));
    }
  });

  function draw(){
    const q = ($('#rcSearch') ? $('#rcSearch').value : '').trim();
    const supId = $('#rcSupFilter') ? $('#rcSupFilter').value : '';
    const dateRange = $('#rcDateFilter') ? $('#rcDateFilter').value : 'all';
    const nq = normalize(q);

    const sevenDaysAgo = new Date(Date.now() - 7*86400000).toISOString().slice(0,10);

    const rows = entries.filter(e=>{
      // Date filter
      if(dateRange === 'month' && !e.date.startsWith(nowMonth)) return false;
      if(dateRange === 'recent' && e.date < sevenDaysAgo) return false;

      // Supplier filter
      if(supId){
        if(e.kind==='inv' && e.i.supplierId !== supId) return false;
        if(e.kind==='old' && e.r.supplierId !== supId) return false;
      }

      // Text query
      if(!nq) return true;
      if(e.kind==='inv'){
        const matchHead = normalize((e.i.supplierName||'')+' '+(e.i.invoiceNo||'')).includes(nq);
        const matchProd = (prodByInv[e.i.id]||[]).some(n=>n.includes(nq));
        const matchBatch = (batchByInv[e.i.id]||[]).some(b=>b.includes(nq));
        return matchHead || matchProd || matchBatch;
      }
      return normalize((e.r.productName||'')+' '+(e.r.supplierName||'')+' '+(e.r.batchNo||'')).includes(nq);
    });

    if(!rows.length){
      $('#rcList').innerHTML = `
        <div style="text-align:center; padding:44px 20px; color:var(--ink-soft);">
          <div style="font-size:2.4rem; margin-bottom:8px;">📦</div>
          <b>${entries.length ? 'No deliveries match your search/filter.' : 'No goods received yet.'}</b>
          <div style="font-size:.85rem; margin-top:4px;">Tap “+ Receive Delivery” to log your first inbound shipment.</div>
        </div>`;
      return;
    }

    $('#rcList').innerHTML = rows.map(e=>{
      if(e.kind === 'inv'){
        return `
          <a class="rcv-row" href="#/receiving/${e.i.id}">
            <div style="width:140px; flex-shrink:0;">
              <span class="rcv-inv-badge">${e.i.invoiceNo ? esc(e.i.invoiceNo) : 'NO-DOC'}</span>
            </div>
            <div style="flex:1; min-width:200px;">
              <div class="rcv-supplier-name">${esc(e.i.supplierName || 'Unknown Supplier')}</div>
              <div class="rcv-meta">
                <span>📅 Received: <b>${fmtDate(e.i.receivedAt)}</b></span>
                ${e.i.note ? `<span>· <i>${esc(e.i.note)}</i></span>` : ''}
              </div>
            </div>
            <div style="text-align:right; flex-shrink:0;">
              <span class="rcv-line-count">${e.n} item line${e.n===1?'':'s'}</span>
              <div class="subtle" style="font-size:.8rem; margin-top:4px;"><b>${round2(e.totalQty)}</b> total qty</div>
            </div>
            <div style="color:var(--ink-soft); font-size:1.2rem; padding-left:8px;">›</div>
          </a>`;
      } else {
        return `
          <div class="rcv-row">
            <div style="width:140px; flex-shrink:0;">
              <span class="rcv-inv-badge" style="border-style:dashed;">LEGACY</span>
            </div>
            <div style="flex:1; min-width:200px;">
              <div class="rcv-supplier-name">${esc(e.r.productName)}</div>
              <div class="rcv-meta">
                <span>📅 ${fmtDate(e.r.receivedAt)}</span>
                <span>· Supplier: ${esc(e.r.supplierName||'—')}</span>
                <span>· <i>Single manual receipt</i></span>
              </div>
            </div>
            <div style="text-align:right; flex-shrink:0;">
              <span class="badge b-from_supplier">${esc(e.r.qty)} ${esc(e.r.unit||'')}</span>
            </div>
            <button class="iconbtn" data-old="${e.r.id}" title="Delete entry" style="margin-left:6px; color:var(--danger);">✕</button>
          </div>`;
      }
    }).join('');

    $('#rcList').querySelectorAll('[data-old]').forEach(b=>b.onclick = (ev)=>{
      ev.stopPropagation();
      const r = legacy.find(x=>x.id===b.dataset.old);
      showConfirm(`Delete this entry? “${r.productName}” ${r.qty} ${r.unit||''} will be taken back off stock if tracked.`, async ()=>{
        const p = await getOne('products', r.productId);
        const d = parseFloat(r.stockDelta!=null ? r.stockDelta : r.qty);
        if(p && isStockTracked(p) && d){ p.stockQty = round2(parseFloat(p.stockQty)-d); await put('products', p); }
        await del('productReceipts', r.id);
        deliveryListScreen();
      });
    });
  }

  draw();

  let t;
  $('#rcSearch').addEventListener('input', ()=>{ clearTimeout(t); t = setTimeout(draw, 250); });
  $('#rcSupFilter').addEventListener('change', draw);
  $('#rcDateFilter').addEventListener('change', draw);
}

async function deliveryDetailScreen(id){
  const [inv, receipts, products] = await Promise.all([
    getOne('receivingInvoices', id),
    getAll('productReceipts'),
    slimProducts()
  ]);
  if(!inv){ location.hash='#/receiving'; return; }
  const prodMap = new Map(products.map(p=>[p.id,p]));
  const lines = receipts.filter(r=>r.invoiceId===id).sort((a,b)=>(a.lineNo||0)-(b.lineNo||0));
  const totalReceivedQty = lines.reduce((acc,l)=> acc + (parseFloat(l.qty)||0), 0);

  $('#main').innerHTML = `
    <div class="topbar">
      <div>
        <div class="subtle" style="font-weight:600; text-transform:uppercase; letter-spacing:.05em; font-size:.76rem; color:var(--sea);">
          Goods Inward Voucher
        </div>
        <h1>Receipt Note: ${inv.invoiceNo ? esc(inv.invoiceNo) : id.slice(0,8).toUpperCase()}</h1>
      </div>
      <div style="display:flex; gap:10px; flex-wrap:wrap;">
        <button class="btn btn-ghost" onclick="window.print()">🖨️ Print Note</button>
        <a href="#/receiving" class="btn btn-ghost">Back to Register</a>
        <button class="btn btn-danger" id="dvDel">Delete Inward</button>
      </div>
    </div>

    <!-- Official Goods Received Note Document -->
    <div class="grn-card">
      <div class="grn-header">
        <div>
          <div class="grn-title">${esc(inv.supplierName || 'General Supplier')}</div>
          <div class="subtle" style="font-size:.9rem;">
            Document Ref: <b>${inv.invoiceNo ? esc(inv.invoiceNo) : 'N/A'}</b>
          </div>
        </div>
        <div style="text-align:right;">
          <span class="badge b-completed" style="font-size:.85rem; padding:5px 12px;">✔ Posted to Inventory</span>
          <div class="subtle" style="font-size:.78rem; margin-top:4px;">Recorded ${fmtDate(inv.createdAt || inv.receivedAt)}</div>
        </div>
      </div>

      <div class="grn-meta-grid">
        <div class="grn-meta-item">
          <small>Date Received</small>
          <b>${fmtDate(inv.receivedAt)}</b>
        </div>
        <div class="grn-meta-item">
          <small>Total Product Lines</small>
          <b>${lines.length} Line${lines.length===1?'':'s'}</b>
        </div>
        <div class="grn-meta-item">
          <small>Total Quantity In</small>
          <b>${round2(totalReceivedQty)} Units</b>
        </div>
        <div class="grn-meta-item">
          <small>Dock / Internal Notes</small>
          <b>${inv.note ? esc(inv.note) : '—'}</b>
        </div>
      </div>

      <!-- Itemized Table -->
      <div style="overflow-x:auto;">
        <table class="dv-table">
          <thead>
            <tr>
              <th style="width:40px;">#</th>
              <th>Product / Description</th>
              <th style="text-align:right;">Qty In</th>
              <th>Unit</th>
              <th>Stock Impact</th>
              <th>Production</th>
              <th>Expiry Date</th>
              <th>Batch / Lot #</th>
            </tr>
          </thead>
          <tbody>
            ${lines.map((l, i)=>{
              const p = prodMap.get(l.productId);
              const tracked = p ? isStockTracked(p) : true;
              const delta = l.stockDelta != null ? l.stockDelta : l.qty;
              return `
                <tr>
                  <td><b>${l.lineNo || i+1}</b></td>
                  <td>
                    <b>${esc(l.productName)}</b>
                    ${p && p.sku ? `<div class="subtle" style="font-size:.78rem;">SKU: ${esc(p.sku)}</div>` : ''}
                  </td>
                  <td style="text-align:right; font-weight:700; font-size:1rem;">${esc(l.qty)}</td>
                  <td>${esc(l.unit || 'units')}</td>
                  <td>
                    ${tracked
                      ? `<span class="badge b-completed">+${round2(delta)} to stock</span>`
                      : `<span class="subtle" style="font-size:.8rem;">Non-tracked</span>`}
                  </td>
                  <td>${l.productionDate ? fmtDate(l.productionDate) : '—'}</td>
                  <td>${l.expiryDate ? fmtDate(l.expiryDate) : '—'}</td>
                  <td>${l.batchNo ? `<code style="font-weight:700; background:var(--paper-dim); padding:2px 6px; border-radius:4px;">${esc(l.batchNo)}</code>` : '—'}</td>
                </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>

      <div style="margin-top:28px; padding-top:16px; border-top:1px dashed var(--line); display:flex; justify-content:space-between; flex-wrap:wrap; gap:16px; font-size:.85rem; color:var(--ink-soft);">
        <div>
          Dockline Warehouse Management System · Goods Inward Post
        </div>
        <div>
          Received & Verified By: __________________________
        </div>
      </div>
    </div>`;

  $('#dvDel').onclick = ()=>showConfirm('Are you sure you want to delete this delivery? All inventory increases will be reversed immediately.', async ()=>{
    try{
      await deleteDelivery(id);
    } catch(e){
      showAlert('Could not delete: ' + e.message);
      return;
    }
    location.hash = '#/receiving';
    render();
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

  function persist(){
    const s = suppliers.find(x=>x.id===S.supplierId);
    S.supplierName = s ? s.name : '';
    saveDraft(S);
    updateSummary();
  }

  function stockHint(l){
    const p = prodMap.get(l.productId);
    if(!p) return `<span style="color:var(--danger,#c00);">⚠ Product no longer exists</span>`;
    if(!isStockTracked(p)) return `<span class="subtle">ℹ Stock tracking is disabled for this product</span>`;
    const q = parseFloat(l.qty);
    if(isNaN(q) || q<=0) return `<span class="subtle">Current inventory: <b>${esc(p.stockQty)} ${esc(p.unit||'')}</b></span>`;
    const d = stockDeltaFor(p, q, l.unit);
    if(d.error) return `<span style="color:var(--danger,#c00);">⚠ ${esc(d.error)}</span>`;
    return `<span style="color:var(--success); font-weight:600;">Current: ${esc(p.stockQty)} → New Stock: ${round2(parseFloat(p.stockQty)+d.delta)} ${esc(p.unit||'')} (+${d.delta})</span>`;
  }

  function autoExpiry(l){
    const p = prodMap.get(l.productId);
    if(!l.expiryTouched && p && p.expiryMode==='shelf' && l.productionDate && p.expiryShelfAmount)
      l.expiryDate = addDuration(l.productionDate, parseFloat(p.expiryShelfAmount), p.expiryShelfUnit||'months');
  }

  /* a different measure of the same product (1 KG product, received as 400 GM): offer to keep it as its own size */
  const mayPrice = ()=> can('prices.edit') && seesBothPrices();
  function sizeDefaults(l, p){
    const ns = newSizeOf(l, p); if(!ns || l.sizeOff) return;
    if(!l.packCostTouched && mayPrice()){ const s = scaledPackPrice(p,'cost',ns.label); l.packCost = s && s.text ? s.text : (packPriceOf(p,ns.label,'cost') || ''); }
    if(!l.packSellTouched && mayPrice()){ const s = scaledPackPrice(p,'sell',ns.label); l.packSell = s && s.text ? s.text : (packPriceOf(p,ns.label,'sell') || ''); }
    ['Cost','Sell'].forEach(W=>{ const have = packPriceOf(p,ns.label,W.toLowerCase()); if(have && !l['pack'+W+'Touched']) l['pack'+W] = have; });
  }
  function sizeBoxHtml(l, p){
    const ns = newSizeOf(l, p); if(!ns) return '';
    const canKeep = p.trackBatches && isStockTracked(p);
    const head = `<label style="display:flex; gap:8px; align-items:flex-start; font-weight:600;"><input type="checkbox" data-szon style="width:auto; margin-top:3px;" ${l.sizeOff||!canKeep?'':'checked'} ${canKeep?'':'disabled'}><span>New size: <b>${esc(ns.label)}</b> packs of ${round2(ns.size)} ${esc(p.unit||'')} each — keep as its own size</span></label>`;
    if(!canKeep) return `<div class="rcv-size" style="margin-top:10px; padding:10px 12px; border:1.5px dashed var(--line); border-radius:12px;">${head}
      <div class="subtle" style="margin-top:6px;">${isStockTracked(p) ? 'Sizes are kept as batches. Turn on batch tracking for this product to give each size its own expiry and price.' : 'Turn on stock tracking (and batch tracking) for this product to keep sizes separate.'}
      ${isStockTracked(p) ? '<button class="btn btn-ghost btn-sm" data-act="trackon" style="margin-left:6px;">Turn on batch tracking</button>' : ''}</div></div>`;
    if(l.sizeOff) return `<div class="rcv-size" style="margin-top:10px; padding:10px 12px; border:1.5px dashed var(--line); border-radius:12px;">${head}<div class="subtle" style="margin-top:4px;">It will only be added to the stock total (${round2(parseFloat(l.qty||0)*ns.size)} ${esc(p.unit||'')}).</div></div>`;
    const sc = scaledPackPrice(p,'cost',ns.label), ss = scaledPackPrice(p,'sell',ns.label);
    return `<div class="rcv-size" style="margin-top:10px; padding:10px 12px; border:1.5px solid var(--signal); border-radius:12px;">${head}
      <div class="subtle" style="margin:4px 0 8px;">Stock goes up by ${round2((parseFloat(l.qty)||0)*ns.size)} ${esc(p.unit||'')}. This size has its own expiry date (below) and its own price. Stock is still taken earliest-expiry first across all sizes.</div>
      <div style="display:grid; grid-template-columns:1fr 1fr; gap:8px;">
        ${mayPrice()?`<div class="field" style="margin:0;"><label>Cost per ${esc(ns.label)} pack</label><input type="text" inputmode="decimal" data-szf="packCost" value="${esc(l.packCost||'')}" placeholder="${sc&&sc.approx?esc(sc.approx):''}"></div>`:''}
        ${mayPrice()?`<div class="field" style="margin:0;"><label>Sell price per ${esc(ns.label)} pack</label><input type="text" inputmode="decimal" data-szf="packSell" value="${esc(l.packSell||'')}" placeholder="${ss&&ss.approx?esc(ss.approx):''}"></div>`:''}
      </div>${(mayPrice()||mayPrice())?`<div class="subtle" style="font-size:12px; margin-top:4px;">Worked out from the product's price — change them if the accountant says so. Blank = no price yet.</div>`:''}</div>`;
  }
  function lineHtml(l, i){
    const p = prodMap.get(l.productId);
    const loc = p && (p.sectionId || p.warehouseId) ? `📍 ${whMap[p.warehouseId]?.name || ''}${secMap[p.sectionId] ? ' / '+secMap[p.sectionId].name : ''}` : '';
    const hasBatchTracking = p && p.trackBatches;
    sizeDefaults(l, p);

    return `
      <div class="rcv-item-card" data-k="${l.key}">
        <div class="rcv-item-top">
          <div style="display:flex; align-items:center; gap:10px; min-width:0; flex:1;">
            <span class="rcv-item-index">${i+1}</span>
            <div style="min-width:0;">
              <b style="font-size:1.05rem; display:block; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${esc(l.productName)}</b>
              <div class="subtle" style="font-size:.8rem;">${p && p.sku ? 'SKU: '+esc(p.sku)+' · ' : ''}${loc}</div>
            </div>
          </div>
          <div style="display:flex; gap:6px;">
            <button class="btn btn-ghost btn-sm" data-act="change" title="Change product">Change</button>
            <button class="btn btn-ghost btn-sm" data-act="rm" title="Remove line" style="color:var(--danger);">✕</button>
          </div>
        </div>

        <div class="rcv-item-grid">
          <div class="field" style="margin-bottom:0;">
            <label>Quantity Received *</label>
            <input type="number" step="any" inputmode="decimal" data-f="qty" placeholder="Quantity" value="${esc(l.qty)}">
          </div>
          <div class="field" style="margin-bottom:0;">
            <label>Unit of Measure</label>
            <input type="text" data-f="unit" placeholder="Unit" value="${esc(l.unit)}">
          </div>
          <div class="field" style="margin-bottom:0;">
            <label>Batch / Lot # ${hasBatchTracking ? '<span style="color:var(--sea);">●</span>' : ''}</label>
            <input type="text" data-f="batchNo" placeholder="Batch / lot no." value="${esc(l.batchNo||'')}">
          </div>
          <div class="field" style="margin-bottom:0;">
            <label>Pack size <span class="subtle" style="font-weight:500;">(optional)</span></label>
            <input type="number" step="any" inputmode="decimal" data-f="packSize" placeholder="${esc((prodMap.get(l.productId)||{}).packSize||'Quantity per pack')}" value="${esc(l.packSize||'')}">
          </div>
        </div>

        <div data-sizebox>${sizeBoxHtml(l, p)}</div>
        <div class="rcv-batch-grid">
          <div class="field" style="margin-bottom:0;">
            <label>Production Date</label>
            <input type="date" data-f="productionDate" value="${esc(l.productionDate||'')}">
          </div>
          <div class="field" style="margin-bottom:0;">
            <label>Expiry Date</label>
            <input type="date" data-f="expiryDate" value="${esc(l.expiryDate||'')}">
          </div>
          <div style="display:flex; align-items:flex-end; padding-bottom:6px;">
            <div data-hint style="font-size:.85rem;">${stockHint(l)}</div>
          </div>
        </div>
      </div>`;
  }

  function updateSummary(){
    const totalLines = S.lines.length;
    const totalQty = S.lines.reduce((acc, l)=> acc + (parseFloat(l.qty)||0), 0);
    const summaryLines = $('#rcvSummaryLines');
    const summaryUnits = $('#rcvSummaryUnits');
    if(summaryLines) summaryLines.textContent = totalLines;
    if(summaryUnits) summaryUnits.textContent = round2(totalQty);
  }

  function drawLines(){
    $('#dvLines').innerHTML = S.lines.map(lineHtml).join('') || `
      <div style="background:var(--card); border:1.5px dashed var(--line); border-radius:14px; text-align:center; padding:36px 18px; margin-bottom:16px;">
        <div style="font-size:2rem; margin-bottom:8px;">📥</div>
        <b>No items added to this delivery yet</b>
        <div class="subtle" style="font-size:.85rem; margin-top:4px;">Tap “+ Add Product Line” below to search and add received items.</div>
      </div>`;

    $('#dvLines').querySelectorAll('[data-k]').forEach(card=>{
      const l = S.lines.find(x=>x.key===card.dataset.k);
      card.querySelectorAll('[data-f]').forEach(inp=>inp.addEventListener('input', ()=>{
        const f = inp.dataset.f;
        l[f] = inp.value;
        if(f==='expiryDate') l.expiryTouched = true;
        if(f==='productionDate'){
          autoExpiry(l);
          const e = card.querySelector('[data-f=expiryDate]');
          if(e && !l.expiryTouched) e.value = l.expiryDate||'';
        }
        if(f==='unit' || f==='qty'){ if(f==='unit'){ l.packCostTouched = l.packSellTouched = false; sizeDefaults(l, prodMap.get(l.productId)); } if(f==='unit' || card.querySelector('[data-sizebox] .rcv-size')) refreshSize(card, l, f==='unit'); }
        card.querySelector('[data-hint]').innerHTML = stockHint(l);
        persist();
      }));
      bindSize(card, l);
      card.querySelector('[data-act=rm]').onclick = ()=>{
        S.lines = S.lines.filter(x=>x!==l);
        persist();
        drawLines();
      };
      card.querySelector('[data-act=change]').onclick = ()=>pick(p=>{
        applyProduct(l,p);
        persist();
        drawLines();
      });
    });
    updateSummary();
  }

  function refreshSize(card, l, full){
    const box = card.querySelector('[data-sizebox]'); if(!box) return;
    const p = prodMap.get(l.productId), act = document.activeElement;
    if(!full && act && box.contains(act)) return;
    box.innerHTML = sizeBoxHtml(l, p); bindSize(card, l);
  }
  function bindSize(card, l){
    const box = card.querySelector('[data-sizebox]'); if(!box) return; const p = prodMap.get(l.productId);
    const on = box.querySelector('[data-szon]'); if(on) on.onchange = ()=>{ l.sizeOff = !on.checked; if(!l.sizeOff) sizeDefaults(l, p); refreshSize(card, l, true); persist(); };
    box.querySelectorAll('[data-szf]').forEach(el=>el.addEventListener('input', ()=>{ l[el.dataset.szf] = el.value; l[el.dataset.szf+'Touched'] = true; persist(); }));
    const tr = box.querySelector('[data-act=trackon]'); if(tr) tr.onclick = async ()=>{
      const pr = await getOne('products', l.productId); pr.trackBatches = true; await put('products', pr); await reconcileBatches([pr.id]);
      p.trackBatches = true; sizeDefaults(l, p); refreshSize(card, l, true); persist(); };
  }
  function applyProduct(l,p){
    l.productId = p.id;
    l.productName = p.name;
    l.unit = p.unit || '';
    l.sizeOff = false; l.packCostTouched = l.packSellTouched = false; l.packCost = l.packSell = '';
    autoExpiry(l);
  }

  function pick(cb){ openProductPicker(null, products, whMap, secMap, cb); }

  function supOpts(){
    return `<option value="">Select supplier…</option>` +
      suppliers.map(s=>`<option value="${s.id}" ${s.id===S.supplierId?'selected':''}>${esc(s.name)}</option>`).join('') +
      `<option value="${NEW}">+ New supplier…</option>`;
  }

  $('#main').innerHTML = `
    <div class="topbar">
      <div>
        <h1>Goods Inward Receipt</h1>
        <div class="subtle">Record inbound supplier delivery note and post received items into inventory</div>
      </div>
      <div style="display:flex; gap:10px;">
        <button class="btn btn-ghost" id="dvCancel">Discard / Cancel</button>
      </div>
    </div>

    <!-- Inbound Shipment Header -->
    <div class="rcv-header-card">
      <div class="section-title" style="margin-bottom:14px; display:flex; align-items:center; gap:8px;">
        <span>📋</span> Shipment & Supplier Details
      </div>
      <div class="rcv-header-grid">
        <div class="field" style="margin-bottom:0;">
          <label>Supplier *</label>
          <select id="dvSup">${supOpts()}</select>
        </div>
        <div class="field" style="margin-bottom:0;">
          <label>Date Received *</label>
          <input type="date" id="dvDate" value="${esc(S.receivedAt)}">
        </div>
        <div class="field" style="margin-bottom:0;">
          <label>Invoice / Waybill / Delivery Note #</label>
          <input type="text" id="dvNo" placeholder="Invoice or delivery note no." value="${esc(S.invoiceNo)}">
        </div>
        <div class="field" style="margin-bottom:0;">
          <label>Internal Note / Bay Reference</label>
          <input type="text" id="dvNote" placeholder="Note" value="${esc(S.note)}">
        </div>
      </div>
    </div>

    <!-- Intake Line Items -->
    <div class="rcv-section-heading">
      <div style="font-family:var(--font-d); font-size:1.15rem; font-weight:700;">
        Received Product Lines
      </div>
      <button class="btn btn-signal btn-sm" id="dvAdd">+ Add Product Line</button>
    </div>

    <div id="dvLines"></div>

    <!-- Sticky Live Action / Summary Bar -->
    <div class="rcv-summary-bar">
      <div class="rcv-summary-metrics">
        <div>
          <div class="rcv-metric-val" id="rcvSummaryLines">${S.lines.length}</div>
          <div class="rcv-metric-lbl">Total Lines</div>
        </div>
        <div class="rcv-summary-divider">
          <div class="rcv-metric-val" id="rcvSummaryUnits">0</div>
          <div class="rcv-metric-lbl">Total Units</div>
        </div>
      </div>
      <div style="display:flex; gap:12px; align-items:center;">
        <button class="btn btn-signal" id="dvSave" style="padding:12px 24px; font-size:1rem;">✔ Post & Update Stock</button>
      </div>
    </div>`;

  drawLines();

  $('#dvSup').onchange = e=>{
    if(e.target.value===NEW){
      e.target.value = S.supplierId;
      openNewSupplierModal(sup=>{
        suppliers.push(sup);
        suppliers.sort((a,b)=>a.name.localeCompare(b.name));
        S.supplierId = sup.id;
        persist();
        $('#dvSup').innerHTML = supOpts();
      });
      return;
    }
    S.supplierId = e.target.value;
    persist();
  };

  $('#dvDate').oninput = e=>{ S.receivedAt = e.target.value; persist(); };
  $('#dvNo').oninput = e=>{ S.invoiceNo = e.target.value; persist(); };
  $('#dvNote').oninput = e=>{ S.note = e.target.value; persist(); };

  $('#dvAdd').onclick = ()=>pick(p=>{
    const l = {key:uid(), qty:'', unit:'', productionDate:'', expiryDate:'', batchNo:'', packSize:''};
    applyProduct(l,p);
    S.lines.push(l);
    persist();
    drawLines();
    const last = $('#dvLines').lastElementChild;
    const q = last && last.querySelector('[data-f=qty]');
    if(q) q.focus();
  });

  $('#dvCancel').onclick = ()=>{
    if(!S.lines.length){ clearDraft(); location.hash='#/receiving'; return; }
    showConfirm('Leave without saving? Your entries will be kept as a draft.', ()=>{
      location.hash='#/receiving';
    });
  };

  let saving = false;
  $('#dvSave').onclick = async ()=>{
    if(saving) return;
    if(!S.supplierId) return showAlert('Please select a supplier.');
    if(!S.lines.length) return showAlert('Please add at least one product line.');

    for(let i=0; i<S.lines.length; i++){
      const l = S.lines[i], n = i+1, q = parseFloat(l.qty);
      if(isNaN(q)||q<=0) return showAlert(`Line ${n} (${l.productName}): Please enter a valid quantity received.`);
      if(l.productionDate && l.expiryDate && l.expiryDate < l.productionDate)
        return showAlert(`Line ${n} (${l.productName}): Expiry date cannot be earlier than the production date.`);
      const d = stockDeltaFor(prodMap.get(l.productId), q, l.unit);
      if(d.error) return showAlert(`Line ${n}: ${d.error}`);
      for(const k of ['packCost','packSell']) if(l[k] && l[k].trim()!=='' && !Dec.parse(l[k])) return showAlert(`Line ${n} (${l.productName}): the price per pack must be a plain number, like 113.75.`);
    }

    saving = true;
    $('#dvSave').disabled = true;
    const sup = suppliers.find(s=>s.id===S.supplierId);
    const invId = uid();
    const header = {
      id: invId,
      supplierId: S.supplierId,
      supplierName: sup ? sup.name : '',
      receivedAt: S.receivedAt || todayISO(),
      invoiceNo: S.invoiceNo.trim(),
      note: S.note.trim(),
      createdAt: new Date().toISOString(),
      lineCount: S.lines.length
    };
    const lines = S.lines.map((l,i)=>({
      id: uid(),
      invoiceId: invId,
      lineNo: i+1,
      productId: l.productId,
      productName: l.productName,
      supplierId: header.supplierId,
      supplierName: header.supplierName,
      qty: round2(parseFloat(l.qty)),
      unit: (l.unit||'').trim(),
      receivedAt: header.receivedAt,
      note: '',
      productionDate: l.productionDate||'',
      expiryDate: l.expiryDate||'',
      batchNo: (l.batchNo||'').trim(),
      packSize: l.packSize===''||l.packSize==null ? '' : parseFloat(l.packSize),
      ...(()=>{ const p = prodMap.get(l.productId), ns = (!l.sizeOff && p && p.trackBatches && isStockTracked(p)) ? newSizeOf(l, p) : null;
        return ns ? {packLabel:ns.label, packSize:ns.size, packCost:Dec.parse(l.packCost)?Dec.str(Dec.parse(l.packCost)):'', packSell:Dec.parse(l.packSell)?Dec.str(Dec.parse(l.packSell)):''} : {}; })()
    }));

    try{
      await saveDelivery(header, lines);
    } catch(e){
      saving = false;
      $('#dvSave').disabled = false;
      return showAlert('Not saved — inventory remained unchanged: ' + e.message);
    }
    clearDraft();
    location.hash = '#/receiving/' + invId;
  };
}
