/* ============================ COMPANY DETAILS & INVOICE SETTINGS ============================
   One shared record (sharedSettings 'company') — everyone on the crew sees the same details on invoices.
   Changing it affects invoices made afterwards only: an issued invoice keeps its own copy. */
const COMPANY_DEFAULTS = {id:'company', name:'', address:'', phone:'', email:'', logo:'', taxOn:false, taxRate:'14', taxLabel:'Tax', prefix:'INV', notes:'Thank you for your business.'};
async function getCompany(){ return Object.assign({}, COMPANY_DEFAULTS, (await getOne('sharedSettings','company')) || {}); }
async function saveCompany(c){ await put('sharedSettings', Object.assign({}, c, {id:'company'})); }

function companyCardHtml(c){
  return `<div class="card" style="margin-top:24px;" id="companyCard">
    <div class="section-title">Company &amp; invoices</div>
    <p class="subtle">Printed at the top of every invoice. Change it whenever you like — invoices already issued keep the details they were issued with.</p>
    <div class="co-logo-row">
      <div class="co-logo" id="co_logo_box">${c.logo ? `<img src="${esc(c.logo)}" alt="">` : '<span class="subtle">Logo</span>'}</div>
      <div style="display:flex; gap:8px; flex-wrap:wrap;">
        <label class="btn btn-ghost btn-sm" style="cursor:pointer;">Choose logo<input type="file" id="co_logo" accept="image/*" style="display:none;"></label>
        ${c.logo ? '<button class="btn btn-ghost btn-sm" id="co_logo_rm">Remove</button>' : ''}
      </div>
    </div>
    <div class="field"><label>Company name</label><input type="text" id="co_name" value="${esc(c.name)}"></div>
    <div class="field"><label>Address</label><textarea id="co_address" rows="2">${esc(c.address)}</textarea></div>
    <div class="row2">
      <div class="field"><label>Phone</label><input type="text" id="co_phone" value="${esc(c.phone)}"></div>
      <div class="field"><label>Email</label><input type="text" id="co_email" value="${esc(c.email)}"></div>
    </div>
    <div class="row2">
      <div class="field"><label>Invoice number prefix</label><input type="text" id="co_prefix" value="${esc(c.prefix)}"></div>
      <div class="field"><label>Tax name</label><input type="text" id="co_taxlabel" value="${esc(c.taxLabel)}"></div>
    </div>
    <div class="row2">
      <div class="field"><label>Tax rate %</label><input type="text" inputmode="decimal" id="co_taxrate" value="${esc(c.taxRate)}"></div>
      <div class="field"><label>New invoices</label><select id="co_taxon"><option value="0" ${c.taxOn?'':'selected'}>Without tax (default)</option><option value="1" ${c.taxOn?'selected':''}>With tax (default)</option></select></div>
    </div>
    <p class="subtle" style="margin-top:-4px;">You can still switch tax on or off for each invoice when you make it.</p>
    <div class="field"><label>Notes &amp; terms (printed at the bottom)</label><textarea id="co_notes" rows="2">${esc(c.notes)}</textarea></div>
    <button class="btn btn-signal btn-sm" id="co_save">Save company details</button>
  </div>`;
}
/* shrinks a chosen picture so the logo stays small (it is stored inside the record and printed on invoices) */
function shrinkImage(file, maxSide=360){
  return new Promise((resolve, reject)=>{
    const img = new Image(), url = URL.createObjectURL(file);
    img.onload = ()=>{
      const k = Math.min(1, maxSide/Math.max(img.width, img.height)), cv = document.createElement('canvas');
      cv.width = Math.round(img.width*k); cv.height = Math.round(img.height*k);
      cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
      URL.revokeObjectURL(url); resolve(cv.toDataURL('image/png'));
    };
    img.onerror = ()=>{ URL.revokeObjectURL(url); reject(new Error('That file is not a picture.')); };
    img.src = url;
  });
}
function bindCompanyCard(c){
  let logo = c.logo;
  const draw = ()=>{ $('#co_logo_box').innerHTML = logo ? `<img src="${esc(logo)}" alt="">` : '<span class="subtle">Logo</span>'; };
  $('#co_logo').onchange = async e=>{
    const f = e.target.files[0]; if(!f) return;
    try{ logo = await shrinkImage(f); draw(); }catch(err){ showAlert(err.message); }
    e.target.value = '';
  };
  if($('#co_logo_rm')) $('#co_logo_rm').onclick = ()=>{ logo = ''; draw(); };
  $('#co_save').onclick = async ()=>{
    const rate = $('#co_taxrate').value.trim();
    if(rate!=='' && !Dec.parse(rate)){ showAlert('Tax rate must be a plain number, like 14.'); return; }
    await saveCompany({name:$('#co_name').value.trim(), address:$('#co_address').value.trim(), phone:$('#co_phone').value.trim(), email:$('#co_email').value.trim(),
      logo, prefix:($('#co_prefix').value.trim()||'INV'), taxLabel:($('#co_taxlabel').value.trim()||'Tax'), taxRate:rate||'0', taxOn:$('#co_taxon').value==='1', notes:$('#co_notes').value.trim()});
    if(typeof syncNow==='function') syncNow();
    showAlert('Company details saved.', 'Saved');
  };
}
