/* ==================================== NEW ORDER ==================================== */
route('order', async (parts)=>{
  const [orderId, step, sub] = parts;
  if(orderId==='new') return newOrderStep1();
  const order = await getOne('orders', orderId);
  if(!order){ location.hash='#/orders'; return; }
  if(step==='open'){
    if(order.status==='draft') return newOrderStep1(order);
    if(order.status==='picking') return storeHubScreen(order.id);
    if(order.status==='completed') return orderSummary(order.id);
  }
  if(step==='match') return matchScreen(order.id);
  if(step==='pick'){
    if(!sub) return storeHubScreen(order.id);
    const pickWarehouseId = sub==='all' ? null : sub;
    const mode = await getPickingMode();
    return mode==='batch' ? pickingBatchScreen(order.id, pickWarehouseId) : pickingItemScreen(order.id, pickWarehouseId);
  }
  if(step==='postponed') return postponedScreen(order.id);
  if(step==='items') return allItemsScreen(order.id);
  if(step==='boxes') return boxReceiptsScreen(order.id, sub==='confirm');
  if(step==='summary') return orderSummary(order.id);
});

/* Ship order sheets often have a few lines above the real table — vessel name, an
   order reference, a logo caption, whatever — before the actual "Sr. / Description /
   Quantity / Unit" header row. Rather than assuming row 1 is the header, scan the
   first several rows for the one that actually looks like the column header row
   (it must contain a cell that reads as "Description" — the only column we can't
   do without) and read the table from there on. aoa = array-of-arrays, i.e.
   XLSX.utils.sheet_to_json(sheet, {header:1, ...}). */
function locateOrderHeaderRow(aoa){
  const SR_NAMES = ['sr','sr no','srno','serial','serial no','s no','sl no','item no'];
  const DESC_NAMES = ['description','desc','item','product'];
  const QTY_NAMES = ['quantity','qty'];
  const UNIT_NAMES = ['unit','uom'];
  const maxScan = Math.min(aoa.length, 30); // the header should appear well within the first page
  for(let r=0; r<maxScan; r++){
    const row = aoa[r] || [];
    let kDesc=-1, kSr=-1, kQty=-1, kUnit=-1;
    row.forEach((cell, c)=>{
      const n = normalize(String(cell==null?'':cell));
      if(!n) return;
      if(kDesc===-1 && DESC_NAMES.includes(n)) kDesc=c;
      else if(kSr===-1 && SR_NAMES.includes(n)) kSr=c;
      else if(kQty===-1 && QTY_NAMES.includes(n)) kQty=c;
      else if(kUnit===-1 && UNIT_NAMES.includes(n)) kUnit=c;
    });
    if(kDesc!==-1) return {rowIndex:r, kSr, kDesc, kQty, kUnit};
  }
  return null;
}

/* The order reference code (what's typed into "IMO number" here) is also usually
   baked into the uploaded filename, always as LETTERS-ALL-NUMBERS (sometimes
   without the second dash, e.g. "FRA-ALL03") — used as a fallback below if the
   sheet's own preamble lines don't yield one. */
function extractOrderCodeFromFilename(filename){
  const base = String(filename||'').replace(/\.[^.]+$/, ''); // drop extension
  const m = base.match(/([A-Za-z]+)-?ALL-?(\d+)/i);
  if(!m) return null;
  return { code: m[0], orderNum: m[2] };
}
const ORDER_CODE_RE = /([A-Za-z]+)-?ALL-?(\d+)/i;
/* The vessel name and the order's reference code sit in a couple of plain text
   lines above the real "Sr. / Description / ..." header row — in either order,
   e.g.:
     TORM DIANA          or       LIZ-ALL-08
     TDI-ALL-12                   LUZON SPIRIT
     SR.  DESCRIPTION...          SR.  DESCRIPTION...
   Neither line sits under a column heading, so they're pulled from aoa (the
   same array-of-arrays used to locate the header row) rather than from any
   particular column: whichever of the first few non-empty rows above the
   header matches the LETTERS-ALL-NUMBERS pattern is the code, and the other
   non-empty row right next to it is taken as the vessel name. */
/* Order sheets carry "CUSTOMER : <company>" next to (or under) the vessel name, e.g.
   "Briolette CUSTOMER : Gold Star Marine". The company is not part of the vessel name:
   cut it off the end of a line, and treat a line that is only the customer as not-a-vessel. */
