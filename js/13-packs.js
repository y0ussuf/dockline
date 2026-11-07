/* ============================ PACK ROUNDING (order splitter) ============================
   Vessels often order broken quantities (5 L when a box is 3 L, 1000 eggs when a tray is 360). Each product
   can have a pack size (and each batch its own, which wins when set). The splitter's "Quantity check"
   suggests a whole number of packs using ONE rounding rule shared by every vessel (up / nearest / down),
   and a vessel can be marked "loose" for a product to skip the check. Both settings sync across devices.
   ======================================================================================== */
async function getPackSettings(){
  const s = await getOne('sharedSettings','pack');
  return {mode: s && ['up','nearest','down'].includes(s.mode) ? s.mode : 'up', loose: (s && s.loose) || {}};
}
async function savePackSettings(st){ await put('sharedSettings', {id:'pack', mode:st.mode, loose:st.loose}); }

/* pack size to use for a product: the batch that would be picked next, else the product's own */
function packOf(product, batches){
  if(!product) return null;
  const list = (batches||[]).filter(b=>b.productId===product.id && b.qtyRemaining>BATCH_EPS).sort(fefoSort);
  const withPack = list.find(b=>parseFloat(b.packSize)>0);
  const size = withPack ? parseFloat(withPack.packSize) : parseFloat(product.packSize);
  if(!(size>0)) return null;
  return {size, name: product.packName || 'pack', fromBatch: !!withPack};
}
function packPlural(name, n){ if(n===1 || /^(kg|g|gm|gms|l|ltr|ltrs|ml|pcs|pc|pkt|pkts|oz|lb|lbs)$/i.test(name.trim())) return name; return /(s|x|z|ch|sh)$/i.test(name) ? name+'es' : /[^aeiou]y$/i.test(name) ? name.slice(0,-1)+'ies' : name+'s'; }
function roundToPacks(qtyInProductUnit, size, mode){
  const packs = qtyInProductUnit/size;
  const whole = Math.abs(packs-Math.round(packs)) < 1e-6;
  if(whole) return {ok:true, packs:Math.round(packs), qty:round2(Math.round(packs)*size)};
  const n = Math.max(1, mode==='down' ? Math.floor(packs+1e-9) : mode==='nearest' ? Math.round(packs) : Math.ceil(packs-1e-9));
  return {ok:false, packs:n, qty:round2(n*size)};
}
/* a line that has a pack size but whose unit can't be compared with the product's unit (so it can't be checked) */
function packUnjudgeable(row, product, batches){
  const pack = packOf(product, batches), q = parseFloat(row.qty);
  if(!pack || !(q>0)) return null;
  if(row.unit && product.unit && normalize(row.unit)!==normalize(product.unit)){
    const c = computeUnitConversion(row.unit, product.unit, q);
    if(!c || !(c.convertedQty>0)) return {pack};
  }
  return null;
}
/* Works out whether an ordered line is a whole number of packs; returns null when it needs no change or can't be judged.
   Quantity is checked in the product's unit, and the suggestion is converted back to the unit the vessel used. */
function packCheck(row, product, batches, mode){
  const pack = packOf(product, batches);
  const q = parseFloat(row.qty);
  if(!pack || !(q>0)) return null;
  let factor = 1; // product-unit quantity per 1 ordered unit
  if(row.unit && product.unit && normalize(row.unit)!==normalize(product.unit)){
    const c = computeUnitConversion(row.unit, product.unit, q);
    if(!c || !(c.convertedQty>0)) return null;
    factor = c.convertedQty/q;
  }
  const useMode = ['up','nearest','down'].includes(product.packRound) ? product.packRound : mode;   // an item can have its own rule
  const r = roundToPacks(q*factor, pack.size, useMode);
  if(r.ok) return null;
  return {pack, packs:r.packs, suggested: round2(r.qty/factor), productQty: r.qty};
}
