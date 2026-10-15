/* ==================================== PRODUCTS ==================================== */
route('products', async ()=>{
  const [products, warehouses, sections, suppliers] = await Promise.all([getAll('products'), getAll('warehouses'), getAll('sections'), getAll('suppliers')]);
  warehouses.sort((a,b)=>a.priority-b.priority);
  const whMap = Object.fromEntries(warehouses.map(w=>[w.id,w]));
  const secMap = Object.fromEntries(sections.map(s=>[s.id,s]));
  const supMap = new Map(suppliers.map(s=>[s.id,s]));

  window.__filterWh = window.__filterWh || 'all';
  window.__search = window.__search || '';

  const unassignedCount = products.filter(p=>!p.warehouseId).length;

  function list(){
    let items = products.filter(p=>{
      if(window.__filterWh==='unassigned' && p.warehouseId) return false;
      if(window.__filterWh!=='all' && window.__filterWh!=='unassigned' && p.warehouseId!==window.__filterWh) return false;
      if(window.__search && !normalize(p.name).includes(normalize(window.__search))) return false;
      return true;
    });
    const groups = {};
    items.forEach(p=>{ const key=p.sectionId||'none'; (groups[key]=groups[key]||[]).push(p); });
    Object.values(groups).forEach(g=>g.sort((a,b)=>a.priority-b.priority));
    const secIds = Object.keys(groups).sort((a,b)=>{
      const sa=secMap[a], sb=secMap[b];
      if(!sa||!sb) return 0;
      if(sa.warehouseId!==sb.warehouseId) return (whMap[sa.warehouseId]?.priority||0)-(whMap[sb.warehouseId]?.priority||0);
      return sa.priority-sb.priority;
    });
    if(!secIds.length) return `<div class="empty"><div class="ic">◫</div>No products match. Try “Add product”.</div>`;
    return secIds.map(sid=>{
      const sec = secMap[sid];
      const wh = sec ? whMap[sec.warehouseId] : null;
      return `<div class="card" style="margin-bottom:14px;">
        <div class="section-title">${wh?esc(wh.name)+' · ':''}${sec?esc(sec.name):'No section'}</div>
        <div data-sortable-section="${sid}">
        ${groups[sid].map(p=>`
          <div class="list-row" data-id="${p.id}">
            <span class="drag-handle">⠿</span>
            <div class="thumb">${p.image?`<img src="${p.image}" loading="lazy" decoding="async">`:'📦'}</div>
            <div style="flex:1; min-width:0;">
              <div style="font-weight:700;">${esc(p.name)} ${p.active?'':'<span class="badge b-picked_later">inactive</span>'} ${!p.warehouseId?'<span class="badge b-unmatched">needs setup</span>':''}</div>
              <div class="subtle">${esc(p.unit||'no unit')} · ${esc(supplierName(p.supplierId,supMap)||'no supplier')}${p.expiryDate?' · exp '+fmtDate(p.expiryDate):''}</div>
            </div>
            <button class="iconbtn" data-alias="${p.id}" title="Also-known-as names">🔗</button>
            <button class="iconbtn" data-edit="${p.id}" title="Edit">✎</button>
            <button class="iconbtn" data-del="${p.id}" title="Delete">✕</button>
          </div>`).join('')}
        </div>
      </div>`;
    }).join('');
  }

  $('#main').innerHTML = `
    <div class="topbar"><h1>Products</h1>
      <div style="display:flex; gap:10px;">
        <button class="btn btn-ghost" id="bulkImport">⇧ Bulk import (CSV)</button>
        <button class="btn btn-signal" id="addProd">+ Add product</button>
      </div>
    </div>
    <div class="field" style="max-width:360px;"><input type="text" id="psearch" placeholder="Search products…" value="${esc(window.__search)}"></div>
    <div class="tag-row" id="whFilter">
      <button class="chip ${window.__filterWh==='all'?'active':''}" data-wh="all">All warehouses</button>
      ${warehouses.map(w=>`<button class="chip ${window.__filterWh===w.id?'active':''}" data-wh="${w.id}">${esc(w.name)}</button>`).join('')}
      ${unassignedCount ? `<button class="chip ${window.__filterWh==='unassigned'?'active':''}" data-wh="unassigned">⚠ Needs setup (${unassignedCount})</button>` : ''}
    </div>
    <div id="prodList">${list()}</div>
  `;
  $('#bulkImport').onclick = ()=>openBulkImport();

  let searchDebounce;
  $('#psearch').oninput = e=>{
    const val = e.target.value;
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(()=>{ window.__search=val; $('#prodList').innerHTML=list(); attachRowHandlers(); }, 180);
  };
  $('#whFilter').onclick = e=>{
    const b = e.target.closest('[data-wh]'); if(!b) return;
    window.__filterWh = b.dataset.wh;
    routes['products']([]);
  };
  $('#addProd').onclick = ()=>openProductForm(null, warehouses, sections, suppliers);

  function attachRowHandlers(){
    $('#prodList').querySelectorAll('[data-edit]').forEach(b=>b.onclick=()=>{
      const p = products.find(x=>x.id===b.dataset.edit);
      openProductForm(p, warehouses, sections, suppliers);
    });
    $('#prodList').querySelectorAll('[data-alias]').forEach(b=>b.onclick=()=>{
      const p = products.find(x=>x.id===b.dataset.alias);
      openAliasManager(p);
    });
    $('#prodList').querySelectorAll('[data-del]').forEach(b=>b.onclick=async ()=>{
      showConfirm('Deactivate this product? It stays visible in past orders.', async ()=>{
        const p = products.find(x=>x.id===b.dataset.del);
        p.active=false; await put('products',p); routes['products']([]);
      }, {danger:true, yesLabel:'Deactivate'});
    });
    $('#prodList').querySelectorAll('[data-sortable-section]').forEach(el=>{
      new Sortable(el,{handle:'.drag-handle', animation:150, onEnd: async ()=>{
        const ids=[...el.children].map(c=>c.dataset.id);
        for(let i=0;i<ids.length;i++){
          const p = products.find(x=>x.id===ids[i]);
          if(p){ p.priority=i+1; await put('products',p); }
        }
      }});
    });
  }
  attachRowHandlers();
});

