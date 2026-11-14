/* ============================ SAME VESSEL, SPELT DIFFERENTLY ============================
   Insights groups past orders into a vessel profile by a cleaned-up name (capitals, spaces and MV/MT prefixes ignored). "KAI I" and
   "KAI 1" clean to different names, so they become two profiles. Here a person can say "these are the same vessel":
   the choice is stored as a small map of  spelling → main spelling  (shared setting 'vesselAliases', next to a list of pairs
   that were confirmed as different ships). It is applied when Insights reads its data — no order or history line is rewritten, each order
   keeps the name typed on it, and the merge can be undone any time. Future orders with the other spelling land in the main profile by themselves.
   Similar-looking names are only ever SUGGESTED, never merged on their own, because sister ships (KAI I / KAI II) are real. */
const canMergeVessels = ()=> (typeof isFullAdmin==='function' && isFullAdmin()) || can('settings.edit');
const VA_ID = 'vesselAliases';
async function vaLoad(){ const r = await getOne('sharedSettings', VA_ID); return {map:Object.assign({}, r&&r.map), notSame:(r&&r.notSame)||[]}; }
async function vaSave(v){ await put('sharedSettings', {id:VA_ID, map:v.map, notSame:v.notSame}); }
const vaFollow = (map, k)=>{ let n = 0; while(map[k] && n++<20) k = map[k]; return k; };

/* called by insightsData(): the same data, with merged vessels carrying their main profile's key */
async function applyVesselAliasesToData(d){
  const {map} = await vaLoad(); if(!Object.keys(map).length) return d;
  const re = o=>{ const k = vaFollow(map, o.vesselKey); return k===o.vesselKey ? o : Object.assign({}, o, {vesselKey:k, mergedFrom:o.vesselKey}); };
  return Object.assign({}, d, {hOrders: d.hOrders.map(re), hLines: d.hLines.map(re), badOrders:(d.badOrders||[]).map(re)});
}

/* ---------- suggestions ---------- */
const VA_ROMAN = {i:1, ii:2, iii:3, iv:4, v:5, vi:6, vii:7, viii:8, ix:9, x:10};
const vaCanon = k=> k.split(' ').map(t=>VA_ROMAN[t]||t).join(' ');
function vaDiffIsLetter(a, b){                      // one letter inserted / changed — but never a digit (KAI 1 vs KAI 2 are different ships)
  if(Math.abs(a.length-b.length)>1) return false;
  let i = 0; while(i<a.length && i<b.length && a[i]===b[i]) i++;
  const x = a.length>=b.length ? a : b, y = a.length>=b.length ? b : a;
  if(a.length===b.length){ if(a.slice(i+1)!==b.slice(i+1)) return false; return !/\d/.test(a[i]+b[i]); }
  if(x.slice(i+1)!==y.slice(i)) return false; return !/\d/.test(x[i]);
}
function vaSuggest(rows, notSame){
  const out = [], skip = new Set(notSame), roman = t=>VA_ROMAN[t]||/^\d+$/.test(t);
  for(let i=0;i<rows.length;i++) for(let j=i+1;j<rows.length;j++){
    const a = rows[i], b = rows[j], pair = [a.key,b.key].sort().join('|'); if(skip.has(pair)) continue;
    let why = '';
    if(vaCanon(a.key)===vaCanon(b.key)) why = 'I and 1 (the same number written two ways)';
    else if(a.key.length>=6 && b.key.length>=6 && vaDiffIsLetter(a.key,b.key)) why = 'one letter different';
    else {
      const ta = a.key.split(' '), tb = b.key.split(' '), [s,l] = ta.length<=tb.length ? [ta,tb] : [tb,ta];
      if(l.length===s.length+1 && s.every(t=>l.includes(t))){ const extra = l.find(t=>!s.includes(t)); if(extra && extra.length>=3 && !roman(extra) && !/\d/.test(extra) && s.length>=1 && s.join('').length>=3) why = `one has an extra word (“${extra}”)`; }
    }
    if(why){ const [keep, drop] = a.orders>=b.orders ? [a,b] : [b,a]; out.push({keep, drop, why, pair}); }
  }
  return out.slice(0,8);
}
let _vaSuggest = [];
async function vesselSuggestHtml(rows){
  if(!canMergeVessels()) return '';
  const {notSame} = await vaLoad(); _vaSuggest = vaSuggest(rows, notSame);
  if(!_vaSuggest.length) return '';
  return `<div class="card" style="margin-bottom:18px;"><div class="section-title">Possibly the same vessel (${_vaSuggest.length})</div>
    <p class="subtle" style="margin:0 0 6px;">Names that look alike. Nothing is merged unless you say so — sister ships like KAI I and KAI II are different vessels.</p>
    ${_vaSuggest.map((s,i)=>`<div class="va-s"><div style="flex:1; min-width:0;"><b>${esc(s.drop.name)}</b> <span class="subtle">(${s.drop.orders})</span> → <b>${esc(s.keep.name)}</b> <span class="subtle">(${s.keep.orders})</span><div class="subtle" style="font-size:.8rem;">${esc(s.why)}</div></div>
      <button class="btn btn-signal btn-sm" data-vamerge="${i}">Merge</button><button class="btn btn-ghost btn-sm" data-vano="${i}">Different</button></div>`).join('')}</div>`;
}
function vesselSuggestWire(){
  document.querySelectorAll('[data-vamerge]').forEach(b=>b.onclick=async ()=>{ const s = _vaSuggest[+b.dataset.vamerge]; await vaMerge(s.drop.key, s.keep.key, s.drop.name, s.keep.name); render(); });
  document.querySelectorAll('[data-vano]').forEach(b=>b.onclick=async ()=>{ const s = _vaSuggest[+b.dataset.vano]; const v = await vaLoad(); v.notSame.push(s.pair); await vaSave(v); render(); });
}

