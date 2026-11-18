/* ============================ UNITS: picked unit vs price unit ============================
   A line is picked in one unit ("PKT 100 GM", "PC", "KG") and priced in another ("per KG", "per PKT"). Nothing is billed in a
   unit that does not match its price unless the maths is exact and shown, or somebody answered the one question it needs.
     - weight/volume on both sides  -> converted exactly:  30 x 100 gm = 3 KG, billed 3 KG x price per KG
     - a count/pack word on one side -> needs one fact about the product ("1 PKT = 23 PC"), asked once, kept on the product
     - anything else                 -> the line asks (blocks issuing) instead of guessing
   Only lines flagged unitCheck are affected, so invoices already issued keep their numbers exactly as they were. */
const UNIT_WORD = {pc:'pc', pcs:'pc', piece:'pc', pieces:'pc', each:'pc', unit:'pc', units:'pc', no:'pc', nos:'pc',
  pkt:'pkt', pkts:'pkt', packet:'pkt', packets:'pkt', pack:'pkt', packs:'pkt', pk:'pkt',
  case:'case', cases:'case', cs:'case', ctn:'ctn', ctns:'ctn', carton:'ctn', cartons:'ctn', box:'box', boxes:'box', bx:'box',
  tray:'pkt', trays:'pkt', tin:'tin', tins:'tin', btl:'btl', btls:'btl', bottle:'btl', bottles:'btl', can:'can', cans:'can', bag:'bag', bags:'bag', jar:'jar', jars:'jar'};
const UNIT_RANK = {pc:1, pkt:2, tin:2, btl:2, can:2, bag:2, jar:2, box:3, case:4, ctn:4};          // bigger rank holds the smaller ones
const unitLabelOf = w => String(w||'').toUpperCase();

/* "PKT 100 GM" -> {word:'pkt', m:100 gm}; "KG" -> {word:null, m:1 kg, bare:true}; "PC" -> {word:'pc', m:null}; unknown -> null */
function unitInfo(text){
  const s = String(text||'').trim().replace(/^per\s+/i, ''); if(!s) return null;                  // "PER PC" is "PC"
  const cm = /(\d+(?:\.\d+)?)\s*(?:pcs?|pieces?|nos?|units?)(?![a-z])/i.exec(s);                  // "23 PC", "TRAY 23 PCS": a pack that holds that many pieces
  if(cm && !/[x*×]/.test(s) && Dec.parse(cm[1]) && Dec.cmp(Dec.parse(cm[1]), Dec.ZERO)>0){
    const f = /^[a-z]+/i.exec(s), w = f && UNIT_WORD[f[0].toLowerCase()];
    return {word:(w && w!=='pc') ? w : 'pkt', m:null, bare:false, cnt:Dec.str(Dec.parse(cm[1]))};
  }
  const size = parseSize(s), first = /^[a-z]+/i.exec(s);
  const bare = SIZE_UNITS[s.toLowerCase().replace(/\.$/,'')] ? parseMeasure(s) : null;
  const word = first ? (UNIT_WORD[first[0].toLowerCase()] || null) : null;
  const m = bare || size || null;
  if(!word && !m) return null;
  return {word, m, bare:!!bare};
}
/* same unit written differently (PC / PCS, KG / KGS, PKT / PACKET) */
function unitSame(a, b){
  const x = unitInfo(a), y = unitInfo(b);
  if(!x || !y) return normalize(a)===normalize(b);
  if(x.cnt || y.cnt) return !!(x.cnt && y.cnt && Dec.cmp(Dec.parse(x.cnt), Dec.parse(y.cnt))===0);   // "23 PC" is not the same unit as "PKT"
  if(x.m && y.m && sameSize(x.m, y.m) && (!x.word || !y.word || x.word===y.word)) return true;       // "400 GM" and "400 GM"
  if(x.word && y.word) return x.word===y.word;
  if(x.m && y.m && x.bare && y.bare) return sameSize(x.m, y.m);
  return false;
}
/* a typed answer: "23", "100 gm", "0.1 kg" -> {qty:'23', unit:'pc'} using defaultUnit when none is typed */
function parseFactAnswer(text, defaultUnit){
  const t = String(text||'').trim(); if(!t) return null;
  const m = parseSize(t);
  if(m){ const q = Dec.parse(m.qty); return q && Dec.cmp(q, Dec.ZERO)>0 ? {qty:Dec.str(q), unit:m.unit} : null; }
  const q = Dec.parse(t); if(!q || Dec.cmp(q, Dec.ZERO)<=0) return null;
  return {qty:Dec.str(q), unit:String(defaultUnit||'').toLowerCase()};
}

/* How is this line billed, given what was picked and what the product is priced per?
   null: nothing to convert (same unit, or not enough known) | {ask:{big,small}, issue} | {issue,partial} | {billed:Rat, label, note, fact?, picked} */
