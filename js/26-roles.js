/* ==================================== ROLES, PERMISSIONS & ACTIVITY ====================================
   Admins build their own roles by ticking exactly what each one may do, and give every account one role.
   - The admin flag lives in the account's app_metadata (role:'admin'); everyone else carries a role_id there
     that points at one role in the shared 'roles' store (see db/roles/README.md for the server side).
   - can('perm') is what the rest of the app asks. Admins can do everything.
   - Every change to the main stores is written to the Activity log (who, when, what), which syncs to the admin.
   The app hides what a person may not use; the database enforces the same rules (db/roles). ============ */

const PERM_GROUPS = [
  {g:'Products & stock', items:[
    ['products.view','See products','Open the Products page and see product details'],
    ['products.edit','Add & edit products','Create products and change their details'],
    ['products.delete','Delete products',''],
    ['stock.view','See stock quantities',''],
    ['stock.edit','Edit stock by hand','Change stock quantities directly (product form, Product Table). Picking and receiving still update stock as part of their own work.'],
    ['receiving','Receive deliveries','Warehouse management, receiving, batches'],
    ['merge','Merge duplicate products',''],
    ['move','Move products between locations',''],
    ['warehouses.edit','Edit warehouses & sections',''],
    ['suppliers.view','See suppliers',''],
    ['suppliers.edit','Add & edit suppliers','']]},
  {g:'Orders', items:[
    ['orders.view','See orders',''],
    ['orders.create','Create & edit orders',''],
    ['orders.pick','Pick orders',''],
    ['orders.delete','Delete orders',''],
    ['splitter','Order Splitter',''],
    ['qcheck','Quantity Check','']]},
  {g:'Money', items:[
    ['prices.sell','See sell prices','Products, Product Table, Excel export, invoices'],
    ['prices.cost','See cost prices and markup','Hidden from this person everywhere when not ticked, including Excel files'],
    ['prices.edit','Change prices',''],
    ['invoices.view','See invoices',''],
    ['invoices.edit','Create & edit invoices',''],
    ['invoices.issue','Issue invoices',''],
    ['invoices.delete','Delete invoices','']]},
  {g:'Reports', items:[
    ['reports.view','Insights & forecasts',''],
    ['history.view','Order history',''],
    ['activity.view','Activity log (who did what)','']]},
  {g:'Settings', items:[
    ['settings.edit','Company & app settings',''],
    ['backup','Backup & restore','']]}
];
const ALL_PERMS = PERM_GROUPS.flatMap(g=>g.items.map(i=>i[0]));
const PERM_LABEL = Object.fromEntries(PERM_GROUPS.flatMap(g=>g.items.map(i=>[i[0], i[1]])));
const ROLE_TEMPLATES = {
  'Manager': ALL_PERMS.filter(p=>p!=='backup'),
  'Picker': ['products.view','stock.view','orders.view','orders.create','orders.pick','splitter','qcheck','receiving','move','suppliers.view'],
  'Viewer': ['products.view','stock.view','orders.view','suppliers.view','history.view']
};
/* accounts made before roles existed (role "staff", no role_id) keep working as they did, minus the admin-only parts */
const LEGACY_STAFF_PERMS = ALL_PERMS.filter(p=>p!=='backup' && p!=='settings.edit');

/* which permission opens which page (any one of the listed is enough). Pages not listed are open to everyone signed in. */
const ROUTE_PERMS = {
  orders:['orders.view'], order:['orders.view'], history:['history.view'], splitter:['splitter'], qcheck:['qcheck'],
  products:['products.view'], productsetup:['products.edit'], table:['products.view'], warehouses:['products.view','warehouses.edit'], warehouse:['receiving','stock.view'],
  stock:['stock.view'], deliveries:['receiving'], boxtypes:['receiving'], receiving:['receiving'], batches:['receiving','stock.view'], reliability:['receiving','suppliers.view'],
  suppliers:['suppliers.view'], prices:['prices.view'], invoices:['invoices.view'], invoice:['invoices.view'],
  insights:['reports.view'], forecast:['reports.view'], duplicates:['merge'], merge:['merge'], mergemany:['merge'],
  activity:['activity.view'], mapcheck:['products.edit'], team:['__admin']
};
let MY_PERMS = null;           // Set of permission keys for a non-admin account; null = not loaded yet
function isFullAdmin(){ return !!(AUTH && AUTH.role==='admin'); }
function can(perm){
  if(!AUTH) return false;
  if(isFullAdmin()) return true;
  if(perm==='__admin') return false;
  if(perm==='prices.view') return can('prices.sell') || can('prices.cost');     // sees at least some price
  return !!(MY_PERMS && MY_PERMS.has(perm));
}
function canAny(list){ return list.some(can); }
function routeAllowed(key){ const need = ROUTE_PERMS[key]; return !need || canAny(need); }

