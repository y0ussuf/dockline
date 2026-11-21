/* ============================ STOCK HISTORY (per product) ============================
   Where did the stock of one product go, and where did it come from? A read-only view over what the app already
   holds: finished orders (vessel, quantity, batches taken), deliveries (supplier, invoice, batch) and opening-stock
   batches. Nothing here changes any stock or any record.
   The "left after" figure is worked BACKWARDS from the stock on hand now, so it is exact for the movements shown;
   anything that was never recorded (a manual correction that lowered stock) is not in the list. */
const shRound = n => Math.round((+n + Number.EPSILON) * 100) / 100;

async function stockMovementsOf(p){
  const [orders, items, receipts, invoices, batches] = await Promise.all([getAll('orders'), getAll('orderItems'), getAll('productReceipts'), getAll('receivingInvoices'), getAll('batches')]);
  const om = new Map(orders.map(o=>[o.id,o])), inv = new Map(invoices.map(i=>[i.id,i]));
  const mine = batches.filter(b=>b.productId===p.id), bm = new Map(mine.map(b=>[b.id,b]));
  const out = [], inn = [];
  const orderOf = o => ({orderId:o.id, vessel: cleanVesselName(o.vessel||'') || o.vessel || 'Vessel', orderNo:o.orderNumber||'', at:String(o.completedAt||o.orderDate||'')});
  for(const it of items){
    const o = om.get(it.orderId); if(!o || !o.stockApplied) continue;          // stock only leaves when the order is finished
    const lines = [];
    if(it.status==='completed' || it.status==='modified'){ if(it.productId===p.id) lines.push({qty:+it.actualQty, unit:it.actualUnit||'', allocs:it.batchAllocs||[]}); }
    else if(it.status==='substituted'){ for(const r of replacementsOf(it)) if(r.productId===p.id) lines.push({qty:+r.qty, unit:r.unit||'', allocs:r.batchAllocs||[]}); }
    for(const l of lines){ if(!(l.qty>0)) continue; out.push(Object.assign({kind:'out', qty:shRound(l.qty), unit:l.unit, batches:l.allocs.map(a=>({no:a.batchNo||'', qty:shRound(a.qty), id:a.batchId}))}, orderOf(o))); }
  }
  for(const r of receipts){
    if(r.productId!==p.id) continue;
    const h = r.invoiceId ? inv.get(r.invoiceId) : null, b = r.batchId ? bm.get(r.batchId) : null, d = (typeof r.stockDelta==='number') ? r.stockDelta : +r.qty;
    if(!(d>0)) continue;
    inn.push({kind:'in', qty:shRound(d), unit:r.unit||p.unit||'', at:String((h&&h.receivedAt)||r.receivedAt||r.createdAt||''), who:(h&&h.supplierName)||r.supplierName||'Delivery', ref:h?(h.number||h.invoiceNo||''):'', invoiceId:r.invoiceId||'',
      batches: r.batchNo||b ? [{no:r.batchNo||(b&&b.batchNo)||'', qty:shRound(d), id:r.batchId||'', exp:r.expiryDate||(b&&b.expiryDate)||''}] : []});
  }
  for(const b of mine){ if(b.kind==='opening') inn.push({kind:'adj', qty:shRound(b.qtyReceived), unit:p.unit||'', at:String(b.receivedAt||b.createdAt||''), who:'Opening stock / stock added by a correction', ref:'', batches:[]}); }
  const all = out.concat(inn).sort((a,b)=>String(b.at).localeCompare(String(a.at)));
  let bal = isStockTracked(p) ? +p.stockQty : null;                              // worked backwards from the stock on hand now
  for(const m of all){ if(bal===null){ m.left = null; continue; } m.left = shRound(bal); bal = shRound(bal + (m.kind==='out' ? m.qty : -m.qty)); }
  return {moves:all, batches:mine};
}

const shDate = s => { const d = String(s||'').slice(0,10); return d ? fmtDate(d) : ''; };
const shBatchText = list => list.length ? list.map(b=> (b.no ? esc(b.no) : 'no batch no.') + (list.length>1 ? ` (${b.qty})` : '')).join(' + ') : '';

