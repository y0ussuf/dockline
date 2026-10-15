/* ==================================== LOGIN (Supabase Auth) ====================================
   Real per-person accounts, replacing the old shared-password screen. Nobody can sign themselves
   up from inside this app — accounts only exist because an admin created them from the Supabase
   dashboard (Authentication → Users → Add user), so "who's allowed in" is controlled entirely
   there, same spirit as before but for real this time.

   Role (admin vs staff) lives in that Supabase user's app_metadata — deliberately NOT in
   user_metadata, because user_metadata can be changed by the signed-in user themselves through
   the API, which would let a staff account quietly promote itself. app_metadata can only be
   changed by an admin from the Supabase dashboard, so a staff account can never touch its own
   role. Set it there as: {"role": "admin"} — anyone without that is treated as regular staff.

   The session (access token + refresh token) is kept in IndexedDB so a device stays logged in
   across visits; "Log out" from Home clears it. The access token is short-lived (Supabase
   defaults to ~1 hour) — it's refreshed automatically on every sync tick and re-checked at
   startup, so a crew member basically never has to re-enter their password day to day. ==== */
let AUTH = null; // {access_token, refresh_token, expires_at, email, role} once logged in, else null

/* "Try demo mode" (added so new features can be tried out in Claude's own artifact preview,
   which can't reach Supabase at all — any fetch to it fails there with a generic "Failed to
   fetch", which is what made the real login unusable for testing). Demo mode skips Supabase
   entirely: no login request, no sync, nothing that touches the network — just an in-memory
   admin session so every screen is reachable locally, on whatever's already in this browser's
   IndexedDB. Nothing about it is saved (no authSession row), so refreshing the page drops
   straight back to the real login screen.

   IS_GITHUB_PAGES is what keeps this from quietly becoming a bypass of the real login once the
   app is actually deployed and being used for real work: GitHub Pages sites are always served
   from a *.github.io address, so the "Try demo mode" button only ever renders when the page is
   NOT on that domain — i.e. in the Claude preview, or opened straight from a local file — never
   on the live site your crew actually logs into. (If you ever move to a custom domain instead
   of the free *.github.io one, widen this check accordingly.) */
const IS_GITHUB_PAGES = /\.github\.io$/i.test(location.hostname);
let DEMO_MODE = false;

function authBaseUrl(cfg){ return cfg.url.replace(/\/rest\/v1\/?$/,'').replace(/\/+$/,''); }

// Supabase's JWT carries app_metadata right in the token itself, so the role can be read
// straight out of it client-side — no extra network call needed just to find out who's an admin.
function decodeJwt(token){
  try{
    const payload = token.split('.')[1];
    const json = decodeURIComponent(atob(payload.replace(/-/g,'+').replace(/_/g,'/')).split('').map(c=>
      '%'+('00'+c.charCodeAt(0).toString(16)).slice(-2)
    ).join(''));
    return JSON.parse(json);
  }catch(e){ return null; }
}
function sessionFromTokenResponse(tok){
  const claims = decodeJwt(tok.access_token) || {};
  const appMeta = claims.app_metadata || {};
  return {
    access_token: tok.access_token,
    refresh_token: tok.refresh_token,
    expires_at: Date.now() + (tok.expires_in||3600)*1000,
    email: claims.email || (tok.user && tok.user.email) || '',
    role: appMeta.role==='admin' ? 'admin' : 'staff'
  };
}
async function getAuthSession(){ return await getOne('settings','authSession'); }
async function setAuthSession(sess){ await rawPut('settings', Object.assign({id:'authSession'}, sess)); return sess; }
async function clearAuthSession(){ await rawDel('settings','authSession'); AUTH=null; }

