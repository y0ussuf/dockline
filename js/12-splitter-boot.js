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
  ws.columns = [{width:8},{width:52},{width:12},{width:14}];
  // Sr./Qty/Unit read as short numbers-and-labels, so centering them makes the sheet scannable;
  // Description stays left-aligned since it's the one column people actually read line by line.
  const CENTER_COLS = [1,3,4];

  if(sourceLabel){
    const r = ws.addRow([sourceLabel]);
    r.getCell(1).font = {bold:true, size:14, color:{argb:'FF12202B'}};
    ws.mergeCells(r.number,1,r.number,4);
    ws.addRow([]);
  }

  for(const g of groups){
    const hRow = ws.addRow([g.name]);
    hRow.height = 24;
    ws.mergeCells(hRow.number,1,hRow.number,4);
    const hc = hRow.getCell(1);
    hc.font = {bold:true, size:12, color:{argb:'FFFFFFFF'}};
    hc.fill = {type:'pattern', pattern:'solid', fgColor:{argb:'FF1B6B93'}};
    hc.alignment = {vertical:'middle', horizontal:'left', indent:1};

    const colRow = ws.addRow(['Sr.','Description','Qty','Unit']);
    colRow.eachCell((cc,colNum)=>{
      cc.font = {bold:true, color:{argb:'FF12202B'}};
      cc.fill = {type:'pattern', pattern:'solid', fgColor:{argb:'FFEDEAE1'}};
      cc.border = {bottom:{style:'thin', color:{argb:'FFDBD6C9'}}};
      cc.alignment = {vertical:'middle', horizontal: CENTER_COLS.includes(colNum) ? 'center' : 'left'};
    });

    g.items.forEach(item=>{
      // the sheet's own Sr. number (e.g. 75), not a per-warehouse recount — so it still matches
      // the original uploaded order when someone's cross-checking the two side by side
      const row = ws.addRow([item.sr || '', item.desc, item.qty, item.unit]);
      row.eachCell({includeEmpty:true}, (cc,colNum)=>{
        cc.border = {bottom:{style:'hair', color:{argb:'FFEDEAE1'}}};
        cc.alignment = {vertical:'middle', horizontal: CENTER_COLS.includes(colNum) ? 'center' : 'left'};
      });
    });
    ws.addRow([]);
  }

  return wb.xlsx.writeBuffer().then(buffer=>{
    const blob = new Blob([buffer], {type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'});
    const base = (sourceCode || sourceLabel || 'order').trim().replace(/[^a-z0-9\-_]+/ig,'_').slice(0,60) || 'order';
    return saveFile(`${base}-split.xlsx`, blob);
  });
}

route('splitter', async ()=>{
  const [products, warehouses] = await Promise.all([getAll('products'), getAll('warehouses')]);
  const whById = Object.fromEntries(warehouses.map(w=>[w.id,w]));

  let fileRows = null;           // null until a file's been processed; else array of {id, sr, desc, qty, unit, productId, warehouseId}
  let sourceLabel = '';          // vessel + order code pulled from the sheet, shown as the title inside the export
  let sourceCode = '';           // just the order code (e.g. "AMR-ALL-6") — used for the exported file's name
  let includedWarehouses = new Set(); // group ids (warehouse id, or 'unassigned') currently checked for export

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
    const aoa = XLSX.utils.sheet_to_json(sheet, {header:1, defval:'', blankrows:false});
    if(!aoa.length){ showAlert('The Excel file appears to be empty.'); return false; }
    const headerInfo = locateOrderHeaderRow(aoa);
    if(!headerInfo){ showAlert('Could not find a "Description" column anywhere in the first rows of this file — please check the file format.'); return false; }
    const fromSheet = extractVesselAndCodeFromSheet(aoa, headerInfo.rowIndex);
    sourceLabel = fromSheet ? [fromSheet.vessel, fromSheet.code].filter(Boolean).join(' · ') : '';
    sourceCode = fromSheet ? (fromSheet.code || '') : '';
    const { kSr, kDesc, kQty, kUnit } = headerInfo;
    const dataRows = aoa.slice(headerInfo.rowIndex+1);

    const rows = [];
    for(const row of dataRows){
      const desc = String((kDesc!==-1 ? row[kDesc] : '') ?? '').trim();
      if(!desc) continue;
      const qtyRaw = kQty!==-1 ? row[kQty] : '';
      const qty = parseFloat(qtyRaw);
      const srVal = kSr!==-1 ? String(row[kSr] ?? '').trim() : '';
      const unitVal = kUnit!==-1 ? String(row[kUnit] ?? '').trim() : '';
      const match = await matchExcelRow(desc);
      const product = (match.status==='mapped' || match.status==='auto') ? match.product : null;
      rows.push({
        id: uid(), sr: srVal, desc, qty: isNaN(qty) ? '' : qty, unit: unitVal,
        productId: product ? product.id : '',
        warehouseId: product ? (product.warehouseId || '') : ''
      });
    }
    if(!rows.length){ showAlert('No usable rows found in the file.'); return false; }
    fileRows = rows;
    includedWarehouses = new Set(groupRows().map(g=>g.id)); // everything checked by default
    return true;
  }

  function draw(){
    if(!fileRows){
      $('#main').innerHTML = `
        <div class="topbar"><h1>Order Splitter</h1></div>
        <p class="subtle" style="margin-top:-10px; max-width:680px;">A standalone tool, separate from the rest of Dockline: upload an order sheet and it splits the items by which warehouse each product is stored in, ready to send straight to a supplier. It doesn't touch orders, stock, or anything else — nothing here is saved.</p>
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
      <div class="section-title">Choose which warehouses to export</div>
      <div class="card" id="sp_groups" style="margin-bottom:18px;"></div>
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
          const gid = row.warehouseId || 'unassigned';
          includedWarehouses.add(gid);
          if(!picked.warehouseId) showAlert(`"${picked.name}" doesn't have a warehouse set on its own product record yet, so it'll stay in "Unassigned" — set its warehouse from Products first if you want it grouped properly.`);
          draw();
        });
      });
    }

    $('#sp_groups').innerHTML = groups.map(g=>`
      <label class="list-row" style="cursor:pointer;">
        <input type="checkbox" class="sp-group-cb" data-gid="${g.id}" ${includedWarehouses.has(g.id)?'checked':''} style="width:auto; margin-right:10px;">
        <div style="flex:1; min-width:0;"><b>${esc(g.name)}</b></div>
        <span class="badge b-pending">${g.items.length} item${g.items.length===1?'':'s'}</span>
      </label>`).join('');
    $('#sp_groups').querySelectorAll('.sp-group-cb').forEach(cb=>cb.onchange=()=>{
      if(cb.checked) includedWarehouses.add(cb.dataset.gid); else includedWarehouses.delete(cb.dataset.gid);
    });

    $('#sp_reset').onclick = ()=>{ fileRows=null; sourceLabel=''; sourceCode=''; includedWarehouses=new Set(); draw(); };
    $('#sp_export').onclick = async ()=>{
      const chosen = groups.filter(g=>includedWarehouses.has(g.id));
      if(!chosen.length){ showAlert('Choose at least one warehouse to export.'); return; }
      const btn = $('#sp_export');
      btn.disabled = true; btn.textContent = 'Exporting…';
      await exportSplitterExcel(chosen, sourceLabel, sourceCode);
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
  await seedSyncConfigIfEmpty(); // pre-fills the crew's shared connection so there's something to log in against
  async function startApp(){
    await seedIfEmpty();
    await seedBoxTypesIfEmpty();
    await migrateSuppliers();
    await loadAndApplyTheme();
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
