/* ============================================================================================
   Merge products
   Two entries for the same item (say "cheese spread 500 GM" and "cheese spread sandwich 500 GM")
   become one. Nothing is deleted: the other product is switched off and marked "merged into …",
   every name it was known by and every record that pointed at it moves to the kept product, and
   the whole merge is written to a log so it can be undone.
   ============================================================================================ */

/* records in these stores can hold a productId (also inside nested lines). Issued/cancelled invoices are
   a record of what was sent, so they keep the product they were issued with. */
const MERGE_REF_STORES = ['mappings','orders','orderItems','boxReceipts','productReceipts','receivingInvoices','batches','historyLines','invoices'];
const MERGE_FIELDS = [ // [field, label] — the ones worth showing when the two products disagree
  ['unit','Unit'], ['supplierId','Supplier'], ['warehouseId','Warehouse'], ['sectionId','Section'], ['packSize','Pack size'], ['packName','Pack name'],
  ['lowStockLimit','Low stock limit'], ['costPrice','Cost price'], ['sellPrice','Sell price'], ['productionDate','Production date'], ['expiryDate','Expiry date'], ['notes','Notes']];
const mgBlank = v=> v===''||v==null;
const mgSame  = (a,b)=> JSON.stringify(a??'')===JSON.stringify(b??'');

/* does the product say what size it is? (name and unit) */
function mgSizeOf(p){ return parseSize(p.name) || parseMeasure(p.unit); }
/* → [] when the two look like the same thing, otherwise short reasons for the warning */
function mgCompat(a, b){
  const why = [];
  const ua = normalize(a.unit), ub = normalize(b.unit);
  if(ua && ub && ua!==ub) why.push(`Different units: “${a.unit}” and “${b.unit}”.`);
  const sa = parseSize(a.name), sb = parseSize(b.name);
  if(sa && sb && !sameSize(sa, sb)) why.push(`Different sizes in the names: ${sa.text} and ${sb.text}.`);
  else if(!!sa !== !!sb) why.push(`Only one name states a size (${(sa||sb).text}).`);
  return why;
}

/* ---------------------------------- counting what would move ---------------------------------- */
async function mgFind(storeName, fromId){
  let rows = await getAll(storeName);
  if(storeName==='invoices') rows = rows.filter(r=>r.status==='draft');
  const out = [];
  for(const r of rows){ const hits = []; mgWalk(r, fromId, null, [], hits); if(hits.length) out.push({r, hits}); }
  return out;
}
/* walks any nested record; with `to` set it rewrites productId from→to, and always collects the paths it found */
function mgWalk(o, from, to, path, hits){
  if(!o || typeof o!=='object') return;
  for(const k of Object.keys(o)){
    const v = o[k];
    if(k==='productId' && v===from){ hits.push(path.concat(k)); if(to!=null) o[k] = to; }
    else if(v && typeof v==='object') mgWalk(v, from, to, path.concat(k), hits);
  }
}
function mgSet(o, path, value){ let x = o; for(let i=0;i<path.length-1;i++){ x = x?.[path[i]]; } if(x && path.length) x[path[path.length-1]] = value; }

async function mgCounts(dropId){
  const c = {}; let total = 0;
  for(const s of MERGE_REF_STORES){ const n = (await mgFind(s, dropId)).length; if(n){ c[s] = n; total += n; } }
  return {c, total};
}
const MG_LABELS = {mappings:'saved names', orders:'orders', orderItems:'order lines', boxReceipts:'box receipts', productReceipts:'deliveries', receivingInvoices:'delivery invoices', batches:'batches', historyLines:'past-order lines (Insights)', invoices:'draft invoices'};

