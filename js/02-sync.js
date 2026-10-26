/* ============================== CREW SYNC ==============================
   Optional: if a Supabase URL + key are configured (Settings → Crew sync),
   every change to these tables is queued locally and pushed up, and
   changes from other crew members' devices are pulled down — so everyone
   shares one live product/warehouse/order database. The app is fully
   usable with this OFF or with no signal at all: every change still goes
   to IndexedDB first and instantly, sync just carries it further when a
   connection exists. Conflict rule: last write (by server timestamp)
   wins; a device never overwrites its own not-yet-pushed edit with an
   older remote one.
   ========================================================================= */
const SYNC_TABLES=['warehouses','sections','products','mappings','orders','orderItems','suppliers','boxReceipts','boxTypes','productReceipts'];
/* Past-order analysis data (Insights) is far bigger than normal records — thousands of lines from one
   import — so it can't go through the one-request-per-record queue above. These two stores sync in
   batches of 500 instead (see pushHistory / the pull below). A record without synced:true hasn't been
   uploaded yet; deletions are remembered in settings.historyPendingDeletes until they've been sent. */
const HISTORY_STORES=['historyOrders','historyLines'];
const DEFAULT_SUPABASE_URL='https://flhwqqblybrmargalgld.supabase.co/rest/v1';
const DEFAULT_SUPABASE_KEY='sb_publishable_VJtbFCSJSkCymNi2V_hl1g_gRUzDmX6';
async function seedSyncConfigIfEmpty(){
  const existing = await getSyncConfig();
  if(existing) return;
  await rawPut('settings', {id:'syncConfig', url:DEFAULT_SUPABASE_URL, key:DEFAULT_SUPABASE_KEY, crewName:''});
}
let syncDebounceTimer=null, syncInFlight=false, syncIntervalHandle=null, syncPaused=false; // paused while a bulk delete runs

function queueSync(store,id,op){
  const key = store+':'+id;
  rawPut('syncQueue', {key, store, id, op, ts:Date.now()});
  clearTimeout(syncDebounceTimer);
  syncDebounceTimer = setTimeout(()=>{ syncNow(); }, 1500);
}
async function getSyncConfig(){ return await getOne('settings','syncConfig'); }
async function setSyncConfig(cfg){ await rawPut('settings', Object.assign({id:'syncConfig'}, cfg)); }
async function getSyncStatus(){ return await getOne('settings','syncStatus') || {}; }
function syncHeaders(cfg){
  // apikey is always the project's public key (required by Supabase's gateway); once someone's
  // logged in, Authorization carries THEIR token instead, so row-level-security policies can see
  // who's actually making the request (auth.uid()/auth.jwt()), not just "someone with the key".
  const token = (AUTH && AUTH.access_token) || cfg.key;
  return {'Content-Type':'application/json', 'apikey':cfg.key, 'Authorization':'Bearer '+token};
}
function syncBaseUrl(cfg){ return cfg.url.replace(/\/+$/,''); }

