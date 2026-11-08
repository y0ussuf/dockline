/* ============================================================================================
   Move products to another warehouse / section in one go.
   Only the location changes: stock, names, prices, batches and history stay with the product.
   Every move is logged so it can be undone, and each product remembers where it used to be.
   ============================================================================================ */
const MV_MAX_LOG = 30;

function mvWhName(whMap, id){ return (whMap.get(id) && whMap.get(id).name) || 'No warehouse'; }
function mvSecName(secMap, id){ return (secMap.get(id) && secMap.get(id).name) || 'No section'; }

async function openMoveModal(ids, onDone){
  const [products, whs, secs] = await Promise.all([getAll('products'), getAll('warehouses'), getAll('sections')]);
  const sel = ids.map(id=>products.find(p=>p.id===id)).filter(Boolean);
  if(!sel.length) return;
  const whMap = new Map(whs.map(w=>[w.id,w])), secMap = new Map(secs.map(s=>[s.id,s]));
  whs.sort((a,b)=>(a.priority||0)-(b.priority||0));
  // where they are now
  const from = new Map(); sel.forEach(p=>{ const k = `${mvWhName(whMap,p.warehouseId)} / ${mvSecName(secMap,p.sectionId)}`; from.set(k,(from.get(k)||0)+1); });
  // the most common current warehouse is the natural destination
  const cnt = new Map(); sel.forEach(p=>cnt.set(p.warehouseId,(cnt.get(p.warehouseId)||0)+1));
  const defWh = [...cnt.entries()].sort((a,b)=>b[1]-a[1])[0][0] || (whs[0] && whs[0].id) || '';
  const secsOf = wid=>secs.filter(s=>s.warehouseId===wid).sort((a,b)=>(a.priority||0)-(b.priority||0));

  showModal(`<h3>Move ${sel.length} product${sel.length===1?'':'s'}</h3>
    <div class="subtle" style="margin-bottom:10px;">Now in: ${[...from.entries()].map(([k,n])=>`<b>${esc(k)}</b> (${n})`).join(' · ')}</div>
    <div class="field"><label>New warehouse</label><select id="mv_wh">${whs.map(w=>`<option value="${w.id}" ${w.id===defWh?'selected':''}>${esc(w.name)}</option>`).join('')}</select></div>
    <div class="field"><label>New section</label><select id="mv_sec"></select></div>
    <div class="field" id="mv_newwrap" hidden><label>Name of the new section</label><input type="text" id="mv_new" placeholder="e.g. Shelf 4"></div>
    <div class="card" id="mv_prev" style="margin:12px 0; padding:10px 12px;"></div>
    <p class="subtle" style="margin:0 0 12px;">Only the location changes. Stock, saved names, prices and history stay with each product.</p>
    <div style="display:flex; gap:10px;"><button class="btn btn-signal" id="mv_go" style="flex:1;">Move</button><button class="btn btn-ghost" onclick="closeModal()">Cancel</button></div>`);
  const fillSecs = ()=>{
    const wid = $('#mv_wh').value, list = secsOf(wid);
    const common = [...new Set(sel.map(p=>p.sectionId))].filter(id=>list.some(s=>s.id===id));
    $('#mv_sec').innerHTML = list.map(s=>`<option value="${s.id}" ${(common.length===1 && sel.every(p=>p.sectionId===s.id))?'selected':''}>${esc(s.name)}</option>`).join('') + '<option value="">— No section —</option><option value="__new">＋ New section…</option>';
    if(!list.length) $('#mv_sec').value = '__new';
    refresh();
  };
  const refresh = ()=>{
    const isNew = $('#mv_sec').value==='__new'; $('#mv_newwrap').hidden = !isNew;
    const wid = $('#mv_wh').value, sname = isNew ? ($('#mv_new').value.trim() || '(new section)') : mvSecName(secMap, $('#mv_sec').value);
    $('#mv_prev').innerHTML = `<b>${sel.length} product${sel.length===1?'':'s'}</b> → ${whDot(wid)}<b>${esc(mvWhName(whMap,wid))}</b> / <b>${esc(sname)}</b>`;
    $('#mv_go').disabled = isNew && !$('#mv_new').value.trim();
  };
  $('#mv_wh').onchange = fillSecs; $('#mv_sec').onchange = refresh; $('#mv_new').oninput = refresh;
  fillSecs();
  $('#mv_go').onclick = async ()=>{
    const btn = $('#mv_go'); btn.disabled = true; btn.textContent = 'Moving…';
    try{
      const wid = $('#mv_wh').value; let sid = $('#mv_sec').value;
      let newSection = null;
      if(sid==='__new'){
        const sibs = secsOf(wid);
        newSection = {id:uid(), warehouseId:wid, name:$('#mv_new').value.trim(), priority: sibs.length ? Math.max(...sibs.map(s=>s.priority||0))+1 : 1};
        await put('sections', newSection); sid = newSection.id;
      }
      const log = await moveProducts(sel.map(p=>p.id), wid, sid, newSection ? newSection.id : null);
      closeModal();
      showModal(`<h3>Moved</h3><p>${log.items.length} product${log.items.length===1?'':'s'} now in <b>${esc(log.toWh)} / ${esc(log.toSec)}</b>.</p>
        <div style="display:flex; gap:10px; margin-top:14px;"><button class="btn btn-signal" style="flex:1;" onclick="closeModal()">OK</button><button class="btn btn-ghost" id="mv_undo">Undo</button></div>`);
      $('#mv_undo').onclick = async ()=>{ await undoMove(log.id); closeModal(); onDone && onDone(); };
      onDone && onDone();
    }catch(err){ closeModal(); showAlert('The move did not finish: '+(err.message||err)); onDone && onDone(); }
  };
}

