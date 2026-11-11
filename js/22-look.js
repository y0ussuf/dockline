/* ============================================================================================
   Look & feel: colour themes (each with a light and a dark version), a one-tap theme switch, and the
   "alive" touches (motion, celebration, greeting, warehouse colours, friendlier empty screens, sound,
   vibration, gradient header). Every touch has its own on/off switch in Settings.
   Saved per device in the 'settings' store (id 'look') and mirrored to localStorage so the page paints
   in the right colours straight away.
   ============================================================================================ */

const LOOK_THEMES = [
  {id:'harbor',   name:'Harbor',         accent:'#FF7A1A', accentDark:'#FF7A1A', sw:['#F7F5F0','#12202B']},
  {id:'midnight', name:'Midnight Ocean', accent:'#0891B2', accentDark:'#22D3EE', sw:['#EEF6FA','#071A2B']},
  {id:'forest',   name:'Forest',         accent:'#B7791F', accentDark:'#E0B23A', sw:['#F3F5EC','#0E1A12']},
  {id:'sunset',   name:'Sunset',         accent:'#EF5A3C', accentDark:'#FFAA4D', sw:['#FFF4EC','#1E1224']},
  {id:'graphite', name:'Graphite',       accent:'#2F6BFF', accentDark:'#5B8CFF', sw:['#F2F2F3','#121316']},
  {id:'rose',     name:'Rose',           accent:'#E11D74', accentDark:'#FB6FA3', sw:['#FFF1F4','#1F0F17']},
  {id:'lavender', name:'Lavender',       accent:'#7C5CFC', accentDark:'#A78BFA', sw:['#F4F1FF','#151126']}
];
const LOOK_TOGGLES = [
  ['motion',    'Smooth movement',        'Pages fade in, buttons press down, lists slide in softly.'],
  ['celebrate', 'Order celebration',      'An animated check and confetti when an order is completed.'],
  ['greeting',  'Greeting on Home',       '“Good morning” with a quick summary of today.'],
  ['gradient',  'Gradient header',        'A colourful header on Home, tinted by the theme.'],
  ['whColors',  'Warehouse colours',      'Every warehouse gets its own colour dot so you recognise it at a glance.'],
  ['emptyArt',  'Friendlier empty screens','A soft illustrated badge instead of a plain icon.'],
  ['themeBtn',  'Theme button in the top bar','One-tap switch for themes without opening Settings.'],
  ['sound',     'Sounds',                 'A soft tick when you pick an item, a different tone for warnings.'],
  ['haptics',   'Vibration',              'A short buzz on a successful pick (phones only).']
];
const LOOK_DEFAULTS = {theme:'harbor', mode:'auto', rotate:false, motion:true, celebrate:true, greeting:true, gradient:true, whColors:true, emptyArt:true, themeBtn:true, sound:false, haptics:false};

let _look = Object.assign({}, LOOK_DEFAULTS);
let _lookCustomAccent = null;   // an accent picked by hand wins over the theme's own accent

