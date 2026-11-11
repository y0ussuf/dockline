/* ============================ INVOICES ============================
   One invoice per order type (Provision, Bond, Cash…) of a finished order, built from what was actually
   picked. Quantities are as picked, prices as stored — all maths is exact (see 17-money.js), nothing is
   rounded. A draft can be edited; once issued an invoice is locked: to fix it, cancel it (its number stays
   on record) and make a new one. */
const INV_STATUS = {draft:'Draft', issued:'Issued', cancelled:'Cancelled'};
const dm = v=> Dec.parse(v) || Dec.ZERO;
const money = d=> Dec.fmt(d, 2);

/* the picked lines of one order type, ready to price */
function invoiceLinesFromItems(items, byProd, basis, whMap){
  const lines = [];
  const push = (it, productId, desc, qty, unit)=>{
    const q = Dec.parse(qty); if(!q || Dec.cmp(q, Dec.ZERO)<=0) return;
    const p = productId ? byProd.get(productId) : null;
    lines.push({id:uid(), itemId:it.id, productId:productId||'', desc, qty:Dec.str(q), unit:unit||'',
      cost:(p&&seesCost()&&p.costPrice)||'', sell:(p&&seesSell()&&p.sellPrice)||'', price:(p ? (basis==='cost'?(seesCost()&&p.costPrice):(seesSell()&&p.sellPrice)) : '')||'',
      priceUnit:(p&&p.unit)||'', ref:(p&&p.priceRef)||null, nameSize:(p&&parseSize(p.name))?{qty:parseSize(p.name).qty,unit:parseSize(p.name).unit}:null,
      lump:lumpOf(p, whMap), discType:'', disc:'', include:true, substituted:it.status==='substituted',
      ordered:it.excelDesc||'', doubt:(productId && it.status!=='substituted' && it.excelDesc) ? (mapRisk(it.excelDesc, p?p.name:desc).level===2 ? mapRisk(it.excelDesc, p?p.name:desc).reason : '') : ''});
  };
  for(const it of items){
    if(it.status==='not_available' || it.status==='pending' || it.status==='unmatched') continue;
    if(it.status==='substituted'){
      const reps = replacementsOf(it);
      if(reps.length){ reps.forEach(r=>push(it, r.productId, r.name || it.replacementName || it.excelDesc, r.qty, r.unit)); continue; }
    }
    push(it, it.productId, it.productName || it.excelDesc, it.actualQty, it.actualUnit || it.requestedUnit);
  }
  return lines;
}
/* How one line is priced. Without a reference size the price is per picked unit (qty × price). With one
   ("65 per 200 ml") the price is pro-rata: the picked size decides — 350 ml → 65 × 350 ÷ 200 = 113.75 each.
   Returns {unit, gross, note, issue, rounded}; gross is exact unless the person's rounding rule says otherwise. */
