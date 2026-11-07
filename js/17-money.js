/* ============================ EXACT MONEY MATHS ============================
   Prices, quantities and totals are kept as exact decimal numbers (a whole number plus a count of
   decimal places), never as JavaScript floats, and are NEVER rounded: 36.25 × 96 is exactly 3480,
   0.1 + 0.2 is exactly 0.3. Prices are stored as the text that was typed or imported ("71.78"). */
const Dec = (()=>{
  const TEN = 10n;
  const pow10 = n=> TEN ** BigInt(n);
  function norm(d){ let {n, s} = d; while(s>0 && n % TEN === 0n){ n /= TEN; s--; } return {n, s}; }
  /* "12.50" → {n:1250n, s:2}; accepts a number or text; null for anything that is not a plain decimal */
  function parse(v){
    if(v===null || v===undefined || v==='') return null;
    let t = typeof v==='number' ? (Number.isFinite(v) ? String(v) : '') : String(v).trim().replace(/,/g,'');
    if(/e/i.test(t) && typeof v==='number'){ t = v.toFixed(12).replace(/\.?0+$/,''); }
    const m = /^([+-])?(\d*)(?:\.(\d*))?$/.exec(t); if(!m || (m[2]==='' && (m[3]===undefined || m[3]===''))) return null;
    const frac = m[3] || '';
    return norm({n: BigInt((m[1]==='-'?'-':'')+((m[2]||'0')+frac)), s: frac.length});
  }
  const align = (a,b)=>{ const s = Math.max(a.s,b.s); return [a.n*pow10(s-a.s), b.n*pow10(s-b.s), s]; };
  const add = (a,b)=>{ const [x,y,s] = align(a,b); return norm({n:x+y, s}); };
  const sub = (a,b)=>{ const [x,y,s] = align(a,b); return norm({n:x-y, s}); };
  const mul = (a,b)=> norm({n:a.n*b.n, s:a.s+b.s});
  const cmp = (a,b)=>{ const [x,y] = align(a,b); return x<y ? -1 : x>y ? 1 : 0; };
  const ZERO = {n:0n, s:0};
  /* text with every digit that exists; at least `minDp` decimals so money reads as 3,480.00 */
  function fmt(d, minDp=2, group=true){
    if(!d) return '';
    let {n, s} = d; const neg = n<0n; if(neg) n = -n;
    let digits = n.toString().padStart(s+1, '0');
    let int = digits.slice(0, digits.length-s), frac = digits.slice(digits.length-s);
    while(frac.length<minDp) frac += '0';
    if(group) int = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return (neg?'-':'')+int+(frac?'.'+frac:'');
  }
  /* the plain string form (no grouping, no padding) — what gets stored */
  const str = d=> fmt(d, 0, false);
  /* the percentage p of d, exactly */
  const pct = (d, p)=> mul(d, {n:p.n, s:p.s+2});
  /* approximate markup % of sell over cost, for DISPLAY ONLY (never stored, never used in invoices) */
  function markupText(cost, sell){
    const c = parse(cost), s = parse(sell); if(!c || !s || c.n<=0n) return '';
    const scale = 10n**8n, v = ((s.n*pow10(c.s) - c.n*pow10(s.s)) * 100n * scale) / (c.n*pow10(s.s));
    const neg = v<0n, a = neg ? -v : v; const whole = a/scale, fr = (a%scale).toString().padStart(8,'0').replace(/0+$/,'');
    return (neg?'-':'')+whole.toString()+(fr?'.'+fr.slice(0,4):'');
  }
  /* sell price = cost × (100 + markup) / 100, exactly (finite decimal, so it always ends) */
  const sellFromMarkup = (cost, m)=>{ const c = parse(cost), p = parse(m); if(!c || !p) return null; return str(mul(c, norm({n:p.n + 100n*pow10(p.s), s:p.s+2}))); };
  return {parse, add, sub, mul, cmp, fmt, str, pct, ZERO, markupText, sellFromMarkup};
})();

/* ---- exact fractions, for pro-rata prices (65 per 200 ml → 350 ml is 65 × 350 ÷ 200) ----
   A fraction is {n, d} with BigInt parts. It can always be written exactly as a decimal when its
   denominator only has the factors 2 and 5 (…÷200, …÷250, …÷500); otherwise it never ends (…÷300). */