function openProductForm(p, warehouses, sections, suppliers, onSaved){
  const editing = !!p;
  p = p || {id:uid(), name:'', unit:'', supplierId:'', warehouseId:warehouses[0]?.id||'', sectionId:'', priority:999, active:true, notes:'', productionDate:'', expiryDate:'', expiryMode:'date', expiryShelfAmount:'', expiryShelfUnit:'months', image:'', stockQty:'', lowStockLimit:''};
  suppliers = (suppliers||[]).slice().sort((a,b)=>a.name.localeCompare(b.name));
  const secForWh = (whId)=> sections.filter(s=>s.warehouseId===whId).sort((a,b)=>a.priority-b.priority);
  const supplierOptions = ()=> `<option value="">— No supplier —</option>` + suppliers.map(s=>`<option value="${s.id}" ${s.id===p.supplierId?'selected':''}>${esc(s.name)}</option>`).join('');
  showModal(`
    <h3>${editing?'Edit product':'Add product'}</h3>
    <div class="field"><label>Product name</label><input type="text" id="f_name" value="${esc(p.name)}"></div>
    <div class="field"><label>Product image (optional)</label><input type="file" id="f_image" accept="image/*"></div>
    <div class="row2">
      <div class="field"><label>Unit</label><input type="text" id="f_unit" placeholder="Kg, LTR, Tin 400 gm…" value="${esc(p.unit)}"></div>
      <div class="field">
        <label>Supplier</label>
        <select id="f_supplier">${supplierOptions()}</select>
        <button type="button" class="btn btn-ghost btn-sm" id="f_newsup" style="margin-top:6px;">+ New supplier</button>
        <div id="f_newsup_row" style="display:none; margin-top:8px; gap:8px;">
          <input type="text" id="f_newsup_name" placeholder="Supplier name" style="margin-bottom:6px;">
          <button type="button" class="btn btn-signal btn-sm" id="f_newsup_save">Add</button>
        </div>
      </div>
    </div>
    <div class="row2">
      <div class="field"><label>Warehouse</label><select id="f_wh">${warehouses.map(w=>`<option value="${w.id}" ${w.id===p.warehouseId?'selected':''}>${esc(w.name)}</option>`).join('')}</select></div>
      <div class="field"><label>Section</label><select id="f_sec">${secForWh(p.warehouseId).map(s=>`<option value="${s.id}" ${s.id===p.sectionId?'selected':''}>${esc(s.name)}</option>`).join('')}</select></div>
    </div>
    <div class="field"><label>Production date</label><input type="date" id="f_pdate" value="${p.productionDate||''}"></div>
    ${expiryFieldHtml('f', {expiryDate:p.expiryDate, mode:p.expiryMode, shelfAmount:p.expiryShelfAmount, shelfUnit:p.expiryShelfUnit})}
    <div class="field"><label>Notes</label><textarea id="f_notes">${esc(p.notes)}</textarea></div>
    <div class="field"><label><input type="checkbox" id="f_active" ${p.active?'checked':''} style="width:auto; margin-right:8px;">Active</label></div>
    <details style="margin-bottom:14px;" ${(p.stockQty!==''&&p.stockQty!=null)?'open':''}>
      <summary class="subtle" style="cursor:pointer; margin-bottom:8px;">Stock tracking (optional)</summary>
      <p class="subtle" style="margin-top:0;">Leave "Stock on hand" blank to not track this product — nothing changes for it. Fill it in and it'll be kept up to date automatically as orders are picked, and flagged on the Stock page once it runs low.</p>
      <div class="row2">
        <div class="field"><label>Stock on hand</label><input type="number" id="f_stockqty" step="any" placeholder="not tracked" value="${p.stockQty===''||p.stockQty==null?'':esc(p.stockQty)}"></div>
        <div class="field"><label>Low stock limit</label><input type="number" id="f_stocklimit" step="any" placeholder="0" value="${p.lowStockLimit===''||p.lowStockLimit==null?'':esc(p.lowStockLimit)}"></div>
      </div>
    </details>
    <div style="display:flex; gap:10px; margin-top:14px;">
      <button class="btn btn-signal" id="f_save" style="flex:1;">Save product</button>
      <button class="btn btn-ghost" id="f_cancel">Cancel</button>
    </div>
  `);
  wireExpiryField('f', 'f_pdate');
  $('#f_wh').onchange = ()=>{
    const opts = secForWh($('#f_wh').value);
    $('#f_sec').innerHTML = opts.map(s=>`<option value="${s.id}">${esc(s.name)}</option>`).join('') || '<option value="">No sections — add one first</option>';
  };
  $('#f_newsup').onclick = ()=>{
    $('#f_newsup_row').style.display = 'flex';
    $('#f_newsup').style.display = 'none';
    $('#f_newsup_name').focus();
  };
  $('#f_newsup_save').onclick = async ()=>{
    const name = $('#f_newsup_name').value.trim();
    if(!name) return;
    const all = await getAll('suppliers');
    const clash = all.find(x=>normalize(x.name)===normalize(name));
    const sup = clash || {id:uid(), name, contactPerson:'', phone:'', email:'', notes:''};
    if(!clash) await put('suppliers', sup);
    suppliers.push(sup); suppliers.sort((a,b)=>a.name.localeCompare(b.name));
    $('#f_supplier').innerHTML = supplierOptions();
    $('#f_supplier').value = sup.id;
    $('#f_newsup_row').style.display = 'none';
    $('#f_newsup').style.display = 'inline-flex';
    $('#f_newsup_name').value = '';
  };
  let newImage = p.image;
  $('#f_image').onchange = async e=>{
    const file = e.target.files[0]; if(!file) return;
    try{
      newImage = await compressImageFile(file, 480, 0.72);
    }catch(err){
      showAlert('Could not process that image — try a different photo.');
    }
  };
  $('#f_cancel').onclick = closeModal;
  $('#f_save').onclick = async ()=>{
    const name = $('#f_name').value.trim();
    if(!name){ showAlert('Product name is required.'); return; }
    p.name = name;
    p.unit = $('#f_unit').value.trim();
    p.supplierId = $('#f_supplier').value;
    p.warehouseId = $('#f_wh').value;
    p.sectionId = $('#f_sec').value;
    p.productionDate = $('#f_pdate').value;
    p.expiryDate = $('#f_edate').value;
    p.expiryMode = expiryModeOf('f');
    p.expiryShelfAmount = $('#f_shelf_amount').value ? parseFloat($('#f_shelf_amount').value) : '';
    p.expiryShelfUnit = $('#f_shelf_unit').value;
    p.notes = $('#f_notes').value.trim();
    p.active = $('#f_active').checked;
    p.image = newImage;
    p.stockQty = $('#f_stockqty').value.trim()==='' ? '' : parseFloat($('#f_stockqty').value);
    p.lowStockLimit = $('#f_stocklimit').value.trim()==='' ? '' : parseFloat($('#f_stocklimit').value);
    if(!editing){
      const siblings = (await getAll('products')).filter(x=>x.sectionId===p.sectionId);
      p.priority = siblings.length ? Math.max(...siblings.map(s=>s.priority||0))+1 : 1;
    }
    await put('products', p);
    closeModal();
    if(onSaved) onSaved(p); else routes['products']([]);
  };
}