function lineCalc(l, priceText, roundMode){
  const price = Dec.parse(priceText), qty = Dec.parse(l.qty);
  const out = {unit:null, gross:Dec.ZERO, note:'', issue:'', rounded:false, exactText:''};
  if(!price || !qty) return out;
  if(l.unitOverride && Dec.parse(l.unitOverride)){ out.unit = Dec.parse(l.unitOverride); out.gross = Dec.mul(qty, out.unit); out.note = 'unit price typed by you'; return out; }
  const refSz = l.ref ? parseMeasure(l.ref.qty+' '+l.ref.unit) : null;
  if(!refSz || Dec.cmp(refSz.base, Dec.ZERO)<=0){ out.unit = price; out.gross = Dec.mul(qty, price); return out; }     // plain price per picked unit
  // pro-rata: what size is one picked unit?
  let pk = l.sizeOverride ? parseMeasure(l.sizeOverride) : parseMeasure(l.unit);
  if(!pk && !l.sizeOverride && l.nameSize && sameSize(parseMeasure(l.nameSize.qty+' '+l.nameSize.unit), refSz) && !l.perPiece){
    // "Pesto sauce 180 GM" priced per 180 gm and picked as "5 PCS": the unit is one jar of that size
    pk = refSz;
  }
  if(l.perPiece){ out.unit = price; out.gross = Dec.mul(qty, price); out.note = 'billed per piece at the price as is'; return out; }
  if(!pk){ out.issue = 'Size needed'; return out; }
  if(pk.family!==refSz.family){ out.issue = 'Unit not comparable'; return out; }
  const unitRat = Rat.mul(Rat.fromDec(price), Rat.div(Rat.fromDec(pk.base), Rat.fromDec(refSz.base)));
  const grossRat = Rat.mul(Rat.fromDec(qty), unitRat);
  const sz = pk.qty+' '+pk.unit, work = `${Dec.fmt(qty,0)} × ${sz} ÷ ${l.ref.qty} ${l.ref.unit} × ${Dec.fmt(price,0)}`;
  const g = Rat.toDec(grossRat), u = Rat.toDec(unitRat);
  if(g){
    out.gross = g; out.unit = u || Rat.roundHalfUp(unitRat, 4);   // unit price on the printout only; the total above is exact
    out.note = `${work} = ${Dec.fmt(g,2)}`; out.unitApprox = !u; return out;
  }
  out.exactText = Rat.peek(grossRat);
  if(roundMode==='half_up'){
    out.gross = Rat.roundHalfUp(grossRat, 2); out.unit = Rat.roundHalfUp(unitRat, 4); out.unitApprox = true; out.rounded = true;
    out.note = `${work} = ${out.exactText} → ${Dec.fmt(out.gross,2)} (rounded half up, per your rule)`; return out;
  }
  out.issue = roundMode==='block' ? 'Does not divide exactly' : 'Does not divide exactly — type the unit price';
  out.note = `${work} = ${out.exactText}`;
  return out;
}
/* every number of an invoice, exactly */
function invoiceTotals(inv){
  let sub = Dec.ZERO, disc = Dec.ZERO;
  const rows = inv.lines.map(l=>{
    if(!l.include || l.lump) return {gross:Dec.ZERO, disc:Dec.ZERO, net:Dec.ZERO, calc:{}};    // group lines are priced by their group below
    const calc = lineCalc(l, l.price, inv.roundMode), gross = calc.gross;
    let d = Dec.ZERO;
    if(l.discType==='pct' && Dec.parse(l.disc)) d = Dec.pct(gross, dm(l.disc));
    else if(l.discType==='amt' && Dec.parse(l.disc)) d = dm(l.disc);
    sub = Dec.add(sub, gross); disc = Dec.add(disc, d);
    return {gross, disc:d, net:Dec.sub(gross, d), calc};
  });
  const lumpRows = (inv.lumps||[]).map(g=>{
    if(!g.include) return {gross:Dec.ZERO, disc:Dec.ZERO, net:Dec.ZERO};
    const c = lumpCalc(g); sub = Dec.add(sub, c.gross); disc = Dec.add(disc, c.disc); return c;
  });
  const taxable = Dec.sub(sub, disc);
  const tax = inv.taxOn ? Dec.pct(taxable, dm(inv.taxRate)) : Dec.ZERO;
  return {rows, lumpRows, sub, disc, taxable, tax, total:Dec.add(taxable, tax)};
}
function lineIssues(l, inv, calc){
  const w = [];
  if(!l.include) return w;
  if(l.doubt && !l.doubtOk) w.push('Check match');
  if(l.lump) return w;
  if(l.price==='' || !Dec.parse(l.price)){ w.push('No price'); return w; }
  if(Dec.cmp(dm(l.price), Dec.ZERO)===0) w.push('Price is 0');
  calc = calc || lineCalc(l, l.price, inv.roundMode);
  if(calc.issue) w.push(calc.issue);
  if(!l.ref){
    const u = normalize(l.unit), pu = normalize(l.priceUnit);
    if(u && pu && u!==pu) w.push(`Picked in “${l.unit}”, price is per “${l.priceUnit}” — check`);
  }
  if(l.substituted) w.push('Substituted item — check the price');
  const cost = Dec.parse(l.cost);
  if(cost && !calc.issue){
    const cc = lineCalc(l, l.cost, inv.roundMode);
    if(!cc.issue){
      const net = invoiceTotals({lines:[l], taxOn:false, roundMode:inv.roundMode}).rows[0].net;
      if(Dec.cmp(net, cc.gross)<0) w.push('Below cost');
    }
  }
  return w;
}
async function nextInvoiceNumber(prefix){
  const year = new Date().getFullYear(), head = `${prefix}-${year}-`;
  let max = 0;
  for(const i of await getAll('invoices')){ if(i.number && i.number.startsWith(head)){ const n = parseInt(i.number.slice(head.length), 10); if(n>max) max = n; } }
  return head + String(max+1).padStart(4,'0');
}
const invBadge = s=> `<span class="badge inv-${s}">${INV_STATUS[s]||s}</span>`;