async function authLogin(email, password){
  const cfg = await getSyncConfig();
  if(!cfg || !cfg.url || !cfg.key) throw new Error("Sync isn't set up on this device yet — see Settings → Crew sync.");
  const res = await fetch(authBaseUrl(cfg)+'/auth/v1/token?grant_type=password', {
    method:'POST',
    headers:{'Content-Type':'application/json', 'apikey':cfg.key},
    body: JSON.stringify({email, password})
  });
  const data = await res.json().catch(()=>({}));
  if(!res.ok) throw new Error(data.error_description || data.msg || data.error || 'Wrong email or password.');
  const sess = await setAuthSession(sessionFromTokenResponse(data));
  AUTH = sess;
  return sess;
}
async function authRefresh(){
  const cfg = await getSyncConfig();
  const sess = await getAuthSession();
  if(!cfg || !sess || !sess.refresh_token) return null;
  try{
    const res = await fetch(authBaseUrl(cfg)+'/auth/v1/token?grant_type=refresh_token', {
      method:'POST',
      headers:{'Content-Type':'application/json', 'apikey':cfg.key},
      body: JSON.stringify({refresh_token: sess.refresh_token})
    });
    if(!res.ok) return null;
    const data = await res.json();
    const newSess = await setAuthSession(sessionFromTokenResponse(data));
    AUTH = newSess;
    return newSess;
  }catch(e){ return null; } // offline, most likely — keep using the still-current token until it's reachable again
}
async function ensureFreshSession(){
  let sess = await getAuthSession();
  if(!sess) return null;
  if(sess.expires_at - Date.now() < 5*60*1000){ // refresh a bit before it actually expires
    const refreshed = await authRefresh();
    if(refreshed) sess = refreshed;
  }
  AUTH = sess;
  return sess;
}
function isAdmin(){ return !!(AUTH && AUTH.role==='admin'); }

function showAuthGate(onSuccess){
  document.body.classList.add('locked');
  const gate = document.getElementById('authGate');
  gate.classList.remove('hidden');
  const emailInput = document.getElementById('authEmail');
  const pwInput = document.getElementById('authPw');
  const err = document.getElementById('authErr');
  const btn = document.getElementById('authSubmit');
  async function tryLogin(){
    err.style.display = 'none';
    btn.disabled = true; btn.textContent = 'Logging in…';
    try{
      await authLogin(emailInput.value.trim(), pwInput.value);
      document.body.classList.remove('locked');
      gate.classList.add('hidden');
      onSuccess();
    }catch(e){
      err.textContent = (e && e.message==='Failed to fetch')
        ? "Can't reach the server from here — this screen (e.g. a preview) likely can't make outside network calls. Use \"Try demo mode\" below instead."
        : (e.message || 'Wrong email or password — try again.');
      err.style.display = 'block';
      pwInput.value = '';
      pwInput.focus();
    }finally{
      btn.disabled = false; btn.textContent = 'Log in';
    }
  }
  btn.onclick = tryLogin;
  pwInput.onkeydown = e=>{ if(e.key==='Enter') tryLogin(); };
  emailInput.onkeydown = e=>{ if(e.key==='Enter') pwInput.focus(); };
  emailInput.focus();
  const demoBtn = document.getElementById('authDemo');
  if(demoBtn){
    if(IS_GITHUB_PAGES){
      demoBtn.style.display = 'none'; // real login only once this is the actual deployed site
    } else {
      demoBtn.style.display = '';
      demoBtn.onclick = ()=>{
        DEMO_MODE = true;
        AUTH = {email:'demo@local', role:'admin', demo:true, access_token:null, refresh_token:null, expires_at: Date.now()+3600000};
        document.body.classList.remove('locked');
        gate.classList.add('hidden');
        onSuccess();
      };
    }
  }
}
async function logOut(){
  await clearAuthSession();
  location.reload();
}

/* ------------------------------ seed data ----------------------------- */
/* Box types (used by Supplier deliveries) are a short, user-owned list — like
   Suppliers — not a fixed set of categories. Seeded with a reasonable starting
   point so the picker isn't empty on day one, but every name here is just a
   normal editable/deletable record from here on. */
async function seedBoxTypesIfEmpty(){
  const existing = await getAll('boxTypes');
  if(existing.length) return;
  const defaults = ['Meat boxes','Fish boxes','Pork boxes','Chicken boxes','Vegetable boxes','Ice boxes','Carton boxes'];
  for(const name of defaults) await put('boxTypes', {id:uid(), name});
}

