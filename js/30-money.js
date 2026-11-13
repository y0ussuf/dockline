/* ============================ PROFIT & LOSS PER VESSEL ============================
   Revenue and cost of goods come from the order's invoices (already exact). Expenses (transport, launch, port fees …) are typed
   by hand per vessel, in EGP or USD. Everything is added up in EGP with exact decimals — nothing stored is ever rounded.
   A USD amount is converted with the vessel's own rate (EGP = USD × rate, exact). Showing EGP totals in USD divides by the rate,
   which may never end, so that view is marked "≈" and is for reading only.
   Stores: 'expenses' rows are {kind:'exp', orderId, cat, amount, cur, note, date} or {kind:'rate', orderId, rate}.
   The default rate is the shared setting 'usdRate'. */
const EXP_CATS = ['Transportation','Launch / boat','Port / gate fees','Packing','Labour','Bills','Bank charges','Spoiled / short items','Discount / return','Other'];
const canMoney = ()=> (typeof isFullAdmin==='function' && isFullAdmin()) || (can('finance') && seesBothPrices());

async function getUsdRate(){ const r = await getOne('sharedSettings','usdRate'); return (r && Dec.parse(r.rate)) ? r.rate : ''; }
async function setUsdRate(rate){ await put('sharedSettings', {id:'usdRate', rate:String(rate).trim()}); }
function moneyCur(){ try{ return localStorage.getItem('dl_money_cur')==='USD' ? 'USD' : 'EGP'; }catch(_){ return 'EGP'; } }
function setMoneyCur(c){ try{ localStorage.setItem('dl_money_cur', c); }catch(_){} }

/* an expense in EGP (exact): typed USD × the vessel's rate */
function expEgp(e, rate){
  const a = Dec.parse(e.amount); if(!a) return Dec.ZERO;
  if(e.cur==='USD'){ const r = Dec.parse(rate); return r ? Dec.mul(a, r) : null; }
  return a;
}
/* show an EGP amount in the chosen currency. USD that does not end exactly is shown as ≈ (display only) */
function showMoney(egp, cur, rate){
  if(cur!=='USD') return money(egp)+' EGP';
  const r = Dec.parse(rate); if(!r || Dec.cmp(r, Dec.ZERO)<=0) return '— USD (set the rate)';
  const q = Rat.div(Rat.fromDec(egp), Rat.fromDec(r)), d = Rat.toDec(q);
  return d ? money(d)+' USD' : '≈ '+money(Rat.roundHalfUp(q, 2))+' USD';
}
const signCls = d=> Dec.cmp(d, Dec.ZERO)<0 ? 'neg' : Dec.cmp(d, Dec.ZERO)>0 ? 'pos' : '';

/* revenue (before tax), cost of goods and what could not be costed, from an order's live invoices */
function invoiceMoney(invs){
  let rev = Dec.ZERO, cogs = Dec.ZERO, noCost = 0, unclear = 0, drafts = 0;
  for(const inv of invs){
    if(inv.status==='draft') drafts++;
    rev = Dec.add(rev, invoiceTotals(inv).taxable);
    for(const l of inv.lines||[]){
      if(!l.include || l.lump) continue;
      if(!Dec.parse(l.cost)){ noCost++; continue; }
      const c = lineCalc(Object.assign({}, l, {unitOverride:''}), l.cost, inv.roundMode);
      if(c.issue || c.exactText){ unclear++; continue; }
      cogs = Dec.add(cogs, c.gross);
    }
    for(const g of inv.lumps||[]){ if(g.include) cogs = Dec.add(cogs, Dec.parse(g.amount) || Dec.ZERO); }   // a group costs what the supplier charged for it
  }
  return {rev, cogs, noCost, unclear, drafts};
}
/* everything for one vessel */
function vesselResult(invs, exps, rate){
  const im = invoiceMoney(invs), byCat = new Map(); let spent = Dec.ZERO, noRate = false;
  for(const e of exps){
    const v = expEgp(e, rate); if(v===null){ noRate = true; continue; }
    spent = Dec.add(spent, v); const k = e.cat || 'Other'; byCat.set(k, Dec.add(byCat.get(k)||Dec.ZERO, v));
  }
  const gross = Dec.sub(im.rev, im.cogs);
  return Object.assign(im, {gross, spent, byCat, net:Dec.sub(gross, spent), noRate, hasInvoice: invs.length>0});
}
const pctOf = (part, whole)=>{ const w = Dec.parse(Dec.str(whole)); if(!w || Dec.cmp(w, Dec.ZERO)<=0) return ''; const r = Rat.div(Rat.mul(Rat.fromDec(part), Rat.fromDec(Dec.parse('100'))), Rat.fromDec(w)); return '≈ '+Rat.peek(r,1).replace('…','')+'%'; };