const CUSTOMER_TAIL_RE = /\s*\bcustomer\b\s*[:：\-–—].*$/i;
const CUSTOMER_LINE_RE = /^\s*customer\b\s*[:：\-–—]/i;
function cleanVesselName(text){
  return String(text==null?'':text).replace(CUSTOMER_TAIL_RE,'').replace(/[\s:：\-–—]+$/,'').replace(/\s+/g,' ').trim();
}
function extractVesselAndCodeFromSheet(aoa, headerRowIndex){
  const preambleLines = [];
  for(let r=0; r<headerRowIndex; r++){
    const text = (aoa[r]||[]).map(c=>String(c==null?'':c).trim()).filter(Boolean).join(' ').trim();
    if(text) preambleLines.push({rowIndex:r, text});
  }
  let codeLine = null, codeMatch = null;
  for(const line of preambleLines){
    const m = line.text.match(ORDER_CODE_RE);
    if(m){ codeLine = line; codeMatch = m; break; }
  }
  if(!codeLine) return null;
  const others = preambleLines.filter(l=>l!==codeLine && !CUSTOMER_LINE_RE.test(l.text) && cleanVesselName(l.text));
  others.sort((a,b)=>Math.abs(a.rowIndex-codeLine.rowIndex)-Math.abs(b.rowIndex-codeLine.rowIndex));
  const vesselLine = others[0] || null;
  return {
    code: codeMatch[0],
    orderNum: codeMatch[2],
    vessel: vesselLine ? cleanVesselName(vesselLine.text) : ''
  };
}

