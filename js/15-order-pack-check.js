/* ============================ QUANTITY CHECK FOR ORDERS ============================
   Between matching and picking: lines whose quantity isn't a whole number of packs are listed with a suggested
   quantity (same rule, same pack sizes and same "loose" settings as the Order Splitter). The vessel's own
   number stays on the line (excelQty); requestedQty becomes what will really be picked and ordered.
   ================================================================================= */
async function beginPicking(orderId){
  const order = await getOne('orders', orderId);
  const fresh = (await getAll('orderItems')).filter(it=>it.orderId===orderId);
  const sorted = fresh.filter(it=>it.status==='pending').sort((a,b)=>{
    for(let i=0;i<3;i++){ if(a.sortKey[i]!==b.sortKey[i]) return a.sortKey[i]-b.sortKey[i]; }
    return 0;
  });
  order.status = 'picking';
  order.queue = sorted.map(it=>it.id);
  order.postponed = [];
  await put('orders', order);
  location.hash = `#/order/${orderId}/pick`;
}

const orderVesselKey = (order)=>{ const n = cleanVesselName(order.vessel||'') || order.vessel || ''; return n ? vesselKeyOf(n) : ''; };

/* the lines of an order that need a look (not whole packs, or marked loose for this vessel) */
async function orderPackLines(order, items, manual){
  const [products, batches, st] = await Promise.all([getAll('products'), getAll('batches'), getPackSettings()]);
  const prod = new Map(products.map(p=>[p.id,p]));
  const loose = new Set(st.loose[orderVesselKey(order)] || []);
  const rows = [], unjudged = [];
  for(const it of items){
    if(it.status!=='pending' || !it.productId) continue;
    const p = prod.get(it.productId); if(!p) continue;
    const base = it.qtyAdjusted ? it.excelQty : it.requestedQty;
    const isLoose = loose.has(p.id);
    let check = isLoose ? null : packCheck({qty:base, unit:it.requestedUnit}, p, batches, st.mode), isManual = false;
    const m = manual && manual.get(it.id);
    if(!check && !isLoose && m){   // an item added by hand for this order: its own step and rule
      check = packCheck({qty:base, unit:it.requestedUnit}, {...p, packSize:m.step, packName:m.name, packRound:m.mode}, [], st.mode);
      isManual = !!check;
    }
    if(check || isLoose) rows.push({it, p, base, check, isLoose, isManual, choice:'suggest', custom:''});
    else if(packUnjudgeable({qty:base, unit:it.requestedUnit}, p, batches)) unjudged.push({it, p, base});
  }
  return {rows, st, unjudged};
}
async function needsQuantityCheck(order, items){
  if(order.packChecked) return false;
  const {rows, unjudged} = await orderPackLines(order, items);
  return rows.length>0 || unjudged.length>0;
}