async function pushChanges(cfg){
  const queued = await getAll('syncQueue');
  let pushed = 0;
  for(const q of queued){
    const now = new Date().toISOString();
    let body;
    if(q.op==='del'){
      body = {store:q.store, id:q.id, data:null, deleted:true, updated_at:now, updated_by:cfg.crewName||''};
    } else {
      const obj = await getOne(q.store, q.id);
      if(!obj){ await rawDel('syncQueue', q.key); continue; }
      body = {store:q.store, id:q.id, data:obj, deleted:false, updated_at:now, updated_by:cfg.crewName||''};
    }
    const res = await fetch(syncBaseUrl(cfg)+'/records?on_conflict=store,id', {
      method:'POST', headers:Object.assign(syncHeaders(cfg),{'Prefer':'resolution=merge-duplicates,return=minimal'}),
      body: JSON.stringify([body])
    });
    if(res.status===401){ const e=new Error('unauthorized'); e.code='unauthorized'; throw e; }
    if(!res.ok) throw new Error('push failed: HTTP '+res.status);
    await rawDel('syncQueue', q.key);
    await rawPut('syncMeta', {key:q.key, store:q.store, id:q.id, updatedAt:now});
    pushed++;
  }
  return pushed;
}
async function postRecordRows(cfg, rows){
  const res = await fetch(syncBaseUrl(cfg)+'/records?on_conflict=store,id', {
    method:'POST', headers:Object.assign(syncHeaders(cfg),{'Prefer':'resolution=merge-duplicates,return=minimal'}),
    body: JSON.stringify(rows)
  });
  if(res.status===401){ const e=new Error('unauthorized'); e.code='unauthorized'; throw e; }
  if(!res.ok) throw new Error('past-order upload failed: HTTP '+res.status);
}
async function bulkDelete(store, ids){
  if(!ids.length) return;
  const db = await dbp;
  await new Promise((resolve,reject)=>{
    const t = db.transaction(store,'readwrite'); const os = t.objectStore(store);
    for(const id of ids) os.delete(id);
    t.oncomplete = resolve; t.onerror = ()=>reject(t.error);
  });
}
async function historyPendingCount(){
  const pd = await getOne('settings','historyPendingDeletes');
  let n = pd && pd.items ? pd.items.length : 0;
  for(const s of HISTORY_STORES) n += (await getAll(s)).filter(r=>!r.synced).length;
  return n;
}
/* every row gets its own timestamp (1 ms apart): the pull pages through rows by "updated_at greater than the
   last one seen", so rows sharing one timestamp across a page boundary would be silently skipped */