/* ------------------------------------------ the merge ------------------------------------------ */
/* o = {name, pick:{field:'keep'|'other'}}.  Returns the log entry. */
async function mergeProducts(keepId, dropId, o){
  const keep = await getOne('products', keepId), drop = await getOne('products', dropId);
  if(!keep || !drop || keepId===dropId) throw new Error('Pick two different products.');
  const keepOrig = JSON.parse(JSON.stringify(keep)), dropOrig = JSON.parse(JSON.stringify(drop));
  const pick = o.pick || {};

  // 1) fields of the kept product
  for(const [f] of MERGE_FIELDS){
    const a = keep[f], b = drop[f];
    if(mgBlank(a) && !mgBlank(b)) keep[f] = b;                         // the kept one has nothing → take the other's
    else if(!mgBlank(b) && !mgSame(a,b) && pick[f]==='other') keep[f] = b;
  }
  if(pick.costPrice==='other' || (mgBlank(keepOrig.costPrice) && !mgBlank(drop.costPrice))){ keep.priceRef = drop.priceRef||keep.priceRef||null; }
  if(!keep.image && drop.image) keep.image = drop.image; else if(pick.image==='other' && drop.image) keep.image = drop.image;
  keep.priceHistory = [...(keep.priceHistory||[]), ...(drop.priceHistory||[]).map(h=>Object.assign({}, h, {from:(h.from?h.from+' · ':'')+'merged from '+drop.name}))].slice(-50);
  // stock: add up what is tracked. (Units were checked before the merge was allowed.)
  const ka = !mgBlank(keep.stockQty), da = !mgBlank(drop.stockQty);
  if(ka && da) keep.stockQty = (parseFloat(keep.stockQty)||0) + (parseFloat(drop.stockQty)||0);
  else if(da) keep.stockQty = drop.stockQty;
  keep.trackBatches = !!(keep.trackBatches || drop.trackBatches);
  if(o.name && o.name.trim()) keep.name = o.name.trim();
  keep.active = keep.active || drop.active;

  // 2) the other product: switched off, remembered as merged, no stock left on it
  drop.active = false; drop.mergedInto = keepId; drop.stockQty = ''; drop.trackBatches = false;

  // 3) move every reference
  const log = {id:'merge-'+Date.now(), at:new Date().toISOString(), keepId, dropId, keepName:keepOrig.name, dropName:dropOrig.name, newName:keep.name,
    keepBefore:{}, dropBefore:{}, changes:{}, addedMappings:[], undone:false};
  const diff = (before, after, orig)=>{ for(const k of new Set([...Object.keys(orig), ...Object.keys(after)])) if(!mgSame(orig[k], after[k])) before[k] = (k in orig) ? orig[k] : {__absent:true}; };
  diff(log.keepBefore, keep, keepOrig); diff(log.dropBefore, drop, dropOrig);

  for(const s of MERGE_REF_STORES){
    const found = await mgFind(s, dropId); if(!found.length) continue;
    const top = [], deep = [];
    for(const {r, hits} of found){
      for(const h of hits) mgSet(r, h, keepId);
      if(hits.length===1 && hits[0].length===1) top.push(r.id); else deep.push({id:r.id, paths:hits});
      if(s==='historyLines') r.synced = false;
    }
    if(s==='historyLines') await bulkPut(s, found.map(x=>x.r)); else for(const {r} of found) await put(s, r);
    log.changes[s] = {top, deep};
  }
  // 4) the other product's own name keeps working when an order uses it
  const norm = normalize(dropOrig.name), mappings = await getAll('mappings');
  if(norm && normalize(keep.name)!==norm && !mappings.some(m=>m.excelDescNormalized===norm)){
    const m = {id:uid(), excelDescNormalized:norm, label:dropOrig.name, productId:keepId};
    await put('mappings', m); log.addedMappings.push(m.id);
  }
  if(normalize(keepOrig.name)!==normalize(keep.name)){          // renamed → the old name of the kept product keeps working too
    const n2 = normalize(keepOrig.name);
    if(n2 && !mappings.some(m=>m.excelDescNormalized===n2) && n2!==norm){ const m = {id:uid(), excelDescNormalized:n2, label:keepOrig.name, productId:keepId}; await put('mappings', m); log.addedMappings.push(m.id); }
  }
  await put('products', keep); await put('products', drop);

  const store = await getOne('sharedSettings', 'mergeLog') || {id:'mergeLog', entries:[]};
  store.entries = [log, ...store.entries].slice(0, 30);
  await put('sharedSettings', store);
  return log;
}