async function seedIfEmpty(){
  const wh = await getAll('warehouses');
  if(wh.length) return;
  const W = (name,priority)=>({id:uid(),name,description:'',priority});
  const warehouses = [W('Main Store',1), W('Dry Store',2), W('Freezer',3), W('Vegetable Store',4)];
  for(const w of warehouses) await put('warehouses', w);

  const S = (whId,name,priority)=>({id:uid(),warehouseId:whId,name,priority});
  const sections = [
    S(warehouses[0].id,'Sauces & Broths',1),
    S(warehouses[0].id,'Canned Food',2),
    S(warehouses[0].id,'Oil',3),
    S(warehouses[1].id,'Rice & Grains',1),
    S(warehouses[1].id,'Pasta',2),
    S(warehouses[1].id,'Spices',3),
    S(warehouses[2].id,'Meat',1),
    S(warehouses[2].id,'Poultry',2),
    S(warehouses[3].id,'Fresh Vegetables',1),
  ];
  for(const s of sections) await put('sections', s);

  const P = (name,unit,supplier,whId,secId,priority,exp)=>({
    id:uid(), name, unit, supplier, warehouseId:whId, sectionId:secId, priority,
    active:true, notes:'', productionDate:'', expiryDate:exp||'', image:''
  });
  const sauces = sections[0].id, canned = sections[1].id, oil = sections[2].id;
  const rice = sections[3].id, pasta = sections[4].id;
  const meat = sections[6].id, poultry = sections[7].id, veg = sections[8].id;
  const products = [
    P('Chicken Broth','Kg','ABC Food Supplier',warehouses[0].id,sauces,1,'2027-09-01'),
    P('BBQ Sauce','LTR','ABC Food Supplier',warehouses[0].id,sauces,2,'2027-04-01'),
    P('Ketchup','LTR','Delta Provisions',warehouses[0].id,sauces,3,'2027-06-01'),
    P('Tomato Peeled','Tin 400 gm','Delta Provisions',warehouses[0].id,canned,1,'2028-01-01'),
    P('Sweet Corn','Tin 400 gm','Delta Provisions',warehouses[0].id,canned,2,'2028-01-01'),
    P('Olive Oil','LTR','Aegean Traders',warehouses[0].id,oil,1,'2027-12-01'),
    P('Basmati Rice','Kg','Delta Provisions',warehouses[1].id,rice,1,''),
    P('Penne Pasta','Kg','Delta Provisions',warehouses[1].id,pasta,1,''),
    P('Beef Tenderloin','Kg','Northsea Meats',warehouses[2].id,meat,1,'2027-03-01'),
    P('Chicken Breast','Kg','Northsea Meats',warehouses[2].id,poultry,1,'2027-02-01'),
    P('Onion','Kg','Green Field Farms',warehouses[3].id,veg,1,''),
    P('Tomato Fresh','Kg','Green Field Farms',warehouses[3].id,veg,2,''),
  ];
  for(const p of products) await put('products', p);
}

/* migrate legacy free-text product.supplier strings into the suppliers store */
async function migrateSuppliers(){
  const [products, suppliers] = await Promise.all([getAll('products'), getAll('suppliers')]);
  const byName = new Map(suppliers.map(s=>[normalize(s.name), s]));
  let changed = false;
  for(const p of products){
    if(p.supplierId) continue;
    const raw = (p.supplier||'').trim();
    if(!raw) continue;
    const key = normalize(raw);
    let sup = byName.get(key);
    if(!sup){
      sup = {id:uid(), name:raw, contactPerson:'', phone:'', email:'', notes:''};
      await put('suppliers', sup);
      byName.set(key, sup);
    }
    p.supplierId = sup.id;
    await put('products', p);
    changed = true;
  }
  return changed;
}
function supplierName(supplierId, suppliersMap){
  if(!supplierId) return '';
  const s = suppliersMap instanceof Map ? suppliersMap.get(supplierId) : null;
  return s ? s.name : '';
}