/* ---------- merge / separate ---------- */
async function vaMerge(fromKey, toKey, fromName, toName){
  if(!fromKey || !toKey || fromKey===toKey) return;
  const v = await vaLoad();
  if(vaFollow(v.map, toKey)===fromKey) return showAlert('That would make the two point at each other — open the other profile and merge from there.');
  v.map[fromKey] = toKey; await vaSave(v);
  await logAction('edit', `Merged vessel “${fromName}” into “${toName}” in Insights`, toName);
}
async function vaSeparate(fromKey, fromName, toName){
  const v = await vaLoad(); delete v.map[fromKey]; await vaSave(v);
  await logAction('edit', `Separated vessel “${fromName}” from “${toName}” in Insights`, toName);
}

/* ---------- on a vessel profile ---------- */
function vesselMergeHtml(mine){
  const others = new Map(); mine.filter(o=>o.mergedFrom).forEach(o=>{ const e = others.get(o.mergedFrom) || {key:o.mergedFrom, name:o.vesselName, n:0}; e.n++; others.set(o.mergedFrom, e); });
  if(!canMergeVessels() && !others.size) return '';
  return `<div class="card" style="margin-bottom:16px;">
    ${others.size ? `<div class="section-title" style="margin-bottom:6px;">Also counted here</div>${[...others.values()].map(e=>`<div class="va-s"><div style="flex:1;"><b>${esc(e.name)}</b> <span class="subtle">· ${e.n} order${e.n===1?'':'s'} spelt this way</span></div>${canMergeVessels()?`<button class="btn btn-ghost btn-sm" data-vasep="${esc(e.key)}" data-vaname="${esc(e.name)}">Separate</button>`:''}</div>`).join('')}` : ''}
    ${canMergeVessels() ? `<button class="btn btn-ghost btn-sm" id="va_pick" style="${others.size?'margin-top:8px;':''}">Same vessel as another profile…</button>` : ''}</div>`;
}
function vesselMergeWire(key, name, hOrders){
  document.querySelectorAll('[data-vasep]').forEach(b=>b.onclick=()=> showConfirm(`Separate “${b.dataset.vaname}” from “${name}”? They go back to being two vessels.`, async ()=>{ await vaSeparate(b.dataset.vasep, b.dataset.vaname, name); render(); }));
  const pick = $('#va_pick'); if(!pick) return;
  pick.onclick = ()=>{
    const rows = new Map();
    for(const o of hOrders){ if(o.vesselKey===key) continue; const r = rows.get(o.vesselKey) || {key:o.vesselKey, names:new Map(), n:0}; r.names.set(o.vesselName,(r.names.get(o.vesselName)||0)+1); r.n++; rows.set(o.vesselKey, r); }
    const list = [...rows.values()].map(r=>({key:r.key, name:[...r.names.entries()].sort((a,b)=>b[1]-a[1])[0][0], n:r.n})).sort((a,b)=>a.name.localeCompare(b.name));
    showModal(`<h3>Same vessel as…</h3><p class="subtle">Pick the profile that is really “${esc(name)}” spelt another way. Its orders will count here.</p>
      <input type="text" id="va_q" placeholder="Search vessels" autocomplete="off" style="margin-bottom:10px;">
      <div id="va_list" style="max-height:50vh; overflow:auto;"></div><button class="btn btn-ghost" onclick="closeModal()" style="margin-top:10px; width:100%;">Cancel</button>`);
    const draw = ()=>{ const q = normalize($('#va_q').value); $('#va_list').innerHTML = list.filter(r=>!q || normalize(r.name).includes(q)).slice(0,60).map(r=>`<button class="va-pick" data-k="${esc(r.key)}" data-n="${esc(r.name)}"><b>${esc(r.name)}</b><span class="subtle">${r.n} order${r.n===1?'':'s'}</span></button>`).join('') || '<p class="subtle">No vessel found.</p>';
      $('#va_list').querySelectorAll('.va-pick').forEach(el=>el.onclick=()=> showConfirm(`Count “${el.dataset.n}” as “${name}”? Their ${rows.get(el.dataset.k).n} orders join this profile. Each order keeps its own name, and you can separate them again.`, async ()=>{ await vaMerge(el.dataset.k, key, el.dataset.n, name); render(); })); };
    $('#va_q').oninput = draw; draw();
  };
}