async function undoMerge(logId){
  const store = await getOne('sharedSettings', 'mergeLog'); const log = store && store.entries.find(e=>e.id===logId);
  if(!log || log.undone) return;
  for(const s of Object.keys(log.changes)){
    const {top, deep} = log.changes[s];
    const rows = await getAll(s), byId = new Map(rows.map(r=>[r.id,r])), out = [];
    for(const id of top){ const r = byId.get(id); if(r){ r.productId = log.dropId; if(s==='historyLines') r.synced = false; out.push(r); } }
    for(const d of deep){ const r = byId.get(d.id); if(r){ d.paths.forEach(p=>mgSet(r, p, log.dropId)); if(s==='historyLines') r.synced = false; out.push(r); } }
    if(s==='historyLines') await bulkPut(s, out); else for(const r of out) await put(s, r);
  }
  for(const id of log.addedMappings) await del('mappings', id);
  const restore = async (id, before)=>{ const p = await getOne('products', id); if(!p) return; for(const k of Object.keys(before)){ if(before[k] && before[k].__absent) delete p[k]; else p[k] = before[k]; } await put('products', p); };
  await restore(log.keepId, log.keepBefore);
  const drop = await getOne('products', log.dropId);
  if(drop){ delete drop.mergedInto; await put('products', drop); }
  await restore(log.dropId, log.dropBefore);
  log.undone = true; await put('sharedSettings', store);
}

/* ------------------------------------ possible duplicates ------------------------------------ */
function mgTokens(name){
  const sz = parseSize(name); let t = String(name||'');
  if(sz) t = t.slice(0, sz.index) + ' ' + t.slice(sz.index + sz.text.length);
  return new Set(normalize(t).split(' ').filter(w=>w && !/^\d+$/.test(w) && w.length>1));
}
async function mgDuplicatePairs(products, mappings, ignored){
  const live = products.filter(p=>p.active!==false && !p.mergedInto);
  const idx = buildSuggestIndex(live, mappings);
  const info = live.map(p=>({p, t:mgTokens(p.name), s:parseSize(p.name)}));
  const out = [];
  for(let i=0;i<info.length;i++) for(let j=i+1;j<info.length;j++){
    const A = info[i], B = info[j];
    if(A.s && B.s && !sameSize(A.s, B.s)) continue;
    if(!A.t.size || !B.t.size) continue;
    const [small, big] = A.t.size<=B.t.size ? [A.t, B.t] : [B.t, A.t];
    let shared = 0; small.forEach(w=>{ if(big.has(w)) shared++; });
    if(shared < Math.max(1, Math.ceil(small.size*0.5))) continue;
    const subset = shared===small.size;
    const sim = nameAlike(A.p.name, B.p.name, idx);
    if(!(subset && (A.s||B.s ? true : sim>=0.6)) && sim<0.8) continue;
    const key = [A.p.id,B.p.id].sort().join('|');
    if(ignored.has(key)) continue;
    out.push({a:A.p, b:B.p, key, score: (subset?1:0) + sim, sameSize: !!(A.s && B.s)});
  }
  return out.sort((x,y)=>y.score-x.score).slice(0, 80);
}

route('duplicates', async ()=>{
  const [products, mappings, ig, logStore, whs] = await Promise.all([getAll('products'), getAll('mappings'), getOne('sharedSettings','mergeIgnore'), getOne('sharedSettings','mergeLog'), getAll('warehouses')]);
  const ignored = new Set((ig && ig.pairs) || []), whName = new Map(whs.map(w=>[w.id,w.name]));
  const pairs = await mgDuplicatePairs(products, mappings, ignored);
  const merged = ((logStore && logStore.entries) || []).filter(e=>!e.undone).slice(0,8);
  const card = p=>`<div style="flex:1; min-width:0;"><b>${esc(p.name)}</b><div class="subtle">${esc(p.unit||'no unit')} · ${esc(whName.get(p.warehouseId)||'no warehouse')}${mgBlank(p.stockQty)?'':' · stock '+esc(p.stockQty)}</div></div>`;
  $('#main').innerHTML = `
    <div class="topbar"><h1>Possible duplicates</h1><a href="#/products" class="btn btn-ghost btn-sm">← Products</a></div>
    <p class="subtle" style="margin-top:-8px;">Pairs of products with almost the same name and the same size — usually the same item from a different brand. Nothing changes until you open a pair and confirm the merge.</p>
    ${pairs.length ? `<div class="card" style="margin-bottom:22px;">${pairs.map(x=>`<div class="list-row mg-pair" data-k="${esc(x.key)}">
        ${card(x.a)}<span class="subtle" style="padding:0 6px;">≈</span>${card(x.b)}
        <a class="btn btn-signal btn-sm" href="#/merge/${x.a.id}/${x.b.id}">Merge…</a>
        <button class="btn btn-ghost btn-sm" data-notdup="${esc(x.key)}" title="Stop suggesting this pair">Not the same</button></div>`).join('')}</div>`
      : '<div class="empty"><div class="ic">✓</div>No likely duplicates found.</div>'}
    ${merged.length ? `<h3 class="section-title">Recent merges</h3><div class="card">${merged.map(e=>`<div class="list-row">
        <div style="flex:1; min-width:0;"><b>${esc(e.dropName)}</b> → <b>${esc(e.newName)}</b><div class="subtle">${fmtDate(e.at.slice(0,10))}</div></div>
        <button class="btn btn-ghost btn-sm" data-undo="${e.id}">Undo</button></div>`).join('')}</div>` : ''}`;
  $('#main').querySelectorAll('[data-notdup]').forEach(b=>b.onclick=async ()=>{
    const cur = await getOne('sharedSettings','mergeIgnore') || {id:'mergeIgnore', pairs:[]};
    if(!cur.pairs.includes(b.dataset.notdup)) cur.pairs.push(b.dataset.notdup);
    await put('sharedSettings', cur); b.closest('.mg-pair').remove();
  });
  $('#main').querySelectorAll('[data-undo]').forEach(b=>b.onclick=()=>showConfirm('Undo this merge? Names, past orders, batches and stock go back to the two separate products.', async ()=>{
    b.disabled = true; await undoMerge(b.dataset.undo); routes['duplicates']([]);
  }, {yesLabel:'Undo merge'}));
});