const Rat = (()=>{
  const gcd = (a,b)=>{ a = a<0n?-a:a; b = b<0n?-b:b; while(b){ [a,b] = [b,a%b]; } return a; };
  const red = r=>{ const g = gcd(r.n, r.d) || 1n; let {n,d} = {n:r.n/g, d:r.d/g}; if(d<0n){ n=-n; d=-d; } return {n,d}; };
  const fromDec = d=> red({n:d.n, d:10n**BigInt(d.s)});
  const mul = (a,b)=> red({n:a.n*b.n, d:a.d*b.d});
  const div = (a,b)=> red({n:a.n*b.d, d:a.d*b.n});
  /* the exact decimal, or null when it never ends */
  function toDec(r){
    r = red(r); let d = r.d, a = 0, b = 0;
    while(d%2n===0n){ d/=2n; a++; } while(d%5n===0n){ d/=5n; b++; }
    if(d!==1n) return null;
    const k = Math.max(a,b); return {n: r.n*(10n**BigInt(k))/r.d, s:k};
  }
  /* round half up (away from zero on .5) to dp decimals — only used when the person's rounding rule says so */
  function roundHalfUp(r, dp){
    r = red(r); const sc = r.n*(10n**BigInt(dp)), neg = sc<0n, a = neg?-sc:sc;
    let q = a/r.d; if((a%r.d)*2n >= r.d) q += 1n;
    return {n: neg?-q:q, s:dp};
  }
  /* "233.333…" — a readable look at a number that never ends (display only) */
  function peek(r, dp=3){
    r = red(r); const sc = r.n*(10n**BigInt(dp)), neg = sc<0n, q = (neg?-sc:sc)/r.d;
    const t = q.toString().padStart(dp+1,'0'); return (neg?'-':'')+t.slice(0,t.length-dp)+'.'+t.slice(t.length-dp)+'…';
  }
  return {fromDec, mul, div, toDec, roundHalfUp, peek};
})();

/* ---- sizes written in names and units: "350 ML", "BTL 350 ML", "PKT 500 GM", "1KG", "KG" ---- */
const SIZE_UNITS = {ml:['ml',1], l:['ml',1000], ltr:['ml',1000], lt:['ml',1000], litre:['ml',1000], liter:['ml',1000], litres:['ml',1000], liters:['ml',1000],
  g:['g',1], gm:['g',1], gms:['g',1], gr:['g',1], gram:['g',1], grams:['g',1], kg:['g',1000], kgs:['g',1000], kilo:['g',1000], kilos:['g',1000]};
/* → {qty:'350', unit:'ml', base:Dec (in ml or g), family:'ml'|'g', text, index} for the LAST size found in the text, or null */
function parseSize(text){
  const t = String(text||''); let found = null;
  const re = /(\d+(?:\.\d+)?)\s*(ml|litres?|liters?|ltr|lt|l|gms?|grams?|gr|g|kgs?|kilos?)(?![a-z])/gi; let m;
  while((m = re.exec(t))){
    const pre = t.slice(Math.max(0,m.index-2), m.index); if(/[xX*]\s*$/.test(pre)) continue;       // "6x200ml" is a multipack, not one size
    const [fam, mult] = SIZE_UNITS[m[2].toLowerCase()]; const q = Dec.parse(m[1]); if(!q || Dec.cmp(q, Dec.ZERO)<=0) continue;
    found = {qty:Dec.str(q), unit:m[2].toLowerCase(), family:fam, base:Dec.mul(q, Dec.parse(String(mult))), text:m[0], index:m.index};
  }
  return found;
}
/* a unit that is itself a measure — "KG", "LTR", "GM" — means size 1 of it */
function parseUnitSize(unitText){
  const s = parseSize(unitText); if(s) return s;
  const w = String(unitText||'').trim().toLowerCase().replace(/\.$/,''); const u = SIZE_UNITS[w]; if(!u) return null;
  return {qty:'1', unit:w, family:u[0], base:Dec.parse(String(u[1])), text:w, index:0};
}
const sameSize = (a,b)=> !!a && !!b && a.family===b.family && Dec.cmp(a.base, b.base)===0;

