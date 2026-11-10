/* ---------- Mapping safety ----------
   A "mapping" teaches the app that a sheet's wording (e.g. "basmati rice") means one of your products.
   A wrong one silently corrupts picking, stock and invoices, so every mapping can be checked here,
   and doubtful ones are flagged wherever they are used. */
const MAP_STOP = new Set(['the','and','with','for','of','in','pcs','pc','pkt','pack','box','btl','tin','can','kg','gm','gms','ltr','ml','nos']);
function mapWords(s){
  return normalize(s).split(' ').filter(w=>w.length>=3 && !/^\d+$/.test(w) && !MAP_STOP.has(w));
}
function mapWordsMatch(a, b){
  if(a===b) return true;
  const s = a.length<b.length ? a : b, l = a.length<b.length ? b : a;
  if(s.length>=4 && l.startsWith(s)) return true;          // rice / rices, mayo / mayonnaise
  return a.length>=4 && b.length>=4 && levRatio(a,b)>=0.8;  // small spelling slips
}
/* level 0 = fine, 1 = look twice, 2 = very different */
function mapRisk(sheetName, productName){
  const a = mapWords(sheetName), b = mapWords(productName);
  if(!normalize(sheetName) || !normalize(productName)) return {level:0, reason:'', score:1};
  const score = similarity(sheetName, productName);
  if(a.length && b.length){
    const shared = a.filter(w=>b.some(x=>mapWordsMatch(w,x))).length;
    if(shared===0) return {level:2, reason:'No word in common', score};
    if(shared===a.length && !(parseSize(String(sheetName||'')) && parseSize(String(productName||'')))) return {level:0, reason:'', score};   // every word of the sheet name is in the product name
  }
  const sa = parseSize(String(sheetName||'')), sb = parseSize(String(productName||''));
  if(sa && sb && sa.family===sb.family && Dec.cmp(sa.base, sb.base)!==0) return {level:1, reason:`Different size (${sa.text} vs ${sb.text})`, score};
  if(score<0.3) return {level:1, reason:'Names look quite different', score};
  return {level:0, reason:'', score};
}
function mapStamp(rec){
  if(!rec.createdAt){ rec.createdAt = new Date().toISOString(); rec.createdBy = (typeof actorName==='function' ? actorName() : '') || ''; }
  return rec;
}
/* saves a mapping; when the two names look nothing alike asks first. done(saved:boolean) */
async function saveMappingSafe(rec, productName, done){
  mapStamp(rec);
  const r = mapRisk(rec.label, productName);
  const go = async ()=>{ await put('mappings', rec); if(done) done(true); };
  if(r.level<2){ await go(); return; }
  showModal(`<h3>These look very different</h3>
    <p>“<b>${esc(rec.label)}</b>” would always be treated as “<b>${esc(productName)}</b>” — in picking, stock and invoices.</p>
    <p class="subtle">${esc(r.reason)}. A wrong match here ends up on an invoice. Are you sure?</p>
    <div style="display:flex; gap:10px; margin-top:16px;"><button class="btn btn-danger" id="mr_yes" style="flex:1;">Yes, they are the same</button><button class="btn btn-ghost" id="mr_no">No, don't save</button></div>`);
  $('#mr_yes').onclick = async ()=>{ closeModal(); await go(); };
  $('#mr_no').onclick = ()=>{ closeModal(); if(done) done(false); };
}
/* small search-and-pick dialog over the products */
async function pickProductDialog(title, onPick){
  const products = (await getAll('products')).filter(p=>p.active!==false);
  showModal(`<h3>${esc(title)}</h3><input type="search" id="pp_q" placeholder="Search products…" autocomplete="off" autofocus><div id="pp_list" style="max-height:50vh; overflow:auto; margin-top:10px;"></div><button class="btn btn-ghost" id="pp_x" style="width:100%; margin-top:10px;">Cancel</button>`);
  const draw = ()=>{
    const q = normalize($('#pp_q').value);
    const list = (q ? products.filter(p=>normalize(p.name).includes(q)) : products).sort((a,b)=>a.name.localeCompare(b.name)).slice(0,40);
    $('#pp_list').innerHTML = list.map(p=>`<div class="list-row" data-pp="${p.id}" style="cursor:pointer;"><div style="flex:1;"><b>${esc(p.name)}</b><div class="subtle">${esc(p.unit||'')}</div></div></div>`).join('') || '<p class="subtle">No products match.</p>';
    $('#pp_list').querySelectorAll('[data-pp]').forEach(r=>r.onclick=()=>{ const p = products.find(x=>x.id===r.dataset.pp); closeModal(); onPick(p); });
  };
  $('#pp_q').oninput = draw; $('#pp_x').onclick = closeModal; draw();
}