let _histClock = 0;
function histStamp(){ _histClock = Math.max(_histClock+1, Date.now()); return new Date(_histClock).toISOString(); }
async function pushHistory(cfg){
  const B = 500; let pushed = 0;
  const by = cfg.crewName||'';
  const pd = await getOne('settings','historyPendingDeletes');
  if(pd && pd.items && pd.items.length){
    let items = pd.items;
    while(items.length){
      const part = items.slice(0,B);
      await postRecordRows(cfg, part.map(x=>({store:x.store, id:x.id, data:null, deleted:true, updated_at:histStamp(), updated_by:by})));
      items = items.slice(B); pushed += part.length;
      if(items.length) await rawPut('settings', {id:'historyPendingDeletes', items});
    }
    await rawDel('settings','historyPendingDeletes');
  }
  for(const store of HISTORY_STORES){
    const pending = (await getAll(store)).filter(r=>!r.synced);
    for(let i=0;i<pending.length;i+=B){
      const chunk = pending.slice(i,i+B);
      await postRecordRows(cfg, chunk.map(r=>{ const data = Object.assign({}, r); delete data.synced; return {store, id:r.id, data, deleted:false, updated_at:histStamp(), updated_by:by}; }));
      chunk.forEach(r=>{ r.synced = true; });
      await bulkPut(store, chunk);
      pushed += chunk.length;
    }
  }
  return pushed;
}
async function pullChanges(cfg){
  let cursorRec = await getOne('settings','syncCursor');
  let cursor = (cursorRec && cursorRec.value) || '1970-01-01T00:00:00Z';
  let pulled = 0, unsyncedHist = null;
  while(true){
    const url = syncBaseUrl(cfg)+'/records?updated_at=gt.'+encodeURIComponent(cursor)+'&order=updated_at.asc&limit=500';
    const res = await fetch(url, {headers:syncHeaders(cfg)});
    if(res.status===401){ const e=new Error('unauthorized'); e.code='unauthorized'; throw e; }
    if(!res.ok) throw new Error('pull failed: HTTP '+res.status);
    const rows = await res.json();
    if(!rows.length) break;
    const histPut = {historyOrders:[], historyLines:[]}, histDel = {historyOrders:[], historyLines:[]};
    for(const row of rows){
      if(HISTORY_STORES.includes(row.store)){
        // bulk path: no per-record bookkeeping; a local edit that hasn't been uploaded yet always wins
        if(!unsyncedHist){ unsyncedHist = new Set(); for(const s of HISTORY_STORES) (await getAll(s)).forEach(r=>{ if(!r.synced) unsyncedHist.add(s+':'+r.id); }); }
        if(!unsyncedHist.has(row.store+':'+row.id)){
          if(row.deleted) histDel[row.store].push(row.id);
          else histPut[row.store].push(Object.assign({}, row.data, {id:row.id, synced:true}));
        }
        pulled++; continue;
      }
      const key = row.store+':'+row.id;
      const pendingLocal = await getOne('syncQueue', key);
      if(pendingLocal) continue; // we have our own unpushed edit — let it win when it goes out
      const metaRec = await getOne('syncMeta', key);
      if(metaRec && metaRec.updatedAt >= row.updated_at) continue; // already applied this or newer
      if(SYNC_TABLES.includes(row.store)){
        if(row.deleted) await rawDel(row.store, row.id);
        else { const data = Object.assign({}, row.data, {id:row.id}); await rawPut(row.store, data); }
      }
      await rawPut('syncMeta', {key, store:row.store, id:row.id, updatedAt:row.updated_at});
      pulled++;
    }
    for(const s of HISTORY_STORES){ await bulkPut(s, histPut[s]); await bulkDelete(s, histDel[s]); }
    cursor = rows[rows.length-1].updated_at;
    await rawPut('settings', {id:'syncCursor', value:cursor});
    if(rows.length<500) break;
  }
  return pulled;
}
async function syncNow(){
  if(DEMO_MODE) return; // demo sessions are local-only — never touch the network, by design
  const cfg = await getSyncConfig();
  if(!cfg || !cfg.url || !cfg.key) return;
  if(syncInFlight || syncPaused) return;
  if(typeof navigator!=='undefined' && navigator.onLine===false) return;
  syncInFlight = true;
  renderSyncIndicator('syncing');
  try{
    const fresh = await ensureFreshSession(); // keeps the access token from going stale on a long-open tab
    if(fresh) AUTH = fresh;
    await pushChanges(cfg);
    await pushHistory(cfg);
    await pullChanges(cfg);
    await rawPut('settings', {id:'syncStatus', lastSyncedAt:new Date().toISOString(), ok:true, error:null});
    renderSyncIndicator('ok');
  }catch(e){
    if(e && e.code==='unauthorized'){
      // the session's been revoked or genuinely expired (refresh didn't save it) — rather than
      // spin forever on sync errors, send them back to the login screen to re-establish it
      await clearAuthSession();
      syncInFlight = false;
      location.reload();
      return;
    }
    await rawPut('settings', {id:'syncStatus', lastSyncedAt:(await getSyncStatus()).lastSyncedAt||null, ok:false, error:String(e.message||e)});
    renderSyncIndicator('error');
  }finally{
    syncInFlight = false;
  }
}
function startSyncLoop(){
  if(DEMO_MODE) return; // nothing to loop — see syncNow()
  if(syncIntervalHandle) return;
  syncIntervalHandle = setInterval(syncNow, 20000);
  window.addEventListener('online', syncNow);
  syncNow();
}
// updates the small status line on the Home screen in place, if it's currently on screen —
// never forces a full re-render, so it won't interrupt whatever the person is doing elsewhere
async function renderSyncIndicator(liveState){
  const el = document.getElementById('syncIndicator');
  if(!el) return;
  const cfg = await getSyncConfig();
  if(!cfg || !cfg.url || !cfg.key){ el.innerHTML = `<span class="subtle">Not set up — add your crew's connection details below.</span>`; return; }
  const pendingCount = (await getAll('syncQueue')).length;
  const status = await getSyncStatus();
  const online = typeof navigator==='undefined' || navigator.onLine!==false;
  let dot='#9aa5b1', label='Offline';
  if(liveState==='syncing'){ dot='#B8860B'; label='Syncing…'; }
  else if(!online){ dot='#9aa5b1'; label='Offline — will sync when back online'; }
  else if(status.ok===false){ dot='#C1432E'; label='Sync error: '+esc(status.error||'unknown'); }
  else if(status.lastSyncedAt){ dot='#2E7D4F'; label='Synced · last '+new Date(status.lastSyncedAt).toLocaleTimeString(); }
  else{ dot='#B8860B'; label='Not synced yet'; }
  el.innerHTML = `<span style="display:inline-flex; align-items:center; gap:7px;"><span style="width:9px;height:9px;border-radius:50%;background:${dot};display:inline-block;"></span>${label}</span>${pendingCount?` <span class="subtle">· ${pendingCount} change${pendingCount===1?'':'s'} waiting to send</span>`:''}`;
}

