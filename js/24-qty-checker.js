/* ==================================== QUANTITY CHECKER ====================================
   A tool of its own, separate from the Order Splitter. Give it an order sheet, it finds the lines whose
   quantity isn't a whole number of packs (same pack sizes, rounding rule and "sold loose" settings as the
   rest of the app), you review the suggestions, and it hands back the SAME file — every sheet, style and
   column untouched — with only the changed quantity cells filled yellow (and a small note holding the
   original number). Nothing here is saved to orders or stock. */

/* a cell's plain value, whatever it holds (formula result, rich text, link…) */
function qcCellValue(cell){
  let v = cell.value;
  if(v && typeof v==='object'){
    if('result' in v) v = v.result;
    else if(v.richText) v = v.richText.map(t=>t.text).join('');
    else if('text' in v) v = v.text;
    else if(v instanceof Date) return v;
    else v = '';
  }
  return v==null ? '' : v;
}

route('qcheck', async ()=>{
  const [products, warehouses, batches, packSt] = await Promise.all([getAll('products'), getAll('warehouses'), getAll('batches'), getPackSettings()]);
  const prodById = new Map(products.map(p=>[p.id,p]));
  const whById = Object.fromEntries(warehouses.map(w=>[w.id,w]));
  let file = null, buf = null;          // the uploaded file, kept exactly as it came
  let rows = null, meta = null;         // checked lines, and where the quantity column is
  let vesselName = '', vKey = '';
  const looseSet = ()=> new Set(packSt.loose[vKey] || []);

  function recheck(resetChoices){
    const loose = looseSet();
    for(const r of rows){
      const prod = r.productId ? prodById.get(r.productId) : null;
      r.isLoose = !!(prod && loose.has(prod.id));
      r.check = (prod && !r.isLoose) ? packCheck({qty:r.origQty, unit:r.unit}, prod, batches, packSt.mode) : null;
      r.unjudged = !!(prod && !r.isLoose && !r.check && packUnjudgeable({qty:r.origQty, unit:r.unit}, prod, batches));
      if(resetChoices){ r.choice = 'suggest'; r.custom = ''; }
      if(!r.check) r.qty = r.origQty;
      else if(r.choice==='keep') r.qty = r.origQty;
      else if(r.choice==='custom' && parseFloat(r.custom)>0) r.qty = parseFloat(r.custom);
      else r.qty = r.check.suggested;
    }
  }
  async function setLoose(productId, on){
    const set = looseSet(); if(on) set.add(productId); else set.delete(productId);
    packSt.loose[vKey] = [...set]; await savePackSettings(packSt); recheck(false); draw();
  }

  async function processFile(f){
    buf = await f.arrayBuffer(); file = f;
    const wb = new ExcelJS.Workbook();
    try{ await wb.xlsx.load(buf); }catch(e){ showAlert('This file could not be opened. Please use an .xlsx file.'); return false; }
    const ws = wb.worksheets[0];
    if(!ws || !ws.rowCount){ showAlert('The Excel file appears to be empty.'); return false; }
    // the sheet as rows of plain values; index = row number - 1, so a row's place in the file is never lost
    const aoa = []; const maxC = Math.max(ws.columnCount, 1);
    for(let r=1; r<=ws.rowCount; r++){ const row = ws.getRow(r), arr = []; for(let c=1; c<=maxC; c++) arr.push(qcCellValue(row.getCell(c))); aoa.push(arr); }
    const h = locateOrderHeaderRow(aoa);
    if(!h){ showAlert('Could not find a "Description" column in the first rows of this file — please check the file format.'); return false; }
    if(h.kQty===-1){ showAlert('This sheet has no "Quantity" column, so there is nothing to check.'); return false; }
    const fromSheet = extractVesselAndCodeFromSheet(aoa, h.rowIndex);
    vesselName = fromSheet ? (fromSheet.vessel || '') : ''; vKey = vesselName ? vesselKeyOf(vesselName) : '';
    meta = {label: fromSheet ? [fromSheet.vessel, fromSheet.code].filter(Boolean).join(' · ') : '', qtyCol:h.kQty+1};
    const out = [];
    for(let i=h.rowIndex+1; i<aoa.length; i++){
      const row = aoa[i], desc = String(row[h.kDesc] ?? '').trim();
      if(!desc || sheetRowHeading(row, h)) continue;
      const qty = parseFloat(row[h.kQty]);
      if(isNaN(qty)) continue;
      const unit = h.kUnit!==-1 ? String(row[h.kUnit] ?? '').trim() : '';
      const match = await matchExcelRow(desc);
      const product = (match.status==='mapped' || match.status==='auto') ? match.product : null;
      out.push({id:uid(), rowNo:i+1, desc, unit, origQty:qty, qty, choice:'suggest', custom:'', productId: product ? product.id : ''});
    }
    if(!out.length){ showAlert('No lines with a quantity were found in the file.'); return false; }
    rows = out; recheck(true);
    return true;
  }

  const unitOf = r=> r.unit ? ' '+esc(r.unit) : '';
  function resultHtml(){
    const flagged = rows.filter(r=>r.check), unmatched = rows.filter(r=>!r.productId), unjudged = rows.filter(r=>r.unjudged), looseRows = rows.filter(r=>r.isLoose);
    const changed = rows.filter(r=>parseFloat(r.qty)!==parseFloat(r.origQty)).length;
    return `
      <div class="bt-card" style="margin-bottom:16px;">
        <div class="bt-h">Quantity check</div>
        <p class="subtle" style="margin:0 0 10px;">${flagged.length ? `${flagged.length} line${flagged.length===1?' isn’t':'s aren’t'} a whole number of packs.` : 'Every checked line is already a whole number of packs — nothing to change.'}</p>
        <div class="subtle" style="font-weight:700; margin-bottom:6px;">Rounding rule — applies to every vessel</div>
        <div class="tag-row" id="qc_mode" style="margin-bottom:12px;">${[['up','Round up'],['nearest','Nearest'],['down','Round down']].map(([m,l])=>`<button class="chip ${packSt.mode===m?'active':''}" data-m="${m}">${l}</button>`).join('')}</div>
        ${flagged.length>1?`<div style="display:flex; gap:8px; flex-wrap:wrap; margin-bottom:10px;"><button class="btn btn-ghost btn-sm" id="qc_all">Accept all suggestions</button><button class="btn btn-ghost btn-sm" id="qc_none">Keep all as ordered</button></div>`:''}
        ${flagged.map(r=>`<div class="qc-row" data-r="${r.id}">
          <div style="min-width:0;"><b>${esc(r.desc)}</b>
            <div class="subtle">Ordered ${r.origQty}${unitOf(r)} · pack ${r.check.pack.size} (${esc(r.check.pack.name)})${r.check.pack.fromBatch?' · from batch':''}</div></div>
          <div class="tag-row" style="margin:8px 0 0;">
            <button class="chip ${r.choice==='suggest'?'active':''}" data-c="suggest">${r.check.suggested}${unitOf(r)} · ${r.check.packs} ${esc(packPlural(r.check.pack.name, r.check.packs))}</button>
            <button class="chip ${r.choice==='keep'?'active':''}" data-c="keep">Keep ${r.origQty}</button>
            <input type="number" step="any" inputmode="decimal" class="qc-custom ${r.choice==='custom'?'on':''}" placeholder="Other" value="${r.choice==='custom'?esc(r.custom):''}">
          </div>
          ${vKey && r.productId ? `<button class="qc-link" data-loose="${r.productId}">Sold loose to ${esc(vesselName)} — don’t check this item</button>`:''}
        </div>`).join('')}
        ${unjudged.length?`<div class="bt-warn" style="margin-top:12px;"><b>⚠ ${unjudged.length} item${unjudged.length===1?'':'s'} couldn’t be checked</b><div class="subtle">The ordered unit doesn’t match the product’s unit, so these stay as ordered. Fix the unit on the product (Products page) to include them.</div>${unjudged.map(r=>`<div class="bt-warn-row"><span>${esc(r.desc)}</span><span class="subtle">${r.origQty}${unitOf(r)}</span></div>`).join('')}</div>`:''}
        ${looseRows.length?`<div class="subtle" style="margin-top:12px;"><b>Loose for ${esc(vesselName)}:</b> ${looseRows.map(r=>`${esc(r.desc)} <button class="qc-link" data-unloose="${r.productId}">undo</button>`).join(' · ')}</div>`:''}
      </div>
      ${unmatched.length ? `<div class="card" style="border-left:4px solid var(--warn); margin-bottom:16px;">
        <b>${unmatched.length} line${unmatched.length===1?'':'s'} couldn't be matched to a product</b>
        <p class="subtle" style="margin:4px 0 10px;">They can't be checked and stay exactly as ordered. Choose the product if you want them checked too.</p>
        ${unmatched.map(r=>`<div class="list-row"><div class="thumb">❓</div><div style="flex:1; min-width:0;"><b>${esc(r.desc)}</b><div class="subtle">${r.origQty}${unitOf(r)}</div></div><button class="btn btn-ghost btn-sm" data-assign="${r.id}">Choose product…</button></div>`).join('')}
      </div>` : ''}
      <div class="sp-count">${changed ? `${changed} quantit${changed===1?'y':'ies'} will be changed and filled yellow in the file` : 'No quantities will be changed'}</div>
      <button class="btn btn-signal btn-lg" id="qc_export">⬇ Download the checked sheet</button>`;
  }

  async function exportChecked(){
    const wb = new ExcelJS.Workbook(); await wb.xlsx.load(buf);      // a fresh copy of the original every time
    const ws = wb.worksheets[0], skipped = [];
    let n = 0;
    for(const r of rows){
      if(parseFloat(r.qty)===parseFloat(r.origQty)) continue;
      const cell = ws.getCell(r.rowNo, meta.qtyCol);
      if(cell.formula || (cell.value && typeof cell.value==='object' && 'formula' in cell.value) || cell.isMerged && cell.master!==cell){ skipped.push(r); continue; }
      const wasText = typeof cell.value === 'string';
      cell.value = wasText ? String(r.qty) : r.qty;
      // give this cell its own copy of its style — neighbouring cells can share one style object, and they must not turn yellow too
      cell.style = Object.assign({}, cell.style, {fill:{type:'pattern', pattern:'solid', fgColor:{argb:'FFFFFF00'}, bgColor:{argb:'FFFFFF00'}}});
      cell.note = `Ordered ${r.origQty}`;
      n++;
    }
    const outBuf = await wb.xlsx.writeBuffer();
    const base = (file.name || 'order').replace(/\.xlsx?$/i, '');
    await saveFile(`${base}-checked.xlsx`, new Blob([outBuf], {type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}));
    return {n, skipped};
  }

  function draw(){
    if(!rows){
      $('#main').innerHTML = `
        <div class="topbar"><h1>Quantity Check</h1></div>
        <p class="subtle" style="margin-top:-10px; max-width:680px;">A tool of its own: upload an order sheet and it finds the lines whose quantity isn't a whole number of packs. You review the suggestions, then download the <b>same sheet</b> back — everything untouched except the changed quantities, which are filled yellow. It doesn't touch orders or stock, and nothing is saved.</p>
        <div class="card" style="max-width:520px;">
          <div class="field"><label>Excel file (.xlsx)</label><input type="file" id="qc_file" accept=".xlsx"></div>
          <p class="subtle">Same format as a normal order upload — Sr. / Description / Quantity / Unit, with the vessel name and order code anywhere above the header row.</p>
          <button class="btn btn-signal btn-lg" id="qc_process">Check file</button>
        </div>`;
      $('#qc_process').onclick = async ()=>{
        const f = $('#qc_file').files[0]; if(!f){ showAlert('Choose an Excel file first.'); return; }
        const btn = $('#qc_process'); btn.disabled = true; btn.textContent = 'Checking…';
        let ok = false; try{ ok = await processFile(f); }catch(err){ showAlert('Something went wrong while reading the file: '+(err.message||err)); }
        btn.disabled = false; btn.textContent = 'Check file';
        if(ok) draw();
      };
      return;
    }
    $('#main').innerHTML = `
      <div class="topbar"><h1>Quantity Check</h1><button class="btn btn-ghost" id="qc_reset">Start over</button></div>
      <p class="subtle" style="margin-top:-10px;">${meta.label ? esc(meta.label)+' · ' : ''}${esc(file.name)} · ${rows.length} line${rows.length===1?'':'s'} read.</p>
      <div id="qc_body">${resultHtml()}</div>`;
    const root = $('#qc_body');
    root.querySelectorAll('#qc_mode [data-m]').forEach(b=>b.onclick = async ()=>{ packSt.mode = b.dataset.m; await savePackSettings(packSt); recheck(true); draw(); });
    const all = $('#qc_all'); if(all) all.onclick = ()=>{ rows.forEach(r=>{ if(r.check) r.choice='suggest'; }); recheck(false); draw(); };
    const none = $('#qc_none'); if(none) none.onclick = ()=>{ rows.forEach(r=>{ if(r.check) r.choice='keep'; }); recheck(false); draw(); };
    root.querySelectorAll('[data-r]').forEach(card=>{
      const r = rows.find(x=>x.id===card.dataset.r);
      card.querySelectorAll('[data-c]').forEach(b=>b.onclick = ()=>{ r.choice = b.dataset.c; recheck(false); draw(); });
      const inp = card.querySelector('.qc-custom');
      inp.onchange = ()=>{ if(parseFloat(inp.value)>0){ r.choice='custom'; r.custom=inp.value; } else { r.choice='suggest'; r.custom=''; } recheck(false); draw(); };
    });
    root.querySelectorAll('[data-loose]').forEach(b=>b.onclick = ()=>setLoose(b.dataset.loose, true));
    root.querySelectorAll('[data-unloose]').forEach(b=>b.onclick = ()=>setLoose(b.dataset.unloose, false));
    root.querySelectorAll('[data-assign]').forEach(b=>b.onclick = ()=>{
      openProductPicker(null, products, whById, {}, picked=>{
        const r = rows.find(x=>x.id===b.dataset.assign); r.productId = picked.id; prodById.set(picked.id, picked); recheck(false); draw();
      });
    });
    $('#qc_reset').onclick = ()=>{ rows = null; meta = null; file = null; buf = null; vesselName = ''; vKey = ''; draw(); };
    $('#qc_export').onclick = async ()=>{
      const btn = $('#qc_export'); btn.disabled = true; btn.textContent = 'Preparing…';
      try{
        const res = await exportChecked();
        if(res.skipped.length) showAlert(`${res.skipped.length} quantit${res.skipped.length===1?'y is':'ies are'} a formula or merged cell, so ${res.skipped.length===1?'it was':'they were'} left unchanged in the file:\n${res.skipped.map(r=>`• ${r.desc} (row ${r.rowNo})`).join('\n')}`, 'Done, with a note');
      }catch(err){ showAlert('The file could not be prepared: '+(err.message||err)); }
      btn.disabled = false; btn.textContent = '⬇ Download the checked sheet';
    };
  }
  draw();
});