/* roles saved before sell/cost were separate carry 'prices.view' = both */
const expandPerms = list=>{ const s = new Set(list); if(s.has('prices.view')){ s.add('prices.sell'); s.add('prices.cost'); } return s; };
const seesSell = ()=>can('prices.sell'), seesCost = ()=>can('prices.cost'), seesBothPrices = ()=>can('prices.sell') && can('prices.cost');
async function loadMyPerms(){
  try{ const cfg = await getSyncConfig(); ACTOR_NAME = (cfg && cfg.crewName) || ''; }catch(e){}
  if(!AUTH || isFullAdmin()){ MY_PERMS = null; return; }
  if(!AUTH.roleId){ MY_PERMS = expandPerms(LEGACY_STAFF_PERMS); return; }
  const r = await getOne('roles', AUTH.roleId);
  MY_PERMS = expandPerms(r && Array.isArray(r.perms) ? r.perms : []);
}
function applyNavPermissions(){
  document.querySelectorAll('.navlink').forEach(a=>{
    const key = (a.getAttribute('data-route')||'').replace('#/','') || 'home';
    a.style.display = routeAllowed(key) ? '' : 'none';
  });
  document.querySelectorAll('#sidebar .nav-label').forEach(l=>{
    let n = l.nextElementSibling, any = false;
    while(n && !n.classList.contains('nav-label') && !n.classList.contains('nav-foot')){ if(n.classList.contains('navlink') && n.style.display!=='none') any = true; n = n.nextElementSibling; }
    l.style.display = any ? '' : 'none';
  });
}
function noAccessHtml(){
  return `<div class="topbar"><h1>No access</h1></div><div class="empty"><div class="ic">🔒</div>Your account doesn't have permission to open this page.<div class="subtle" style="margin-top:8px;">Ask the admin if you need it.</div><p><a class="btn btn-ghost" href="#/">Back home</a></p></div>`;
}

/* a last line of defence for writes the screens should already have hidden (the database refuses them too).
   Writes that picking / receiving / moving do as part of their own work are never blocked here. */
const GUARD_PUT = {suppliers:['suppliers.edit','products.edit','receiving'], warehouses:['warehouses.edit'], sections:['warehouses.edit','move'], invoices:['invoices.edit','invoices.issue'], roles:['__admin']};
const GUARD_DEL = {products:['products.delete'], orders:['orders.delete'], invoices:['invoices.delete'], suppliers:['suppliers.edit'], warehouses:['warehouses.edit'], sections:['warehouses.edit','move'], roles:['__admin']};
function permGuard(store, prev, next){
  if(!AUTH || isFullAdmin() || MY_PERMS===null) return;
  const need = (next ? GUARD_PUT : GUARD_DEL)[store];
  if(need && !canAny(need)) throw new Error("Your account doesn't have permission to do that.");
}
/* re-read my role after a sync: a changed role (or the role list arriving for the first time) takes effect without a reload */
async function refreshPerms(){
  const before = MY_PERMS ? [...MY_PERMS].sort().join() : '';
  await loadMyPerms();
  const after = MY_PERMS ? [...MY_PERMS].sort().join() : '';
  if(before!==after){ if(typeof PRICES_SPLIT!=='undefined' && PRICES_SPLIT) await applyAllStashedPrices(); applyNavPermissions(); if(typeof render==='function') render(); }
}