async function loadVesselData(orderId){
  const [invs, rows, gRate] = await Promise.all([getAll('invoices'), getAll('expenses'), getUsdRate()]);
  const mine = rows.filter(r=>r.orderId===orderId);
  const own = mine.find(r=>r.kind==='rate');
  return {invs: invs.filter(i=>i.orderId===orderId && i.status!=='cancelled'), exps: mine.filter(r=>r.kind==='exp'), rateRow: own||null, rate: (own&&own.rate)||gRate, gRate};
}

/* ---------- one vessel ---------- */
route('money', async (parts)=>{
  if(!canMoney()){ $('#main').innerHTML = noAccessHtml(); return; }
  if(!parts[0]) return moneyAll();
  const order = await getOne('orders', parts[0]); if(!order){ location.hash = '#/money'; return; }
  const d = await loadVesselData(order.id), cur = moneyCur(), r = vesselResult(d.invs, d.exps, d.rate);
  const sm = x=> showMoney(x, cur, d.rate);
  const maxCat = [...r.byCat.values()].reduce((m,v)=> Dec.cmp(v,m)>0 ? v : m, Dec.ZERO);
  const catRows = [...r.byCat.entries()].sort((a,b)=>Dec.cmp(b[1],a[1])).map(([k,v])=>{
    const w = Dec.cmp(maxCat, Dec.ZERO)>0 ? Math.max(3, Math.round(Number(Rat.peek(Rat.div(Rat.fromDec(v), Rat.fromDec(maxCat)),3).replace('…',''))*100)) : 0;
    return `<div class="mn-cat"><div class="mn-cat-h"><span>${esc(k)}</span><b>${sm(v)}</b></div><div class="mn-bar"><i style="width:${w}%"></i></div></div>`; }).join('');
  const warn = [];
  if(!r.hasInvoice) warn.push('There is no invoice for this order yet, so revenue and cost of goods show as 0. Create the invoice first.');
  if(r.drafts) warn.push(`${r.drafts} invoice${r.drafts>1?'s are':' is'} still a draft — the numbers follow the draft and can change.`);
  if(r.noCost) warn.push(`${r.noCost} invoice line${r.noCost>1?'s have':' has'} no cost price, so they count as 0 cost. Profit looks higher than it is.`);
  if(r.unclear) warn.push(`${r.unclear} line${r.unclear>1?'s':''} could not be costed exactly (size or unit unclear) and count as 0 cost.`);
  if(r.noRate) warn.push('Some expenses are in USD but there is no rate yet — set it below.');
  const canEdit = true;
  $('#main').innerHTML = `
    <div class="topbar"><h1>Profit & loss</h1><a class="btn btn-ghost btn-sm" href="#/money">← All vessels</a></div>
    <p class="subtle" style="margin-top:-10px;">${esc(order.vessel)} · ${esc(order.imo||order.orderNumber||'')}</p>
    <div class="mn-seg" id="mn_cur"><button data-c="EGP" class="${cur==='EGP'?'on':''}">EGP</button><button data-c="USD" class="${cur==='USD'?'on':''}">USD</button></div>
    ${warn.map(w=>`<div class="bt-warn" style="margin-bottom:10px;">${esc(w)}</div>`).join('')}
    <div class="mn-hero ${signCls(r.net)}"><div class="mn-hero-l">Net result</div><div class="mn-hero-v">${sm(r.net)}</div>
      <div class="mn-hero-s">${Dec.cmp(r.net, Dec.ZERO)<0?'We lost money on this vessel':Dec.cmp(r.net, Dec.ZERO)>0?'We made money on this vessel':'Break-even'}${pctOf(r.net, r.rev)?` · ${pctOf(r.net, r.rev)} of revenue`:''}</div></div>
    <div class="card mn-sum">
      <div><span>Revenue <small>(invoices, before tax)</small></span><b>${sm(r.rev)}</b></div>
      <div><span>Cost of goods</span><b>- ${sm(r.cogs)}</b></div>
      <div class="mn-line"><span>Profit before expenses</span><b class="${signCls(r.gross)}">${sm(r.gross)}</b></div>
      <div><span>Expenses</span><b>- ${sm(r.spent)}</b></div>
      <div class="mn-line mn-net"><span>Net result</span><b class="${signCls(r.net)}">${sm(r.net)}</b></div>
    </div>
    ${r.byCat.size ? `<div class="card" style="margin-top:14px;"><div class="section-title">Where the expenses went</div>${catRows}</div>` : ''}
    <div class="card" style="margin-top:14px;"><div class="section-title" style="display:flex; align-items:center;"><span style="flex:1;">Expenses</span><button class="btn btn-signal btn-sm" id="mn_add">+ Add expense</button></div>
      ${d.exps.length ? d.exps.slice().sort((a,b)=>(b.date||'').localeCompare(a.date||'')).map(e=>`<div class="mn-exp" data-e="${e.id}"><div style="flex:1; min-width:0;"><b>${esc(e.cat||'Other')}</b><div class="subtle">${e.date?esc(fmtDate(e.date)):''}${e.note?' · '+esc(e.note):''}</div></div><div style="text-align:right;"><b>${e.cur==='USD'?Dec.fmt(Dec.parse(e.amount),2)+' USD':money(Dec.parse(e.amount))+' EGP'}</b>${e.cur==='USD'&&d.rate?`<div class="subtle">= ${money(expEgp(e,d.rate)||Dec.ZERO)} EGP</div>`:''}</div></div>`).join('') : '<p class="subtle">No expenses yet. Add transport, launch, port fees, bills and so on.</p>'}
    </div>
    <div class="card" style="margin-top:14px;"><div class="section-title">Dollar rate for this vessel</div>
      <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">1 USD = <input type="text" inputmode="decimal" id="mn_rate" value="${esc(d.rate||'')}" placeholder="e.g. 53.42" style="width:110px;"> EGP
        <button class="btn btn-ghost btn-sm" id="mn_ratesave">Save</button><button class="btn btn-ghost btn-sm" id="mn_ratefetch">Get today's rate</button></div>
      <p class="subtle" id="mn_ratemsg" style="margin:8px 0 0;">${d.rateRow?'This vessel keeps its own rate, so later changes to the default do not alter it.':d.gRate?'Using the default rate. It is saved to this vessel when you add an expense.':'Type the rate you want to use.'}</p></div>`;
  $('#mn_cur').querySelectorAll('button').forEach(b=>b.onclick=()=>{ setMoneyCur(b.dataset.c); routes['money'](parts); });
  const saveRate = async v=>{
    if(!Dec.parse(v) || Dec.cmp(Dec.parse(v), Dec.ZERO)<=0) return showAlert('Type the rate as a plain number, like 53.42.');
    await put('expenses', {id: d.rateRow ? d.rateRow.id : 'rt-'+uid(), kind:'rate', orderId:order.id, rate:Dec.str(Dec.parse(v))});
    if(!d.gRate) await setUsdRate(v);
    routes['money'](parts);
  };
  $('#mn_ratesave').onclick = ()=> saveRate($('#mn_rate').value);
  $('#mn_ratefetch').onclick = async ()=>{
    const m = $('#mn_ratemsg'); m.textContent = 'Looking up today\'s rate…';
    try{
      const res = await fetch('https://open.er-api.com/v6/latest/USD'); const j = await res.json();
      const v = j && j.rates && j.rates.EGP; if(!v) throw 0;
      $('#mn_rate').value = String(v); m.textContent = `Today's rate found: ${v}. Check it, then press Save.`;
    }catch(_){ m.textContent = 'Could not reach a rate service (offline?). Type the rate by hand.'; }
  };
  $('#mn_add').onclick = ()=> expenseForm(order, d, null, ()=>routes['money'](parts));
  $('#main').querySelectorAll('[data-e]').forEach(el=>el.onclick=()=> expenseForm(order, d, d.exps.find(x=>x.id===el.dataset.e), ()=>routes['money'](parts)));
});