async function newOrderStep1(existing){
  const o = existing || {id:uid(), vessel:'', imo:'', orderNumber:'', orderDate: todayISO(), destination:'', status:'draft', createdAt:new Date().toISOString()};
  // suggests ports already used before, so the same destination is typed the same way
  // every time (which is also what keeps its badge color consistent) — plus a few common
  // presets to get started with on a brand-new setup
  const pastDest = [...new Set((await getAll('orders')).map(x=>(x.destination||'').trim()).filter(Boolean))];
  const presets = ['Suez Port','Alexandria Port','Port Said','Damietta Port','Sokhna Port','Safaga Port'];
  const destOptions = [...new Set([...pastDest, ...presets])].sort();
  $('#main').innerHTML = `
    <div class="topbar"><h1>New order</h1></div>
    <div class="card" style="max-width:560px;">
      <div class="field"><label>Vessel / ship name</label><input type="text" id="o_vessel" value="${esc(o.vessel)}" placeholder="MV Example"></div>
      <div class="row2">
        <div class="field"><label>IMO number</label><input type="text" id="o_imo" value="${esc(o.imo)}" placeholder="9876543"></div>
        <div class="field"><label>Order number</label><input type="text" id="o_num" value="${esc(o.orderNumber)}" placeholder="ORD-2026-001"></div>
      </div>
      <div class="field"><label>Order date</label><input type="date" id="o_date" value="${o.orderDate}"></div>
      <div class="field">
        <label>Destination (where this order is heading)</label>
        <input type="text" id="o_dest" list="o_destList" value="${esc(o.destination||'')}" placeholder="e.g. Suez Port, Alexandria Port…">
        <datalist id="o_destList">${destOptions.map(d=>`<option value="${esc(d)}">`).join('')}</datalist>
        <div id="o_destPreview" style="margin-top:8px;">${destinationBadge(o.destination||'')}</div>
      </div>
      <div class="field"><label>Excel file (.xlsx)</label><input type="file" id="o_file" accept=".xlsx,.xls"></div>
      <p class="subtle" id="o_fileHint">Expected columns: Sr. · Description · Quantity · Unit — any lines above the header row (vessel name, order reference, etc.) are detected and skipped automatically.</p>
      <button class="btn btn-signal btn-lg" id="o_next">Import &amp; continue</button>
    </div>`;
  $('#o_dest').oninput = ()=>{
    $('#o_destPreview').innerHTML = destinationBadge($('#o_dest').value.trim());
  };
  $('#o_file').onchange = async e=>{
    const file = e.target.files[0];
    if(!file) return;
    // only fill fields that are still blank, so re-picking a file (or editing a draft)
    // never overwrites something already typed in — nothing is submitted here either way
    const fill = (found, source)=>{
      if(!found) return false;
      let filledSomething = false;
      if(found.vessel && !$('#o_vessel').value.trim()){ $('#o_vessel').value = found.vessel; filledSomething = true; }
      if(!$('#o_imo').value.trim()){ $('#o_imo').value = found.code; filledSomething = true; }
      if(!$('#o_num').value.trim()){ $('#o_num').value = found.orderNum; filledSomething = true; }
      if(filledSomething){
        $('#o_fileHint').innerHTML = `Picked up <b>${esc(found.code)}</b>${found.vessel?' and vessel name':''} from the ${source} — review below before continuing.`;
      }
      return filledSomething;
    };
    try{
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, {type:'array'});
      const sheet = wb.Sheets[wb.SheetNames[0]];
      const aoa = XLSX.utils.sheet_to_json(sheet, {header:1, defval:'', blankrows:false});
      const headerInfo = locateOrderHeaderRow(aoa);
      const fromSheet = headerInfo ? extractVesselAndCodeFromSheet(aoa, headerInfo.rowIndex) : null;
      if(fill(fromSheet, 'sheet')) return;
    }catch(err){ /* fall through to filename-based guess below */ }
    fill(extractOrderCodeFromFilename(file.name), 'filename');
  };
  $('#o_next').onclick = async ()=>{
    const vessel = $('#o_vessel').value.trim();
    const imo = $('#o_imo').value.trim();
    const num = $('#o_num').value.trim();
    const file = $('#o_file').files[0];
    if(!vessel || !num){ showAlert('Vessel name and order number are required.'); return; }
    if(!file){ showAlert('Please choose an Excel file to import.'); return; }
    o.vessel=vessel; o.imo=imo; o.orderNumber=num; o.orderDate=$('#o_date').value; o.destination=$('#o_dest').value.trim();
    await put('orders', o);

    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, {type:'array'});
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const aoa = XLSX.utils.sheet_to_json(sheet, {header:1, defval:'', blankrows:false});
    if(!aoa.length){ showAlert('The Excel file appears to be empty.'); return; }

    // skip over any vessel-name / order-reference / blank lines above the real table —
    // the header row is wherever "Description" (and ideally Sr./Quantity/Unit) actually sits
    const headerInfo = locateOrderHeaderRow(aoa);
    if(!headerInfo){ showAlert('Could not find a "Description" column anywhere in the first rows of this file — please check the file format.'); return; }
    const { kSr, kDesc, kQty, kUnit } = headerInfo;
    const dataRows = aoa.slice(headerInfo.rowIndex+1);

    // clear previous items for this order (re-import)
    const existingItems = (await getAll('orderItems')).filter(it=>it.orderId===o.id);
    for(const it of existingItems) await del('orderItems', it.id);

    let created = 0;
    for(const row of dataRows){
      const desc = String((kDesc!==-1 ? row[kDesc] : '') ?? '').trim();
      if(!desc) continue;
      const qtyRaw = kQty!==-1 ? row[kQty] : '';
      const qty = parseFloat(qtyRaw);
      const srVal = kSr!==-1 ? String(row[kSr] ?? '').trim() : '';
      const unitVal = kUnit!==-1 ? String(row[kUnit] ?? '').trim() : '';
      const item = {
        id: uid(), orderId: o.id, sr: srVal, importIndex: created, excelDesc: desc,
        excelQty: isNaN(qty) ? 0 : qty, qtyFlag: (kQty!==-1 && isNaN(qty)) ? 'invalid quantity' : '',
        excelUnit: unitVal,
        productId: null, warehouseName:'', sectionName:'', productName:'', sortKey:[9999,9999,9999],
        requestedQty: isNaN(qty)?0:qty, requestedUnit: unitVal,
        actualQty: null, actualUnit: '', status:'unmatched', matchType:'', replacementName:'', notes:'',
        actualProductionDate:'', actualExpiryDate:''
      };
      await put('orderItems', item);
      created++;
    }
    if(!created){ showAlert('No usable rows found in the file.'); return; }
    location.hash = `#/order/${o.id}/match`;
  };
}

