/* ============================ PRICE SHEET IMPORT ============================
   A sheet of  name | COST | SELL  is matched to the products with the same engine as order imports
   (saved names, smart suggestions). Nothing is written until you press Apply, and prices are saved
   exactly as written in the sheet — no rounding. */
route('prices', async ()=>{
  const state = {dup:new Map(), rows:null, filter:'all', shown:40, ctx:null, fileName:''};
  const [products, warehouses, sections] = await Promise.all([getAll('products'), getAll('warehouses'), getAll('sections')]);
  const whMap = Object.fromEntries(warehouses.map(w=>[w.id,w])), secMap = Object.fromEntries(sections.map(s=>[s.id,s]));
  const prodById = new Map(products.map(p=>[p.id,p]));
  const priced = products.filter(p=>p.costPrice!==undefined && p.costPrice!=='' || p.sellPrice!==undefined && p.sellPrice!=='').length;

  const numText = v=>{ if(v===null || v===undefined || v==='') return ''; const d = Dec.parse(v); return d ? Dec.str(d) : null; };   // null = not a number
  function readSheet(aoa){
    let hr = -1, kName = 0, kCost = -1, kSell = -1;
    for(let r=0; r<Math.min(aoa.length,15); r++){
      const row = aoa[r]||[]; let c=-1, s=-1;
      row.forEach((v,i)=>{ const n = normalize(String(v==null?'':v)); if(/^(cost|buy|buying|cost price|purchase)/.test(n)) c = i; else if(/^(sell|selling|sale|sell price)/.test(n)) s = i; });
      if(c!==-1 && s!==-1){ hr = r; kCost = c; kSell = s; kName = row.findIndex((v,i)=> i!==c && i!==s && String(v==null?'':v).trim()!=='' ); if(kName===-1) kName = [0,1,2].find(i=>i!==c && i!==s); break; }
    }
    if(hr===-1) return null;
    const out = [];
    for(const row of aoa.slice(hr+1)){
      const name = String(row[kName]==null?'':row[kName]).trim(); if(!name) continue;
      const cost = numText(row[kCost]), sell = numText(row[kSell]);
      out.push({id:uid(), name, cost: cost===null?'':cost, sell: sell===null?'':sell, bad: cost===null || sell===null});
    }
    return out;
  }
  function warnsOf(r){
    const w = [], c = Dec.parse(r.cost), s = Dec.parse(r.sell);
    if(r.bad) w.push('A price is not a number');
    if(c && s && Dec.cmp(s,c)<0) w.push('Sell is below cost');
    if((c && Dec.cmp(c,Dec.ZERO)===0) || (s && Dec.cmp(s,Dec.ZERO)===0)) w.push('Price is 0');
    if(r.productId && (state.dup.get(r.productId)||0)>1) w.push('Another row in the sheet matches the same product — tick the right one');
    if(r.cost==='' && !r.bad) w.push('No cost'); if(r.sell==='' && !r.bad) w.push('No sell price');
    return w;
  }
  const same = r=>{ const p = r.productId && prodById.get(r.productId); return !!p && (p.costPrice||'')===r.cost && (p.sellPrice||'')===r.sell; };

  async function process(file){
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, {type:'array'});
    const aoa = sheetToRows(wb.Sheets[wb.SheetNames[0]], {raw:true});
    const rows = readSheet(aoa);
    if(!rows){ showAlert('Could not find the COST and SELL columns in the first rows of this file.'); return false; }
    if(!rows.length){ showAlert('No products found in the file.'); return false; }
    state.ctx = await loadMatchContext();
    let n = 0;
    for(const r of rows){
      const m = await matchExcelRow(r.name, state.ctx);
      r.productId = (m.status==='mapped'||m.status==='auto') ? m.product.id : '';
      r.how = m.status==='mapped' ? 'saved name' : m.status==='auto' ? 'matched' : '';
      r.cands = r.productId ? [] : suggestSmart(r.name, state.ctx.index, 3, 0.4);
      r.include = !!r.productId && !r.bad;
      if(++n % 40 === 0){ const el = $('#pr_prog'); if(el) el.textContent = `Matching… ${n} of ${rows.length}`; await new Promise(res=>setTimeout(res,0)); }
    }
    const seen = new Map(); rows.forEach(r=>{ if(r.productId) seen.set(r.productId,(seen.get(r.productId)||0)+1); });
    rows.forEach(r=>{ if(r.productId && seen.get(r.productId)>1) r.include = false; });   // two sheet rows for one product: you choose
    state.rows = rows; state.fileName = file.name; state.filter = 'all'; state.shown = 40;
    return true;
  }
  const catOf = r=> r.skip ? 'skipped' : r.productId ? 'matched' : r.cands.length ? 'choose' : 'none';

  function draw(){
    if(!state.rows){
      $('#main').innerHTML = `
        <div class="topbar"><h1>Prices</h1></div>
        <p class="subtle" style="margin-top:-10px; max-width:640px;">Upload a sheet with the product name, the <b>COST</b> price and the <b>SELL</b> price. Each name is matched to a product (saved names and similar names count), and you review everything before a single price is saved. Prices are stored exactly as written — never rounded.</p>
        <div class="card" style="max-width:520px;">
          <div class="field"><label>Price sheet (.xlsx)</label><input type="file" id="pr_file" accept=".xlsx,.xls"></div>
          <button class="btn btn-signal btn-lg" id="pr_go">Read sheet</button>
          <p class="subtle" id="pr_prog" style="margin-top:10px;">${priced? `${priced} product${priced===1?'':'s'} already ${priced===1?'has':'have'} a price.` : 'No product has a price yet.'}</p>
        </div>`;
      $('#pr_go').onclick = async ()=>{
        const f = $('#pr_file').files[0]; if(!f){ showAlert('Choose a price sheet first.'); return; }
        const b = $('#pr_go'); b.disabled = true; b.textContent = 'Reading…';
        let ok = false; try{ ok = await process(f); }catch(e){ showAlert('Could not read this file: '+(e&&e.message||e)); }
        b.disabled = false; b.textContent = 'Read sheet';
        if(ok) draw();
      };
      return;
    }
    const rows = state.rows;
    state.dup = new Map(); rows.forEach(r=>{ if(r.productId) state.dup.set(r.productId, (state.dup.get(r.productId)||0)+1); });
    const cnt = {all:rows.length, matched:0, choose:0, none:0, skipped:0, warn:0, same:0};
    rows.forEach(r=>{ cnt[catOf(r)]++; if(warnsOf(r).length) cnt.warn++; if(same(r)) cnt.same++; });
    const f = state.filter;
    const view = rows.filter(r=> f==='all' ? true : f==='warn' ? warnsOf(r).length>0 : f==='same' ? same(r) : catOf(r)===f);
    const apply = rows.filter(r=>r.include && r.productId && !same(r));
    const chip = (k,l)=>`<button class="chip ${f===k?'active':''}" data-f="${k}">${l} · ${cnt[k]}</button>`;
    const money = s=> s===''? '—' : Dec.fmt(Dec.parse(s));
    $('#main').innerHTML = `
      <div class="topbar"><h1>Prices</h1><button class="btn btn-ghost btn-sm" id="pr_reset">Start over</button></div>
      <p class="subtle" style="margin-top:-10px;">${esc(state.fileName)} — ${rows.length} rows. Nothing is saved until you press Apply.</p>
      <div class="tag-row" id="pr_chips">${chip('all','All')}${chip('matched','Matched')}${chip('choose','Pick a product')}${chip('none','No product')}${chip('warn','⚠ Check')}${chip('same','Unchanged')}${chip('skipped','Skipped')}</div>
      <div style="display:flex; gap:8px; flex-wrap:wrap; margin:12px 0;">
        <button class="btn btn-ghost btn-sm" id="pr_conf">⚡ Accept clear suggestions</button>
        <button class="btn btn-ghost btn-sm" id="pr_addnew">➕ Add unmatched as new products…</button>
      </div>
      <div id="pr_list">${view.slice(0,state.shown).map(r=>{
        const p = r.productId && prodById.get(r.productId), w = warnsOf(r), cat = catOf(r);
        return `<div class="pr-row ${cat}" data-id="${r.id}">
          <div class="pr-top"><label class="pr-name"><input type="checkbox" class="sp-cb" data-inc="${r.id}" ${r.include?'checked':''} ${r.productId?'':'disabled'}><b>${esc(r.name)}</b></label>
            <span class="pr-px">${money(r.cost)} <span class="subtle">cost</span> · ${money(r.sell)} <span class="subtle">sell</span></span></div>
          ${p ? `<div class="subtle">→ ${esc(p.name)}${r.how?` · ${r.how}`:''}${(p.costPrice||p.sellPrice)? ` · now ${money(p.costPrice||'')} / ${money(p.sellPrice||'')}`:' · no price yet'}${same(r)?' · <b>unchanged</b>':''}</div>`
            : `<div class="cand-list">${r.cands.map(c=>`<button class="cand-btn" data-pick="${r.id}" data-pid="${c.p.id}">${esc(c.p.name)} <span class="subtle">· ${Math.round(c.s*100)}%${c.via?` · also called “${esc(c.via)}”`:''}</span></button>`).join('')}
              <button class="btn btn-ghost btn-sm" data-search="${r.id}">🔍 Search…</button><button class="btn btn-ghost btn-sm" data-skip="${r.id}">Skip</button></div>`}
          ${p ? `<div class="pr-act"><button class="qc-link" data-unmatch="${r.id}">Change product</button></div>` : ''}
          ${w.length ? `<div class="pr-warn">⚠ ${w.map(esc).join(' · ')}</div>` : ''}
        </div>`; }).join('') || '<p class="subtle">Nothing here.</p>'}
        ${view.length>state.shown ? `<button class="btn btn-ghost" id="pr_more" style="width:100%;">Show more (${view.length-state.shown} left)</button>` : ''}
      </div>
      <div class="pr-bar"><span>${apply.length} price${apply.length===1?'':'s'} will be saved</span><button class="btn btn-signal" id="pr_apply" ${apply.length?'':'disabled'}>Apply ${apply.length}</button></div>`;
    $('#pr_chips').querySelectorAll('[data-f]').forEach(b=>b.onclick=()=>{ state.filter=b.dataset.f; state.shown=40; draw(); });
    if($('#pr_more')) $('#pr_more').onclick = ()=>{ state.shown += 80; draw(); };
    $('#pr_reset').onclick = ()=>{ state.rows = null; draw(); };
    const byId = id=> rows.find(r=>r.id===id);
    const setProduct = (r, p, learn)=>{ r.productId = p.id; r.how = 'chosen'; r.include = !r.bad && (state.dup.get(p.id)||0)===0; r.cands = []; r.skip = false; r.learn = learn; prodById.set(p.id, p); };
    $('#pr_list').querySelectorAll('[data-inc]').forEach(cb=>cb.onchange=()=>{ byId(cb.dataset.inc).include = cb.checked; draw(); });
    $('#pr_list').querySelectorAll('[data-pick]').forEach(b=>b.onclick=()=>{ setProduct(byId(b.dataset.pick), prodById.get(b.dataset.pid), true); draw(); });
    $('#pr_list').querySelectorAll('[data-skip]').forEach(b=>b.onclick=()=>{ const r = byId(b.dataset.skip); r.skip = true; r.include = false; draw(); });
    $('#pr_list').querySelectorAll('[data-unmatch]').forEach(b=>b.onclick=()=>{ const r = byId(b.dataset.unmatch); r.productId = ''; r.include = false; r.skip = false; r.cands = suggestSmart(r.name, state.ctx.index, 3, 0.4); draw(); });
    $('#pr_list').querySelectorAll('[data-search]').forEach(b=>b.onclick=()=>openProductPicker(null, products, whMap, secMap, picked=>{ setProduct(byId(b.dataset.search), picked, true); draw(); }));
    $('#pr_conf').onclick = ()=>{
      const list = rows.filter(r=>!r.productId && !r.skip && r.cands.length && isConfident(suggestSmart(r.name, state.ctx.index, 2, 0.5)));
      if(!list.length){ showAlert('No suggestion is clearly the best yet. Pick a few by hand — each one teaches the app.', 'Nothing clear'); return; }
      showModal(`<h3>Accept ${list.length} clear suggestion${list.length===1?'':'s'}</h3><p class="subtle" style="margin-top:-8px;">Untick any that are wrong.</p>
        <div style="max-height:52vh; overflow:auto; border:1px solid var(--line); border-radius:10px; padding:6px;">${list.map((r,i)=>{ const s = suggestSmart(r.name, state.ctx.index, 1, 0.5)[0]; r._top = s.p; return `<label style="display:flex; gap:10px; align-items:center; padding:7px 4px; border-bottom:1px solid var(--line);"><input type="checkbox" data-ok="${i}" checked><span style="flex:1; min-width:0;"><b>${esc(r.name)}</b><span class="subtle" style="display:block;">→ ${esc(s.p.name)} · ${Math.round(s.s*100)}%${s.via?` · also called “${esc(s.via)}”`:''}</span></span></label>`; }).join('')}</div>
        <div style="display:flex; gap:10px; margin-top:12px;"><button class="btn btn-signal" id="ok_go" style="flex:1;">Accept ticked</button><button class="btn btn-ghost" onclick="closeModal()">Cancel</button></div>`);
      $('#ok_go').onclick = ()=>{ list.forEach((r,i)=>{ if(document.querySelector(`[data-ok="${i}"]`).checked) setProduct(r, r._top, true); }); closeModal(); draw(); };
    };
    $('#pr_addnew').onclick = ()=>{
      const list = rows.filter(r=>!r.productId && !r.bad);
      if(!list.length){ showAlert('Every row already has a product.'); return; }
      showModal(`<h3>Add ${list.length} as new products?</h3><p class="subtle" style="margin-top:-8px;">Each name becomes a new product with its cost and sell price from the sheet. Untick the ones that are not real products. You can set unit and warehouse later from Products.</p>
        <div style="max-height:50vh; overflow:auto; border:1px solid var(--line); border-radius:10px; padding:6px;">${list.map((r,i)=>`<label style="display:flex; gap:10px; align-items:center; padding:7px 4px; border-bottom:1px solid var(--line);"><input type="checkbox" data-nw="${i}"><span style="flex:1;"><b>${esc(r.name)}</b></span></label>`).join('')}</div>
        <div style="display:flex; gap:10px; margin-top:12px;"><button class="btn btn-signal" id="nw_go" style="flex:1;">Add ticked</button><button class="btn btn-ghost" onclick="closeModal()">Cancel</button></div>`);
      $('#nw_go').onclick = async ()=>{
        const pick = list.filter((r,i)=>document.querySelector(`[data-nw="${i}"]`).checked);
        for(const r of pick){
          const p = {id:uid(), name:r.name, unit:'', supplierId:'', warehouseId:'', sectionId:'', priority:999, active:true, notes:'', stockQty:'', lowStockLimit:'', costPrice:'', sellPrice:'', priceHistory:[]};
          await put('products', p); products.push(p); setProduct(r, p, false);
        }
        state.ctx = await loadMatchContext(); closeModal(); draw();
      };
    };
    $('#pr_apply').onclick = async ()=>{
      const todo = rows.filter(r=>r.include && r.productId && !same(r));
      const over = todo.filter(r=>{ const p = prodById.get(r.productId); return p && (p.costPrice||p.sellPrice); }).length;
      const btn = $('#pr_apply'); btn.disabled = true; btn.textContent = 'Saving…';
      const used = new Set(); let saved = 0;
      const keys = new Set((await getAll('mappings')).map(m=>m.excelDescNormalized));
      for(const r of todo){
        const p = await getOne('products', r.productId); if(!p) continue;
        p.costPrice = r.cost; p.sellPrice = r.sell;
        p.priceHistory = [...(p.priceHistory||[]), {at:new Date().toISOString(), cost:r.cost, sell:r.sell, from:'sheet '+state.fileName}].slice(-50);
        await put('products', p); prodById.set(p.id, p); saved++;
        const k = normalize(r.name);
        if(r.learn && k && !keys.has(k) && normalize(p.name)!==k){ await put('mappings', {id:uid(), excelDescNormalized:k, label:r.name, productId:p.id}); keys.add(k); }
      }
      if(typeof syncNow==='function') syncNow();
      state.rows = null;
      showAlert(`${saved} price${saved===1?'':'s'} saved${over?` (${over} replaced an earlier price — the old one is kept in the product's price history)`:''}.`, 'Done');
      draw();
    };
  }
  draw();
});