/* ------------------------------ alias manager ------------------------------ */
async function openAliasManager(product){
  async function draw(){
    const mappings = (await getAll('mappings')).filter(m=>m.productId===product.id);
    showModal(`
      <h3>Also-known-as names — ${esc(product.name)}</h3>
      <p class="subtle">When an Excel order uses one of these names instead of “${esc(product.name)}”, it will be matched to this product automatically.</p>
      <div id="aliasList" style="margin:14px 0;">
        ${mappings.length ? mappings.map(m=>`
          <div class="list-row" data-mid="${m.id}">
            <div style="flex:1;">${esc(m.label || m.excelDescNormalized)}</div>
            <button class="iconbtn" data-rmalias="${m.id}" title="Remove">✕</button>
          </div>`).join('') : `<p class="subtle">No alternate names yet.</p>`}
      </div>
      <div class="field"><label>Add a name used in ship orders</label>
        <div style="display:flex; gap:8px;">
          <input type="text" id="alias_new" placeholder="e.g. Chicken Cubes">
          <button class="btn btn-signal btn-sm" id="alias_add">Add</button>
        </div>
      </div>
      <button class="btn btn-ghost" style="margin-top:10px;" onclick="closeModal()">Done</button>
    `);
    $('#aliasList').querySelectorAll('[data-rmalias]').forEach(b=>b.onclick=async ()=>{
      await del('mappings', b.dataset.rmalias);
      draw();
    });
    $('#alias_add').onclick = async ()=>{
      const raw = $('#alias_new').value.trim();
      if(!raw) return;
      const norm = normalize(raw);
      const all = await getAll('mappings');
      const clash = all.find(m=>m.excelDescNormalized===norm && m.productId!==product.id);
      if(clash){
        const otherProduct = await getOne('products', clash.productId);
        showConfirm(`"${raw}" is currently mapped to "${otherProduct?otherProduct.name:'another product'}". Point it to "${product.name}" instead?`, async ()=>{
          clash.productId = product.id; clash.label = raw;
          await put('mappings', clash);
          draw();
        }, {onNo: draw});
        return;
      } else {
        const dup = all.find(m=>m.excelDescNormalized===norm && m.productId===product.id);
        if(!dup) await put('mappings', {id:uid(), excelDescNormalized:norm, label:raw, productId:product.id});
      }
      draw();
    };
  }
  draw();
}