route('stockhistory', async (parts)=>{
  const pid = parts[0];
  const p = pid ? await getOne('products', pid) : null;
  if(!p){ location.hash = '#/stock'; return; }
  const {moves, batches} = await stockMovementsOf(p);
  const unit = esc(p.unit||''), tab = window.__shTab || 'moves';
  const received = shRound(moves.filter(m=>m.kind!=='out').reduce((s,m)=>s+m.qty,0)), wentOut = shRound(moves.filter(m=>m.kind==='out').reduce((s,m)=>s+m.qty,0));
  const head = `<div class="topbar"><h1>${esc(p.name)}</h1><a href="#/stock" class="btn btn-ghost" style="text-decoration:none;">Back</a></div>
    <div class="bt-tiles"><div class="bt-tile bt-tile-blue"><b>${isStockTracked(p)?esc(p.stockQty):'—'}</b><span>In stock</span></div><div class="bt-tile"><b>${received}</b><span>Received</span></div><div class="bt-tile bt-tile-amber"><b>${wentOut}</b><span>Went out</span></div></div>
    <div style="display:flex; gap:8px; margin-bottom:12px; flex-wrap:wrap;">${[['moves','Movements'],['vessel','By vessel'],['batch','By batch']].map(([k,t])=>`<button class="chip ${tab===k?'active':''}" data-sh="${k}">${t}</button>`).join('')}<button class="chip" id="sh_xl" style="margin-left:auto;">Excel</button></div>`;
  let body = '';
  if(tab==='moves'){
    body = `<div class="bt-h">Movements <span class="subtle" style="font-weight:500;">— newest first</span></div><div class="bt-list">${moves.map(m=>{
      const title = m.kind==='out' ? esc(m.vessel) : m.kind==='in' ? `Received · ${esc(m.who)}` : esc(m.who);
      const sub = [m.kind==='out' && m.orderNo ? esc(m.orderNo) : '', m.kind==='in' && m.ref ? 'Invoice '+esc(m.ref) : '', shDate(m.at), shBatchText(m.batches) ? 'batch '+shBatchText(m.batches) : (m.kind==='out' && batches.length ? 'no batch recorded' : ''), m.batches[0]&&m.batches[0].exp ? 'exp '+shDate(m.batches[0].exp) : ''].filter(Boolean).join(' · ');
      const href = m.kind==='out' ? `#/order/${m.orderId}/summary` : (m.invoiceId ? `#/receiving/${m.invoiceId}` : '');
      return `<${href?`a href="${href}"`:'div'} class="bt-row" style="display:flex; gap:10px; align-items:center; text-decoration:none; color:inherit;"><div style="flex:1; min-width:0;"><b>${title}</b><div class="subtle">${sub}</div></div>
        <div style="text-align:right;"><span class="exp-badge ${m.kind==='out'?'exp-warn':'exp-ok'}">${m.kind==='out'?'−':'+'} ${m.qty} ${esc(m.unit)}</span>${m.left===null?'':`<div class="subtle" style="font-size:.75rem; margin-top:3px;">Left ${m.left}</div>`}</div></${href?'a':'div'}>`; }).join('') || '<p class="subtle">No movements recorded yet.</p>'}</div>`;
  } else if(tab==='vessel'){
    const g = new Map();
    moves.filter(m=>m.kind==='out').forEach(m=>{ const k = normalize(m.vessel); const e = g.get(k) || {vessel:m.vessel, qty:0, orders:new Set(), units:new Set(), last:''}; e.qty = shRound(e.qty+m.qty); e.orders.add(m.orderId); e.units.add(String(m.unit||'').toUpperCase()); if(String(m.at)>e.last) e.last = String(m.at); g.set(k,e); });
    body = `<div class="bt-h">Went to ${g.size} vessel${g.size===1?'':'s'}</div><div class="bt-list">${[...g.values()].sort((a,b)=>b.qty-a.qty).map(e=>`<div class="bt-row" style="display:flex; gap:10px; align-items:center;"><div style="flex:1; min-width:0;"><b>${esc(e.vessel)}</b><div class="subtle">${e.orders.size} order${e.orders.size===1?'':'s'} · last ${shDate(e.last)}</div></div><span class="exp-badge exp-warn">${e.qty} ${e.units.size===1?esc([...e.units][0]):''}</span></div>`).join('') || '<p class="subtle">Nothing has gone to an order yet.</p>'}</div>
      <p class="subtle" style="margin-top:12px;">Quantities in different units are added together as written on the orders.</p>`;
  } else {
    body = `<div class="bt-h">Batches</div><div class="bt-list">${batches.slice().sort((a,b)=>String(b.receivedAt||'').localeCompare(String(a.receivedAt||''))).map(b=>`<a href="#/batches/trace/${b.id}" class="bt-row" style="display:flex; gap:10px; align-items:center; text-decoration:none; color:inherit;"><div style="flex:1; min-width:0;"><b>${batchTitle(b)}</b><div class="subtle">Received ${round2(b.qtyReceived)} ${unit}${b.receivedAt?' · '+shDate(b.receivedAt):''}${b.expiryDate?' · exp '+shDate(b.expiryDate):''}</div></div><span class="exp-badge ${b.qtyRemaining>0?'exp-ok':''}">${round2(b.qtyRemaining)} ${unit} left</span></a>`).join('') || '<p class="subtle">This product has no batches. Turn on “Track batches” on the product to keep them.</p>'}</div>`;
  }
  $('#main').innerHTML = head + body + `<p class="subtle" style="margin-top:14px;">Only movements recorded in Dockline are listed, and only orders that have been finished. Orders finished before batch tracking was switched on show the vessel and quantity but no batch. A manual correction that lowered the stock is not a recorded movement.</p>`;
  document.querySelectorAll('[data-sh]').forEach(b=>b.onclick = ()=>{ window.__shTab = b.dataset.sh; render(); });
  $('#sh_xl').onclick = async ()=>{
    if(!(await ensureLibOrAlert('exceljs'))) return;
    const wb = new ExcelJS.Workbook(), ws = wb.addWorksheet('Stock history'); ws.addRow(['Product', p.name]); ws.addRow([]);
    ws.addRow(['Date','Type','Vessel / supplier','Order / invoice','Quantity','Unit','Batch','Left after']).font = {bold:true};
    moves.forEach(m=>ws.addRow([shDate(m.at), m.kind==='out'?'Out':m.kind==='in'?'In':'Adjustment', m.kind==='out'?m.vessel:m.who, m.kind==='out'?m.orderNo:m.ref, m.kind==='out'?-m.qty:m.qty, m.unit, m.batches.map(b=>b.no+(m.batches.length>1?` (${b.qty})`:'')).join(' + '), m.left===null?'':m.left]));
    ws.columns.forEach(c=>c.width = 18);
    const buf = await wb.xlsx.writeBuffer(); const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([buf])); a.download = `stock-history-${String(p.name).replace(/[^a-z0-9]+/gi,'-')}.xlsx`; a.click();
  };
});