/* ---------- the printed document ---------- */
function invoiceDocHtml(inv){
  const co = inv.company || {}, t = invoiceTotals(inv), lines = inv.lines.map((l,i)=>({l,r:t.rows[i]})).filter(x=>x.l.include);
  const lines0 = lines; const lineRows = lines0.filter(x=>!x.l.lump);
  const lumps = (inv.lumps||[]).map((g,i)=>({g, r:t.lumpRows[i]})).filter(x=>x.g.include);
  const anyDisc = lines.some(x=>Dec.cmp(x.r.disc,Dec.ZERO)!==0) || lumps.some(x=>Dec.cmp(x.r.disc,Dec.ZERO)!==0);
  return `<div class="inv-doc ${inv.status==='cancelled'?'is-cancelled':''}" id="inv_doc">
    ${inv.status==='cancelled' ? '<div class="inv-stamp">CANCELLED</div>' : ''}
    <div class="inv-head">
      <div class="inv-co">${co.logo?`<img class="inv-logo" src="${esc(co.logo)}" alt="">`:''}
        <div><div class="inv-co-name">${esc(co.name||'')}</div>
          <div class="inv-sub">${esc(co.address||'').replace(/\n/g,'<br>')}</div>
          <div class="inv-sub">${[co.phone,co.email].filter(Boolean).map(esc).join(' · ')}</div></div></div>
      <div class="inv-title"><div class="inv-h1">SALES INVOICE</div><div class="inv-no">${inv.number?esc(inv.number):'DRAFT'}</div></div>
    </div>
    <div class="inv-meta">
      <div><div class="inv-k">Bill to (vessel)</div><div class="inv-v">${esc(inv.vessel)}</div><div class="inv-sub">${esc(inv.code||'')}</div></div>
      <div><div class="inv-k">Order type</div><div class="inv-v">${esc(inv.orderType)}</div><div class="inv-sub">Order ${esc(inv.orderNumber||'')}</div></div>
      <div><div class="inv-k">Invoice date</div><div class="inv-v">${fmtDate(inv.invoiceDate)}</div></div>
    </div>
    <div class="inv-tw"><table class="inv-table"><thead><tr><th>#</th><th>Description</th><th class="n">Qty</th><th>Unit</th><th class="n">Unit price</th>${anyDisc?'<th class="n">Discount</th>':''}<th class="n">Total</th></tr></thead><tbody>
      ${lineRows.map((x,i)=>`<tr><td class="subtle">${String(i+1).padStart(2,'0')}</td><td><b>${esc(x.l.desc)}</b></td><td class="n">${Dec.fmt(dm(x.l.qty),0)}</td><td>${esc(x.l.unit)}</td><td class="n">${money(x.r.calc.unit || dm(x.l.price))}</td>${anyDisc?`<td class="n">${Dec.cmp(x.r.disc,Dec.ZERO)===0?'—':money(x.r.disc)}</td>`:''}<td class="n"><b>${money(x.r.net)}</b></td></tr>`).join('')}
      ${lumps.map((x,i)=>`<tr><td class="subtle">${String(lineRows.length+i+1).padStart(2,'0')}</td><td><b>${esc(x.g.group)}</b></td><td class="n">1</td><td>lot</td><td class="n">${money(x.r.gross)}</td>${anyDisc?`<td class="n">${Dec.cmp(x.r.disc,Dec.ZERO)===0?'—':money(x.r.disc)}</td>`:''}<td class="n"><b>${money(x.r.net)}</b></td></tr>`).join('')}
    </tbody></table></div>
    <div class="inv-foot">
      <div class="inv-notes"><div class="inv-k">Notes &amp; terms</div><div>${esc(inv.notes||'').replace(/\n/g,'<br>')}</div></div>
      <div class="inv-tot">
        <div><span>Subtotal</span><span>${money(t.sub)} EGP</span></div>
        <div><span>Total discount</span><span>- ${money(t.disc)} EGP</span></div>
        <div><span>${esc(inv.taxLabel||'Tax')} (${inv.taxOn?esc(Dec.fmt(dm(inv.taxRate),0)):'0'}%)</span><span>${money(t.tax)} EGP</span></div>
        <div class="grand"><span>Total</span><span>${money(t.total)} EGP</span></div>
      </div>
    </div>
    <div class="inv-sign"><div><span>Receiver's signature</span></div><div><span>Company stamp</span></div></div>
  </div>`;
}

/* ---------- list ---------- */
route('invoices', async ()=>{
  const all = (await getAll('invoices')).sort((a,b)=> (b.createdAt||'').localeCompare(a.createdAt||''));
  const f = window.__invFilter || 'all';
  const view = all.filter(i=> f==='all' || i.status===f);
  const nums = new Map(); all.forEach(i=>{ if(i.number) nums.set(i.number,(nums.get(i.number)||0)+1); });
  $('#main').innerHTML = `
    <div class="topbar"><h1>Invoices</h1><button class="btn btn-signal btn-sm" id="inv_new">+ New invoice</button></div>
    <div class="tag-row" id="inv_f">${[['all','All'],['draft','Drafts'],['issued','Issued'],['cancelled','Cancelled']].map(([k,l])=>`<button class="chip ${f===k?'active':''}" data-f="${k}">${l} · ${k==='all'?all.length:all.filter(i=>i.status===k).length}</button>`).join('')}</div>
    <div class="card" style="margin-top:12px;">${view.length ? view.map(i=>{ const t = invoiceTotals(i); return `
      <a class="list-row inv-row" href="#/invoice/${i.id}">
        <div style="flex:1; min-width:0;"><b>${i.number?esc(i.number):'Draft'}</b> ${nums.get(i.number)>1?'<span class="badge b-unmatched">duplicate number</span>':''}
          <div class="subtle">${esc(i.vessel)} · ${esc(i.orderType)} · ${fmtDate(i.invoiceDate)}</div></div>
        <div style="text-align:right;"><b>${money(t.total)}</b> <span class="subtle">EGP</span><div>${invBadge(i.status)}</div></div>
      </a>`; }).join('') : `<div class="empty"><div class="ic">🧾</div>${all.length?'Nothing here.':'No invoices yet. Open a completed order and make one.'}</div>`}</div>`;
  $('#inv_f').querySelectorAll('[data-f]').forEach(b=>b.onclick=()=>{ window.__invFilter = b.dataset.f; routes['invoices']([]); });
  $('#inv_new').onclick = async ()=>{
    const orders = (await getAll('orders')).filter(o=>o.status==='completed').sort(compareOrdersForList);
    showModal(`<h3>Invoice which order?</h3><div style="max-height:55vh; overflow:auto;">${orders.length ? orders.map(o=>`<a class="list-row" href="#/invoice/order/${o.id}" onclick="closeModal()"><div style="flex:1;"><b>${esc(o.vessel)}</b><div class="subtle">${esc(o.orderNumber)} · ${fmtDate(o.orderDate)}</div></div></a>`).join('') : '<p class="subtle">No completed orders yet.</p>'}</div><button class="btn btn-ghost" style="margin-top:10px;" onclick="closeModal()">Close</button>`);
  };
});

