/* ==================================== ORDER SPLITTER ====================================
   A standalone, self-contained tool: upload the same order sheet used for picking, and it
   splits the items by which warehouse each product lives in, for sending straight to a
   supplier. On purpose this never touches orders/orderItems or any other part of the app —
   nothing here is saved to the database, it's pure upload → preview → export, held entirely
   in local variables for the lifetime of this screen. Re-uses the same header-detection and
   product-matching logic as a normal order import (locateOrderHeaderRow, matchExcelRow) so
   it recognizes the file the same way picking does, but keeps its own separate flow. */
function exportSplitterExcel(groups, sourceLabel, sourceCode){
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Dockline';
  wb.created = new Date();
  const ws = wb.addWorksheet('Order by warehouse');
  const showOrdered = groups.some(g=>g.items.some(i=>i.ordered!=null));
  const NC = showOrdered ? 5 : 4;
  ws.columns = [{width:8},{width:52},{width:12},{width:14}].concat(showOrdered?[{width:16}]:[]);
  // Sr./Qty/Unit read as short numbers-and-labels, so centering them makes the sheet scannable;
  // Description stays left-aligned since it's the one column people actually read line by line.
  const CENTER_COLS = [1,3,4,5];

  if(sourceLabel){
    const r = ws.addRow([sourceLabel]);
    r.getCell(1).font = {bold:true, size:14, color:{argb:'FF12202B'}};
    ws.mergeCells(r.number,1,r.number,NC);
    ws.addRow([]);
  }

  for(const g of groups){
    const hRow = ws.addRow([g.name]);
    hRow.height = 24;
    ws.mergeCells(hRow.number,1,hRow.number,NC);
    const hc = hRow.getCell(1);
    hc.font = {bold:true, size:12, color:{argb:'FFFFFFFF'}};
    hc.fill = {type:'pattern', pattern:'solid', fgColor:{argb:'FF1B6B93'}};
    hc.alignment = {vertical:'middle', horizontal:'left', indent:1};

    const colRow = ws.addRow(['Sr.','Description','Qty','Unit'].concat(showOrdered?['Ordered']:[]));
    colRow.eachCell((cc,colNum)=>{
      cc.font = {bold:true, color:{argb:'FF12202B'}};
      cc.fill = {type:'pattern', pattern:'solid', fgColor:{argb:'FFEDEAE1'}};
      cc.border = {bottom:{style:'thin', color:{argb:'FFDBD6C9'}}};
      cc.alignment = {vertical:'middle', horizontal: CENTER_COLS.includes(colNum) ? 'center' : 'left'};
    });

    const addItem = item=>{
      // the sheet's own Sr. number (e.g. 75), not a per-warehouse recount — so it still matches
      // the original uploaded order when someone's cross-checking the two side by side
      const row = ws.addRow([item.sr || '', item.desc, item.qty, item.unit].concat(showOrdered?[item.ordered!=null ? item.ordered : '']:[]));
      row.eachCell({includeEmpty:true}, (cc,colNum)=>{
        cc.border = {bottom:{style:'hair', color:{argb:'FFEDEAE1'}}};
        cc.alignment = {vertical:'middle', horizontal: CENTER_COLS.includes(colNum) ? 'center' : 'left'};
      });
    };
    if(g.sections){
      // a warehouse with more than one section: each section gets its own sub-heading under the warehouse
      for(const sec of g.sections){
        const sRow = ws.addRow([sec.name]);
        sRow.height = 20;
        ws.mergeCells(sRow.number,1,sRow.number,NC);
        const sc = sRow.getCell(1);
        sc.font = {bold:true, size:11, color:{argb:'FF12202B'}};
        sc.fill = {type:'pattern', pattern:'solid', fgColor:{argb:'FFD6E8F2'}};
        sc.alignment = {vertical:'middle', horizontal:'left', indent:1};
        sec.items.forEach(addItem);
      }
    } else g.items.forEach(addItem);
    ws.addRow([]);
  }

  return wb.xlsx.writeBuffer().then(buffer=>{
    const blob = new Blob([buffer], {type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'});
    const base = (sourceCode || sourceLabel || 'order').trim().replace(/[^a-z0-9\-_]+/ig,'_').slice(0,60) || 'order';
    return saveFile(`${base}-split.xlsx`, blob);
  });
}

route('splitter', async ()=>{
  const [products, warehouses, batches, packSt, sectionList] = await Promise.all([getAll('products'), getAll('warehouses'), getAll('batches'), getPackSettings(), getAll('sections')]);
  const secById = Object.fromEntries(sectionList.map(s=>[s.id,s]));
  const prodById = new Map(products.map(p=>[p.id,p]));
  let vesselName = '', vKey = '';
  const whById = Object.fromEntries(warehouses.map(w=>[w.id,w]));

  let fileRows = null;           // null until a file's been processed; else array of {id, sr, desc, qty, unit, productId, warehouseId}
  let sourceLabel = '';          // vessel + order code pulled from the sheet, shown as the title inside the export
  let sourceCode = '';           // just the order code (e.g. "AMR-ALL-6") — used for the exported file's name
  let spQuery = '';              // search box text; narrows the list of items shown below
  const openGroups = new Set();  // warehouses whose item list is expanded
  const secOf = r=>{ const pr = r.productId ? prodById.get(r.productId) : null; const s = pr && pr.sectionId && secById[pr.sectionId]; return s ? {id:s.id, name:s.name} : {id:'none', name:'No section'}; };

  function groupRows(){
    const groups = new Map(); // key -> {name, items:[]}
    for(const r of fileRows){
      const key = r.warehouseId || 'unassigned';
      const name = r.warehouseId ? (whById[r.warehouseId] ? whById[r.warehouseId].name : '(deleted warehouse)') : "Unassigned — couldn't locate";
      if(!groups.has(key)) groups.set(key, {name, items:[]});
      groups.get(key).items.push(r);
    }
    const arr = [...groups.entries()].map(([id,g])=>({id, name:g.name, items:g.items}));
    arr.sort((a,b)=> a.id==='unassigned' ? 1 : b.id==='unassigned' ? -1 : a.name.localeCompare(b.name));
    return arr;
  }

  async function processFile(file){
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, {type:'array'});
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const aoa = sheetToRows(sheet);
    if(!aoa.length){ showAlert('The Excel file appears to be empty.'); return false; }
    const headerInfo = locateOrderHeaderRow(aoa);
    if(!headerInfo){ showAlert('Could not find a "Description" column anywhere in the first rows of this file — please check the file format.'); return false; }
    const fromSheet = extractVesselAndCodeFromSheet(aoa, headerInfo.rowIndex);
    sourceLabel = fromSheet ? [fromSheet.vessel, fromSheet.code].filter(Boolean).join(' · ') : '';
    sourceCode = fromSheet ? (fromSheet.code || '') : '';
    vesselName = fromSheet ? (fromSheet.vessel || '') : ''; vKey = vesselName ? vesselKeyOf(vesselName) : '';
    const { kSr, kDesc, kQty, kUnit } = headerInfo;
    const dataRows = aoa.slice(headerInfo.rowIndex+1);

    const rows = [];
    for(const row of dataRows){
      const desc = String((kDesc!==-1 ? row[kDesc] : '') ?? '').trim();
      if(!desc) continue;
      if(sheetRowHeading(row, headerInfo)) continue;   // a heading such as BOND is not a product
      const qtyRaw = kQty!==-1 ? row[kQty] : '';
      const qty = parseFloat(qtyRaw);
      const srVal = kSr!==-1 ? String(row[kSr] ?? '').trim() : '';
      const unitVal = kUnit!==-1 ? String(row[kUnit] ?? '').trim() : '';
      const match = await matchExcelRow(desc);
      const product = (match.status==='mapped' || match.status==='auto') ? match.product : null;
      rows.push({
        id: uid(), sr: srVal, desc, qty: isNaN(qty) ? '' : qty, origQty: isNaN(qty) ? '' : qty, unit: unitVal, choice:'suggest', custom:'',
        productId: product ? product.id : '',
        warehouseId: product ? (product.warehouseId || '') : ''
      });
    }
    if(!rows.length){ showAlert('No usable rows found in the file.'); return false; }
    fileRows = rows;
    rows.forEach(r=>r.on = true);   // every item is ticked for export by default
    spQuery = ''; openGroups.clear();
    return true;
  }

  function draw(){
    if(!fileRows){
      $('#main').innerHTML = `
        <div class="topbar"><h1>Order Splitter</h1></div>
        <p class="subtle" style="margin-top:-10px; max-width:680px;">A standalone tool, separate from the rest of Dockline: upload an order sheet and it splits the items by which warehouse each product is stored in, ready to send straight to a supplier. It doesn't touch orders, stock, or anything else — nothing here is saved. Quantities are exported exactly as ordered; to check them against pack sizes use <a href="#/qcheck">Quantity Check</a>.</p>
        <div class="card" style="max-width:520px;">
          <div class="field"><label>Excel file (.xlsx)</label><input type="file" id="sp_file" accept=".xlsx,.xls"></div>
          <p class="subtle" id="sp_hint">Same format as a normal order upload — Sr. / Description / Quantity / Unit, with the vessel name and order code anywhere above the header row.</p>
          <button class="btn btn-signal btn-lg" id="sp_process">Process file</button>
        </div>`;
      $('#sp_process').onclick = async ()=>{
        const file = $('#sp_file').files[0];
        if(!file){ showAlert('Choose an Excel file first.'); return; }
        const btn = $('#sp_process');
        btn.disabled = true; btn.textContent = 'Processing…';
        const ok = await processFile(file);
        btn.disabled = false; btn.textContent = 'Process file';
        if(ok) draw();
      };
      return;
    }

    const groups = groupRows();
    const unassignedGroup = groups.find(g=>g.id==='unassigned');
    const unassignedCount = unassignedGroup ? unassignedGroup.items.length : 0;

    $('#main').innerHTML = `
      <div class="topbar"><h1>Order Splitter</h1>
        <button class="btn btn-ghost" id="sp_reset">Start over</button>
      </div>
      <p class="subtle" style="margin-top:-10px;">${sourceLabel ? esc(sourceLabel)+' · ' : ''}${fileRows.length} item${fileRows.length===1?'':'s'} found across ${groups.length} location${groups.length===1?'':'s'}.</p>
      ${unassignedCount ? `<div class="card" style="border-left:4px solid var(--warn); margin-bottom:16px;">
        <b>${unassignedCount} item${unassignedCount===1?'':'s'} couldn't be matched to a product</b>
        <p class="subtle" style="margin:4px 0 10px;">Pick the right product for each so it lands in the correct warehouse — items left as-is will export under "Unassigned".</p>
        <div id="sp_unassigned"></div>
      </div>` : ''}
      <div class="section-title">Choose what to export</div>
      <div class="sp-tools">
        <input type="search" id="sp_search" class="sp-search" placeholder="Search items…" value="${esc(spQuery)}" autocomplete="off">
        <div class="sp-btns"><button class="btn btn-ghost btn-sm" id="sp_all">${spQuery?'Tick shown':'Tick all'}</button><button class="btn btn-ghost btn-sm" id="sp_none">${spQuery?'Untick shown':'Untick all'}</button></div>
      </div>
      <div id="sp_groups" style="margin-bottom:12px;"></div>
      <div class="sp-count" id="sp_count"></div>
      <button class="btn btn-signal btn-lg" id="sp_export">⬇ Export selected to Excel</button>`;

    if(unassignedCount){
      $('#sp_unassigned').innerHTML = unassignedGroup.items.map(r=>`
        <div class="list-row">
          <div class="thumb">❓</div>
          <div style="flex:1; min-width:0;"><b>${esc(r.desc)}</b><div class="subtle">${r.qty}${r.unit?' '+esc(r.unit):''}</div></div>
          <button class="btn btn-ghost btn-sm" data-assign="${r.id}">Choose product…</button>
        </div>`).join('');
      $('#sp_unassigned').querySelectorAll('[data-assign]').forEach(b=>b.onclick=()=>{
        openProductPicker(null, products, whById, {}, (picked)=>{
          const row = fileRows.find(x=>x.id===b.dataset.assign);
          row.productId = picked.id;
          row.warehouseId = picked.warehouseId || '';
          prodById.set(picked.id, picked);
          row.on = true;
          if(!picked.warehouseId) showAlert(`"${picked.name}" doesn't have a warehouse set on its own product record yet, so it'll stay in "Unassigned" — set its warehouse from Products first if you want it grouped properly.`);
          draw();
        });
      });
    }

    const q = normalize(spQuery);
    const shown = r=> !q || normalize(r.desc).includes(q) || (r.productId && prodById.get(r.productId) && normalize(prodById.get(r.productId).name).includes(q));
    const tri = (rows)=>{ const n = rows.filter(r=>r.on).length; return n===0 ? 0 : n===rows.length ? 2 : 1; };
    const box = (st, attrs)=>`<input type="checkbox" class="sp-cb" ${attrs} ${st===2?'checked':''} data-ind="${st===1?1:0}">`;
    const itemRow = r=>`<label class="sp-item"><input type="checkbox" class="sp-cb" data-row="${r.id}" ${r.on?'checked':''}><span class="sp-name">${esc(r.desc)}</span><span class="subtle sp-q">${r.qty}${r.unit?' '+esc(r.unit):''}</span></label>`;
    let html = '';
    for(const g of groups){
      const vis = g.items.filter(shown);
      if(q && !vis.length) continue;
      const st = tri(g.items), open = q ? true : openGroups.has(g.id);
      const secs = new Map();
      for(const r of vis){ const s = secOf(r); if(!secs.has(s.id)) secs.set(s.id, {name:s.name, items:[]}); secs.get(s.id).items.push(r); }
      const secList = [...secs.entries()].sort((a,b)=> a[0]==='none' ? 1 : b[0]==='none' ? -1 : a[1].name.localeCompare(b[1].name));
      const onN = g.items.filter(r=>r.on).length;
      html += `<div class="sp-wh ${open?'open':''}" data-g="${g.id}">
        <div class="sp-wh-h"><label class="sp-wh-l">${box(st, `data-wh="${g.id}"`)}<b>${esc(g.name)}</b></label>
          <span class="badge ${onN===g.items.length?'b-pending':''}">${onN}/${g.items.length}</span>
          <button class="sp-tog" data-tog="${g.id}" aria-label="Show items">${open?'▾':'▸'}</button></div>
        ${open ? `<div class="sp-wh-b">${secList.map(([sid,s])=>{
          const all = g.items.filter(r=>secOf(r).id===sid);
          return `<div class="sp-sec"><label class="sp-sec-h">${box(tri(all), `data-sec="${g.id}|${sid}"`)}<span>${esc(s.name)}</span><span class="subtle">${all.filter(r=>r.on).length}/${all.length}</span></label>${s.items.map(itemRow).join('')}</div>`;}).join('')}</div>` : ''}
      </div>`;
    }
    $('#sp_groups').innerHTML = html || '<p class="subtle">No items match your search.</p>';
    const total = fileRows.filter(r=>r.on).length;
    const updateCount = ()=>{ const n = fileRows.filter(r=>r.on).length; $('#sp_count').textContent = `${n} of ${fileRows.length} item${fileRows.length===1?'':'s'} will be exported`; $('#sp_export').disabled = !n; };
    updateCount();
    const root = $('#sp_groups');
    root.querySelectorAll('input[data-ind="1"]').forEach(cb=>cb.indeterminate = true);
    const rowsOf = (gid, sid)=> groups.find(g=>g.id===gid).items.filter(r=>!sid || secOf(r).id===sid);
    root.querySelectorAll('[data-wh]').forEach(cb=>cb.onchange=()=>{ rowsOf(cb.dataset.wh).filter(shown).forEach(r=>r.on = cb.checked); draw(); });
    root.querySelectorAll('[data-sec]').forEach(cb=>cb.onchange=()=>{ const [gid,sid] = cb.dataset.sec.split('|'); rowsOf(gid,sid).filter(shown).forEach(r=>r.on = cb.checked); draw(); });
    root.querySelectorAll('[data-row]').forEach(cb=>cb.onchange=()=>{ fileRows.find(x=>x.id===cb.dataset.row).on = cb.checked; draw(); });
    root.querySelectorAll('[data-tog]').forEach(b=>b.onclick=()=>{ const id = b.dataset.tog; openGroups.has(id) ? openGroups.delete(id) : openGroups.add(id); draw(); });
    $('#sp_all').onclick = ()=>{ fileRows.filter(shown).forEach(r=>r.on = true); draw(); };
    $('#sp_none').onclick = ()=>{ fileRows.filter(shown).forEach(r=>r.on = false); draw(); };
    const si = $('#sp_search');
    si.oninput = ()=>{ spQuery = si.value; const pos = si.selectionStart; draw(); const n = $('#sp_search'); n.focus(); try{ n.setSelectionRange(pos,pos); }catch(e){} };

    $('#sp_reset').onclick = ()=>{ vesselName=''; vKey=''; fileRows=null; sourceLabel=''; sourceCode=''; spQuery=''; openGroups.clear(); draw(); };
    $('#sp_export').onclick = async ()=>{
      const chosen = groups.map(g=>({...g, items:g.items.filter(r=>r.on)})).filter(g=>g.items.length);
      if(!chosen.length){ showAlert('Tick at least one item to export.'); return; }
      const btn = $('#sp_export');
      btn.disabled = true; btn.textContent = 'Exporting…';
      const withOrdered = chosen.map(g=>{
        const items = g.items.map(r=>Object.assign({}, r, {ordered: (parseFloat(r.qty)!==parseFloat(r.origQty)) ? r.origQty : null}));
        // more than one section set up in this warehouse → split the sheet by section (shelf order; items with no section last)
        const defined = g.id==='unassigned' ? [] : sectionList.filter(s=>s.warehouseId===g.id);
        let sections = null;
        if(defined.length>1){
          const by = new Map();
          for(const it of items){ const sid = secOf(it).id; if(!by.has(sid)) by.set(sid, {id:sid, name:secOf(it).name, items:[]}); by.get(sid).items.push(it); }
          sections = [...by.values()].sort((a,b)=> a.id==='none' ? 1 : b.id==='none' ? -1 : ((secById[a.id]?.priority ?? 9999) - (secById[b.id]?.priority ?? 9999)) || a.name.localeCompare(b.name));
        }
        return {id:g.id, name:g.name, items, sections};
      });
      await exportSplitterExcel(withOrdered, sourceLabel, sourceCode);
      btn.disabled = false; btn.textContent = '⬇ Export selected to Excel';
    };
  }
  draw();
});

/* ------------------------------ backup / restore ------------------------------ */
/* Saves a file whether we're running inside Claude's artifact sandbox (uses the
   downloads capability) or as a plain installed app / regular browser tab
   (falls back to a normal Blob download link, which works offline too). */
async function saveFile(filename, data, mimeType){
  if(window.claude && typeof window.claude.use === 'function'){
    const dl = await window.claude.use('downloads');
    if(dl){
      try{
        await dl.save({filename, data});
        return true;
      }catch(e){
        if(e && e.code === 'declined') return false;
        showAlert('Could not save the file' + (e && e.message ? ': '+e.message : '.'));
        return false;
      }
    }
  }
  // plain-browser / installed-app fallback
  try{
    const blob = (data instanceof Blob) ? data : new Blob([data], {type: mimeType||'application/octet-stream'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(()=>URL.revokeObjectURL(url), 4000);
    return true;
  }catch(e){
    showAlert('Could not save the file' + (e && e.message ? ': '+e.message : '.'));
    return false;
  }
}

async function downloadBackup(){
  const payload = {schemaVersion: DB_VER, exportedAt: new Date().toISOString(), stores:{}};
  for(const s of STORES) payload.stores[s] = await getAll(s);
  const json = JSON.stringify(payload);
  await saveFile(`dockline-backup-${todayISO()}.json`, json, 'application/json');
}
async function restoreBackupFile(file){
  const text = await file.text();
  let payload;
  try{ payload = JSON.parse(text); }
  catch(e){ showAlert('That file is not a valid backup (invalid JSON).'); return; }
  if(!payload || typeof payload.stores !== 'object'){
    showAlert('That file does not look like a Dockline backup.');
    return;
  }
  showConfirm('Restore this backup? It will replace all current products, warehouses, sections, suppliers, orders and settings with the data in this file. This cannot be undone.', async ()=>{
    for(const s of STORES){
      const records = payload.stores[s];
      if(!Array.isArray(records)) continue;
      const existing = await getAll(s);
      for(const rec of existing) await del(s, rec.id);
      for(const rec of records) await put(s, rec);
    }
    showAlert('Backup restored. The app will now reload.');
    setTimeout(()=>location.reload(), 1200);
  }, {danger:true, yesLabel:'Restore & overwrite'});
}

/* ---------------------------- update check ----------------------------
   GitHub Pages (and most phone browsers on top of it) cache this file far more
   aggressively than feels reasonable for a single HTML page with no versioned
   filenames — the symptom is "I uploaded a new copy but the site still looks
   old until I clear the browser's cache/data". Since there's no build step to
   give each release its own filename, this instead re-fetches the page's own
   HTML straight from the network (cache:'no-store' + a cache-busting query
   string, so nothing in between can serve a stale copy of THIS request),
   reads the APP_VERSION baked into it, and compares it to the version this
   tab is actually running. If they differ, a small banner offers a one-tap
   reload instead of a manual cache wipe. Runs shortly after load, again
   whenever the tab regains focus (covers a phone left open for days), and
   every 10 minutes while it stays open and visible. */
async function checkForUpdate(){
  try{
    const url = location.pathname + '?_=' + Date.now();
    const res = await fetch(url, {cache:'no-store'});
    if(!res.ok) return;
    const text = await res.text();
    const m = text.match(/const APP_VERSION\s*=\s*'([^']+)'/);
    if(m && m[1] && m[1] !== APP_VERSION){
      $('#updateBanner').classList.add('show');
    }
  }catch(e){ /* offline or blocked — just skip this round, no harm done */ }
}
function reloadToLatest(){
  location.href = location.pathname + '?_=' + Date.now();
}

/* ------------------------------- boot ------------------------------- */
(async function boot(){
  await seedSyncConfigIfEmpty(); // pre-fills the connection from js/config.js (public client settings) when this device has none
  async function startApp(){
    if(DEMO_MODE){ await loadDemoData(); await seedDemoData(); }   // sample data exists only in demo mode
    await migrateSuppliers();
    await loadAndApplyTheme();
    await loadMyPerms(); applyNavPermissions(); AUDIT_ON = true;
    if(!location.hash) location.hash = '#/';
    render();
    compressExistingImages(); // background, non-blocking — shrinks any oversized photos already stored
    startSyncLoop();
    setTimeout(checkForUpdate, 4000);
    setInterval(()=>{ if(document.visibilityState==='visible') checkForUpdate(); }, 10*60*1000);
    document.addEventListener('visibilitychange', ()=>{ if(document.visibilityState==='visible') checkForUpdate(); });
    $('#updateBannerReload').onclick = reloadToLatest;
    $('#updateBannerDismiss').onclick = ()=> $('#updateBanner').classList.remove('show');
  }
  const sess = await ensureFreshSession();
  if(sess){ AUTH = sess; await startApp(); }
  else showAuthGate(startApp);
})();