async function matchScreen(orderId){
  const order = await getOne('orders', orderId);
  let items = (await getAll('orderItems')).filter(it=>it.orderId===orderId);
  const [products, warehouses, sections, suppliers] = await Promise.all([getAll('products'), getAll('warehouses'), getAll('sections'), getAll('suppliers')]);
  const whMap = Object.fromEntries(warehouses.map(w=>[w.id,w]));
  const secMap = Object.fromEntries(sections.map(s=>[s.id,s]));
  const productsById = new Map(products.map(p=>[p.id,p]));
  const needsSetup = (productId)=>{ const p = productsById.get(productId); return p && !p.warehouseId; };

  // auto-run matching for items that haven't been resolved yet
  for(const it of items){
    if(it.productId || it.status==='not_available') continue;
    const r = await matchExcelRow(it.excelDesc);
    if(r.status==='mapped' || r.status==='auto'){
      applyMatch(it, r.product, r.status==='mapped'?'saved mapping':'auto-matched');
    } else if(r.status==='suggest'){
      it._candidates = r.candidates.map(c=>({id:c.p.id, name:c.p.name, score:c.score}));
      it.status='unmatched';
    } else {
      it.status='unmatched'; it._candidates=[];
    }
    await put('orderItems', it);
  }

  function applyMatch(it, product, matchType){
    it.productId = product.id;
    it.productName = product.name;
    it.requestedUnit = it.requestedUnit || product.unit;
    it.warehouseId = product.warehouseId || '';
    it.warehouseName = whMap[product.warehouseId]?.name || '';
    it.sectionName = secMap[product.sectionId]?.name || '';
    it.sortKey = [whMap[product.warehouseId]?.priority ?? 9999, secMap[product.sectionId]?.priority ?? 9999, product.priority ?? 9999];
    it.status = 'pending';
    it.matchType = matchType;
  }

  function draw(){
    items = items.sort((a,b)=> (a.status==='unmatched'?0:1) - (b.status==='unmatched'?0:1));
    const unresolved = items.filter(it=>it.status==='unmatched').length;
    $('#main').innerHTML = `
      <div class="topbar"><h1>Review matching</h1></div>
      <p class="subtle" style="margin-top:-10px;">${esc(order.vessel)} · ${esc(order.orderNumber)} — ${items.length} line item${items.length===1?'':'s'}, ${unresolved} need${unresolved===1?'s':''} your attention.</p>
      <div id="matchList"></div>
      <button class="btn btn-signal btn-lg" id="toPreview" style="max-width:340px; margin-top:16px;" ${unresolved?'disabled':''}>
        ${unresolved? 'Resolve all items to continue' : 'Sort order & continue →'}
      </button>`;
    const list = $('#matchList');
    list.innerHTML = items.map(it=>{
      const cls = it.status==='not_available' ? 'bad' : (it.productId ? (it.matchType==='auto-matched'?'ok':'warn') : 'bad');
      return `<div class="match-card ${cls}" data-id="${it.id}">
        <div style="display:flex; justify-content:space-between; gap:10px; flex-wrap:wrap;">
          <div><b>${it.sr?`Sr. ${esc(it.sr)} · `:''}${esc(it.excelDesc)}</b><div class="subtle">${it.excelQty} ${esc(it.excelUnit)}${it.qtyFlag?' · '+it.qtyFlag:''}</div></div>
          <div>${it.productId ? `<span class="badge b-completed">→ ${esc(it.productName)}</span>` : it.status==='not_available' ? `<span class="badge b-not_available">not available</span>` : `<span class="badge b-unmatched">unmatched</span>`}</div>
        </div>
        ${it.productId ? `
          <div style="margin-top:8px; display:flex; gap:8px; flex-wrap:wrap; align-items:center;">
            <button class="btn btn-ghost btn-sm" data-change="${it.id}">Change match</button>
            ${needsSetup(it.productId) ? `<span class="badge b-unmatched">needs setup</span><button class="btn btn-ghost btn-sm" data-complete="${it.id}">Fill in details now</button>` : ''}
          </div>
        ` : it.status==='not_available' ? `
          <div style="margin-top:8px;"><button class="btn btn-ghost btn-sm" data-change="${it.id}">Pick a product instead</button></div>
        ` : `
          <div class="cand-list">
            ${(it._candidates||[]).map(c=>`<button class="cand-btn" data-pick="${it.id}" data-pid="${c.id}">${esc(c.name)} <span class="subtle">· ${Math.round(c.score*100)}% match</span></button>`).join('')}
            <button class="btn btn-ghost btn-sm" data-search="${it.id}">🔍 Search database…</button>
            <button class="btn btn-ghost btn-sm" data-createprod="${it.id}">+ Create new product</button>
            <button class="btn btn-ghost btn-sm" data-na="${it.id}">Mark “not available”</button>
          </div>`}
      </div>`;
    }).join('');

    list.querySelectorAll('[data-pick]').forEach(b=>b.onclick=async ()=>{
      const it = items.find(x=>x.id===b.dataset.pick);
      const product = products.find(p=>p.id===b.dataset.pid);
      applyMatch(it, product, 'confirmed');
      await put('orderItems', it);
      maybeSaveMapping(it);
      draw();
    });
    list.querySelectorAll('[data-na]').forEach(b=>b.onclick=async ()=>{
      const it = items.find(x=>x.id===b.dataset.na);
      it.status='not_available'; it.productId=null;
      await put('orderItems', it); draw();
    });
    list.querySelectorAll('[data-search],[data-change]').forEach(b=>b.onclick=()=>{
      const id = b.dataset.search || b.dataset.change;
      const it = items.find(x=>x.id===id);
      openProductPicker(it, products, whMap, secMap, async (product)=>{
        applyMatch(it, product, 'confirmed');
        await put('orderItems', it);
        maybeSaveMapping(it);
        draw();
      });
    });
    list.querySelectorAll('[data-createprod]').forEach(b=>b.onclick=()=>{
      const it = items.find(x=>x.id===b.dataset.createprod);
      const draftProduct = {id:uid(), name:it.excelDesc, unit:it.excelUnit||'', supplierId:'', warehouseId:'', sectionId:'', priority:999, active:true, notes:'', productionDate:'', expiryDate:'', image:''};
      openProductForm(draftProduct, warehouses, sections, suppliers, async (savedProduct)=>{
        products.push(savedProduct);
        productsById.set(savedProduct.id, savedProduct);
        applyMatch(it, savedProduct, 'created inline');
        await put('orderItems', it);
        draw();
      });
    });
    list.querySelectorAll('[data-complete]').forEach(b=>b.onclick=()=>{
      const it = items.find(x=>x.id===b.dataset.complete);
      const product = productsById.get(it.productId);
      openProductForm(product, warehouses, sections, suppliers, async (savedProduct)=>{
        productsById.set(savedProduct.id, savedProduct);
        applyMatch(it, savedProduct, it.matchType);
        await put('orderItems', it);
        draw();
      });
    });
    $('#toPreview').onclick = goToPicking;
  }

  async function goToPicking(){
    const stillUnresolved = items.some(it=>it.status==='unmatched');
    if(stillUnresolved) return;
    const sorted = items.filter(it=>it.status==='pending').sort((a,b)=>{
      for(let i=0;i<3;i++){ if(a.sortKey[i]!==b.sortKey[i]) return a.sortKey[i]-b.sortKey[i]; }
      return 0;
    });
    order.status='picking';
    order.queue = sorted.map(it=>it.id);
    order.postponed = [];
    await put('orders', order);
    location.hash = `#/order/${order.id}/pick`;
  }

  function maybeSaveMapping(it){
    showModal(`<h3>Remember this match?</h3>
      <p class="subtle">Next time “${esc(it.excelDesc)}” appears in an Excel import, we can match it to <b>${esc(it.productName)}</b> automatically.</p>
      <div style="display:flex; gap:10px; margin-top:14px;">
        <button class="btn btn-signal" id="mp_yes" style="flex:1;">Remember mapping</button>
        <button class="btn btn-ghost" id="mp_no">Just this once</button>
      </div>`);
    $('#mp_yes').onclick = async ()=>{
      await put('mappings', {id:uid(), excelDescNormalized: normalize(it.excelDesc), label: it.excelDesc, productId: it.productId});
      closeModal(); draw();
    };
    $('#mp_no').onclick = ()=>{ closeModal(); draw(); };
  }

  draw();
}