/* ---------- per order: one invoice per type ---------- */
route('invoice', async (parts)=>{
  if(parts[0]==='order') return invoiceOrderScreen(parts[1]);
  return invoiceScreen(parts[0]);
});
async function invoiceOrderScreen(orderId){
  const [order, allItems, invs, products, co, whs] = await Promise.all([getOne('orders', orderId), getAll('orderItems'), getAll('invoices'), getAll('products'), getCompany(), getAll('warehouses')]);
  const whMap = new Map(whs.map(w=>[w.id,w]));
  if(!order){ location.hash = '#/invoices'; return; }
  const items = allItems.filter(it=>it.orderId===orderId).sort((a,b)=>(a.importIndex||0)-(b.importIndex||0));
  const byProd = new Map(products.map(p=>[p.id,p]));
  const types = [...new Set(items.map(it=>it.orderType||'Provision'))];
  const mine = invs.filter(i=>i.orderId===orderId);
  $('#main').innerHTML = `
    <div class="topbar"><h1>Invoices</h1><a class="btn btn-ghost btn-sm" href="#/order/${order.id}/summary">← Order</a></div>
    <p class="subtle" style="margin-top:-10px;">${esc(order.vessel)} · ${esc(order.imo||order.orderNumber)} — one invoice for each type of order in this sheet, built from what was picked.</p>
    ${order.status!=='completed' ? '<div class="bt-warn" style="margin-bottom:14px;"><b>This order is not finished yet.</b><div class="subtle">Only lines already picked are included. Finish the order first so the quantities are final.</div></div>' : ''}
    ${types.map(t=>{
      const its = items.filter(it=>(it.orderType||'Provision')===t), lines = invoiceLinesFromItems(its, byProd, 'sell', whMap);
      const have = mine.filter(i=>i.orderType===t).sort((a,b)=>(b.createdAt||'').localeCompare(a.createdAt||''));
      const live = have.find(i=>i.status!=='cancelled');
      return `<div class="card" style="margin-bottom:14px;"><div style="display:flex; justify-content:space-between; gap:10px; align-items:center; flex-wrap:wrap;">
        <div><b style="font-size:1.1rem;">${esc(t)}</b><div class="subtle">${its.length} line${its.length===1?'':'s'} · ${lines.length} to bill</div></div>
        ${live ? `<a class="btn btn-ghost btn-sm" href="#/invoice/${live.id}">Open ${live.number?esc(live.number):'draft'} ${invBadge(live.status)}</a>` : `<button class="btn btn-signal btn-sm" data-mk="${esc(t)}" ${lines.length?'':'disabled'}>Create invoice</button>`}
      </div>${have.filter(i=>i!==live).length ? `<div class="subtle" style="margin-top:8px;">Earlier: ${have.filter(i=>i!==live).map(i=>`<a href="#/invoice/${i.id}">${esc(i.number||'draft')}</a> (${INV_STATUS[i.status]})`).join(' · ')}</div>`:''}</div>`; }).join('')}`;
  $('#main').querySelectorAll('[data-mk]').forEach(b=>b.onclick=async ()=>{
    const t = b.dataset.mk;
    const inv = {id:uid(), number:'', status:'draft', orderId:order.id, orderType:t, vessel:order.vessel, code:order.imo||'', orderNumber:order.orderNumber,
      priceBasis:(seesSell()?'sell':'cost'), taxOn:!!co.taxOn, taxRate:co.taxRate, taxLabel:co.taxLabel, invoiceDate:todayISO(), notes:co.notes||'', roundMode:co.roundMode||'ask',
      lines: invoiceLinesFromItems(items.filter(it=>(it.orderType||'Provision')===t), byProd, 'sell', whMap), createdAt:new Date().toISOString()};
    inv.lumps = [...new Set(inv.lines.filter(l=>l.lump).map(l=>l.lump))].map(g=>({id:uid(), group:g, amount:'', markup:'', ref:'', discType:'', disc:'', include:true}));
    await put('invoices', inv); location.hash = '#/invoice/'+inv.id;
  });
}