route('mapcheck', async ()=>{
  let [maps, products] = await Promise.all([getAll('mappings'), getAll('products')]);
  const byId = new Map(products.map(p=>[p.id,p]));
  let view = 'doubt', q = '', shown = 60;
  $('#main').innerHTML = `<div class="topbar"><h1>Check mappings</h1></div>
    <p class="subtle" style="margin-top:-8px;">Each line says “when a sheet says <i>this</i>, treat it as <i>that product</i>”. A wrong one ends up in picking, stock and invoices — the most different ones are shown first.</p>
    <div class="pt-tools"><input type="search" id="mc_q" placeholder="Search sheet names or products…" autocomplete="off"></div>
    <div class="tag-row" id="mc_tabs"></div><div id="mc_list"></div>`;
  const rows = ()=>maps.map(m=>{ const p = byId.get(m.productId); const r = p ? mapRisk(m.label||m.excelDescNormalized, p.name) : {level:2, reason:'Product no longer exists', score:0}; return {m, p, r}; })
    .sort((a,b)=>b.r.level-a.r.level || a.r.score-b.r.score);
  function draw(){
    const all = rows(), nq = normalize(q);
    const doubt = all.filter(x=>x.r.level>0 && !x.m.reviewedAt), done = all.filter(x=>x.m.reviewedAt);
    $('#mc_tabs').innerHTML = [['doubt',`Doubtful (${doubt.length})`],['all',`All (${all.length})`],['ok',`Kept (${done.length})`]].map(([k,l])=>`<button class="chip ${view===k?'active':''}" data-v="${k}">${l}</button>`).join('');
    $('#mc_tabs').querySelectorAll('[data-v]').forEach(b=>b.onclick=()=>{ view=b.dataset.v; shown=60; draw(); });
    let list = view==='doubt' ? doubt : view==='ok' ? done : all;
    if(nq) list = list.filter(x=>normalize((x.m.label||'')+' '+(x.p?x.p.name:'')).includes(nq));
    const part = list.slice(0, shown);
    $('#mc_list').innerHTML = part.length ? part.map(({m,p,r})=>`<div class="card" style="padding:10px 12px; margin-bottom:8px;">
        <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;"><b>${esc(m.label||m.excelDescNormalized)}</b><span class="subtle">→</span><b>${p?esc(p.name):'—'}</b></div>
        ${r.level? `<div class="pr-warn">⚠ ${esc(r.reason)}</div>`:''}
        <div class="subtle" style="font-size:12px; margin-top:2px;">${m.createdAt?`Added ${esc(fmtDate(m.createdAt.slice(0,10)))}${m.createdBy?' by '+esc(m.createdBy):''}`:'Added: unknown'}${m.reviewedAt?` · kept by ${esc(m.reviewedBy||'someone')}`:''}</div>
        <div style="display:flex; gap:8px; margin-top:8px; flex-wrap:wrap;"><button class="btn btn-ghost btn-sm" data-k="${m.id}">Keep</button><button class="btn btn-ghost btn-sm" data-c="${m.id}">Change product</button><button class="btn btn-ghost btn-sm" data-r="${m.id}" style="color:var(--danger);">Remove</button></div></div>`).join('')
        + (list.length>shown ? `<button class="btn btn-ghost" id="mc_more" style="width:100%;">Show more (${list.length-shown})</button>` : '')
      : `<div class="empty"><div class="ic">✓</div><p>${view==='doubt'?'No doubtful mappings.':'Nothing to show.'}</p></div>`;
    const L = $('#mc_list'), find = id=>maps.find(m=>m.id===id);
    L.querySelectorAll('[data-k]').forEach(b=>b.onclick=async ()=>{ const m = find(b.dataset.k); m.reviewedAt = new Date().toISOString(); m.reviewedBy = actorName(); await put('mappings', m); draw(); });
    L.querySelectorAll('[data-r]').forEach(b=>b.onclick=()=>{ const m = find(b.dataset.r); showConfirm(`Remove “${m.label}”? Next time that wording will need to be matched again.`, async ()=>{ await del('mappings', m.id); maps = maps.filter(x=>x.id!==m.id); draw(); }, {danger:true, yesLabel:'Remove'}); });
    L.querySelectorAll('[data-c]').forEach(b=>b.onclick=()=>{ const m = find(b.dataset.c); pickProductDialog(`“${m.label}” is really…`, p=>{
      saveMappingSafe(Object.assign({}, m, {productId:p.id, reviewedAt:new Date().toISOString(), reviewedBy:actorName()}), p.name, async ok=>{ if(ok){ maps = await getAll('mappings'); } draw(); });
    }); });
    const more = $('#mc_more'); if(more) more.onclick = ()=>{ shown += 60; draw(); };
  }
  let t; $('#mc_q').oninput = ()=>{ clearTimeout(t); t = setTimeout(()=>{ q = $('#mc_q').value; shown = 60; draw(); }, 150); };
  draw();
});