/* This can be opened WHILE another modal (e.g. the Modify/Substitute modal) is
   already showing — e.g. "Tap to choose a product" inside Substitute. showModal()/
   closeModal() always replace #modal-root's entire contents, so reusing them here
   would wipe out that parent modal's markup and wired event handlers underneath
   it; then picking a product would silently do nothing, because the fields the
   onPick callback tries to write into (#m_prod, #m_edate, etc.) would no longer
   exist in the DOM. Instead this builds its own independent overlay appended to
   <body>, stacked visually on top, so the modal underneath is left completely
   untouched and still works once this one closes. */
function openProductPicker(it, products, whMap, secMap, onPick){
  const overlay = document.createElement('div');
  overlay.className = 'modal-bg';
  overlay.innerHTML = `<div class="modal">
    <h3>Choose product</h3>
    <div class="field"><input type="text" id="pp_search" placeholder="Search products…" autofocus></div>
    <div id="pp_list" style="max-height:340px; overflow:auto;"></div>
    <button type="button" class="btn btn-ghost" style="margin-top:10px;" id="pp_cancel">Cancel</button>
  </div>`;
  document.body.appendChild(overlay);
  function closePicker(){ overlay.remove(); }
  overlay.addEventListener('click', e=>{ if(e.target===overlay) closePicker(); });
  overlay.querySelector('#pp_cancel').onclick = closePicker;
  function draw(q){
    const items = products.filter(p=>p.active && (!q || normalize(p.name).includes(normalize(q))));
    overlay.querySelector('#pp_list').innerHTML = items.slice(0,40).map(p=>`
      <button type="button" class="cand-btn" data-pid="${p.id}" style="width:100%; margin-bottom:6px;">
        ${esc(p.name)} <span class="subtle">· ${whMap[p.warehouseId]?.name||''} / ${secMap[p.sectionId]?.name||''}</span>
      </button>`).join('') || `<p class="subtle">No products found.</p>`;
    overlay.querySelectorAll('[data-pid]').forEach(b=>b.onclick=()=>{
      const picked = products.find(p=>p.id===b.dataset.pid);
      closePicker();
      onPick(picked);
    });
  }
  draw('');
  let ppDebounce;
  overlay.querySelector('#pp_search').oninput = e=>{
    const val = e.target.value;
    clearTimeout(ppDebounce);
    ppDebounce = setTimeout(()=>draw(val), 180);
  };
}