/* ---------- one invoice: edit a draft / view an issued one ---------- */
async function invoiceScreen(id){
  let inv = await getOne('invoices', id);
  if(!inv){ location.hash = '#/invoices'; return; }
  const products = await getAll('products'); const byProd = new Map(products.map(p=>[p.id,p]));
  const save = async ()=>{ await put('invoices', inv); };
  function draw(){
    if(inv.status!=='draft'){
      $('#main').innerHTML = `
        <div class="topbar no-print"><h1>${esc(inv.number)}</h1>${invBadge(inv.status)}</div>
        <div class="no-print" style="display:flex; gap:8px; flex-wrap:wrap; margin-bottom:14px;">
          <button class="btn btn-signal btn-sm" id="iv_print">🖨 Print / save as PDF</button>
          <button class="btn btn-ghost btn-sm" id="iv_xls">⬇ Excel</button>
          ${inv.status==='issued' ? '<button class="btn btn-ghost btn-sm" id="iv_cancel" style="color:var(--danger);">Cancel invoice</button>' : '<button class="btn btn-ghost btn-sm" id="iv_redo">Make a new draft from this</button>'}
          <a class="btn btn-ghost btn-sm" href="#/invoice/order/${inv.orderId}">Order invoices</a>
        </div>
        ${inv.status==='cancelled' ? `<div class="bt-warn no-print" style="margin-bottom:12px;">Cancelled ${fmtDate(inv.cancelledAt)}${inv.cancelReason?' — '+esc(inv.cancelReason):''}. The number stays on record.</div>`:''}
        ${invoiceDocHtml(inv)}`;
      $('#iv_print').onclick = ()=>window.print();
      $('#iv_xls').onclick = ()=>exportInvoiceExcel(inv);
      if($('#iv_cancel')) $('#iv_cancel').onclick = ()=>{
        showModal(`<h3>Cancel ${esc(inv.number)}?</h3><p class="subtle">It can't be edited. The cancelled invoice and its number stay on record; you can then make a corrected one.</p><div class="field"><label>Reason (optional)</label><input type="text" id="cx_reason"></div>
          <div style="display:flex; gap:10px;"><button class="btn btn-signal" id="cx_go" style="flex:1; background:var(--danger);">Cancel invoice</button><button class="btn btn-ghost" onclick="closeModal()">Keep it</button></div>`);
        $('#cx_go').onclick = async ()=>{ inv.status='cancelled'; inv.cancelledAt = new Date().toISOString(); inv.cancelReason = $('#cx_reason').value.trim(); await save(); closeModal(); if(typeof syncNow==='function') syncNow(); draw(); };
      };
      if($('#iv_redo')) $('#iv_redo').onclick = async ()=>{
        const n = Object.assign({}, inv, {id:uid(), number:'', status:'draft', createdAt:new Date().toISOString(), issuedAt:undefined, cancelledAt:undefined, cancelReason:undefined, invoiceDate:todayISO(), lines:inv.lines.map(l=>Object.assign({}, l, {id:uid()})), lumps:(inv.lumps||[]).map(g=>Object.assign({}, g, {id:uid()}))});
        await put('invoices', n); location.hash = '#/invoice/'+n.id;
      };
      return;
    }
    const t = invoiceTotals(inv), co = null;
    const issues = inv.lines.map((l,i)=>lineIssues(l, inv, t.rows[i].calc));
    const BLOCK = ['Check match','No amount','No price','Size needed','Unit not comparable','Does not divide exactly'];
    const lumpBad = (inv.lumps||[]).some(g=>g.include && !Dec.parse(g.amount));
    const blocking = lumpBad || inv.lines.some((l,i)=>l.include && issues[i].some(m=>BLOCK.some(b=>m.startsWith(b))));
    $('#main').innerHTML = `
      <div class="topbar"><h1>${esc(inv.orderType)} invoice</h1>${invBadge('draft')}</div>
      <p class="subtle" style="margin-top:-10px;">${esc(inv.vessel)} · ${esc(inv.code||inv.orderNumber||'')} — draft, nothing is final until you issue it. Quantities are as picked; prices are exact, never rounded.</p>
      <div class="card" style="margin-bottom:14px;">
        <div class="row2">
          <div class="field"><label>Price to use</label><div class="tag-row">${seesSell()?`<button class="chip ${inv.priceBasis==='sell'?'active':''}" data-b="sell">Sell price</button>`:''}${seesCost()?`<button class="chip ${inv.priceBasis==='cost'?'active':''}" data-b="cost">Cost price</button>`:''}</div></div>
          <div class="field"><label>Invoice date</label><input type="date" id="iv_date" value="${esc(inv.invoiceDate)}"></div>
        </div>
        <div class="row2">
          <div class="field"><label>${esc(inv.taxLabel||'Tax')}</label><select id="iv_tax"><option value="0" ${inv.taxOn?'':'selected'}>No tax</option><option value="1" ${inv.taxOn?'selected':''}>Add tax</option></select></div>
          <div class="field"><label>${esc(inv.taxLabel||'Tax')} rate %</label><input type="text" inputmode="decimal" id="iv_rate" value="${esc(inv.taxRate)}" ${inv.taxOn?'':'disabled'}></div>
        </div>
      </div>
      ${(inv.lumps||[]).map((g,gi)=>{ const c = t.lumpRows[gi], n = inv.lines.filter(l=>l.lump===g.group && l.include).length; return `
        <div class="card iv-lump" style="margin-bottom:14px; border-color:var(--signal);">
          <div class="iv-top"><label class="pr-name"><input type="checkbox" class="sp-cb" data-ginc="${gi}" ${g.include?'checked':''}><b>${esc(g.group)}</b></label><span class="iv-q">${n} item${n===1?'':'s'} · one line</span></div>
          ${g.include ? `<p class="subtle" style="margin:6px 0;">Priced as a whole: type the supplier's invoice total for these items. The items below are listed without prices.</p>
          <div class="iv-grid">
            <div class="field"><label>Supplier invoice total (EGP)</label><input type="text" inputmode="decimal" data-gf="amount:${gi}" value="${esc(g.amount)}" placeholder="e.g. 48250.75"></div>
            <div class="field"><label>Markup % (optional)</label><input type="text" inputmode="decimal" data-gf="markup:${gi}" value="${esc(g.markup)}" placeholder="0"></div>
            <div class="field"><label>Supplier invoice no. (for your records)</label><input type="text" data-gf="ref:${gi}" value="${esc(g.ref)}"></div>
            <div class="field"><label>Discount</label><div style="display:flex; gap:6px;"><select data-gdt="${gi}" style="width:84px;"><option value="">none</option><option value="pct" ${g.discType==='pct'?'selected':''}>%</option><option value="amt" ${g.discType==='amt'?'selected':''}>EGP</option></select><input type="text" inputmode="decimal" data-gf="disc:${gi}" value="${esc(g.disc)}" ${g.discType?'':'disabled'}></div></div>
            <div class="iv-tot"><span class="subtle">Line total</span><b>${money(c.net)}</b></div>
          </div>
          ${Dec.parse(g.markup) ? `<div class="iv-work">${esc(money(dm(g.amount)))} + ${esc(g.markup)}% = ${esc(money(c.gross))}</div>` : ''}
          ${Dec.parse(g.amount) ? '' : '<div class="pr-warn">⚠ No amount</div>'}` : ''}
        </div>`; }).join('')}
      <div id="iv_lines">${inv.lines.map((l,i)=> l.lump ? `
        <div class="iv-line ${l.include?'':'off'}" data-i="${i}" style="padding:8px 12px;"><div class="iv-top"><label class="pr-name"><input type="checkbox" class="sp-cb" data-inc="${i}" ${l.include?'checked':''}><b>${esc(l.desc)}</b></label><span class="iv-q">${Dec.fmt(dm(l.qty),0)} ${esc(l.unit)} <span class="subtle">· in ${esc(l.lump)}</span></span></div>
          ${l.include && l.doubt ? `<div class="pr-warn">⚠ Ordered as “${esc(l.ordered)}” but matched to “${esc(l.desc)}” (${esc(l.doubt)}). ${l.doubtOk?'<b>Confirmed.</b>':`<button class="btn btn-ghost btn-sm" data-ok="doubt:${i}">Yes, this is right</button>`}</div>` : ''}
        </div>` : `
        <div class="iv-line ${l.include?'':'off'}" data-i="${i}">
          <div class="iv-top"><label class="pr-name"><input type="checkbox" class="sp-cb" data-inc="${i}" ${l.include?'checked':''}><b>${esc(l.desc)}</b></label><span class="iv-q">${Dec.fmt(dm(l.qty),0)} ${esc(l.unit)}</span></div>
          ${l.include && l.doubt ? `<div class="pr-warn">⚠ Ordered as “${esc(l.ordered)}” but matched to “${esc(l.desc)}” (${esc(l.doubt)}). ${l.doubtOk?'<b>Confirmed.</b>':`<button class="btn btn-ghost btn-sm" data-ok="doubt:${i}">Yes, this is right</button>`}</div>` : (l.include && l.ordered && normalize(l.ordered)!==normalize(l.desc) ? `<div class="subtle" style="font-size:12px;">Ordered as “${esc(l.ordered)}”</div>` : '')}
          ${l.include ? `<div class="iv-grid">
            <div class="field"><label>${l.ref?`Price per ${esc(l.ref.qty)} ${esc(l.ref.unit)}`:'Unit price'}</label><input type="text" inputmode="decimal" data-price="${i}" value="${esc(l.price)}" placeholder="—"></div>
            <div class="field"><label>Discount</label><div style="display:flex; gap:6px;"><select data-dt="${i}" style="width:84px;"><option value="">none</option><option value="pct" ${l.discType==='pct'?'selected':''}>%</option><option value="amt" ${l.discType==='amt'?'selected':''}>EGP</option></select><input type="text" inputmode="decimal" data-d="${i}" value="${esc(l.disc)}" ${l.discType?'':'disabled'}></div></div>
            <div class="iv-tot"><span class="subtle">Line total</span><b>${money(t.rows[i].net)}</b></div>
          </div>
          ${t.rows[i].calc.note?`<div class="iv-work">${esc(t.rows[i].calc.note)}</div>`:''}
          ${issues[i].includes('Size needed')?`<div class="iv-fix"><input type="text" data-size="${i}" placeholder="Size of one ${esc(l.unit||'unit')}, e.g. 350 ml"><button class="btn btn-ghost btn-sm" data-ok="size:${i}">Use size</button><button class="btn btn-ghost btn-sm" data-ok="piece:${i}">Bill per piece at this price</button></div>`:''}
          ${issues[i].some(m=>m.startsWith('Does not divide'))?`<div class="iv-fix"><span class="subtle">Exact amount ${esc(t.rows[i].calc.exactText)} never ends.</span><input type="text" inputmode="decimal" data-uo="${i}" placeholder="Unit price to use"><button class="btn btn-ghost btn-sm" data-ok="uo:${i}">Use this price</button></div>`:''}
          ${(l.unitOverride||l.sizeOverride||l.perPiece)?`<button class="qc-link" data-ok="clear:${i}">Undo my change to this line</button>`:''}
          ${issues[i].length?`<div class="pr-warn">⚠ ${issues[i].map(esc).join(' · ')}</div>`:''}` : ''}
        </div>`).join('')}</div>
      <div class="card iv-sum"><div><span>Subtotal</span><b>${money(t.sub)}</b></div><div><span>Discount</span><b>- ${money(t.disc)}</b></div>${inv.taxOn?`<div><span>${esc(inv.taxLabel||'Tax')} (${esc(inv.taxRate)}%)</span><b>${money(t.tax)}</b></div>`:''}<div class="grand"><span>Total (EGP)</span><b>${money(t.total)}</b></div></div>
      <div class="field" style="margin-top:14px;"><label>Notes &amp; terms</label><textarea id="iv_notes" rows="2">${esc(inv.notes)}</textarea></div>
      <div class="pr-bar"><button class="btn btn-ghost btn-sm" id="iv_del">Delete draft</button><button class="btn btn-signal" id="iv_issue" ${blocking?'disabled':''}>${blocking?'Fix the flagged lines to issue':'Issue invoice'}</button></div>`;
    $('#main').querySelectorAll('[data-b]').forEach(b=>b.onclick=async ()=>{
      inv.priceBasis = b.dataset.b;
      inv.lines.forEach(l=>{ l.price = (inv.priceBasis==='cost' ? l.cost : l.sell) || ''; });
      await save(); draw();
    });
    $('#main').querySelectorAll('[data-ok]').forEach(b=>b.onclick=async ()=>{
      const [act, i] = b.dataset.ok.split(':'), l = inv.lines[+i];
      if(act==='size'){ const v = $(`[data-size="${i}"]`).value.trim(); if(!parseMeasure(v)){ showAlert('Write the size like 350 ml, 500 gm or 1 kg.'); return; } l.sizeOverride = v; }
      if(act==='piece') l.perPiece = true;
      if(act==='doubt') l.doubtOk = true;
      if(act==='uo'){ const v = $(`[data-uo="${i}"]`).value.trim(); if(!Dec.parse(v)){ showAlert('Enter a plain number, like 116.67.'); return; } l.unitOverride = Dec.str(Dec.parse(v)); }
      if(act==='clear'){ delete l.unitOverride; delete l.sizeOverride; delete l.perPiece; }
      await save(); draw();
    });
    $('#main').querySelectorAll('[data-ginc]').forEach(cb=>cb.onchange=async ()=>{ inv.lumps[+cb.dataset.ginc].include = cb.checked; await save(); draw(); });
    $('#main').querySelectorAll('[data-gdt]').forEach(el=>el.onchange=async ()=>{ const g = inv.lumps[+el.dataset.gdt]; g.discType = el.value; if(!el.value) g.disc = ''; await save(); draw(); });
    $('#main').querySelectorAll('[data-gf]').forEach(el=>el.onchange=async ()=>{
      const [f, gi] = el.dataset.gf.split(':'), g = inv.lumps[+gi], v = el.value.trim();
      if(f==='ref'){ g.ref = v; await save(); return; }
      if(v!=='' && !Dec.parse(v)){ showAlert('Enter a plain number, like 48250.75.'); el.focus(); return; }
      g[f] = v===''?'':Dec.str(Dec.parse(v)); await save(); draw();
    });
    $('#iv_date').onchange = async e=>{ inv.invoiceDate = e.target.value; await save(); };
    $('#iv_tax').onchange = async e=>{ inv.taxOn = e.target.value==='1'; await save(); draw(); };
    $('#iv_rate').onchange = async e=>{ if(e.target.value.trim()!=='' && !Dec.parse(e.target.value)){ showAlert('Tax rate must be a plain number.'); e.target.value = inv.taxRate; return; } inv.taxRate = e.target.value.trim()||'0'; await save(); draw(); };
    $('#iv_notes').onchange = async e=>{ inv.notes = e.target.value; await save(); };
    const bad = (el, msg)=>{ showAlert(msg||'Enter a plain number, like 36.25.'); el.focus(); };
    $('#main').querySelectorAll('[data-inc]').forEach(cb=>cb.onchange=async ()=>{ inv.lines[+cb.dataset.inc].include = cb.checked; await save(); draw(); });
    $('#main').querySelectorAll('[data-price]').forEach(el=>el.onchange=async ()=>{ const v = el.value.trim(); if(v!=='' && !Dec.parse(v)) return bad(el); inv.lines[+el.dataset.price].price = v===''?'':Dec.str(Dec.parse(v)); await save(); draw(); });
    $('#main').querySelectorAll('[data-dt]').forEach(el=>el.onchange=async ()=>{ const l = inv.lines[+el.dataset.dt]; l.discType = el.value; if(!el.value) l.disc = ''; await save(); draw(); });
    $('#main').querySelectorAll('[data-d]').forEach(el=>el.onchange=async ()=>{ const v = el.value.trim(); if(v!=='' && !Dec.parse(v)) return bad(el); inv.lines[+el.dataset.d].disc = v===''?'':Dec.str(Dec.parse(v)); await save(); draw(); });
    $('#iv_del').onclick = ()=>showConfirm('Delete this draft? Nothing is lost from the order.', async ()=>{ await del('invoices', inv.id); location.hash = '#/invoice/order/'+inv.orderId; }, {danger:true, yesLabel:'Delete draft'});
    $('#iv_issue').onclick = async ()=>{
      const co = await getCompany();
      if(!co.name){ showAlert('Add your company name in Settings → Company & invoices first, so it prints on the invoice.', 'Company details missing'); return; }
      if(!inv.lines.some(l=>l.include && !l.lump) && !(inv.lumps||[]).some(g=>g.include)){ showAlert('Tick at least one line.'); return; }
      showConfirm(`Issue this invoice? It gets its number and can no longer be edited. Total ${money(invoiceTotals(inv).total)} EGP.`, async ()=>{
        inv.company = {name:co.name, address:co.address, phone:co.phone, email:co.email, logo:co.logo};
        inv.number = await nextInvoiceNumber(co.prefix||'INV'); inv.status = 'issued'; inv.issuedAt = new Date().toISOString();
        await save(); if(typeof syncNow==='function') syncNow(); draw();
      }, {yesLabel:'Issue invoice'});
    };
  }
  draw();
}