function expenseForm(order, d, e, done){
  const known = [...new Set([...EXP_CATS])];
  const cur0 = e ? e.cur : 'EGP';
  showModal(`<h3>${e?'Edit expense':'Add expense'} <span class="subtle" style="font-weight:500;">· ${esc(order.vessel)}</span></h3>
    <div class="field"><label>What was it for?</label><input type="text" id="ex_cat" list="ex_cats" value="${esc(e?e.cat:'')}" placeholder="Transportation, launch, bills…" autocomplete="off"><datalist id="ex_cats">${known.map(c=>`<option value="${esc(c)}">`).join('')}</datalist></div>
    <div class="tag-row" style="margin:-4px 0 12px;">${EXP_CATS.slice(0,6).map(c=>`<button type="button" class="chip" data-cat="${esc(c)}">${esc(c)}</button>`).join('')}</div>
    <div class="mn-amt"><div class="field" style="flex:1; margin:0;"><label>Amount</label><input type="text" inputmode="decimal" id="ex_amt" value="${e?esc(e.amount):''}" placeholder="0.00"></div>
      <div class="mn-seg" id="ex_cur" style="margin:22px 0 0;"><button type="button" data-c="EGP" class="${cur0==='EGP'?'on':''}">EGP</button><button type="button" data-c="USD" class="${cur0==='USD'?'on':''}">USD</button></div></div>
    <p class="subtle" id="ex_conv" style="margin:6px 0 12px;"></p>
    <div class="field"><label>Date</label><input type="date" id="ex_date" value="${esc((e&&e.date)||todayISO())}"></div>
    <div class="field"><label>Note (optional)</label><input type="text" id="ex_note" value="${esc(e?e.note||'':'')}"></div>
    <div class="mod-bar"><button class="qa-primary mod-save" id="ex_save">${qIc('check')}Save</button>${e?'<button class="mod-cancel" id="ex_del" style="color:var(--danger,#c0392b);">Delete</button>':''}<button class="mod-cancel" onclick="closeModal()">Cancel</button></div>`);
  let cur = cur0;
  const conv = ()=>{ const a = Dec.parse($('#ex_amt').value), r = Dec.parse(d.rate); $('#ex_conv').textContent = (cur==='USD' && a) ? (r ? `= ${money(Dec.mul(a, r))} EGP at 1 USD = ${d.rate} EGP` : 'No dollar rate yet — set it on the vessel page first.') : ''; };
  $('#ex_amt').oninput = conv; conv();
  $('#ex_cur').querySelectorAll('button').forEach(b=>b.onclick=()=>{ cur = b.dataset.c; $('#ex_cur').querySelectorAll('button').forEach(x=>x.classList.toggle('on', x===b)); conv(); });
  document.querySelectorAll('[data-cat]').forEach(b=>b.onclick=()=>{ $('#ex_cat').value = b.dataset.cat; });
  $('#ex_save').onclick = async ()=>{
    const cat = $('#ex_cat').value.trim(), amt = $('#ex_amt').value.trim().replace(/,/g,'');
    if(!cat) return showAlert('Say what the expense was for.');
    if(!Dec.parse(amt) || Dec.cmp(Dec.parse(amt), Dec.ZERO)===0) return showAlert('Type the amount as a plain number, like 1250 or 18.5.');
    if(cur==='USD' && !Dec.parse(d.rate)) return showAlert('Set the dollar rate first (bottom of the vessel page), then add the USD expense.');
    const row = Object.assign({}, e||{}, {id: e?e.id:'ex-'+uid(), kind:'exp', orderId:order.id, cat, amount:Dec.str(Dec.parse(amt)), cur, date:$('#ex_date').value, note:$('#ex_note').value.trim(), vessel:order.vessel});
    await put('expenses', row);
    if(!d.rateRow && Dec.parse(d.rate)) await put('expenses', {id:'rt-'+uid(), kind:'rate', orderId:order.id, rate:Dec.str(Dec.parse(d.rate))});   // this vessel keeps the rate it was costed at
    closeModal(); done();
  };
  if(e) $('#ex_del').onclick = ()=> showConfirm('Delete this expense?', async ()=>{ await del('expenses', e.id); done(); });
}

