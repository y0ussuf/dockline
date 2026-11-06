/* ============================ PRODUCT SETUP (bulk) ============================
   One screen to set stock tracking, batch tracking and pack size / pack name for many products at once,
   instead of opening each product. Only the fields on this screen are changed on a product; everything
   else (photo, dates, location…) is left exactly as it is. Changes are kept in memory until "Save".
   ============================================================================ */
route('productsetup', async ()=>{
  const [products, warehouses] = await Promise.all([slimProducts(), getAll('warehouses')]);
  warehouses.sort((a,b)=>a.priority-b.priority);
  const edits = {};               // productId -> {stockQty, trackBatches, packSize, packName} (only changed keys)
  let filter = 'all', whF = 'all', q = '', limit = 60;
  const cur = (p,k)=> (edits[p.id] && k in edits[p.id]) ? edits[p.id][k] : p[k];
  const hasStock = p=> { const v = cur(p,'stockQty'); return v!=='' && v!=null && !isNaN(parseFloat(v)); };
  const rowErr = p=> cur(p,'trackBatches') && !hasStock(p) ? 'Needs “Stock on hand” (0 is fine) to track batches' : '';

  function visible(){
    const nq = normalize(q);
    return products.filter(p=>{
      if(!p.active) return false;
      if(whF!=='all' && p.warehouseId!==whF) return false;
      if(nq && !normalize(p.name).includes(nq)) return false;
      if(filter==='nopack') return !(parseFloat(cur(p,'packSize'))>0);
      if(filter==='notrack') return !cur(p,'trackBatches');
      if(filter==='changed') return !!edits[p.id];
      return true;
    }).sort((a,b)=>a.name.localeCompare(b.name));
  }
  function rowHtml(p){
    const err = rowErr(p), changed = !!edits[p.id];
    return `<div class="su-row ${changed?'su-changed':''} ${err?'su-bad':''}" data-id="${p.id}">
      <div class="su-name"><b>${esc(p.name)}</b><span class="subtle">${esc(p.unit||'no unit')}</span></div>
      <label class="su-f"><span>Stock on hand</span><input type="number" step="any" inputmode="decimal" data-k="stockQty" placeholder="not tracked" value="${hasStock(p)?esc(cur(p,'stockQty')):''}"></label>
      <label class="su-f"><span>Pack size</span><input type="number" step="any" inputmode="decimal" data-k="packSize" placeholder="e.g. 360" value="${parseFloat(cur(p,'packSize'))>0?esc(cur(p,'packSize')):''}"></label>
      <label class="su-f"><span>Pack name</span><input type="text" data-k="packName" placeholder="box" value="${esc(cur(p,'packName')||'')}"></label>
      <label class="su-sw"><input type="checkbox" data-k="trackBatches" ${cur(p,'trackBatches')?'checked':''}><span>Track batches</span></label>
      ${err?`<div class="su-err">${err}</div>`:''}
    </div>`;
  }
  function drawBar(){
    const n = Object.keys(edits).length, bad = products.filter(p=>edits[p.id] && rowErr(p)).length;
    $('#suBar').innerHTML = n ? `<span><b>${n}</b> product${n===1?'':'s'} changed${bad?` · <span style="color:var(--danger);">${bad} need attention</span>`:''}</span>
      <span style="display:flex; gap:8px;"><button class="btn btn-ghost btn-sm" id="suDiscard">Discard</button><button class="btn btn-signal" id="suSave" ${bad?'disabled':''}>Save changes</button></span>` : '';
    $('#suBar').classList.toggle('on', !!n);
    const d = $('#suDiscard'); if(d) d.onclick = ()=>{ for(const k in edits) delete edits[k]; drawList(); drawBar(); };
    const s = $('#suSave'); if(s) s.onclick = save;
  }
  function drawList(){
    const list = visible(), shown = list.slice(0, limit);
    $('#suCount').textContent = `${list.length} product${list.length===1?'':'s'}`;
    $('#suList').innerHTML = shown.map(rowHtml).join('') || `<p class="subtle">No products match.</p>`;
    $('#suMore').innerHTML = list.length>shown.length ? `<button class="btn btn-ghost" id="suShowMore">Show ${Math.min(60,list.length-shown.length)} more (${list.length-shown.length} hidden)</button>` : '';
    const m = $('#suShowMore'); if(m) m.onclick = ()=>{ limit += 60; drawList(); };
  }
  function setEdit(p, k, v){
    const e = edits[p.id] = edits[p.id] || {};
    e[k] = v;
    // back to the saved values → not a change any more
    if(Object.keys(e).every(key=>{ const a = e[key], b = p[key]; return (a===''||a==null||a===false) ? (b===''||b==null||b===false||b===undefined) : String(a)===String(b); })) delete edits[p.id];
  }

  $('#main').innerHTML = `
    <div class="topbar"><h1>Product setup</h1><a href="#/products" class="btn btn-ghost">Back</a></div>
    <p class="subtle" style="margin-top:-10px; max-width:640px;">Set stock, pack size and batch tracking for many products at once. Pack size is how much one box/tray holds, in the product's unit (e.g. 360 for eggs). Nothing is saved until you press <b>Save changes</b>.</p>
    <div class="field" style="max-width:360px;"><input type="text" id="suSearch" placeholder="Search products…"></div>
    <div class="tag-row" id="suFilter">
      <button class="chip active" data-f="all">All</button><button class="chip" data-f="nopack">No pack size</button>
      <button class="chip" data-f="notrack">Not batch-tracked</button><button class="chip" data-f="changed">Changed</button>
    </div>
    <div class="tag-row" id="suWh"><button class="chip active" data-w="all">All warehouses</button>${warehouses.map(w=>`<button class="chip" data-w="${w.id}">${esc(w.name)}</button>`).join('')}</div>
    <div class="su-tools"><span class="subtle" id="suCount"></span>
      <button class="btn btn-ghost btn-sm" id="suTrackAll" title="Switch on batch tracking for every product shown that has a stock number">Track batches for all shown</button></div>
    <div id="suList"></div><div id="suMore" style="margin:12px 0;"></div>
    <div class="su-bar" id="suBar"></div>`;
  drawList(); drawBar();

  let t; $('#suSearch').addEventListener('input', e=>{ clearTimeout(t); const v=e.target.value; t=setTimeout(()=>{ q=v; limit=60; drawList(); }, 300); });
  $('#suFilter').onclick = e=>{ const b=e.target.closest('[data-f]'); if(!b) return; filter=b.dataset.f; limit=60;
    $('#suFilter').querySelectorAll('.chip').forEach(c=>c.classList.toggle('active', c===b)); drawList(); };
  $('#suWh').onclick = e=>{ const b=e.target.closest('[data-w]'); if(!b) return; whF=b.dataset.w; limit=60;
    $('#suWh').querySelectorAll('.chip').forEach(c=>c.classList.toggle('active', c===b)); drawList(); };
  $('#suTrackAll').onclick = ()=>{
    const list = visible().filter(p=>hasStock(p) && !cur(p,'trackBatches'));
    if(!list.length) return showAlert('Nothing to switch on: every product shown is either already tracked or has no stock number yet.');
    showConfirm(`Switch on batch tracking for ${list.length} product${list.length===1?'':'s'}? Their current stock becomes an “Opening stock” batch you can split into real batches later.`, ()=>{
      list.forEach(p=>setEdit(p,'trackBatches',true)); drawList(); drawBar();
    });
  };
  // typing updates memory only; the row re-renders only for state changes (error/changed markers), not on each key
  $('#suList').addEventListener('input', e=>{
    const inp = e.target.closest('[data-k]'); if(!inp) return;
    const row = inp.closest('[data-id]'), p = products.find(x=>x.id===row.dataset.id), k = inp.dataset.k;
    if(k==='trackBatches') setEdit(p,k,inp.checked);
    else if(k==='packName') setEdit(p,k,inp.value.trim());
    else setEdit(p,k, inp.value.trim()==='' ? '' : parseFloat(inp.value));
    row.classList.toggle('su-changed', !!edits[p.id]);
    const err = rowErr(p); row.classList.toggle('su-bad', !!err);
    let el = row.querySelector('.su-err');
    if(err){ if(!el){ el = document.createElement('div'); el.className='su-err'; row.appendChild(el); } el.textContent = err; } else if(el) el.remove();
    drawBar();
  });

  async function save(){
    const ids = Object.keys(edits);
    const btn = $('#suSave'); if(btn){ btn.disabled = true; btn.textContent = 'Saving…'; }
    let n = 0;
    try{
      for(const id of ids){
        const p = await getOne('products', id); if(!p) continue;   // always the stored record, so nothing else about it is overwritten
        const e = edits[id];
        if('stockQty' in e) p.stockQty = e.stockQty;
        if('packSize' in e) p.packSize = e.packSize;
        if('packName' in e) p.packName = e.packName;
        if('trackBatches' in e) p.trackBatches = !!e.trackBatches;
        if(p.trackBatches && !isStockTracked(p)){ p.trackBatches = false; }
        await put('products', p); n++;
      }
      await reconcileBatches(ids);
    }catch(err){ showAlert('Some changes were not saved: '+err.message); drawBar(); return; }
    showAlert(`${n} product${n===1?'':'s'} updated.`, 'Saved');
    routes['productsetup']([]);
  }
});