/* ------------------------------ bulk product + alias import ------------------------------ */
function openBulkImport(){
  showModal(`
    <h3>Bulk import products &amp; aliases</h3>
    <p class="subtle">Upload a CSV with two columns — <b>alias</b> and <b>product_name</b>. Each unique product name is created (or matched to an existing product); every alias that differs from its product name is saved as an alternate name, so those wordings match automatically in future Excel imports.</p>
    <div class="field"><input type="file" id="csv_file" accept=".csv"></div>
    <div id="csv_preview"></div>
    <div style="display:flex; gap:10px; margin-top:14px;">
      <button class="btn btn-signal" id="csv_import" disabled style="flex:1;">Import</button>
      <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
    </div>`);

  let parsedGroups = null;

  $('#csv_file').onchange = async (e)=>{
    const file = e.target.files[0];
    if(!file) return;
    $('#csv_preview').innerHTML = `<p class="subtle">Reading file…</p>`;
    const text = await file.text();
    const wb = XLSX.read(text, {type:'string'});
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet, {defval:''});
    if(!rows.length){ $('#csv_preview').innerHTML = `<p style="color:var(--danger);">That file looks empty.</p>`; return; }

    const sample = rows[0];
    const findKey = (names)=> Object.keys(sample).find(k=>names.includes(normalize(k)));
    const kAlias = findKey(['alias','aliases','excel name','excel description','name variant']);
    const kProduct = findKey(['product_name','product name','productname','database name','db name','database product']);
    if(!kAlias || !kProduct){
      $('#csv_preview').innerHTML = `<p style="color:var(--danger);">Couldn't find "alias" and "product_name" columns — found: ${Object.keys(sample).map(esc).join(', ')}.</p>`;
      return;
    }

    const groups = new Map(); // normalizedProductName -> {display, aliasMap: Map(normalizedAlias -> rawAlias)}
    let totalRows = 0;
    for(const row of rows){
      const productName = String(row[kProduct]||'').trim();
      const alias = String(row[kAlias]||'').trim();
      if(!productName) continue;
      totalRows++;
      const np = normalize(productName);
      if(!np) continue;
      if(!groups.has(np)) groups.set(np, {display: productName, aliasMap: new Map()});
      const g = groups.get(np);
      if(alias){
        const na = normalize(alias);
        if(na && na !== np && !g.aliasMap.has(na)) g.aliasMap.set(na, alias);
      }
    }
    parsedGroups = groups;
    const totalAliases = [...groups.values()].reduce((s,g)=>s+g.aliasMap.size,0);
    $('#csv_preview').innerHTML = `
      <p style="margin-top:10px;"><b>${totalRows}</b> rows → <b>${groups.size}</b> unique products, <b>${totalAliases}</b> alternate names to link.</p>
      <p class="subtle">New products are created with just a name. You'll fill in image, unit, supplier, dates, warehouse and section afterward — filter Products by "Needs setup" to find them quickly.</p>`;
    $('#csv_import').disabled = false;
  };

  $('#csv_import').onclick = async ()=>{
    if(!parsedGroups) return;
    $('#csv_import').disabled = true;
    $('#csv_import').textContent = 'Importing…';
    const existingProducts = await getAll('products');
    const existingMappings = await getAll('mappings');
    const byName = new Map(existingProducts.map(p=>[normalize(p.name), p]));
    const byAlias = new Map(existingMappings.map(m=>[m.excelDescNormalized, m]));
    let productsCreated=0, productsMatched=0, aliasesCreated=0, aliasesConflict=0;

    for(const [np, g] of parsedGroups){
      let product = byName.get(np);
      if(!product){
        product = {id:uid(), name:g.display, unit:'', supplier:'', warehouseId:'', sectionId:'', priority:999, active:true, notes:'', productionDate:'', expiryDate:'', image:''};
        await put('products', product);
        byName.set(np, product);
        productsCreated++;
      } else {
        productsMatched++;
      }
      for(const [na, rawAlias] of g.aliasMap){
        const existing = byAlias.get(na);
        if(existing){
          if(existing.productId !== product.id) aliasesConflict++;
          continue;
        }
        const m = {id:uid(), excelDescNormalized:na, label:rawAlias, productId:product.id};
        await put('mappings', m);
        byAlias.set(na, m);
        aliasesCreated++;
      }
    }

    window.__filterWh = productsCreated ? 'unassigned' : 'all';
    routes['products']([]);
    showAlert(`Import complete: ${productsCreated} new products, ${productsMatched} matched existing products, ${aliasesCreated} alternate names linked${aliasesConflict?`, ${aliasesConflict} aliases skipped (already pointed to a different product)`:''}.`, 'Import complete');
  };
}