/* Find an order by vessel / order number / IMO code — e.g. "AMR-ALL-6" — so a
   delivery can be logged against it directly from Warehouse Mgmt, without first
   drilling into that order's own picking screens. Any order regardless of status
   (draft/picking/completed) is selectable, since a delivery can arrive before
   picking has even started. */
function openOrderPicker(onPick){
  showModal(`<h3>Find order</h3>
    <div class="field"><input type="text" id="op_search" placeholder="Search by vessel, order number, or IMO code…" autofocus></div>
    <div id="op_list" style="max-height:360px; overflow:auto;"></div>
    <button class="btn btn-ghost" style="margin-top:10px;" onclick="closeModal()">Cancel</button>`);
  let allOrders = null;
  async function draw(q){
    if(!allOrders) allOrders = (await getAll('orders')).sort((a,b)=>(b.createdAt||'').localeCompare(a.createdAt||''));
    const nq = normalize(q);
    const items = !nq ? allOrders : allOrders.filter(o=>
      normalize(o.vessel).includes(nq) || normalize(o.orderNumber).includes(nq) || normalize(o.imo).includes(nq)
    );
    $('#op_list').innerHTML = items.slice(0,40).map(o=>`
      <button class="cand-btn" data-oid="${o.id}" style="width:100%; margin-bottom:6px;">
        <b>${esc(o.vessel)}</b> · ${esc(o.orderNumber)} <span class="subtle">· IMO ${esc(o.imo)||'—'} · ${o.status}</span>
      </button>`).join('') || `<p class="subtle">No matching orders. Check the spelling, or create the order first from Orders → + New Order.</p>`;
    $('#op_list').querySelectorAll('[data-oid]').forEach(b=>b.onclick=()=>{
      closeModal(); onPick(allOrders.find(o=>o.id===b.dataset.oid));
    });
  }
  draw('');
  let opDebounce;
  $('#op_search').oninput = e=>{
    const val = e.target.value;
    clearTimeout(opDebounce);
    opDebounce = setTimeout(()=>draw(val), 180);
  };
}