/* ------------------------------ theme accent color ------------------------------ */
const THEME_PRESETS = [
  {name:'Orange (default)', hex:'#FF7A1A'},
  {name:'Blue', hex:'#2563EB'},
  {name:'Red', hex:'#DC2626'},
  {name:'Green', hex:'#16A34A'},
  {name:'Purple', hex:'#7C3AED'},
  {name:'Pink', hex:'#DB2777'},
  {name:'Teal', hex:'#0D9488'}
];
const DEFAULT_ACCENT = '#FF7A1A';
function pickTextColor(hex){
  const c = hex.replace('#','');
  const r = parseInt(c.substr(0,2),16), g=parseInt(c.substr(2,2),16), b=parseInt(c.substr(4,2),16);
  const yiq = (r*299+g*587+b*114)/1000;
  return yiq >= 150 ? '#12202B' : '#ffffff';
}
function applyAccent(hex){
  document.documentElement.style.setProperty('--signal', hex);
  document.documentElement.style.setProperty('--signal-text', pickTextColor(hex));
}
async function loadAndApplyTheme(){
  const rec = await getOne('settings', 'theme');
  applyAccent(rec && rec.accent ? rec.accent : DEFAULT_ACCENT);
}
async function saveAccent(hex){
  await put('settings', {id:'theme', accent:hex});
  applyAccent(hex);
}

/* ------------------------------ picking mode ------------------------------ */
const BATCH_SIZE = 4;
async function getPickingMode(){
  const rec = await getOne('settings', 'pickingMode');
  return (rec && rec.mode==='batch') ? 'batch' : 'single';
}
async function setPickingMode(mode){
  await put('settings', {id:'pickingMode', mode});
}

/* ------------------------ image compression (performance) ------------------------
   Product photos used to be stored at full camera resolution as base64 — a single
   phone photo can be several MB, and with hundreds of products that bloats every
   backup and slows down every screen that renders a thumbnail. New uploads are
   compressed here before they ever touch the database; compressExistingImages()
   below shrinks anything that was already stored oversized, once, in the
   background, without blocking the app from loading. */