/* ------------------------------------------ the screen ------------------------------------------ */
route('merge', async ([keepId, dropId])=>{
  const [a, b, whs, sups] = await Promise.all([getOne('products', keepId), getOne('products', dropId), getAll('warehouses'), getAll('suppliers')]);
  if(!a || !b || a.id===b.id){ location.hash = '#/products'; return; }
  const nameOf = new Map([...whs, ...sups].map(x=>[x.id, x.name]));
  const show = (f, v)=> mgBlank(v) ? '<span class="subtle">—</span>' : esc(['warehouseId','supplierId'].includes(f) ? (nameOf.get(v)||v) : (f==='sectionId' ? '(section)' : v));
  const [counts, mappings] = await Promise.all([mgCounts(b.id), getAll('mappings')]);
  const why = mgCompat(a, b);
  const conflicts = MERGE_FIELDS.filter(([f])=> !mgBlank(a[f]) && !mgBlank(b[f]) && !mgSame(a[f], b[f]));
  const fills = MERGE_FIELDS.filter(([f])=> mgBlank(a[f]) && !mgBlank(b[f]));
  const bothStock = !mgBlank(a.stockQty) && !mgBlank(b.stockQty);
  const names = mappings.filter(m=>m.productId===b.id).map(m=>m.label||m.excelDescNormalized);
  const prod = (p, tag)=>`<div class="card mg-side"><div class="subtle">${tag}</div><b style="font-size:1.05rem;">${esc(p.name)}</b>
      <div class="subtle">${esc(p.unit||'no unit')}${mgBlank(p.stockQty)?' · stock not tracked':' · stock '+esc(p.stockQty)}</div></div>`;
  $('#main').innerHTML = `
    <div class="topbar"><h1>Merge products</h1><a href="#/duplicates" class="btn btn-ghost btn-sm">← Cancel</a></div>
    <div class="mg-grid">${prod(a,'KEEP')}<button class="btn btn-ghost btn-sm" id="mg_swap" title="Keep the other one instead">⇄ Swap</button>${prod(b,'MERGE IN (switched off afterwards)')}</div>
    ${why.length ? `<div class="card" style="border-color:var(--warn); margin:14px 0;"><b>⚠ These may not be the same thing</b>
      ${why.map(w=>`<div class="subtle">${esc(w)}</div>`).join('')}
      ${bothStock ? '<div class="subtle">Their stock would be added together, so only merge if the quantities are in the same measure.</div>' : ''}
      <label style="display:block; margin-top:8px;"><input type="checkbox" id="mg_ok" style="width:auto; margin-right:8px;">They are the same product — merge anyway</label></div>` : ''}
    <div class="field" style="margin-top:14px;"><label>Name after the merge</label><input type="text" id="mg_name" value="${esc(a.name)}"></div>
    <p class="subtle" style="margin-top:-6px;">Both names keep working: “${esc(b.name)}” and “${esc(a.name)}” are saved as names for the merged product${names.length?`, along with ${names.length} saved name${names.length===1?'':'s'} of the other one`:''}.</p>
    ${conflicts.length ? `<h3 class="section-title">Where they differ — choose</h3><div class="card">${conflicts.map(([f,l])=>`<div class="list-row" style="flex-wrap:wrap;">
      <b style="width:130px;">${l}</b>
      <label style="flex:1;"><input type="radio" name="mg_${f}" value="keep" checked style="width:auto; margin-right:6px;">${show(f,a[f])}</label>
      <label style="flex:1;"><input type="radio" name="mg_${f}" value="other" style="width:auto; margin-right:6px;">${show(f,b[f])}</label></div>`).join('')}</div>
      <p class="subtle">Prices are never combined or rounded — you pick one exactly as written.</p>` : ''}
    <h3 class="section-title">What will happen</h3>
    <div class="card"><ul style="margin:0; padding-left:18px; line-height:1.7;">
      ${Object.entries(counts.c).map(([s,n])=>`<li><b>${n}</b> ${MG_LABELS[s]||s} move to “${esc(a.name)}”</li>`).join('') || '<li>No orders or history use the other product.</li>'}
      ${bothStock ? `<li>Stock is added: ${esc(a.stockQty)} + ${esc(b.stockQty)}</li>` : (mgBlank(a.stockQty)&&!mgBlank(b.stockQty) ? `<li>Stock ${esc(b.stockQty)} moves over</li>` : '')}
      ${fills.length ? `<li>Filled in from the other product: ${fills.map(([,l])=>l.toLowerCase()).join(', ')}</li>` : ''}
      <li>Issued invoices keep the name they were issued with</li>
      <li>“${esc(b.name)}” is switched off, not deleted — and the merge can be undone</li>
    </ul></div>
    <div style="display:flex; gap:10px; margin-top:16px; max-width:420px;"><button class="btn btn-signal" id="mg_go" style="flex:1;" ${why.length?'disabled':''}>Merge</button><a class="btn btn-ghost" href="#/duplicates">Cancel</a></div>`;
  const ok = $('#mg_ok'); if(ok) ok.onchange = ()=>{ $('#mg_go').disabled = !ok.checked; };
  $('#mg_swap').onclick = ()=>{ location.hash = `#/merge/${b.id}/${a.id}`; };
  $('#mg_go').onclick = async ()=>{
    const pick = {}; conflicts.forEach(([f])=>{ const r = document.querySelector(`input[name="mg_${f}"]:checked`); pick[f] = r ? r.value : 'keep'; });
    const btn = $('#mg_go'); btn.disabled = true; btn.textContent = 'Merging…';
    try{ await mergeProducts(a.id, b.id, {name:$('#mg_name').value, pick}); }
    catch(err){ showAlert('The merge did not finish: '+(err.message||err)); btn.disabled = false; btn.textContent = 'Merge'; return; }
    showAlert(`Merged into “${$('#mg_name').value.trim()||a.name}”. You can undo it from Possible duplicates → Recent merges.`, 'Merged');
    location.hash = '#/products';
  };
});