/* the product form: prices hidden without "see prices"; fields locked unless the role may change them */
function applyProductFormPerms(){
  const priceIds = ['f_cost','f_markup','f_sell','f_refq','f_refu'], stockIds = ['f_stockqty','f_stocklimit'];
  const box = document.querySelector('.pr-box'), saveBtn = document.getElementById('f_save'); if(!saveBtn) return;
  const fields = [...document.querySelectorAll('#f_name, input[id^="f_"], select[id^="f_"], textarea[id^="f_"]')].filter(el=>el.id!=='f_save' && el.id!=='f_cancel');
  const pe = can('products.edit'), se = can('stock.edit'), pre = can('prices.edit');
  const hide = id=>{ const el = document.getElementById(id); const w = el && el.closest('.field'); if(w) w.style.display = 'none'; };
  if(!seesCost()){ hide('f_cost'); hide('f_markup'); }
  if(!seesSell()) hide('f_sell');
  fields.forEach(el=>{
    const ok = priceIds.includes(el.id) ? (can('prices.edit') && seesBothPrices()) : stockIds.includes(el.id) ? se : pe;
    if(!ok){ el.disabled = true; }
  });
  if(box && !can('prices.view')) box.style.display = 'none';
  if(!(pe || se || (pre && seesBothPrices()))) saveBtn.style.display = 'none';
}

/* ------------------------------------ activity log ------------------------------------ */
let ACTOR_NAME = '', AUDIT_ON = false;   // switched on once the app has started, so start-up housekeeping isn't logged as someone's work
const actorName = ()=> ACTOR_NAME || (AUTH && AUTH.email ? AUTH.email.split('@')[0] : '') || 'this device';
const AUDITED = new Set(['products','orders','invoices','productReceipts','boxReceipts','receivingInvoices','batches','suppliers','warehouses','sections','roles','mappings']);
const AUD_TRACK = {stockQty:'stock', costPrice:'price', sellPrice:'price', priceRef:'price', lowStockLimit:'edit', supplierId:'edit', name:'edit', unit:'edit', active:'edit', packSize:'edit', warehouseId:'move', sectionId:'move'};
const AUD_FIELD = {stockQty:'Stock', costPrice:'Cost price', sellPrice:'Sell price', priceRef:'Prices are for', lowStockLimit:'Low-stock limit', supplierId:'Supplier', name:'Name', unit:'Unit', active:'Active', packSize:'Pack size', warehouseId:'Warehouse', sectionId:'Section'};
const audShow = v => v==null||v==='' ? '—' : (typeof v==='object' ? (v.qty ? `${v.qty} ${v.unit||''}`.trim() : '—') : String(v));
function orderLabel(o){ return [o.vessel, o.orderNumber && ('#'+o.orderNumber)].filter(Boolean).join(' ') || 'order'; }
async function auditChange(store, prev, next){
  if(!AUDIT_ON) return;
  const here = (location.hash||'#/').split('/')[1] || 'home';
  const base = {id:'ac-'+uid(), at:new Date().toISOString(), by:actorName(), email:(AUTH&&AUTH.email)||'', store, page:here};
  const log = async e=>{ try{ await put('activity', Object.assign(base, e, {id:'ac-'+uid()})); }catch(_){} };
  const cur = next || prev, tid = cur.id;
  if(store==='products'){
    if(!prev) return log({kind:'add', target:cur.name, tid, text:`Added product “${cur.name}”`});
    if(!next) return log({kind:'delete', target:cur.name, tid, text:`Deleted product “${cur.name}”`});
    const ch = [], kinds = new Set();
    for(const f of Object.keys(AUD_TRACK)){ if(JSON.stringify(prev[f]??'')!==JSON.stringify(next[f]??'')){ ch.push({f, from:prev[f]??'', to:next[f]??''}); kinds.add(AUD_TRACK[f]); } }
    if(!ch.length) return;
    const money = ch.some(c=>AUD_TRACK[c.f]==='price');
    const kind = kinds.has('stock') ? 'stock' : kinds.has('price') ? 'price' : kinds.has('move') ? 'move' : 'edit';
    return log({kind, kinds:[...kinds], target:next.name, tid, money, changes:ch, text:`${next.name}: ${ch.map(c=>AUD_TRACK[c.f]==='price' ? `${AUD_FIELD[c.f]} changed` : `${AUD_FIELD[c.f]} ${c.f==='supplierId'||c.f==='warehouseId'||c.f==='sectionId'?'changed':audShow(c.from)+' → '+audShow(c.to)}`).join(' · ')}`});
  }
  if(store==='orders'){
    if(!prev) return log({kind:'order', target:orderLabel(next), tid, text:`Created order ${orderLabel(next)}`});
    if(!next) return log({kind:'delete', target:orderLabel(prev), tid, text:`Deleted order ${orderLabel(prev)}`});
    if(prev.status!==next.status) return log({kind:'order', target:orderLabel(next), tid, text:`Order ${orderLabel(next)}: ${prev.status||'—'} → ${next.status||'—'}`});
    return;
  }
  if(store==='invoices'){
    const lab = c=>`invoice ${c.number||'(draft)'}${c.vessel?' · '+c.vessel:''}`;
    if(!prev) return log({kind:'invoice', target:lab(next), tid, text:`Created ${lab(next)}`});
    if(!next) return log({kind:'delete', target:lab(prev), tid, text:`Deleted ${lab(prev)}`});
    if(prev.status!==next.status) return log({kind:'invoice', target:lab(next), tid, text:`${lab(next)}: ${prev.status||'—'} → ${next.status||'—'}`});
    return;
  }
  if(store==='productReceipts' || store==='boxReceipts' || store==='receivingInvoices'){
    const what = store==='receivingInvoices' ? 'a delivery invoice' : store==='boxReceipts' ? 'a box receipt' : 'a product receipt';
    if(!prev) return log({kind:'receive', target:what, tid, text:`Recorded ${what}${cur.invoiceNo?' '+cur.invoiceNo:''}`});
    if(!next) return log({kind:'delete', target:what, tid, text:`Deleted ${what}`});
    return;
  }
  if(store==='batches'){
    const lab = `batch ${cur.batchNo||cur.batchNumber||''}`.trim();
    if(!prev) return log({kind:'receive', target:lab, tid, text:`Added ${lab}${cur.qty!=null?' ('+cur.qty+')':''}`});
    if(!next) return log({kind:'delete', target:lab, tid, text:`Deleted ${lab}`});
    if(String(prev.qty)!==String(next.qty)) return log({kind:'stock', target:lab, tid, text:`${lab}: ${audShow(prev.qty)} → ${audShow(next.qty)}`});
    return;
  }
  if(store==='mappings'){
    if(!prev) return log({kind:'setup', target:cur.label||'', tid, text:`Mapped “${cur.label||''}” → ${cur.productName||'a product'}`});
    if(!next) return log({kind:'delete', target:cur.label||'', tid, text:`Removed mapping “${cur.label||''}”`});
    if(prev.productId!==next.productId) return log({kind:'setup', target:next.label||'', tid, text:`Changed mapping “${next.label||''}” to another product`});
    return;
  }
  const noun = {suppliers:'supplier', warehouses:'warehouse', sections:'section', roles:'role'}[store];
  const nm = c=>c.name||'';
  if(!prev) return log({kind:'setup', target:nm(cur), tid, text:`Added ${noun} “${nm(cur)}”`});
  if(!next) return log({kind:'delete', target:nm(cur), tid, text:`Deleted ${noun} “${nm(cur)}”`});
  if(nm(prev)!==nm(next)) return log({kind:'setup', target:nm(next), tid, text:`Renamed ${noun} “${nm(prev)}” → “${nm(next)}”`});
  if(store==='roles' && JSON.stringify(prev.perms)!==JSON.stringify(next.perms)) return log({kind:'setup', target:nm(next), tid, text:`Changed what the role “${nm(next)}” can do`});
}