/* ==================================== WAREHOUSES ==================================== */
route('warehouses', async ()=>{
  const [warehouses, sections, products] = await Promise.all([getAll('warehouses'), getAll('sections'), getAll('products')]);
  warehouses.sort((a,b)=>a.priority-b.priority);

  // shared by both a section's product list and the "No section" list below
  function productRowHtml(p){
    const missing = [];
    if(!p.image) missing.push('photo');
    if(!p.unit) missing.push('unit');
    if(!p.supplierId) missing.push('supplier');
    if(!p.productionDate) missing.push('production date');
    if(!p.expiryDate) missing.push('expiry date');
    return `<div class="list-row" style="padding:7px 0;">
      <div class="thumb" style="width:34px; height:34px; font-size:1rem;">${p.image?`<img src="${p.image}" loading="lazy" decoding="async">`:'📦'}</div>
      <div style="flex:1; min-width:0;">
        ${esc(p.name)}${p.active?'':' <span class="badge b-picked_later">inactive</span>'}
        ${missing.length?`<div class="subtle">missing: ${missing.join(', ')}</div>`:''}
      </div>
      <button class="btn btn-ghost btn-sm" data-editprod="${p.id}">Edit</button>
    </div>`;
  }

  function render(){
    const admin = isAdmin();
    $('#main').innerHTML = `
      <div class="topbar"><h1>Warehouses</h1>${admin?'<button class="btn btn-signal" id="addWh">+ Add warehouse</button>':''}</div>
      <p class="subtle" style="margin-top:-10px; margin-bottom:18px;">Drag ⠿ to reorder. Warehouse order and section order set the picking sequence.${admin?'':' Adding, renaming or deleting warehouses/sections is admin-only — ask your admin if something here needs to change.'}</p>
      <div id="whList"></div>`;
    const list = $('#whList');
    list.innerHTML = warehouses.map(w=>{
      const secs = sections.filter(s=>s.warehouseId===w.id).sort((a,b)=>a.priority-b.priority);
      // products that point at this warehouse but whose section is empty or no longer
      // exists (e.g. the warehouse has 0 sections) — these used to be invisible because
      // the list below only ever rendered products nested under a real section
      const unsec = products.filter(p=>p.warehouseId===w.id && !secs.some(s=>s.id===p.sectionId));
      return `<div class="card" style="margin-bottom:14px;" data-whid="${w.id}">
        <div class="list-row" style="border:none; padding:0 0 10px;">
          <span class="drag-handle wh-handle">⠿</span>
          <div style="flex:1;"><b style="font-family:var(--font-d); font-size:1.05rem;">${esc(w.name)}</b>
            <div class="subtle">${secs.length} section${secs.length===1?'':'s'} · ${products.filter(p=>p.warehouseId===w.id).length} products</div>
          </div>
          ${admin ? `<button class="iconbtn" data-editwh="${w.id}">✎</button><button class="iconbtn" data-delwh="${w.id}">✕</button>` : ''}
        </div>
        <div data-sec-sortable="${w.id}" style="padding-left:8px; border-left:2px solid var(--line);">
        ${secs.map(s=>{
          const secProducts = products.filter(p=>p.sectionId===s.id).sort((a,b)=>a.priority-b.priority);
          const expanded = window.__expandedSection === s.id;
          return `<div data-secid="${s.id}">
            <div class="list-row">
              <span class="drag-handle">⠿</span>
              <div style="flex:1; cursor:pointer;" data-togglesec="${s.id}">${esc(s.name)}<span class="subtle"> · ${secProducts.length} product${secProducts.length===1?'':'s'}</span></div>
              ${admin ? `<button class="iconbtn" data-editsec="${s.id}">✎</button><button class="iconbtn" data-delsec="${s.id}">✕</button>` : ''}
            </div>
            ${expanded ? `
              <div style="padding:2px 0 12px 44px;">
                ${secProducts.length ? secProducts.map(productRowHtml).join('') : `<p class="subtle">No products in this section yet.</p>`}
                <div style="display:flex; gap:8px; flex-wrap:wrap; margin-top:6px;">
                  <button class="btn btn-ghost btn-sm" data-addprodto="${s.id}">+ Add new product</button>
                  <button class="btn btn-ghost btn-sm" data-assignprodto="${s.id}">+ Assign existing product</button>
                </div>
              </div>
            ` : ''}
          </div>`;
        }).join('') || (unsec.length ? '' : `<div class="subtle" style="padding:10px 0;">No sections yet.</div>`)}
        ${unsec.length ? (()=>{
          const key = 'unsec:'+w.id;
          const expanded = window.__expandedSection === key;
          return `<div data-secid="${key}">
            <div class="list-row">
              <span class="drag-handle" style="visibility:hidden;">⠿</span>
              <div style="flex:1; cursor:pointer;" data-togglesec="${key}">No section<span class="subtle"> · ${unsec.length} product${unsec.length===1?'':'s'}</span></div>
            </div>
            ${expanded ? `
              <div style="padding:2px 0 12px 44px;">
                <p class="subtle" style="margin-top:0;">These products are assigned to this warehouse but not to any section in it — edit a product to put it under one.</p>
                ${unsec.map(productRowHtml).join('')}
              </div>
            ` : ''}
          </div>`;
        })() : ''}
        </div>
        ${admin ? `<button class="btn btn-ghost btn-sm" data-addsec="${w.id}" style="margin-top:10px;">+ Add section</button>` : ''}
      </div>`;
    }).join('');

    new Sortable(list, {handle:'.wh-handle', animation:150, onEnd: async ()=>{
      const ids=[...list.children].map(c=>c.dataset.whid);
      for(let i=0;i<ids.length;i++){ const w=warehouses.find(x=>x.id===ids[i]); w.priority=i+1; await put('warehouses',w); }
    }});
    list.querySelectorAll('[data-sec-sortable]').forEach(el=>{
      new Sortable(el,{handle:'.drag-handle', animation:150, onEnd: async ()=>{
        const ids=[...el.children].map(c=>c.dataset.secid).filter(Boolean);
        for(let i=0;i<ids.length;i++){ const s=sections.find(x=>x.id===ids[i]); if(s){ s.priority=i+1; await put('sections',s); } }
      }});
    });

    list.querySelectorAll('[data-editwh]').forEach(b=>b.onclick=()=>whForm(warehouses.find(w=>w.id===b.dataset.editwh)));
    list.querySelectorAll('[data-delwh]').forEach(b=>b.onclick=()=>{
      const whId = b.dataset.delwh;
      const wh = warehouses.find(w=>w.id===whId);
      const whSections = sections.filter(s=>s.warehouseId===whId);
      const whProducts = products.filter(p=>p.warehouseId===whId);
      const parts = [];
      if(whSections.length) parts.push(`${whSections.length} section${whSections.length===1?'':'s'}`);
      if(whProducts.length) parts.push(`${whProducts.length} product${whProducts.length===1?'':'s'}`);
      const msg = parts.length
        ? `"${wh.name}" still has ${parts.join(' and ')} in it. Deleting the warehouse will permanently delete all of them too, and this can't be undone. Delete "${wh.name}" and everything in it?`
        : `Delete "${wh.name}"?`;
      showConfirm(msg, async ()=>{
        for(const p of whProducts) await del('products', p.id);
        for(const s of whSections) await del('sections', s.id);
        await del('warehouses', whId);
        routes['warehouses']([]);
      }, {danger:true, yesLabel: parts.length ? 'Delete everything' : 'Delete'});
    });
    list.querySelectorAll('[data-addsec]').forEach(b=>b.onclick=()=>secForm(null, b.dataset.addsec));
    list.querySelectorAll('[data-editsec]').forEach(b=>b.onclick=()=>secForm(sections.find(s=>s.id===b.dataset.editsec)));
    list.querySelectorAll('[data-delsec]').forEach(b=>b.onclick=()=>{
      const has = products.some(p=>p.sectionId===b.dataset.delsec);
      if(has){ showAlert('Move or remove products from this section first.'); return; }
      showConfirm('Delete this section?', async ()=>{ await del('sections', b.dataset.delsec); routes['warehouses']([]); }, {danger:true, yesLabel:'Delete'});
    });
    list.querySelectorAll('[data-togglesec]').forEach(b=>b.onclick=()=>{
      const id = b.dataset.togglesec;
      window.__expandedSection = (window.__expandedSection === id) ? null : id;
      render();
    });
    list.querySelectorAll('[data-editprod]').forEach(b=>b.onclick=async ()=>{
      const p = products.find(x=>x.id===b.dataset.editprod);
      const suppliersList = await getAll('suppliers');
      openProductForm(p, warehouses, sections, suppliersList, ()=>{ render(); });
    });
    list.querySelectorAll('[data-addprodto]').forEach(b=>b.onclick=async ()=>{
      const sec = sections.find(s=>s.id===b.dataset.addprodto);
      const siblings = products.filter(p=>p.sectionId===sec.id);
      const draftProduct = {
        id:uid(), name:'', unit:'', supplierId:'', warehouseId: sec.warehouseId, sectionId: sec.id,
        priority: siblings.length ? Math.max(...siblings.map(s=>s.priority||0))+1 : 1,
        active:true, notes:'', productionDate:'', expiryDate:'', image:''
      };
      const suppliersList = await getAll('suppliers');
      openProductForm(draftProduct, warehouses, sections, suppliersList, (savedProduct)=>{
        products.push(savedProduct);
        render();
      });
    });
    list.querySelectorAll('[data-assignprodto]').forEach(b=>b.onclick=()=>{
      const sec = sections.find(s=>s.id===b.dataset.assignprodto);
      const whMap = Object.fromEntries(warehouses.map(w=>[w.id,w]));
      const secMap = Object.fromEntries(sections.map(s=>[s.id,s]));
      openProductPicker(null, products, whMap, secMap, async (picked)=>{
        const siblings = products.filter(p=>p.sectionId===sec.id && p.id!==picked.id);
        picked.warehouseId = sec.warehouseId;
        picked.sectionId = sec.id;
        picked.priority = siblings.length ? Math.max(...siblings.map(s=>s.priority||0))+1 : 1;
        await put('products', picked);
        render();
      });
    });
  }

  function whForm(w){
    const editing = !!w; w = w || {id:uid(), name:'', description:'', priority:(Math.max(0,...warehouses.map(x=>x.priority))+1)};
    showModal(`<h3>${editing?'Edit warehouse':'Add warehouse'}</h3>
      <div class="field"><label>Name</label><input type="text" id="w_name" value="${esc(w.name)}"></div>
      <div class="field"><label>Description (optional)</label><input type="text" id="w_desc" value="${esc(w.description)}"></div>
      <div style="display:flex; gap:10px; margin-top:10px;"><button class="btn btn-signal" id="w_save" style="flex:1;">Save</button><button class="btn btn-ghost" onclick="closeModal()">Cancel</button></div>`);
    $('#w_save').onclick = async ()=>{
      const name = $('#w_name').value.trim(); if(!name){ showAlert('Name required'); return; }
      w.name=name; w.description=$('#w_desc').value.trim();
      await put('warehouses', w); closeModal(); routes['warehouses']([]);
    };
  }
  function secForm(s, whId){
    const editing = !!s;
    const wId = whId || (s && s.warehouseId);
    const sibCount = sections.filter(x=>x.warehouseId===wId).length;
    s = s || {id:uid(), warehouseId:wId, name:'', priority:sibCount+1};
    showModal(`<h3>${editing?'Edit section':'Add section'}</h3>
      <div class="field"><label>Section name</label><input type="text" id="s_name" value="${esc(s.name)}"></div>
      <div style="display:flex; gap:10px; margin-top:10px;"><button class="btn btn-signal" id="s_save" style="flex:1;">Save</button><button class="btn btn-ghost" onclick="closeModal()">Cancel</button></div>`);
    $('#s_save').onclick = async ()=>{
      const name = $('#s_name').value.trim(); if(!name){ showAlert('Name required'); return; }
      s.name=name; await put('sections', s); closeModal(); routes['warehouses']([]);
    };
  }
  window.closeModal = closeModal;
  $('#main').innerHTML=''; render();
  $('#main').querySelector('#addWh')?.addEventListener('click', ()=>whForm(null));
});