/* colour themes are optional per person (the 'Themes' permission); the accent colour always stays available */
const lookMayTheme = ()=> typeof can!=='function' || can('themes');
const lookCls = k=> k==='themeBtn' ? 'lk-showthemebtn' : 'lk-'+k.toLowerCase();
function lookResolvedThemeId(){
  if(_look.rotate && lookMayTheme()){ const d = new Date(), doy = Math.floor((d - new Date(d.getFullYear(),0,0))/864e5); return LOOK_THEMES[doy % LOOK_THEMES.length].id; }
  if(!lookMayTheme()) return 'harbor';
  return LOOK_THEMES.some(t=>t.id===_look.theme) ? _look.theme : 'harbor';
}
function lookResolvedMode(){
  if(_look.mode==='light' || _look.mode==='dark') return _look.mode;
  return (window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light';
}
function applyLook(){
  const root = document.documentElement, id = lookResolvedThemeId(), mode = lookResolvedMode(), th = LOOK_THEMES.find(t=>t.id===id);
  root.setAttribute('data-look', id); root.setAttribute('data-theme', mode);
  const accent = _lookCustomAccent || (mode==='dark' ? th.accentDark : th.accent);
  root.style.setProperty('--signal', accent); root.style.setProperty('--signal-text', pickTextColor(accent));
  const may = lookMayTheme(), on = k=> k==='themeBtn' ? (!!_look[k] && may) : !!_look[k];
  root.classList.remove('lk-themebtn');   // old name — it also styled the whole page (big text) because it sat on <html>
  ['motion','whColors','emptyArt','gradient','themeBtn'].forEach(k=>root.classList.toggle(lookCls(k), on(k)));
  const meta = document.querySelector('meta[name="theme-color"]'); if(meta) meta.setAttribute('content', getComputedStyle(root).getPropertyValue('--paper').trim() || '#0F1720');
  try{ localStorage.setItem('dk_look', JSON.stringify({id, mode, accent, text:pickTextColor(accent), cls:['motion','whColors','emptyArt','gradient','themeBtn'].filter(on).map(lookCls)})); }catch(e){}
}
async function loadLook(){
  const [rec, theme] = await Promise.all([getOne('settings','look'), getOne('settings','theme')]);
  _look = Object.assign({}, LOOK_DEFAULTS, rec && rec.prefs || {});
  const acc = theme && theme.accent ? theme.accent : null;
  const isCustom = theme && (theme.custom ?? (acc && acc.toLowerCase()!==DEFAULT_ACCENT.toLowerCase()));
  _lookCustomAccent = isCustom ? acc : null;
  applyLook();
}
async function saveLook(patch){
  Object.assign(_look, patch);
  await put('settings', {id:'look', prefs:_look});
  applyLook();
}
if(window.matchMedia) matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', ()=>{ if(_look.mode==='auto') applyLook(); });

/* ------------------------------ one-tap theme switcher ------------------------------ */
function themeTilesHtml(){
  const cur = lookResolvedThemeId();
  return LOOK_THEMES.map(t=>`<button class="lk-tile ${t.id===cur?'on':''}" data-lkt="${t.id}" title="${t.name}">
      <span class="lk-prev" style="background:linear-gradient(135deg, ${t.sw[0]} 0 50%, ${t.sw[1]} 50% 100%);"><i style="background:${t.accent};"></i></span><span class="lk-nm">${t.name}</span></button>`).join('');
}
function modeButtonsHtml(){
  return `<div class="lk-seg" id="lkMode">${[['auto','Auto'],['light','Light'],['dark','Dark']].map(([v,l])=>`<button data-lkm="${v}" class="${_look.mode===v?'on':''}">${l}</button>`).join('')}</div>`;
}
function bindThemeControls(root, onChange){
  root.querySelectorAll('[data-lkt]').forEach(b=>b.onclick=async ()=>{ await saveLook({theme:b.dataset.lkt, rotate:false}); root.querySelectorAll('[data-lkt]').forEach(x=>x.classList.toggle('on', x===b)); lookFeedback('tick'); onChange && onChange(); });
  root.querySelectorAll('[data-lkm]').forEach(b=>b.onclick=async ()=>{ await saveLook({mode:b.dataset.lkm}); root.querySelectorAll('[data-lkm]').forEach(x=>x.classList.toggle('on', x===b)); onChange && onChange(); });
}
function openThemeSwitcher(){
  showModal(`<h3>Theme</h3><div class="lk-grid">${themeTilesHtml()}</div>
    <div style="margin:12px 0 4px;" class="subtle">Brightness</div>${modeButtonsHtml()}
    <label class="lk-sw" style="margin-top:12px;"><input type="checkbox" id="lkRot" ${_look.rotate?'checked':''}><span>Surprise me — a different theme each day</span></label>
    <div style="display:flex; gap:10px; margin-top:14px;"><button class="btn btn-signal" style="flex:1;" onclick="closeModal()">Done</button><a class="btn btn-ghost" href="#/settings" onclick="closeModal()">More options</a></div>`);
  const m = $('#modal-root'); bindThemeControls(m);
  $('#lkRot').onchange = async e=>{ await saveLook({rotate:e.target.checked}); m.querySelectorAll('[data-lkt]').forEach(x=>x.classList.toggle('on', x.dataset.lkt===lookResolvedThemeId())); };
}
function installThemeButtons(){
  if(document.getElementById('lkBtnTop')) return;
  const mk = id=>{ const b = document.createElement('button'); b.type='button'; b.id=id; b.className='lk-themebtn'; b.title='Theme'; b.setAttribute('aria-label','Change theme'); b.textContent='🎨'; b.onclick=openThemeSwitcher; return b; };
  const top = document.getElementById('mobileTopbar'); if(top) top.appendChild(mk('lkBtnTop'));
  const nav = document.querySelector('#sidebar .nav-foot'); if(nav){ const a = document.createElement('a'); a.className='navlink lk-sidebtn'; a.href='javascript:void(0)'; a.id='lkBtnSide'; a.innerHTML='<span class="ic">🎨</span> Theme'; a.onclick=e=>{ e.preventDefault(); openThemeSwitcher(); }; nav.appendChild(a); }
}

/* ------------------------------ settings card ------------------------------ */
function lookCardHtml(){
  return `<div class="card" style="margin-top:24px;" id="lookCard">
    <div class="section-title">Look &amp; feel</div>
    <p class="subtle">Pick a theme, and switch off anything you don't like. Changes apply straight away.</p>
    <div class="lk-grid" id="lkGrid">${themeTilesHtml()}</div>
    <div class="subtle" style="margin:14px 0 6px;">Brightness</div>${modeButtonsHtml()}
    <label class="lk-sw" style="margin-top:12px;"><input type="checkbox" id="lkRot2" ${_look.rotate?'checked':''}><span><b>Surprise me</b><small>A different theme each day</small></span></label>
    <div class="subtle" style="margin:16px 0 6px;">Your own accent colour <span class="subtle">(overrides the theme's accent on buttons and highlights)</span></div>
    <div style="display:flex; gap:10px; flex-wrap:wrap; margin:6px 0;" id="themeSwatches">${THEME_PRESETS.map(p=>`<button class="theme-swatch ${_lookCustomAccent && p.hex.toLowerCase()===_lookCustomAccent.toLowerCase()?'selected':''}" data-color="${p.hex}" style="background:${p.hex}" title="${p.name}"></button>`).join('')}</div>
    <div style="display:flex; align-items:center; gap:12px; flex-wrap:wrap;">
      <label class="subtle" style="display:flex; align-items:center; gap:8px;">Custom: <input type="color" id="themeCustom" value="${_lookCustomAccent || LOOK_THEMES.find(t=>t.id===lookResolvedThemeId()).accent}"></label>
      <button class="btn btn-ghost btn-sm" id="themeReset">Use the theme's own colour</button></div>
    <div class="subtle" style="margin:18px 0 4px;">Extras — each one can be switched off</div>
    ${LOOK_TOGGLES.map(([k,t,d])=>`<label class="lk-sw"><input type="checkbox" data-lkx="${k}" ${_look[k]?'checked':''}><span><b>${t}</b><small>${d}</small></span></label>`).join('')}
    <div style="display:flex; gap:10px; flex-wrap:wrap; margin-top:10px;"><button class="btn btn-ghost btn-sm" id="lkTest">▶ Try the celebration</button><button class="btn btn-ghost btn-sm" id="lkReset">Reset look &amp; feel</button></div></div>`;
}
function bindLookCard(){
  const card = $('#lookCard'); if(!card) return;
  bindThemeControls(card);
  $('#lkRot2').onchange = async e=>{ await saveLook({rotate:e.target.checked}); card.querySelectorAll('[data-lkt]').forEach(x=>x.classList.toggle('on', x.dataset.lkt===lookResolvedThemeId())); };
  card.querySelectorAll('[data-lkx]').forEach(c=>c.onchange = async ()=>{ await saveLook({[c.dataset.lkx]:c.checked}); if(c.dataset.lkx==='sound' && c.checked) lookFeedback('ok'); if(c.dataset.lkx==='haptics' && c.checked) lookFeedback('ok'); });
  const setCustom = async hex=>{ await saveAccent(hex); _lookCustomAccent = hex; applyLook(); };
  card.querySelectorAll('[data-color]').forEach(b=>b.onclick=async ()=>{ await setCustom(b.dataset.color); card.querySelectorAll('[data-color]').forEach(x=>x.classList.toggle('selected', x===b)); });
  $('#themeCustom').oninput = e=>{ document.documentElement.style.setProperty('--signal', e.target.value); document.documentElement.style.setProperty('--signal-text', pickTextColor(e.target.value)); };
  $('#themeCustom').onchange = e=>setCustom(e.target.value);
  $('#themeReset').onclick = async ()=>{ await put('settings', {id:'theme', accent:DEFAULT_ACCENT, custom:false}); _lookCustomAccent = null; applyLook(); routes['settings']([]); };
  $('#lkTest').onclick = ()=>lookCelebrate(true);
  $('#lkReset').onclick = async ()=>{ await put('settings', {id:'theme', accent:DEFAULT_ACCENT, custom:false}); _lookCustomAccent = null; _look = Object.assign({}, LOOK_DEFAULTS); await put('settings', {id:'look', prefs:_look}); applyLook(); routes['settings']([]); };
}

/* ------------------------------ sound, vibration, celebration ------------------------------ */
let _lkAudio = null;
function lkTone(freq, start, dur, gain){
  try{
    _lkAudio = _lkAudio || new (window.AudioContext || window.webkitAudioContext)();
    const ctx = _lkAudio, o = ctx.createOscillator(), g = ctx.createGain(), t = ctx.currentTime + start;
    o.type = 'sine'; o.frequency.value = freq; g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(gain||0.08, t+0.01); g.gain.exponentialRampToValueAtTime(0.0001, t+dur);
    o.connect(g); g.connect(ctx.destination); o.start(t); o.stop(t+dur+0.02);
  }catch(e){}
}
/* kind: 'ok' (item picked), 'warn', 'done' (order finished), 'tick' (UI) */
function lookFeedback(kind){
  try{
    if(_look.sound){
      if(kind==='ok'){ lkTone(880,0,.09); lkTone(1175,.07,.12); }
      else if(kind==='warn'){ lkTone(330,0,.16,.1); lkTone(247,.15,.22,.1); }
      else if(kind==='done'){ [523,659,784,1047].forEach((f,i)=>lkTone(f,i*.11,.22)); }
      else if(kind==='tick'){ lkTone(700,0,.04,.05); }
    }
    if(_look.haptics && navigator.vibrate){ navigator.vibrate(kind==='warn' ? [40,60,40] : kind==='done' ? [30,40,30,40,80] : kind==='ok' ? 25 : 0); }
  }catch(e){}
}
function lookCelebrate(force){
  if(!force && !_look.celebrate) return;
  lookFeedback('done');
  if(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches){ return; }
  const ov = document.createElement('div'); ov.className = 'lk-cele';
  ov.innerHTML = `<canvas></canvas><div class="lk-check"><svg viewBox="0 0 52 52"><circle cx="26" cy="26" r="24" fill="none" stroke-width="3"/><path d="M14 27l8 8 16-17" fill="none" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg><b>Order complete!</b></div>`;
  document.body.appendChild(ov);
  const cv = ov.querySelector('canvas'), ctx = cv.getContext('2d'); cv.width = innerWidth; cv.height = innerHeight;
  const cs = getComputedStyle(document.documentElement), cols = [cs.getPropertyValue('--signal').trim(), cs.getPropertyValue('--sea').trim(), '#FFC857', '#6FD08C', '#F87171', '#A78BFA'];
  const bits = Array.from({length:110}, ()=>({x:innerWidth/2, y:innerHeight*0.42, vx:(Math.random()-.5)*14, vy:-Math.random()*13-3, s:5+Math.random()*6, r:Math.random()*6, vr:(Math.random()-.5)*.4, c:cols[(Math.random()*cols.length)|0]}));
  let t0 = performance.now();
  const frame = now=>{
    const dt = now - t0; ctx.clearRect(0,0,cv.width,cv.height);
    bits.forEach(b=>{ b.vy += .32; b.x += b.vx; b.y += b.vy; b.r += b.vr; b.vx *= .995; ctx.save(); ctx.translate(b.x,b.y); ctx.rotate(b.r); ctx.fillStyle = b.c; ctx.globalAlpha = Math.max(0, 1 - dt/2600); ctx.fillRect(-b.s/2,-b.s/3,b.s,b.s*.66); ctx.restore(); });
    if(dt < 2600 && document.body.contains(ov)) requestAnimationFrame(frame); else ov.remove();
  };
  requestAnimationFrame(frame);
  ov.onclick = ()=>ov.remove(); setTimeout(()=>ov.remove(), 2800);
}

/* ------------------------------ greeting, warehouse colour dots ------------------------------ */
function lookGreetingWord(){ const h = new Date().getHours(); return h<5 ? 'Good night' : h<12 ? 'Good morning' : h<18 ? 'Good afternoon' : 'Good evening'; }
async function homeHeaderHtml(active, awaiting, completedToday){
  const crew = await getSyncConfig().then(c=>c && c.crewName).catch(()=>'');
  const who = (crew || (AUTH && AUTH.email ? AUTH.email.split('@')[0] : '') || '').trim();
  const bits = [];
  if(active) bits.push(`<b>${active}</b> order${active===1?'':'s'} being picked`);
  if(awaiting) bits.push(`<b>${awaiting}</b> picked, not sent`);
  if(completedToday) bits.push(`<b>${completedToday}</b> completed today`);
  const sub = bits.length ? bits.join(' · ') : 'Nothing waiting right now — a quiet day.';
  const cls = 'lk-hero' + (_look.gradient ? ' grad' : '');
  if(!_look.greeting) return `<div class="${cls}"><h1>Dashboard</h1></div>`;
  return `<div class="${cls}"><h1>${lookGreetingWord()}${who?', '+esc(who):''} <span class="lk-wave">👋</span></h1><div class="lk-sub">${sub}</div></div>`;
}
const LK_WH_HUES = [18, 200, 145, 285, 45, 340, 170, 230, 95, 320];
function whColor(id){ let h = 0; for(const ch of String(id||'')) h = (h*31 + ch.charCodeAt(0)) >>> 0; return `hsl(${LK_WH_HUES[h % LK_WH_HUES.length]} 70% 52%)`; }
function whDot(id){ return `<span class="wh-dot" style="background:${whColor(id)}"></span>`; }

/* warning sound for plain notices (dialogs without a title are warnings; success dialogs pass a title) */
(function(){ const orig = window.showAlert; if(typeof orig==='function'){ window.showAlert = function(m, t){ if(!t) lookFeedback('warn'); return orig.apply(this, arguments); }; } })();
