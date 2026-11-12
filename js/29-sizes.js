/* ---------- Pack sizes of one product (1 KG and 400 GM of the same sugar) ----------
   A product keeps ONE stock total in its own unit (KG). A delivery received in a different measure of the same
   kind ("10 × 400 GM") becomes a batch that remembers its pack size (packLabel "400 GM", packSize 0.4 in KG).
   Each pack size can have its own cost and sell price, kept with the product's other prices (packPrices) so
   people who may not see prices never receive them. Stock is taken earliest-expiry first across all sizes. */
const sizeKey = label=> String(label||'').trim().replace(/\s+/g,' ').toUpperCase();
/* receiving: is this line a NEW size of the product? → {label, size (in the product's unit), pack} or null */
function newSizeOf(l, p){
  if(!p || !l || !l.unit || !p.unit) return null;
  if(normalize(l.unit)===normalize(p.unit)) return null;
  const c = computeUnitConversion(l.unit, p.unit, 1);
  if(!c || !isFinite(c.convertedQty) || !(c.convertedQty>0)) return null;
  return {label:sizeKey(l.unit), size:c.convertedQty};
}
function packPriceOf(p, label, which){ const e = p && p.packPrices && p.packPrices[sizeKey(label)]; return (e && e[which]) || ''; }
/* the product's own price scaled to a pack, exactly: {text} when it ends, {approx} when it never ends, null when unknown */
function scaledPackPrice(p, which, label){
  const price = Dec.parse(p && (which==='cost' ? p.costPrice : p.sellPrice)); if(!price) return null;
  const ref = p.priceRef && p.priceRef.qty ? p.priceRef : {qty:'1', unit:p.unit};
  const refSz = parseMeasure(`${ref.qty} ${ref.unit}`), pk = parseSize(label) || parseMeasure(label);
  if(!refSz || !pk || pk.family!==refSz.family || Dec.cmp(refSz.base, Dec.ZERO)<=0) return null;
  const r = Rat.mul(Rat.fromDec(price), Rat.div(Rat.fromDec(pk.base), Rat.fromDec(refSz.base)));
  const d = Rat.toDec(r); return d ? {text:Dec.str(d)} : {approx:Rat.peek(r)};
}
const packPriceNote = (p, label)=>{ const r = (p.priceRef && p.priceRef.qty) ? `${p.priceRef.qty} ${p.priceRef.unit}` : `1 ${p.unit}`; return `worked out from the price for ${r}`; };

/* the sizes a product has: from its batches and any saved prices */
async function sizesOfProduct(p){
  const bs = (await getAll('batches')).filter(b=>b.productId===p.id && b.packLabel);
  const m = new Map();
  bs.forEach(b=>{ const k = sizeKey(b.packLabel); m.set(k, {label:k, size:b.packSize, left:round2((m.get(k)||{left:0}).left + (b.qtyRemaining||0))}); });
  Object.keys(p.packPrices||{}).forEach(k=>{ if(!m.has(k)) m.set(k, {label:k, size:null, left:0}); });
  return [...m.values()];
}
/* accountant's editor: cost + sell price of each size (suggestions are only suggestions) */
async function packPriceEditor(p, done){
  const sizes = await sizesOfProduct(p);
  if(!sizes.length){ showAlert('This product has no extra pack sizes yet. They appear when you receive it in a different measure, like 400 GM.'); return; }
  const mayCost = seesCost(), maySell = seesSell(), mayEdit = can('prices.edit') && seesBothPrices();
  showModal(`<h3>Pack sizes & prices — ${esc(p.name)}</h3>
    <p class="subtle">The product itself is priced per ${esc(p.priceRef&&p.priceRef.qty?p.priceRef.qty+' '+p.priceRef.unit:'1 '+(p.unit||'unit'))}. Each size below is billed per pack at its own price.</p>
    ${sizes.map((s,i)=>{ const sc = scaledPackPrice(p,'sell',s.label), cc = scaledPackPrice(p,'cost',s.label);
      return `<div class="card" style="padding:10px 12px; margin-bottom:8px;"><b>${esc(s.label)}</b> <span class="subtle">· ${s.left} ${esc(p.unit||'')} on the shelf</span>
      <div style="display:grid; grid-template-columns:1fr 1fr; gap:8px; margin-top:6px;">
        ${mayCost?`<div class="field" style="margin:0;"><label>Cost per pack</label><input type="text" inputmode="decimal" data-sz="${i}" data-w="cost" value="${esc(packPriceOf(p,s.label,'cost'))}" placeholder="${cc?esc(cc.text||cc.approx):''}" ${mayEdit?'':'disabled'}></div>`:''}
        ${maySell?`<div class="field" style="margin:0;"><label>Sell price per pack</label><input type="text" inputmode="decimal" data-sz="${i}" data-w="sell" value="${esc(packPriceOf(p,s.label,'sell'))}" placeholder="${sc?esc(sc.text||sc.approx):''}" ${mayEdit?'':'disabled'}></div>`:''}
      </div>${(mayCost||maySell)?`<div class="subtle" style="font-size:12px; margin-top:4px;">Blank = not set. Greyed numbers are only a suggestion ${esc(packPriceNote(p,s.label))}.</div>`:''}</div>`; }).join('')}
    <div style="display:flex; gap:10px; margin-top:12px;">${mayEdit?'<button class="btn btn-signal" id="sz_save" style="flex:1;">Save prices</button>':''}<button class="btn btn-ghost" onclick="closeModal()" style="${mayEdit?'':'flex:1;'}">Close</button></div>`);
  const sv = $('#sz_save'); if(!sv) return;
  sv.onclick = async ()=>{
    const pp = Object.assign({}, p.packPrices||{});
    for(const el of document.querySelectorAll('[data-sz]')){
      const s = sizes[+el.dataset.sz], v = el.value.trim();
      if(v!=='' && !Dec.parse(v)){ showAlert('Enter plain numbers, like 113.75.'); return; }
      const e = Object.assign({}, pp[s.label]||{}); if(v==='') delete e[el.dataset.w]; else e[el.dataset.w] = Dec.str(Dec.parse(v)); pp[s.label] = e;
    }
    p.packPrices = pp; await put('products', p); closeModal(); if(done) done();
  };
}
