/* ---------------- order status helpers (shared by Home / Orders / History / Summary) ----------------
   An order that's finished picking but hasn't left the warehouse yet (the ship hasn't arrived)
   is flagged awaitingDispatch, so everyone can see it's DONE but NOT SENT. Orders without the
   flag — including everything completed before this existed — count as sent. */
function isAwaitingDispatch(o){ return o.status==='completed' && !!o.awaitingDispatch; }
function orderBadgeHtml(o){
  if(isAwaitingDispatch(o)) return `<span class="badge b-awaiting">picked · not sent</span>`;
  return `<span class="badge b-${o.status}">${o.status}</span>`;
}
/* picking/draft first (still being worked on), then picked-but-not-sent, then sent/completed;
   newest first inside each group */
function orderSortRank(o){
  if(o.status!=='completed') return 0;
  return isAwaitingDispatch(o) ? 1 : 2;
}
function compareOrdersForList(a, b){
  return orderSortRank(a)-orderSortRank(b) ||
    ((b.status==='completed' ? (b.completedAt||b.createdAt||'') : (b.createdAt||'')).localeCompare(
      a.status==='completed' ? (a.completedAt||a.createdAt||'') : (a.createdAt||'')));
}

/* ==================================== HOME ==================================== */
route('home', async ()=>{
  const [orders, products, warehouses, shortfalls] = await Promise.all([getAll('orders'), getAll('products'), getAll('warehouses'), openShortfalls()]);
  const active = orders.filter(o=>o.status==='picking').length;
  const today = todayISO();
  const completedToday = orders.filter(o=>o.status==='completed' && (o.completedAt||'').slice(0,10)===today).length;
  const awaitingCount = orders.filter(isAwaitingDispatch).length;
  const recent = orders.slice().sort(compareOrdersForList).slice(0,6);
  const lowStockCount = products.filter(p=>p.active && isLowStock(p)).length;
  $('#main').innerHTML = `
    <div class="topbar"><h1>Dashboard</h1></div>
    ${DEMO_MODE ? `<div class="card" style="margin-bottom:18px; border-color:var(--warn); background:var(--warn-bg);"><b>🧪 Demo mode</b><span class="subtle"> — you're testing locally, not logged into a real account. Nothing here syncs anywhere, and this ends when you reload the page.</span></div>` : ''}
    ${(lowStockCount || shortfalls.length) ? `
      <div style="display:flex; gap:10px; flex-wrap:wrap; margin-bottom:18px;">
        ${lowStockCount ? `<a href="#/stock" class="btn btn-ghost" style="border-color:var(--warn); color:var(--warn);">⚠ ${lowStockCount} low stock item${lowStockCount===1?'':'s'}</a>` : ''}
        ${shortfalls.length ? `<a href="#/deliveries" class="btn btn-ghost" style="border-color:var(--danger); color:var(--danger);">⚠ ${shortfalls.length} unresolved shortfall${shortfalls.length===1?'':'s'}</a>` : ''}
      </div>` : ''}
    <div class="grid-stats">
      <div class="stat"><b>${active}</b><div class="lbl">Active orders</div></div>
      <div class="stat"><b>${completedToday}</b><div class="lbl">Completed today</div></div>
      <div class="stat"><b>${awaitingCount}</b><div class="lbl">Picked, not sent</div></div>
      <div class="stat"><b>${products.length}</b><div class="lbl">Products in database</div></div>
      <div class="stat"><b>${warehouses.length}</b><div class="lbl">Warehouses</div></div>
    </div>
    <div style="display:flex; gap:10px; flex-wrap:wrap; margin-bottom:28px;">
      <a href="#/order/new" class="btn btn-signal btn-lg" style="max-width:320px;">+ New Order</a>
      <a href="#/receiving" class="btn btn-ghost btn-lg" style="max-width:320px;">Product receiving</a>
      <a href="#/deliveries" class="btn btn-ghost btn-lg" style="max-width:320px;">Supplier deliveries</a>
    </div>
    <h3 class="section-title">Recent orders</h3>
    <div class="card">
      ${recent.length ? recent.map(o=>`
        <div class="list-row">
          <div class="thumb">🚢</div>
          <div style="flex:1; min-width:0;">
            <div style="font-weight:700;">${esc(o.vessel)} <span class="subtle">· ${esc(o.orderNumber)}</span></div>
            <div class="subtle">IMO ${esc(o.imo)} · ${fmtDate(o.orderDate)}</div>
          </div>
          ${destinationBadge(o.destination)}
          ${orderBadgeHtml(o)}
          <a href="#/order/${o.id}/open" class="btn btn-ghost btn-sm">Open</a>
        </div>`).join('') : `<div class="empty"><div class="ic">🚢</div>No orders yet. Start with “+ New Order”.</div>`}
    </div>
    <div class="card" style="margin-top:24px;">
      <div class="section-title">Account</div>
      <p class="subtle">${DEMO_MODE ? 'Demo mode <span class="badge b-modified">not a real account</span>' : `Logged in as <b>${esc(AUTH ? AUTH.email : '')}</b> ${isAdmin()?'<span class="badge b-completed">admin</span>':'<span class="badge b-pending">staff</span>'}`}</p>
      <div style="display:flex; gap:10px; flex-wrap:wrap; margin-top:4px;">
        <a href="#/settings" class="btn btn-ghost btn-sm">⚙ Settings</a>
        <button class="btn btn-ghost btn-sm" id="doLogout">${DEMO_MODE ? 'Exit demo mode' : 'Log out'}</button>
      </div>
    </div>`;
  $('#doLogout').onclick = ()=>{
    if(DEMO_MODE){ logOut(); return; }
    showConfirm("Log out? You'll need your password again to get back in.", logOut);
  };
});

/* ==================================== SETTINGS ==================================== */
route('settings', async ()=>{
  const [themeRec, syncCfgRaw] = await Promise.all([getOne('settings','theme'), getSyncConfig()]);
  const syncCfgCache = syncCfgRaw || {};
  const currentAccent = (themeRec && themeRec.accent) ? themeRec.accent.toLowerCase() : DEFAULT_ACCENT.toLowerCase();
  $('#main').innerHTML = `
    <div class="topbar"><h1>Settings</h1></div>
    <div class="card">
      <div class="section-title">Backup &amp; restore</div>
      <p class="subtle">Everything lives on this device, whether or not crew sync (below) is on. Download a backup before updating the app or trying something new, and keep the file somewhere safe.</p>
      <div style="display:flex; gap:10px; flex-wrap:wrap; margin-top:12px;">
        <button class="btn btn-signal btn-sm" id="doBackup">⬇ Download backup</button>
        ${isAdmin() ? `<label class="btn btn-ghost btn-sm" style="cursor:pointer;">⬆ Restore from backup<input type="file" id="restoreFile" accept=".json" style="display:none;"></label>` : `<span class="subtle">Restoring a backup is admin-only — it overwrites everything on this device.</span>`}
      </div>
    </div>
    <div class="card" style="margin-top:24px;" id="syncCard">
      <div class="section-title">Crew sync</div>
      <p class="subtle">Share one live set of products, warehouses and orders with the rest of the crew. Everything still works with no signal — changes made offline send themselves as soon as a connection comes back.</p>
      ${DEMO_MODE ? `<p class="subtle" style="color:var(--warn);">🧪 Disabled in demo mode — there's no real account behind this session, so there's nothing to sync.</p>` : `<p id="syncIndicator" style="margin:12px 0;"></p>`}
      <div class="field"><label>Your name (shown as who made each change)</label><input type="text" id="syncCrewName" placeholder="e.g. Ahmed" value="${esc(syncCfgCache.crewName||'')}"></div>
      ${isAdmin() ? `
      <details ${syncCfgCache.url?'':'open'}>
        <summary class="subtle" style="cursor:pointer; margin-bottom:10px;">Connection details</summary>
        <div class="field"><label>Supabase project URL</label><input type="text" id="syncUrl" placeholder="https://xxxx.supabase.co/rest/v1" value="${esc(syncCfgCache.url||'')}"></div>
        <div class="field"><label>Supabase API key</label><input type="text" id="syncKey" placeholder="sb_publishable_…" value="${esc(syncCfgCache.key||'')}"></div>
      </details>` : ''}
      <div style="display:flex; gap:10px; flex-wrap:wrap;">
        <button class="btn btn-signal btn-sm" id="syncSave">Save &amp; sync now</button>
        ${syncCfgCache.url?'<button class="btn btn-ghost btn-sm" id="syncOff">Turn off sync on this device</button>':''}
      </div>
    </div>
    <div class="card" style="margin-top:24px;">
      <div class="section-title">Theme color</div>
      <p class="subtle">Pick an accent color for buttons and highlights — purely cosmetic, change it whenever you like.</p>
      <div style="display:flex; gap:10px; flex-wrap:wrap; margin:14px 0;" id="themeSwatches">
        ${THEME_PRESETS.map(p=>`<button class="theme-swatch ${p.hex.toLowerCase()===currentAccent?'selected':''}" data-color="${p.hex}" style="background:${p.hex}" title="${p.name}"></button>`).join('')}
      </div>
      <div style="display:flex; align-items:center; gap:12px; flex-wrap:wrap;">
        <label class="subtle" style="display:flex; align-items:center; gap:8px;">Custom: <input type="color" id="themeCustom" value="${currentAccent}"></label>
        <button class="btn btn-ghost btn-sm" id="themeReset">Reset to default</button>
      </div>
    </div>`;
  $('#doBackup').onclick = downloadBackup;
  if($('#restoreFile')) $('#restoreFile').onchange = e=>{
    const file = e.target.files[0];
    if(file) restoreBackupFile(file);
    e.target.value = '';
  };
  $('#themeSwatches').querySelectorAll('[data-color]').forEach(b=>b.onclick=async ()=>{
    await saveAccent(b.dataset.color);
    routes['settings']([]);
  });
  $('#themeCustom').onchange = async e=>{
    await saveAccent(e.target.value);
    routes['settings']([]);
  };
  $('#themeCustom').oninput = e=> applyAccent(e.target.value); // live preview while dragging the picker
  $('#themeReset').onclick = async ()=>{
    await saveAccent(DEFAULT_ACCENT);
    routes['settings']([]);
  };
  renderSyncIndicator();
  $('#syncSave').onclick = async ()=>{
    const crewName = $('#syncCrewName').value.trim();
    let url = syncCfgCache.url, key = syncCfgCache.key;
    if($('#syncUrl') && $('#syncKey')){ // only present for admins — staff can't see or change the connection itself
      url = $('#syncUrl').value.trim();
      key = $('#syncKey').value.trim();
      if(!url || !key){ showAlert('Enter both the project URL and the API key.'); return; }
    }
    await setSyncConfig({url, key, crewName});
    startSyncLoop();
    routes['settings']([]);
  };
  if($('#syncOff')) $('#syncOff').onclick = ()=>{
    showConfirm('This device will stop sending and receiving crew changes. Everything already on this device stays — this only turns off the connection.', async ()=>{
      await rawDel('settings','syncConfig');
      if(syncIntervalHandle){ clearInterval(syncIntervalHandle); syncIntervalHandle=null; }
      routes['settings']([]);
    });
  };
});

