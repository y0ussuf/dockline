/* ---------- Groups priced "as a whole" (meat & poultry, fish, pork…) ----------
   Their prices change with every delivery, so instead of a price per product the invoice gets ONE line per group:
   the supplier invoice total (typed in), plus an optional markup %. Which products belong to a group is a field on
   the product (lumpGroup); the list of groups is one shared record. */
async function getLumpGroups(){ const r = await getOne('sharedSettings','lumpGroups'); return (r && Array.isArray(r.names)) ? r.names : []; }
async function saveLumpGroups(names){ await put('sharedSettings', {id:'lumpGroups', names}); }

async function lumpGroupManager(onDone){
  let names = await getLumpGroups(); const products = await getAll('products');
  const draw = ()=>{
    showModal(`<h3>Groups priced as a whole</h3>
      <p class="subtle">Products in a group are not priced one by one. Each invoice gets a single line per group: the supplier invoice total, plus an optional markup %.</p>
      <div id="lg_list">${names.map((n,i)=>`<div class="list-row"><div style="flex:1;"><b>${esc(n)}</b><div class="subtle">${products.filter(p=>p.lumpGroup===n).length} products</div></div><button class="btn btn-ghost btn-sm" data-rm="${i}" style="color:var(--danger);">Remove</button></div>`).join('') || '<p class="subtle">No groups yet.</p>'}</div>
      <div style="display:flex; gap:8px; margin-top:10px;"><input type="text" id="lg_new" placeholder="New group, e.g. Meat &amp; poultry"><button class="btn btn-signal btn-sm" id="lg_add">Add</button></div>
      <button class="btn btn-ghost" id="lg_done" style="width:100%; margin-top:12px;">Done</button>`);
    $('#lg_add').onclick = async ()=>{ const v = $('#lg_new').value.trim(); if(!v) return; if(names.some(n=>n.toLowerCase()===v.toLowerCase())){ showAlert('That group already exists.'); return; } names = [...names, v]; await saveLumpGroups(names); draw(); };
    $('#lg_new').onkeydown = e=>{ if(e.key==='Enter') $('#lg_add').click(); };
    document.querySelectorAll('[data-rm]').forEach(b=>b.onclick=async ()=>{
      const n = names[+b.dataset.rm], used = products.filter(p=>p.lumpGroup===n);
      const go = async ()=>{ for(const p of used){ p.lumpGroup = ''; await put('products', p); } names = names.filter(x=>x!==n); await saveLumpGroups(names); draw(); };
      used.length ? showConfirm(`Remove “${n}”? Its ${used.length} products go back to normal per-product pricing.`, go, {danger:true, yesLabel:'Remove'}) : go();
    });
    $('#lg_done').onclick = ()=>{ closeModal(); if(onDone) onDone(); };
  };
  draw();
}

/* ---- invoice maths for the group lines ----
   amount = supplier invoice total (exact); sell = amount + markup%; then the line's discount like any other line. */
function lumpCalc(g){
  const amount = Dec.parse(g.amount) || Dec.ZERO, mk = Dec.parse(g.markup);
  const gross = mk ? Dec.add(amount, Dec.pct(amount, mk)) : amount;
  let d = Dec.ZERO;
  if(g.discType==='pct' && Dec.parse(g.disc)) d = Dec.pct(gross, dm(g.disc));
  else if(g.discType==='amt' && Dec.parse(g.disc)) d = dm(g.disc);
  return {gross, disc:d, net:Dec.sub(gross, d)};
}