function drawScaledDataUrl(img, maxDim, quality){
  let {width, height} = img;
  if(width > height){ if(width > maxDim){ height = Math.round(height*maxDim/width); width = maxDim; } }
  else { if(height > maxDim){ width = Math.round(width*maxDim/height); height = maxDim; } }
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  canvas.getContext('2d').drawImage(img, 0, 0, width, height);
  return canvas.toDataURL('image/jpeg', quality);
}
function compressImageFile(file, maxDim, quality){
  return new Promise((resolve, reject)=>{
    const reader = new FileReader();
    reader.onload = ()=>{
      const img = new Image();
      img.onload = ()=>{ try{ resolve(drawScaledDataUrl(img, maxDim, quality)); }catch(e){ reject(e); } };
      img.onerror = reject;
      img.src = reader.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}
function compressDataUrl(dataUrl, maxDim, quality){
  return new Promise((resolve, reject)=>{
    const img = new Image();
    img.onload = ()=>{ try{ resolve(drawScaledDataUrl(img, maxDim, quality)); }catch(e){ reject(e); } };
    img.onerror = reject;
    img.src = dataUrl;
  });
}
async function compressExistingImages(){
  const SIZE_THRESHOLD = 60000; // ~60KB of base64 text — bigger than this was almost certainly a full-res photo
  const products = await getAll('products');
  for(const p of products){
    if(p.image && typeof p.image === 'string' && p.image.startsWith('data:image') && p.image.length > SIZE_THRESHOLD){
      try{
        const compressed = await compressDataUrl(p.image, 480, 0.72);
        if(compressed.length < p.image.length){
          p.image = compressed;
          await put('products', p);
        }
      }catch(e){ /* leave this one as-is and move on */ }
      await new Promise(r=>setTimeout(r, 0)); // yield to the UI thread between images
    }
  }
}


/* -------------------------- product matching -------------------------- */
async function matchExcelRow(desc){
  const [products, mappings] = await Promise.all([getAll('products'), getAll('mappings')]);
  const norm = normalize(desc);
  const mapping = mappings.find(m=>m.excelDescNormalized===norm);
  if(mapping){
    const p = products.find(x=>x.id===mapping.productId);
    if(p) return {status:'mapped', product:p};
  }
  const exact = products.find(p=>normalize(p.name)===norm && p.active);
  if(exact) return {status:'auto', product:exact};
  const scored = products.filter(p=>p.active).map(p=>({p,score:similarity(desc,p.name)})).sort((a,b)=>b.score-a.score);
  if(scored[0] && scored[0].score >= 0.82) return {status:'auto', product:scored[0].p};
  const candidates = scored.filter(s=>s.score>=0.4).slice(0,4);
  if(candidates.length) return {status:'suggest', candidates};
  return {status:'unmatched'};
}

/* ------------------------------- router -------------------------------- */
const routes = {};
function route(path, fn){ routes[path]=fn; }

/* On narrow screens the sidebar is an off-canvas drawer (replaces the old bottom nav) toggled
   by the hamburger button in #mobileTopbar; it closes itself on every navigation. */
function setSidebarOpen(open){
  const sb = document.getElementById('sidebar');
  const bd = document.getElementById('sidebarBackdrop');
  if(!sb) return;
  sb.classList.toggle('open', open);
  if(bd) bd.classList.toggle('open', open);
}
(function wireSidebarToggle(){
  const toggleBtn = document.getElementById('sidebarToggle');
  const backdrop = document.getElementById('sidebarBackdrop');
  if(toggleBtn) toggleBtn.onclick = ()=> setSidebarOpen(!document.getElementById('sidebar').classList.contains('open'));
  if(backdrop) backdrop.onclick = ()=> setSidebarOpen(false);
})();

async function render(){
  const hash = location.hash || '#/';
  document.querySelectorAll('.navlink').forEach(a=>{
    let base = '#/'+(hash.split('/')[1]||'');
    if(base==='#/stock' || base==='#/deliveries' || base==='#/boxtypes' || base==='#/receiving' || base==='#/reliability') base='#/warehouse'; // sub-pages of the warehouse-management hub
    a.classList.toggle('active', a.getAttribute('data-route')===base || (base==='#/' && a.getAttribute('data-route')==='#/'));
  });
  setSidebarOpen(false);
  const parts = hash.replace('#/','').split('/').filter(Boolean);
  const key = parts[0] || 'home';
  const handler = routes[key] || routes['home'];
  await handler(parts.slice(1));
  window.scrollTo(0,0);
}
window.addEventListener('hashchange', render);

function showModal(html){
  $('#modal-root').innerHTML = `<div class="modal-bg" id="modal-bg"><div class="modal">${html}</div></div>`;
  $('#modal-bg').addEventListener('click', e=>{ if(e.target.id==='modal-bg') closeModal(); });
}
function closeModal(){ $('#modal-root').innerHTML=''; }
window.closeModal = closeModal;

/* custom confirm/alert — native browser dialogs are blocked inside the artifact preview */
function showConfirm(message, onYes, opts){
  opts = opts||{};
  showModal(`
    <h3>${opts.title || 'Please confirm'}</h3>
    <p>${esc(message)}</p>
    <div style="display:flex; gap:10px; margin-top:16px;">
      <button class="btn ${opts.danger?'btn-danger':'btn-signal'}" id="cf_yes" style="flex:1;">${opts.yesLabel||'Yes'}</button>
      <button class="btn btn-ghost" id="cf_no">${opts.noLabel||'Cancel'}</button>
    </div>`);
  $('#cf_yes').onclick = ()=>{ closeModal(); onYes(); };
  $('#cf_no').onclick = ()=>{ if(opts.onNo) opts.onNo(); else closeModal(); };
}
function showAlert(message, title){
  showModal(`
    <h3>${title||'Notice'}</h3>
    <p style="white-space:pre-line;">${esc(message)}</p>
    <button class="btn btn-signal" id="al_ok" style="margin-top:16px; width:100%;">OK</button>`);
  $('#al_ok').onclick = closeModal;
}


