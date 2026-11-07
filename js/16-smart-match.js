/* ============================ SMARTER NAME MATCHING ============================
   Suggests which product a name from an order/past order is, using:
   • the product's name AND every name already mapped to it (its aliases: each match you confirmed teaches it),
   • word weights: a rare word ("tenderloin") counts for more than a common one ("fresh", "chicken"),
   • typos, plurals and shortened words ("chick" ≈ "chicken"), word order ignored,
   • pack sizes: a different size lowers the score (but still shows).
   Candidates come from a word index so 1000+ names against thousands of products stays instant.
   ============================================================================ */
const _SM_SIZE_RE = /^\d+(?:\.\d+)?(?:kg|g|gm|gms|ml|l|ltr|pcs|pc|pkt|ctn|x)?$/;
function _smSizes(s){ return new Set(normalize(s).split(' ').filter(t=>_SM_SIZE_RE.test(t))); }
function _smTokMatch(t, u){
  if(t===u) return true;
  if(t.length>=4 && u.length>=4){
    if(t.startsWith(u) || u.startsWith(t)) return true;      // "chick" ≈ "chicken"
    return levRatio(t,u)>=0.8;                                // small typos
  }
  return false;
}

/* Build once per set of products/mappings (cheap to rebuild after a change). */
function buildSuggestIndex(products, mappings){
  const labels = new Map();
  for(const m of mappings||[]){
    if(!m.productId) continue;
    const l = m.label || m.excelDescNormalized; if(!l) continue;
    if(!labels.has(m.productId)) labels.set(m.productId, []);
    labels.get(m.productId).push(l);
  }
  const entries = [], df = new Map(), active = products.filter(p=>p.active);
  for(const p of active){
    const seen = new Set(), prodTokens = new Set();
    const add = (name, alias)=>{
      const k = normalize(name); if(!k || seen.has(k)) return; seen.add(k);
      const tokens = [...new Set(nameTokens(name))];
      tokens.forEach(t=>prodTokens.add(t));
      entries.push({p, name, alias, norm:k, tokens, sizes:_smSizes(name)});
    };
    add(p.name, false);
    (labels.get(p.id)||[]).forEach(l=>add(l, true));
    prodTokens.forEach(t=>df.set(t,(df.get(t)||0)+1));
  }
  const N = Math.max(1, active.length), byTok = new Map();
  const weight = t=>{ const d = df.get(t); return d ? Math.max(0.35, Math.log(1+N/d)) : Math.max(0.35, Math.log(1+N)); };
  entries.forEach((e,i)=>{ e.w = e.tokens.map(weight); for(const t of e.tokens){ const k = t.slice(0,3); if(!byTok.has(k)) byTok.set(k, []); byTok.get(k).push(i); } });
  return {entries, byTok, weight, count:active.length};
}

function _smScore(descNorm, aTok, aW, aSizes, e, idx){
  let base = 0;
  if(descNorm===e.norm) base = 0.99;
  else base = similarity(descNorm, e.norm);
  let word = 0;
  if(aTok.length && e.tokens.length){
    let wa = 0, wam = 0, wb = 0, wbm = 0;
    aTok.forEach((t,i)=>{ wa += aW[i]; if(e.tokens.some(u=>_smTokMatch(t,u))) wam += aW[i]; });
    e.tokens.forEach((u,i)=>{ wb += e.w[i]; if(aTok.some(t=>_smTokMatch(t,u))) wbm += e.w[i]; });
    const ra = wa ? wam/wa : 0, rb = wb ? wbm/wb : 0;
    word = 0.5*Math.max(ra,rb) + 0.5*((ra+rb)/2);
  }
  let score = Math.min(0.95, Math.max(Math.min(base,0.95), word));
  if(descNorm===e.norm) score = 0.99;
  if(aSizes.size && e.sizes.size && ![...aSizes].some(t=>e.sizes.has(t))) score = Math.min(score, 0.8);
  return score;
}

/* how alike two typed names are (0–1), using the same word weighting as the suggestions */
function nameAlike(a, b, idx){
  const an = normalize(a), bn = normalize(b); if(!an || !bn) return 0;
  const aTok = [...new Set(nameTokens(a))];
  return _smScore(an, aTok, aTok.map(idx.weight), _smSizes(a), {norm:bn, tokens:[...new Set(nameTokens(b))], sizes:_smSizes(b), w:[...new Set(nameTokens(b))].map(idx.weight)}, idx);
}

/* → [{p, s, via}]  best first; `via` is the alias that produced the match (null when it was the product's own name) */
function suggestSmart(desc, idx, n=4, min=0.4){
  const descNorm = normalize(desc); if(!descNorm || !idx) return [];
  const aTok = [...new Set(nameTokens(desc))], aW = aTok.map(idx.weight);
  const aSizes = _smSizes(desc);
  let cand = new Set();
  for(const t of aTok){ const l = idx.byTok.get(t.slice(0,3)); if(l) l.forEach(i=>cand.add(i)); }
  const ids = cand.size>=3 ? [...cand] : idx.entries.map((_,i)=>i);   // a heavily misspelled start → look at everything
  const best = new Map();
  for(const i of ids){
    const e = idx.entries[i], s = _smScore(descNorm, aTok, aW, aSizes, e, idx);
    if(s<min) continue;
    const cur = best.get(e.p.id);
    if(!cur || s>cur.s || (s===cur.s && !e.alias)) best.set(e.p.id, {p:e.p, s, via: e.alias ? e.name : null});
  }
  return [...best.values()].sort((a,b)=>b.s-a.s).slice(0,n);
}
/* a suggestion we'd be comfortable accepting in bulk: clearly the best, and clearly better than the runner-up */
function isConfident(sugs){
  if(!sugs.length) return false;
  const top = sugs[0], second = sugs[1];
  return top.s>=0.85 && (!second || top.s-second.s>=0.08);
}