/* --------------------------------------- Activity page --------------------------------------- */
const ACT_KINDS = [['','Everything'],['stock','Stock'],['price','Prices'],['receive','Receiving'],['order','Orders'],['invoice','Invoices'],['add','Added'],['delete','Deleted'],['move','Moved'],['edit','Edits'],['setup','Setup']];
route('activity', async ()=>{
  const all = (await getAll('activity')).sort((a,b)=>a.at<b.at?1:-1);
  const people = [...new Set(all.map(a=>a.by).filter(Boolean))].sort();
  let kind = '', who = '', q = '', shown = 150;
  const showMoney = seesBothPrices();
  $('#main').innerHTML = `<div class="topbar"><h1>Activity</h1></div>
    <p class="subtle" style="margin-top:-8px;">Who did what, newest first. Everything that changes stock, prices, products, orders, invoices and setup is recorded here with the person's name.</p>
    <div class="pt-tools"><input type="search" id="ac_q" placeholder="Search products, orders…" autocomplete="off"><select id="ac_who"><option value="">Everyone</option>${people.map(p=>`<option>${esc(p)}</option>`).join('')}</select></div>
    <div class="tag-row" id="ac_kinds">${ACT_KINDS.map(([k,l])=>`<button class="chip ${k===''?'active':''}" data-k="${k}">${l}</button>`).join('')}</div>
    <div id="ac_list"></div>`;
  const rowText = a=>{
    if(a.money && !showMoney && a.changes){ return esc(a.target+': '+a.changes.map(c=>AUD_TRACK[c.f]==='price' ? AUD_FIELD[c.f]+' changed' : AUD_FIELD[c.f]+' '+audShow(c.from)+' → '+audShow(c.to)).join(' · ')); }
    if(a.money && showMoney && a.changes){ return esc(a.target+': '+a.changes.map(c=>AUD_TRACK[c.f]==='price' ? `${AUD_FIELD[c.f]} ${audShow(c.from)} → ${audShow(c.to)}` : (c.f==='supplierId'||c.f==='warehouseId'||c.f==='sectionId') ? AUD_FIELD[c.f]+' changed' : `${AUD_FIELD[c.f]} ${audShow(c.from)} → ${audShow(c.to)}`).join(' · ')); }
    return esc(a.text||'');
  };
  function draw(){
    const nq = normalize(q);
    const list = all.filter(a=>(!kind || a.kind===kind || (a.kinds||[]).includes(kind)) && (!who || a.by===who) && (!nq || normalize((a.text||'')+' '+(a.target||'')).includes(nq)));
    const rows = list.slice(0, shown); let lastDay = '';
    $('#ac_list').innerHTML = rows.length ? rows.map(a=>{
      const day = a.at.slice(0,10), head = day!==lastDay ? `<div class="subtle" style="margin:14px 2px 4px; font-weight:700;">${fmtDate(day)}</div>` : ''; lastDay = day;
      const t = new Date(a.at).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});
      return `${head}<div class="card" style="padding:10px 12px; margin-bottom:6px;"><div style="display:flex; gap:8px; align-items:baseline;"><b>${esc(a.by||'?')}</b><span class="subtle">${t}${a.page?' · '+esc(a.page):''}</span></div><div>${rowText(a)}</div></div>`;
    }).join('') + (list.length>shown ? `<button class="btn btn-ghost" id="ac_more" style="width:100%;">Show more (${list.length-shown} older)</button>` : '') : `<div class="empty"><div class="ic">◔</div>Nothing recorded yet.</div>`;
    const more = $('#ac_more'); if(more) more.onclick = ()=>{ shown += 150; draw(); };
  }
  $('#ac_q').oninput = e=>{ q = e.target.value; shown = 150; draw(); };
  $('#ac_who').onchange = e=>{ who = e.target.value; shown = 150; draw(); };
  $('#ac_kinds').onclick = e=>{ const b = e.target.closest('[data-k]'); if(!b) return; kind = b.dataset.k; shown = 150; document.querySelectorAll('#ac_kinds .chip').forEach(c=>c.classList.toggle('active', c===b)); draw(); };
  draw();
});