/* ---------- Excel copy of an invoice ---------- */
async function exportInvoiceExcel(inv){
  const t = invoiceTotals(inv), wb = new ExcelJS.Workbook(), ws = wb.addWorksheet('Invoice');
  const co = inv.company || {};
  ws.addRow([co.name||'']).font = {bold:true, size:14};
  ws.addRow([[co.address, co.phone, co.email].filter(Boolean).join(' · ')]);
  ws.addRow([]);
  ws.addRow(['SALES INVOICE', inv.number||'DRAFT']).font = {bold:true};
  ws.addRow(['Vessel', inv.vessel]); ws.addRow(['Order code', inv.code||'']); ws.addRow(['Order type', inv.orderType]); ws.addRow(['Date', fmtDate(inv.invoiceDate)]);
  ws.addRow([]);
  const h = ws.addRow(['#','Description','Qty','Unit','Unit price','Discount','Total']); h.font = {bold:true};
  const fmtc = '#,##0.00##############';
  inv.lines.forEach((l,i)=>{ if(!l.include || l.lump) return; const r = t.rows[i];
    const row = ws.addRow([ws.rowCount-9, l.desc, Number(l.qty), l.unit, Number(Dec.str(r.calc.unit || dm(l.price))), Number(Dec.str(r.disc)), Number(Dec.str(r.net))]);
    [5,6,7].forEach(c=>row.getCell(c).numFmt = fmtc); });
  (inv.lumps||[]).forEach((g,gi)=>{ if(!g.include) return; const c = t.lumpRows[gi];
    const row = ws.addRow([ws.rowCount-9, g.group, 1, 'lot', Number(Dec.str(c.gross)), Number(Dec.str(c.disc)), Number(Dec.str(c.net))]); [5,6,7].forEach(k=>row.getCell(k).numFmt = fmtc); });
  ws.addRow([]);
  [['Subtotal',t.sub],['Total discount',t.disc],[`${inv.taxLabel||'Tax'} (${inv.taxOn?inv.taxRate:'0'}%)`,t.tax],['Total (EGP)',t.total]].forEach(([k,v])=>{ const r = ws.addRow(['','','','','',k,Number(Dec.str(v))]); r.getCell(7).numFmt = fmtc; r.font = {bold:k.startsWith('Total (')}; });
  ws.columns = [{width:5},{width:42},{width:10},{width:14},{width:14},{width:18},{width:16}];
  const buf = await wb.xlsx.writeBuffer();
  await saveFile(`${(inv.number||'draft')}-${inv.vessel}.xlsx`.replace(/[^\w.\- ]+/g,'_'), new Blob([buf], {type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}));
}