/* picker used from a product row: choose which product to merge into this one */
async function openMergePicker(p){
  const all = (await getAll('products')).filter(x=>x.id!==p.id && x.active!==false && !x.mergedInto);
  const idx = buildSuggestIndex(all, []);
  const ranked = all.map(x=>({x, s:nameAlike(p.name, x.name, idx)})).sort((u,v)=>v.s-u.s);
  const draw = q=>{
    const nq = normalize(q);
    const rows = (nq ? ranked.filter(r=>normalize(r.x.name).includes(nq)) : ranked).slice(0, 12);
    $('#mgp_list').innerHTML = rows.map(r=>`<a class="list-row" style="text-decoration:none; color:inherit;" href="#/merge/${p.id}/${r.x.id}"><div style="flex:1;"><b>${esc(r.x.name)}</b><div class="subtle">${esc(r.x.unit||'no unit')}</div></div><span class="subtle">merge ›</span></a>`).join('') || '<p class="subtle">Nothing found.</p>';
  };
  showModal(`<h3>Merge into “${esc(p.name)}”</h3><p class="subtle">Pick the other product — it gets folded into this one. Most similar names first.</p>
    <input type="text" id="mgp_q" placeholder="Search products…" autofocus><div id="mgp_list" style="margin-top:10px; max-height:50vh; overflow:auto;"></div>
    <button class="btn btn-ghost" style="margin-top:10px;" onclick="closeModal()">Cancel</button>`);
  draw(''); $('#mgp_q').oninput = e=>draw(e.target.value);
  $('#mgp_list').onclick = e=>{ if(e.target.closest('a')) closeModal(); };
}