/* ----------------------------------------- Team page ----------------------------------------- */
async function teamCall(action, payload){
  const cfg = await getSyncConfig(); if(!cfg || !cfg.url) throw new Error('Sync is not set up on this device.');
  const res = await fetch(authBaseUrl(cfg)+'/functions/v1/team-admin', {method:'POST', headers:syncHeaders(cfg), body:JSON.stringify(Object.assign({action}, payload||{}))});
  let body = null; try{ body = await res.json(); }catch(e){}
  if(!res.ok) { const err = new Error((body && body.error) || ('HTTP '+res.status)); err.status = res.status; throw err; }
  return body;
}
function permPickerHtml(sel){
  return PERM_GROUPS.map(g=>`<div class="rl-group"><div style="display:flex; align-items:center; gap:8px; margin:12px 0 4px;"><b style="flex:1;">${g.g}</b><button type="button" class="btn btn-ghost btn-sm" data-grp="${g.g}">Select all</button></div>
    ${g.items.map(([k,l,d])=>`<label class="lk-sw" style="align-items:flex-start;"><input type="checkbox" data-perm="${k}" data-g="${g.g}" ${sel.has(k)?'checked':''}><span>${l}${d?`<span class="subtle" style="display:block; font-weight:400;">${d}</span>`:''}</span></label>`).join('')}</div>`).join('');
}
route('team', async ()=>{
  if(!isFullAdmin()){ $('#main').innerHTML = noAccessHtml(); return; }
  const roles = (await getAll('roles')).sort((a,b)=>a.name.localeCompare(b.name));
  $('#main').innerHTML = `<div class="topbar"><h1>Team</h1></div>
    <p class="subtle" style="margin-top:-8px;">Make your own roles by ticking what each may do, then give every person one role. The app hides what a role can't use, and the database refuses it too.</p>
    <div class="card"><div class="section-title" style="display:flex; align-items:center;"><span style="flex:1;">Roles</span><button class="btn btn-signal btn-sm" id="rl_new">+ New role</button></div>
      <div id="rl_list">${roles.length ? roles.map(r=>`<div class="rl-row" style="display:flex; gap:8px; align-items:center; padding:10px 0; border-bottom:1px solid var(--line,#eee);"><div style="flex:1;"><b>${esc(r.name)}</b><div class="subtle">${(r.perms||[]).length} of ${ALL_PERMS.length} permissions</div></div><button class="btn btn-ghost btn-sm" data-edit="${r.id}">Edit</button><button class="btn btn-ghost btn-sm" data-del="${r.id}">Delete</button></div>`).join('') : '<p class="subtle">No roles yet. Create the first one, or start from a template (Manager, Picker, Viewer).</p>'}</div></div>
    <div class="card" style="margin-top:16px;"><div class="section-title" style="display:flex; align-items:center;"><span style="flex:1;">People</span><button class="btn btn-signal btn-sm" id="tm_new">+ Add person</button></div><div id="tm_list"><p class="subtle">Loading…</p></div></div>`;
  function editRole(r){
    const isNew = !r; r = r || {id:uid(), name:'', perms:[]};
    showModal(`<h3>${isNew?'New role':'Edit role'}</h3>
      <div class="field"><label>Role name</label><input type="text" id="rl_name" placeholder="e.g. Receiving, Invoices, Reports" value="${esc(r.name)}"></div>
      ${isNew ? `<div class="field"><label>Start from</label><select id="rl_tpl"><option value="">Nothing ticked</option>${Object.keys(ROLE_TEMPLATES).map(t=>`<option>${t}</option>`).join('')}</select></div>` : ''}
      <div id="rl_perms" style="max-height:48vh; overflow:auto; padding-right:4px;">${permPickerHtml(expandPerms(r.perms))}</div>
      <div style="display:flex; gap:10px; margin-top:12px;"><button class="btn btn-signal" id="rl_save" style="flex:1;">Save role</button><button class="btn btn-ghost" onclick="closeModal()">Cancel</button></div>`);
    const boxes = ()=>[...document.querySelectorAll('[data-perm]')];
    if($('#rl_tpl')) $('#rl_tpl').onchange = e=>{ const set = new Set(ROLE_TEMPLATES[e.target.value]||[]); boxes().forEach(b=>b.checked = set.has(b.dataset.perm)); if(e.target.value && !$('#rl_name').value) $('#rl_name').value = e.target.value; };
    document.querySelectorAll('[data-grp]').forEach(b=>b.onclick = ()=>{ const g = boxes().filter(x=>x.dataset.g===b.dataset.grp), all = g.every(x=>x.checked); g.forEach(x=>x.checked = !all); b.textContent = all ? 'Select all' : 'Clear'; });
    $('#rl_save').onclick = async ()=>{
      const name = $('#rl_name').value.trim(); if(!name){ showAlert('Give the role a name.'); return; }
      if(roles.some(x=>x.id!==r.id && x.name.toLowerCase()===name.toLowerCase())){ showAlert('There is already a role with that name.'); return; }
      await put('roles', Object.assign({}, r, {name, perms: boxes().filter(b=>b.checked).map(b=>b.dataset.perm)}));
      closeModal(); routes.team([]);
    };
  }
  $('#rl_new').onclick = ()=>editRole(null);
  $('#rl_list').onclick = e=>{
    const ed = e.target.closest('[data-edit]'), dl = e.target.closest('[data-del]');
    if(ed) editRole(roles.find(r=>r.id===ed.dataset.edit));
    if(dl){ const r = roles.find(x=>x.id===dl.dataset.del); showConfirm(`Delete the role “${r.name}”? People who have it will lose all access until you give them another role.`, async ()=>{ await del('roles', r.id); routes.team([]); }, {yesLabel:'Delete'}); }
  };
  /* people — talks to the admin-only server function (db/roles/team-admin) */
  const list = $('#tm_list');
  async function loadPeople(){
    try{
      const r = await teamCall('list'); const users = r.users || [];
      list.innerHTML = users.length ? users.map(u=>`<div style="display:flex; gap:8px; align-items:center; padding:10px 0; border-bottom:1px solid var(--line,#eee); flex-wrap:wrap;"><div style="flex:1; min-width:160px;"><b>${esc(u.email)}</b><div class="subtle">${u.role==='admin'?'Admin':(roles.find(x=>x.id===u.role_id)?'':'No role yet')}</div></div>
        ${u.role==='admin' ? '<span class="badge">Admin</span>' : `<select data-user="${u.id}" style="width:auto;"><option value="">— no role —</option>${roles.map(x=>`<option value="${x.id}" ${x.id===u.role_id?'selected':''}>${esc(x.name)}</option>`).join('')}</select>`}
        ${u.role==='admin' || u.email===AUTH.email ? '' : `<button class="btn btn-ghost btn-sm" data-pw="${u.id}">New password</button><button class="btn btn-ghost btn-sm" data-rm="${u.id}" data-em="${esc(u.email)}">Remove</button>`}</div>`).join('') : '<p class="subtle">No accounts yet.</p>';
    }catch(err){
      list.innerHTML = `<p class="subtle">${err.status===404 ? 'The server function for managing people is not set up yet — see <b>db/roles/README.md</b>. Roles can still be created above.' : 'Could not load people: '+esc(err.message)}</p>`;
    }
  }
  list.onchange = async e=>{ const s = e.target.closest('[data-user]'); if(!s) return; try{ await teamCall('setRole', {user_id:s.dataset.user, role_id:s.value}); showAlert('Role changed. It applies to that person the next time their app refreshes its login (within about an hour, or when they sign in again).', 'Saved'); }catch(err){ showAlert(err.message); } };
  list.onclick = e=>{
    const rm = e.target.closest('[data-rm]'), pw = e.target.closest('[data-pw]');
    if(rm) showConfirm(`Remove ${rm.dataset.em}? They will no longer be able to sign in.`, async ()=>{ try{ await teamCall('remove', {user_id:rm.dataset.rm}); loadPeople(); }catch(err){ showAlert(err.message); } }, {yesLabel:'Remove'});
    if(pw){ showModal(`<h3>New password</h3><div class="field"><label>Password (at least 8 characters)</label><input type="text" id="tm_pw" autocomplete="off"></div><div style="display:flex; gap:10px;"><button class="btn btn-signal" id="tm_pw_go" style="flex:1;">Set password</button><button class="btn btn-ghost" onclick="closeModal()">Cancel</button></div>`);
      $('#tm_pw_go').onclick = async ()=>{ const v = $('#tm_pw').value; if(v.length<8){ showAlert('Use at least 8 characters.'); return; } try{ await teamCall('setPassword', {user_id:pw.dataset.pw, password:v}); closeModal(); showAlert('Password changed. Tell the person privately.', 'Done'); }catch(err){ showAlert(err.message); } }; }
  };
  $('#tm_new').onclick = ()=>{
    showModal(`<h3>Add a person</h3><div class="field"><label>Email</label><input type="email" id="tm_email" autocomplete="off"></div>
      <div class="field"><label>Password (at least 8 characters — they can't pick their own, so tell them privately)</label><input type="text" id="tm_pass" autocomplete="off"></div>
      <div class="field"><label>Role</label><select id="tm_role"><option value="">— choose —</option>${roles.map(x=>`<option value="${x.id}">${esc(x.name)}</option>`).join('')}</select></div>
      <div style="display:flex; gap:10px;"><button class="btn btn-signal" id="tm_go" style="flex:1;">Create account</button><button class="btn btn-ghost" onclick="closeModal()">Cancel</button></div>`);
    $('#tm_go').onclick = async ()=>{
      const email = $('#tm_email').value.trim(), password = $('#tm_pass').value, role_id = $('#tm_role').value;
      if(!/^\S+@\S+\.\S+$/.test(email)){ showAlert('Type a valid email.'); return; } if(password.length<8){ showAlert('Use at least 8 characters.'); return; } if(!role_id){ showAlert('Choose a role.'); return; }
      try{ await teamCall('create', {email, password, role_id}); closeModal(); loadPeople(); }catch(err){ showAlert(err.message); }
    };
  };
  loadPeople();
});
