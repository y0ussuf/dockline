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