async function moveProducts(ids, wid, sid, createdSectionId){
  const [products, whs, secs] = await Promise.all([getAll('products'), getAll('warehouses'), getAll('sections')]);
  const sel = ids.map(id=>products.find(p=>p.id===id)).filter(Boolean).sort((a,b)=>(a.priority||0)-(b.priority||0));
  const whMap = new Map(whs.map(w=>[w.id,w])), secMap = new Map(secs.map(s=>[s.id,s]));
  const chosen = new Set(ids);
  const there = products.filter(p=>p.sectionId===sid && sid && !chosen.has(p.id));
  let pri = there.length ? Math.max(...there.map(p=>p.priority||0)) : 0;
  const log = {id:'move-'+Date.now(), at:new Date().toISOString(), toWh:mvWhName(whMap,wid), toSec: sid ? mvSecName(secMap,sid) : 'No section', createdSectionId, items:[], undone:false};
  for(const p of sel){
    log.items.push({id:p.id, w:p.warehouseId||'', s:p.sectionId||'', pri:p.priority, hist:p.locationHistory||null});
    const prev = {at:log.at, wh:mvWhName(whMap,p.warehouseId), sec:mvSecName(secMap,p.sectionId)};
    p.locationHistory = [prev, ...(p.locationHistory||[])].slice(0, 10);
    p.warehouseId = wid; p.sectionId = sid || ''; p.priority = ++pri;
    await put('products', p);
  }
  const store = await getOne('sharedSettings','moveLog') || {id:'moveLog', entries:[]};
  store.entries = [log, ...store.entries].slice(0, MV_MAX_LOG);
  await put('sharedSettings', store);
  return log;
}

async function undoMove(logId){
  const store = await getOne('sharedSettings','moveLog'); const log = store && store.entries.find(e=>e.id===logId);
  if(!log || log.undone) return;
  const products = await getAll('products'), byId = new Map(products.map(p=>[p.id,p]));
  for(const it of log.items){
    const p = byId.get(it.id); if(!p) continue;
    p.warehouseId = it.w; p.sectionId = it.s; p.priority = it.pri;
    if(it.hist) p.locationHistory = it.hist; else delete p.locationHistory;
    await put('products', p);
  }
  if(log.createdSectionId){            // a section made just for this move goes away again if nothing else is in it
    const left = (await getAll('products')).some(p=>p.sectionId===log.createdSectionId);
    if(!left) await del('sections', log.createdSectionId);
  }
  log.undone = true; await put('sharedSettings', store);
}

/* small banner on the Products page: the latest move, with Undo */
async function moveBannerHtml(){
  const store = await getOne('sharedSettings','moveLog'); const e = store && store.entries.find(x=>!x.undone);
  if(!e || Date.now() - new Date(e.at).getTime() > 14*864e5) return '';
  return `<div class="card mv-banner"><span>Moved <b>${e.items.length}</b> product${e.items.length===1?'':'s'} to <b>${esc(e.toWh)} / ${esc(e.toSec)}</b> <span class="subtle">· ${fmtDate(e.at.slice(0,10))}</span></span><button class="btn btn-ghost btn-sm" data-mvundo="${e.id}">Undo</button></div>`;
}