async function orderQuantityCheck(orderId){
  const order = await getOne('orders', orderId);
  if(!order){ location.hash='#/orders'; return; }
  const items = (await getAll('orderItems')).filter(it=>it.orderId===orderId);
  const manual = new Map();   // items added by hand for this order only: itemId -> {step, name, mode}
  let {rows, st, unjudged} = await orderPackLines(order, items, manual);
  const vKey = orderVesselKey(order), vName = cleanVesselName(order.vessel||'') || order.vessel || 'this vessel';
  const finalQty = r=> !r.check ? r.base : r.choice==='keep' ? r.base : (r.choice==='custom' && parseFloat(r.custom)>0) ? parseFloat(r.custom) : r.check.suggested;
  const reload = async ()=>{ const old = new Map(rows.map(r=>[r.it.id,r])); const n = await orderPackLines(order, items, manual); rows = n.rows; st = n.st; unjudged = n.unjudged;
    rows.forEach(r=>{ const o = old.get(r.it.id); if(o){ r.choice=o.choice; r.custom=o.custom; } }); };

  const ruleName = m=> ({up:'round up', nearest:'nearest', down:'round down'})[m]||m;
  const ruleOf = r=> r.isManual ? (manual.get(r.it.id).mode||'') : (r.p.packRound||'');
  function draw(){
    const flagged = rows.filter(r=>r.check), loose = rows.filter(r=>r.isLoose);
    const unit = r=> r.it.requestedUnit ? ' '+esc(r.it.requestedUnit) : '';
    $('#main').innerHTML = `
      <div class="topbar"><h1>Quantity check</h1></div>
      <p class="subtle" style="margin-top:-10px;">${esc(vName)} · ${esc(order.orderNumber||'')}</p>
      <div class="bt-card" style="margin-bottom:16px;">
        <p class="subtle" style="margin:0 0 10px;">${flagged.length ? `${flagged.length} line${flagged.length===1?' isn’t':'s aren’t'} a whole number of packs. The vessel’s own quantity is always kept on the order.` : 'Nothing needs changing.'}</p>
        <div class="subtle" style="font-weight:700; margin-bottom:6px;">Rounding rule — applies to every vessel</div>
        <div class="tag-row" id="oq_mode" style="margin-bottom:12px;">${[['up','Round up'],['nearest','Nearest'],['down','Round down']].map(([m,l])=>`<button class="chip ${st.mode===m?'active':''}" data-m="${m}">${l}</button>`).join('')}</div>
        <div style="display:flex; gap:8px; flex-wrap:wrap; margin-bottom:6px;"><button class="btn btn-ghost btn-sm" id="oq_add">+ Check another item</button><button class="btn btn-ghost btn-sm" id="oq_whole">Round the rest up to whole numbers</button></div>
        ${flagged.length>1?`<div style="display:flex; gap:8px; flex-wrap:wrap; margin-bottom:6px;"><button class="btn btn-ghost btn-sm" id="oq_all">Accept all suggestions</button><button class="btn btn-ghost btn-sm" id="oq_none">Keep all as ordered</button></div>`:''}
        ${flagged.map(r=>`<div class="qc-row" data-id="${r.it.id}">
          <b>${esc(r.it.productName||r.it.excelDesc)}</b>
          <div class="subtle">Ordered ${r.base}${unit(r)} · ${r.isManual?'in multiples of':'pack'} ${r.check.pack.size} (${esc(r.check.pack.name)})${r.check.pack.fromBatch?' · from batch':''}${r.isManual?' · this order only':''}</div>
          <div class="tag-row" style="margin:8px 0 0;">
            <button class="chip ${r.choice==='suggest'?'active':''}" data-c="suggest">${r.check.suggested}${unit(r)} · ${r.check.packs} ${esc(packPlural(r.check.pack.name, r.check.packs))}</button>
            <button class="chip ${r.choice==='keep'?'active':''}" data-c="keep">Keep ${r.base}</button>
            <input type="number" step="any" inputmode="decimal" class="qc-custom ${r.choice==='custom'?'on':''}" placeholder="Other" value="${r.choice==='custom'?esc(r.custom):''}">
          </div>
          <label class="qc-rule">Rounding for this item <select data-rule>${[['','Use the general rule ('+ruleName(st.mode)+')'],['up','Always round up'],['nearest','Round to nearest'],['down','Always round down']].map(([v,l])=>`<option value="${v}" ${ruleOf(r)===v?'selected':''}>${l}</option>`).join('')}</select></label>
          ${vKey?`<button class="qc-link" data-loose="${r.p.id}">Sold loose to ${esc(vName)} — don’t check this item</button>`:''}
        </div>`).join('')}
        ${loose.length?`<div class="subtle" style="margin-top:12px;"><b>Loose for ${esc(vName)}:</b> ${loose.map(r=>`${esc(r.it.productName||r.it.excelDesc)} <button class="qc-link" data-unloose="${r.p.id}">undo</button>`).join(' · ')}</div>`:''}
      </div>
      ${unjudged.length?`<div class="bt-warn"><div class="bt-warn-h"><span class="bt-warn-ic">⚠</span><div><b>${unjudged.length} item${unjudged.length===1?'':'s'} couldn’t be checked</b>
        <div class="subtle">The ordered unit doesn’t match the product’s unit, so the app can’t tell if it’s a whole pack. They stay as ordered.</div></div></div>
        ${unjudged.map(u=>`<div class="bt-warn-row"><span><b>${esc(u.it.productName||u.it.excelDesc)}</b><span class="subtle" style="display:block;">ordered ${u.base} ${esc(u.it.requestedUnit||'')} · product is kept in “${esc(u.p.unit||'no unit')}”</span></span>
          <button class="btn btn-ghost btn-sm" data-fixunit="${u.p.id}">Edit product</button></div>`).join('')}</div>`:''}
      <div style="display:flex; gap:10px; flex-wrap:wrap;">
        <button class="btn btn-signal btn-lg" id="oq_go" style="flex:1;">Apply &amp; start picking</button>
        <a class="btn btn-ghost btn-lg" style="text-decoration:none;" href="#/order/${orderId}/match">Back to matching</a>
      </div>`;
    $('#oq_mode').onclick = async e=>{ const b = e.target.closest('[data-m]'); if(!b) return; st.mode = b.dataset.m; await savePackSettings(st); rows.forEach(r=>{ r.choice='suggest'; r.custom=''; }); await reload(); draw(); };
    const all = $('#oq_all'); if(all) all.onclick = ()=>{ rows.forEach(r=>{ if(r.check) r.choice='suggest'; }); draw(); };
    const none = $('#oq_none'); if(none) none.onclick = ()=>{ rows.forEach(r=>{ if(r.check) r.choice='keep'; }); draw(); };
    $('#main').querySelectorAll('.qc-row').forEach(card=>{
      const r = rows.find(x=>x.it.id===card.dataset.id);
      card.querySelectorAll('[data-c]').forEach(b=>b.onclick = ()=>{ r.choice = b.dataset.c; draw(); });
      const inp = card.querySelector('.qc-custom');
      inp.onchange = ()=>{ if(parseFloat(inp.value)>0){ r.choice='custom'; r.custom=inp.value; } else { r.choice='suggest'; r.custom=''; } draw(); };
    });
    $('#main').querySelectorAll('.qc-row').forEach(card=>{
      const r = rows.find(x=>x.it.id===card.dataset.id), sel = card.querySelector('[data-rule]');
      sel.onchange = async ()=>{
        if(r.isManual) manual.get(r.it.id).mode = sel.value;
        else { r.p.packRound = sel.value; await put('products', r.p); }   // saved on the item: used every time from now on
        r.choice = 'suggest'; r.custom = ''; await reload(); draw();
      };
    });
    $('#oq_add').onclick = ()=>openAddCheck();
    $('#main').querySelectorAll('[data-fixunit]').forEach(b=>b.onclick = async ()=>{
      const [whs, secs, sups, p] = await Promise.all([getAll('warehouses'), getAll('sections'), getAll('suppliers'), getOne('products', b.dataset.fixunit)]);
      openProductForm(p, whs, secs, sups, async ()=>{ await reload(); draw(); });
    });
    $('#oq_whole').onclick = async ()=>{
      let n = 0;
      for(const it of items){
        if(it.status!=='pending' || !it.productId || rows.some(r=>r.it.id===it.id)) continue;
        const base = it.qtyAdjusted ? it.excelQty : it.requestedQty;
        if(!(base>0) || Math.abs(base-Math.round(base))<1e-6) continue;
        manual.set(it.id, {step:1, name:(it.requestedUnit||'unit'), mode:'up'}); n++;
      }
      if(!n) return showAlert('Every other item is already a whole number.');
      await reload(); draw();
    };
    const setLoose = async (pid, on)=>{ const set = new Set(st.loose[vKey]||[]); if(on) set.add(pid); else set.delete(pid); st.loose[vKey] = [...set]; await savePackSettings(st); await reload(); draw(); };
    $('#main').querySelectorAll('[data-loose]').forEach(b=>b.onclick = ()=>setLoose(b.dataset.loose, true));
    $('#main').querySelectorAll('[data-unloose]').forEach(b=>b.onclick = ()=>setLoose(b.dataset.unloose, false));
    $('#oq_go').onclick = async ()=>{
      $('#oq_go').disabled = true;
      const touched = new Map(rows.map(r=>[r.it.id, r]));
      for(const it of items){
        const r = touched.get(it.id);
        if(it.status!=='pending') continue;
        const base = it.qtyAdjusted ? it.excelQty : it.requestedQty;
        const q = r ? finalQty(r) : base;
        if(round2(q)!==round2(base)){ it.requestedQty = round2(q); it.qtyAdjusted = true; await put('orderItems', it); }
        else if(it.qtyAdjusted){ it.requestedQty = it.excelQty; it.qtyAdjusted = false; await put('orderItems', it); }
      }
      order.packChecked = true; await put('orders', order);
      await beginPicking(orderId);
    };
  }
  async function openAddCheck(){
    const taken = new Set(rows.map(r=>r.it.id));
    const prods = new Map((await getAll('products')).map(p=>[p.id,p]));
    const cand = items.filter(it=>it.status==='pending' && it.productId && prods.has(it.productId) && !taken.has(it.id));
    if(!cand.length) return showAlert('Every item of this order is already in the check.');
    showModal(`<h3>Check another item</h3>
      <div class="field"><label>Item</label><select id="ac_item">${cand.map(it=>`<option value="${it.id}">${esc(it.productName||it.excelDesc)} — ${it.qtyAdjusted?it.excelQty:it.requestedQty} ${esc(it.requestedUnit||'')}</option>`).join('')}</select></div>
      <div class="row2"><div class="field"><label>Order in multiples of</label><input type="number" step="any" inputmode="decimal" id="ac_step" placeholder="e.g. 1 or 12" autofocus></div>
      <div class="field"><label>Called</label><input type="text" id="ac_name" placeholder="kg, box, pack"></div></div>
      <div class="field"><label>Rounding</label><select id="ac_mode"><option value="up">Round up</option><option value="">Use the general rule</option><option value="nearest">Round to nearest</option><option value="down">Round down</option></select></div>
      <label class="bt-switch"><input type="checkbox" id="ac_save" checked><span><b>Remember for this item</b><small>Saves it as the item's pack size and rounding, so it's checked automatically next time.</small></span></label>
      <div style="display:flex; gap:10px; margin-top:12px;"><button class="btn btn-signal" id="ac_ok" style="flex:1;">Add to check</button><button class="btn btn-ghost" onclick="closeModal()">Cancel</button></div>`);
    $('#ac_ok').onclick = async ()=>{
      const step = parseFloat($('#ac_step').value);
      if(!(step>0)) return showAlert('Enter the step, for example 1 or 12.');
      const it = cand.find(x=>x.id===$('#ac_item').value), p = prods.get(it.productId);
      const name = $('#ac_name').value.trim() || p.unit || 'pack', mode = $('#ac_mode').value;
      if($('#ac_save').checked){ p.packSize = step; p.packName = name; p.packRound = mode; await put('products', p); }
      else manual.set(it.id, {step, name, mode});
      closeModal(); await reload();
      const row = rows.find(r=>r.it.id===it.id);
      draw();
      if(!row) showAlert('That quantity is already a whole number of '+step+' '+name+', so nothing needs changing.', 'No change needed');
    };
  }
  draw();
}
