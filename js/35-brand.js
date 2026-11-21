/* ==================================== SITE NAME (brand) ====================================
   The name at the top of the menu, on the login screen, in the mobile top bar and in the browser tab.
   It is written in two parts: the first in the normal text colour and the second in the theme colour
   — "Dock" + "line" by default, or e.g. "Gold " + "Star" for a company. Anyone who may change settings can set it;
   it is one shared record (sharedSettings 'brand'), so the whole crew sees the same name.
   A copy is kept in localStorage so the name is right on the login screen and before the first sync. */

const BRAND_DEFAULT = {name:'Dock', accent:'line'};
const BRAND_LIMIT = 24;            // characters per part
let _brand = Object.assign({}, BRAND_DEFAULT);

function brandClean(b){
  const one = v=> String(v==null ? '' : v).replace(/\s+/g,' ').slice(0, BRAND_LIMIT);
  const name = one(b && b.name).replace(/^ +/,''), accent = one(b && b.accent).replace(/ +$/,'');   // inner spaces are kept: "Gold " + "Star"
  return (name.trim() || accent.trim()) ? {name, accent} : Object.assign({}, BRAND_DEFAULT);
}
function brandPlain(b){ b = brandClean(b || _brand); return (b.name + b.accent).replace(/\s+/g,' ').trim(); }
function brandReadCache(){ try{ const v = JSON.parse(localStorage.getItem('dk_brand')||'null'); if(v) return brandClean(v); }catch(e){} return null; }
function brandWriteCache(b){ try{ if(b.name===BRAND_DEFAULT.name && b.accent===BRAND_DEFAULT.accent) localStorage.removeItem('dk_brand'); else localStorage.setItem('dk_brand', JSON.stringify(b)); }catch(e){} }
function applyBrand(b){
  _brand = brandClean(b);
  const html = esc(_brand.name) + '<span>' + esc(_brand.accent) + '</span>';
  document.querySelectorAll('.brand').forEach(el=>{ el.innerHTML = html; });
  const plain = brandPlain(_brand);
  document.title = plain + ' — Provisioning & Picking';
  document.querySelectorAll('.brandPlain').forEach(el=>{ el.textContent = plain; });
}
/* the saved shared record wins; with none (never set) the default name is used */
async function loadBrand(){
  let rec = null;
  try{ rec = await getOne('sharedSettings','brand'); }catch(e){}
  if(rec && !rec.deleted){ const b = brandClean(rec); applyBrand(b); brandWriteCache(b); }
  else if(!brandReadCache()) applyBrand(BRAND_DEFAULT);
}
async function saveBrand(b){
  b = brandClean(b);
  await put('sharedSettings', {id:'brand', name:b.name, accent:b.accent});
  applyBrand(b); brandWriteCache(b);
  if(typeof syncNow==='function') syncNow();
}

/* ---- the Settings card ---- */
function brandCardHtml(){
  if(typeof can==='function' && !can('settings.edit')) return '';
  const b = _brand;
  return `<div class="card" style="margin-top:24px;" id="brandCard">
    <div class="sec-h"><span class="sec-ic" data-ico="pencil"></span><div class="section-title">Site name</div></div>
    <p class="subtle">Shown at the top of the menu, on the login screen and in the browser tab, for everyone on the crew. The second box is written in the theme colour — in “Dockline” that is “line”.</p>
    <div class="row2">
      <div class="field"><label>First part</label><input type="text" id="br_name" maxlength="${BRAND_LIMIT}" value="${esc(b.name)}" autocomplete="off"></div>
      <div class="field"><label>Coloured part</label><input type="text" id="br_accent" maxlength="${BRAND_LIMIT}" value="${esc(b.accent)}" autocomplete="off"></div>
    </div>
    <p class="subtle" style="margin-top:-4px;">To separate two words, leave a space at the end of the first box (for example “Gold ” and “Star”).</p>
    <div class="brand" id="br_preview" style="padding:8px 0 14px; font-size:1.5rem;"></div>
    <div style="display:flex; gap:8px; flex-wrap:wrap;"><button class="btn btn-signal btn-sm" id="br_save">Save site name</button><button class="btn btn-ghost btn-sm" id="br_reset">Back to “Dockline”</button></div>
  </div>`;
}
function bindBrandCard(){
  if(!$('#brandCard')) return;
  const cur = ()=>({name:$('#br_name').value, accent:$('#br_accent').value});
  const preview = ()=>{ const b = brandClean(cur()); $('#br_preview').innerHTML = esc(b.name) + '<span>' + esc(b.accent) + '</span>'; };
  $('#br_name').oninput = $('#br_accent').oninput = preview;
  preview();
  $('#br_save').onclick = async ()=>{
    const v = cur();
    if(!(v.name+v.accent).trim()){ showAlert('Type a name first.'); return; }
    await saveBrand(v); showAlert('The site name was changed.', 'Saved');
  };
  $('#br_reset').onclick = async ()=>{
    await saveBrand(BRAND_DEFAULT);
    $('#br_name').value = BRAND_DEFAULT.name; $('#br_accent').value = BRAND_DEFAULT.accent; preview();
  };
}

/* paint the saved name before anything else loads (this script runs after the page's markup exists) */
applyBrand(brandReadCache() || BRAND_DEFAULT);