function resolveUnits(l, qty){
  let pu = unitInfo(l.priceUnit); const pk = unitInfo(l.unit); let inferred = '';
  if(!pu && pk && !String(l.priceUnit||'').trim()){
    /* the product has no unit: "BROTH BEEF KG" is priced per KG; if even the name does not say and a sized pack was picked, ask - never bill 30 packs as 30 KG */
    const nm = /(?:^|\s)(kgs?|ltr|lt|l|gms?|g|ml)\s*$/i.exec(String(l.sysName||'').trim());
    if(nm){ pu = unitInfo(nm[1]); inferred = nm[1].toUpperCase(); l = Object.assign({}, l, {priceUnit:inferred}); }
    else if(pk.m && pk.word) return {issue:'Price unit needed'};
  }
  const r = resolveCore(l, qty, pu, pk);
  if(r && inferred && r.note) r.note += ` (price unit ${inferred} taken from the product name)`;
  return r;
}
function resolveCore(l, qty, pu, pk){
  if(!pu || !pk) return null;
  if(pu.word && pk.word && pu.word===pk.word) return null;                                   // PKT priced per PKT: as it is
  if(pu.bare && pk.bare && pk.m.family===pu.m.family && sameSize(pk.m, pu.m)) return null;   // KG priced per KG
  const facts = l.facts || {}, q = Rat.fromDec(qty), pickedText = `${Dec.fmt(qty,0)} ${l.unit}`;
  const priceLabel = (l.priceUnit||'').trim().toUpperCase();
  const factRat = f => ({n:Dec.parse(f.qty).n, d:10n**BigInt(Dec.parse(f.qty).s)});
  const sizeOfUnit = u => { const mm = parseMeasure(u); return mm || null; };
  const needFact = (big, smallLabel) => ({ask:{big, smallLabel}, issue:'Unit conversion needed'});

  /* ---- a unit that says how many pieces it holds: "23 PC", "TRAY 23 PCS" - converted exactly, nothing to ask ---- */
  if(pu.cnt || pk.cnt){
    const cr = c => factRat({qty:c});
    if(pu.cnt && pk.cnt){
      if(Dec.cmp(Dec.parse(pu.cnt), Dec.parse(pk.cnt))===0) return null;
      return {packs:Rat.div(Rat.mul(q, cr(pk.cnt)), cr(pu.cnt)), label:'PACK', picked:pickedText, note:`${Dec.fmt(qty,0)} × ${pk.cnt} ÷ ${pu.cnt}`};
    }
    if(pu.cnt && pk.word==='pc' && !pk.m) return {packs:Rat.div(q, cr(pu.cnt)), label:'PACK', picked:pickedText, note:`${Dec.fmt(qty,0)} ${unitLabelOf(pk.word)} ÷ ${pu.cnt}`};
    if(pk.cnt && pu.word==='pc' && !pu.m) return {billed:Rat.mul(q, cr(pk.cnt)), label:'PC', picked:pickedText, note:`${Dec.fmt(qty,0)} × ${pk.cnt}`};
    return {issue:'Unit not comparable'};
  }
  /* same size written the same way on both sides ("400 GM" picked, priced per "400 GM"): as it is */
  if(pu.m && pk.m && !pu.bare && !pk.bare && sameSize(pu.m, pk.m)) return null;

  /* ---- priced per a measure (KG, LTR, GM, ML) ---- */
  if(pu.bare || (pu.m && pk.m)){
    if(pk.m){                                                                                   // picked has a size: "PKT 100 GM", "GM"
      if(pk.m.family!==pu.m.family) return {issue:'Unit not comparable'};
      const billed = Rat.div(Rat.mul(q, Rat.fromDec(pk.m.base)), Rat.fromDec(pu.m.base));
      return {billed, label:priceLabel, picked:pickedText, note:`${Dec.fmt(qty,0)} × ${pk.m.qty} ${pk.m.unit}`};
    }
    const f = facts[pk.word];                                                                   // picked a count/pack word: "1 PKT = 100 gm"
    const fm = f ? sizeOfUnit(f.unit) : null;
    if(f && fm && fm.family===pu.m.family){
      const per = Rat.div(Rat.mul(factRat(f), Rat.fromDec(fm.base)), Rat.fromDec(pu.m.base));
      return {billed:Rat.mul(q, per), label:priceLabel, picked:pickedText, note:`${Dec.fmt(qty,0)} ${unitLabelOf(pk.word)} × ${f.qty} ${f.unit}`, fact:{big:pk.word, f}};
    }
    return needFact(pk.word, priceLabel);
  }

  /* ---- priced per a count/pack word (PKT, PC, CASE...) ---- */
  const pw = pu.word;
  if(pk.m && !pk.word){                                                                         // picked by size ("GM", "KG") but priced per pack
    const f = facts[pw], fm = f ? sizeOfUnit(f.unit) : null;
    if(f && fm && fm.family===pk.m.family){
      const packs = Rat.div(Rat.mul(q, Rat.fromDec(pk.m.base)), Rat.mul(factRat(f), Rat.fromDec(fm.base)));
      return {packs, label:unitLabelOf(pw), picked:pickedText, note:`${Dec.fmt(qty,0)} ${l.unit} ÷ ${f.qty} ${f.unit}`, fact:{big:pw, f}};
    }
    return needFact(pw, String(l.unit||'').trim().toUpperCase());
  }
  const rp = UNIT_RANK[pk.word], ru = UNIT_RANK[pw];
  if(rp!==undefined && ru!==undefined && rp<ru){                                                // picked pieces, priced per the pack that holds them
    const f = facts[pw];
    if(f && unitInfo(f.unit) && unitInfo(f.unit).word===pk.word){
      return {packs:Rat.div(q, factRat(f)), label:unitLabelOf(pw), picked:pickedText, note:`${Dec.fmt(qty,0)} ${unitLabelOf(pk.word)} ÷ ${f.qty}`, fact:{big:pw, f}};
    }
    return needFact(pw, unitLabelOf(pk.word));
  }
  const f = facts[pk.word];                                                                     // picked the pack (or unknown rank), priced per the smaller unit
  if(f && unitInfo(f.unit) && unitInfo(f.unit).word===pw){
    return {billed:Rat.mul(q, factRat(f)), label:unitLabelOf(pw), picked:pickedText, note:`${Dec.fmt(qty,0)} ${unitLabelOf(pk.word)} × ${f.qty}`, fact:{big:pk.word, f}};
  }
  return needFact(pk.word, unitLabelOf(pw));
}