/* ---------- all vessels ---------- */
async function moneyAll(){
  const [orders, invs, rows, gRate] = await Promise.all([getAll('orders'), getAll('invoices'), getAll('expenses'), getUsdRate()]);
  const cur = moneyCur(), month = window.__mnMonth || '', sort = window.__mnSort || 'worst';
  const out = orders.map(o=>{
    const mine = rows.filter(r=>r.orderId===o.id), rr = mine.find(r=>r.kind==='rate');
    const rate = (rr&&rr.rate)||gRate, res = vesselResult(invs.filter(i=>i.orderId===o.id && i.status!=='cancelled'), mine.filter(r=>r.kind==='exp'), rate);
    return {o, res, rate, has: res.hasInvoice || mine.some(r=>r.kind==='exp')};
  }).filter(x=>x.has && (!month || String(x.o.orderDate||x.o.createdAt||'').slice(0,7)===month));
  const months = [...new Set(orders.map(o=>String(o.orderDate||o.createdAt||'').slice(0,7)).filter(Boolean))].sort().reverse();
  out.sort((a,b)=> sort==='best' ? Dec.cmp(b.res.net, a.res.net) : sort==='new' ? String(b.o.orderDate||b.o.createdAt||'').localeCompare(String(a.o.orderDate||a.o.createdAt||'')) : Dec.cmp(a.res.net, b.res.net));
  // totals are in EGP; a USD view divides by the default rate (vessels with their own rate are converted at that rate in their own page)
  let tRev=Dec.ZERO, tGross=Dec.ZERO, tSpent=Dec.ZERO, tNet=Dec.ZERO; const cats = new Map();
  for(const x of out){ tRev=Dec.add(tRev,x.res.rev); tGross=Dec.add(tGross,x.res.gross); tSpent=Dec.add(tSpent,x.res.spent); tNet=Dec.add(tNet,x.res.net); for(const [k,v] of x.res.byCat) cats.set(k, Dec.add(cats.get(k)||Dec.ZERO, v)); }
  const sm = v=> showMoney(v, cur, gRate), losers = out.filter(x=>Dec.cmp(x.res.net, Dec.ZERO)<0).length;
  $('#main').innerHTML = `
    <div class="topbar"><h1>Profit & loss</h1></div>
    <p class="subtle" style="margin-top:-10px;">Every vessel with an invoice or expenses. Open one to add expenses.</p>
    <div class="mn-seg" id="mn_cur"><button data-c="EGP" class="${cur==='EGP'?'on':''}">EGP</button><button data-c="USD" class="${cur==='USD'?'on':''}">USD</button></div>
    ${cur==='USD' && !Dec.parse(gRate) ? '<div class="bt-warn" style="margin-bottom:10px;">No default dollar rate yet. Open a vessel and save a rate to see USD here.</div>':''}
    <div class="mn-hero ${signCls(tNet)}"><div class="mn-hero-l">Net result${month?' · '+esc(month):''}</div><div class="mn-hero-v">${sm(tNet)}</div><div class="mn-hero-s">${out.length} vessel${out.length===1?'':'s'} · ${losers} at a loss · expenses ${sm(tSpent)}</div></div>
    <div class="tag-row" style="margin:12px 0;"><select id="mn_month"><option value="">All months</option>${months.map(m=>`<option value="${m}" ${m===month?'selected':''}>${m}</option>`).join('')}</select>
      <select id="mn_sort"><option value="worst" ${sort==='worst'?'selected':''}>Worst first</option><option value="best" ${sort==='best'?'selected':''}>Best first</option><option value="new" ${sort==='new'?'selected':''}>Newest first</option></select></div>
    ${out.length ? out.map(x=>`<a class="card mn-v ${signCls(x.res.net)}" href="#/money/${x.o.id}"><div style="flex:1; min-width:0;"><b>${esc(x.o.vessel)}</b><div class="subtle">${esc(x.o.imo||x.o.orderNumber||'')}${x.o.orderDate?' · '+esc(fmtDate(x.o.orderDate)):''}${x.res.hasInvoice?'':' · no invoice yet'}</div><div class="subtle">Profit ${showMoney(x.res.gross, cur, gRate)} · expenses ${showMoney(x.res.spent, cur, gRate)}</div></div><div class="mn-v-n">${showMoney(x.res.net, cur, gRate)}</div></a>`).join('') : '<div class="card"><p class="subtle">Nothing yet. Once an order has an invoice or an expense it shows up here.</p></div>'}
    ${cats.size ? `<div class="card" style="margin-top:14px;"><div class="section-title">Expenses by category</div>${[...cats.entries()].sort((a,b)=>Dec.cmp(b[1],a[1])).map(([k,v])=>`<div class="mn-cat-h" style="padding:6px 0;"><span>${esc(k)}</span><b>${sm(v)}</b></div>`).join('')}</div>`:''}`;
  $('#mn_cur').querySelectorAll('button').forEach(b=>b.onclick=()=>{ setMoneyCur(b.dataset.c); moneyAll(); });
  $('#mn_month').onchange = e=>{ window.__mnMonth = e.target.value; moneyAll(); };
  $('#mn_sort').onchange = e=>{ window.__mnSort = e.target.value; moneyAll(); };
}
