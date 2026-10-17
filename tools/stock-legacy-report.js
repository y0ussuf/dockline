#!/usr/bin/env node
/* Dockline — legacy stock report (READ-ONLY).
   Usage:  node tools/stock-legacy-report.js <dockline-backup.json> [outDir]
   Reads an app backup and writes:
     stock-legacy-report.md        human-readable summary
     opening-balances.csv          one row per tracked product, to be filled in and approved (see README)
     legacy-orders.csv             one row per finished order with its proof level and concerns
   It never touches the app or the database. It does NOT decide that any balance is correct. */
const fs = require('fs'), path = require('path');
const [,, file, outDir = '.'] = process.argv;
if (!file) { console.error('usage: node stock-legacy-report.js <backup.json> [outDir]'); process.exit(2); }
const backup = JSON.parse(fs.readFileSync(file, 'utf8'));
const S = backup.stores || {};
const products = S.products || [], items = S.orderItems || [], orders = S.orders || [], mappings = S.mappings || [], receipts = S.productReceipts || [];
const normalize = s => (s || '').toString().toLowerCase().trim().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();   // identical to the app's normalize()
const num = v => (v === '' || v == null || isNaN(parseFloat(v))) ? null : parseFloat(v);
const unitKey = u => normalize(u).replace(/\.$/, '');
const csv = rows => rows.map(r => r.map(c => { c = c == null ? '' : String(c); return /[",\n]/.test(c) ? '"' + c.replace(/"/g, '""') + '"' : c; }).join(',')).join('\n') + '\n';

const prodById = new Map(products.map(p => [p.id, p]));
const tracked = products.filter(p => num(p.stockQty) !== null);
const mapByDesc = new Map(mappings.map(m => [m.excelDescNormalized, m.productId]));
const itemsByOrder = new Map(); for (const it of items) { if (!itemsByOrder.has(it.orderId)) itemsByOrder.set(it.orderId, []); itemsByOrder.get(it.orderId).push(it); }
const repsOf = it => Array.isArray(it.replacements) && it.replacements.length ? it.replacements
  : (it.replacementProductId ? [{ productId: it.replacementProductId, qty: it.actualQty, unit: it.actualUnit }] : []);

// every quantity that the app WOULD have taken off stock for a line (mirrors applyStockDeductions)
function deductionLines(it) {
  if (it.status === 'completed' || it.status === 'modified') return it.productId ? [{ productId: it.productId, qty: it.actualQty, unit: it.actualUnit }] : [];
  if (it.status === 'substituted') return repsOf(it).filter(r => r.productId).map(r => ({ productId: r.productId, qty: r.qty, unit: r.unit }));
  return [];
}
const perProduct = new Map(tracked.map(p => [p.id, { orders: new Set(), concerns: {}, lines: 0 }]));
const addConcern = (pid, code) => { const e = perProduct.get(pid); if (e) e.concerns[code] = (e.concerns[code] || 0) + 1; };

const orderRows = []; let counts = { finished: 0, applied: 0, notApplied: 0, withConcerns: 0 };
for (const o of orders) {
  if (o.status !== 'completed') continue;
  counts.finished++;
  const its = itemsByOrder.get(o.id) || [], concerns = [];
  if (o.stockApplied !== true) { concerns.push('stock was never deducted for this order (finished before stock tracking, or by an older app version)'); counts.notApplied++; }
  else counts.applied++;
  let trackedLines = 0;
  for (const it of its) {
    for (const d of deductionLines(it)) {
      const p = prodById.get(d.productId);
      if (!p) { concerns.push(`line "${it.excelDesc}": product no longer exists`); continue; }
      if (!perProduct.has(p.id)) continue;                              // untracked: nothing was ever deducted
      trackedLines++; perProduct.get(p.id).orders.add(o.id); perProduct.get(p.id).lines++;
      if (typeof d.qty !== 'number' || isNaN(d.qty)) { concerns.push(`line "${it.excelDesc}": no picked quantity recorded`); addConcern(p.id, 'missing_quantity'); }
      if (unitKey(d.unit) !== unitKey(p.unit)) { concerns.push(`line "${it.excelDesc}": picked unit "${d.unit || ''}" ≠ stock unit "${p.unit || ''}"`); addConcern(p.id, 'unit_mismatch'); }
    }
    if (it.productId && ['completed', 'modified', 'from_supplier'].includes(it.status)) {          // mapping changed after the order was imported?
      const want = mapByDesc.get(normalize(it.excelDesc));
      if (want && want !== it.productId && prodById.get(want)) { concerns.push(`line "${it.excelDesc}": linked to “${(prodById.get(it.productId) || {}).name || it.productId}”, mapping now says “${prodById.get(want).name}”`); addConcern(it.productId, 'mapping_drift'); }
    }
    if (it.status === 'pending') concerns.push(`line "${it.excelDesc}": still pending on a finished order`);
  }
  if (concerns.length) counts.withConcerns++;
  // proof level: the app never stored what it deducted, so NO historical deduction can be proven from this data
  const proof = o.stockApplied !== true ? 'not deducted' : concerns.length ? 'unproven — with concerns' : 'unproven — derivable from current lines';
  orderRows.push([o.id, o.vesselName || '', (o.completedAt || '').slice(0, 10), o.stockApplied === true ? 'yes' : 'no', trackedLines, proof, concerns.join(' | ')]);
}

// receipts are the only other recorded stock movement; deleted receipts / manual overwrites left no trace
const recByProduct = new Map(); for (const r of receipts) { const e = recByProduct.get(r.productId) || { n: 0, sum: 0 }; e.n++; e.sum += +r.qty || 0; recByProduct.set(r.productId, e); }

const prodRows = [], md = [];
for (const p of tracked.sort((a, b) => String(a.name).localeCompare(String(b.name)))) {
  const e = perProduct.get(p.id), bal = num(p.stockQty), rec = recByProduct.get(p.id) || { n: 0, sum: 0 };
  const reasons = [];
  if (bal < 0) reasons.push('negative balance');
  if (!String(p.unit || '').trim()) reasons.push('product has no unit');
  if (e.concerns.unit_mismatch) reasons.push(`${e.concerns.unit_mismatch} line(s) picked in a different unit`);
  if (e.concerns.mapping_drift) reasons.push(`${e.concerns.mapping_drift} line(s) with changed mapping`);
  if (e.concerns.missing_quantity) reasons.push(`${e.concerns.missing_quantity} line(s) without quantity`);
  const status = reasons.length ? 'COUNT REQUIRED' : (e.orders.size || rec.n) ? 'REVIEW (history cannot be proven)' : 'no known concern (no history)';
  prodRows.push([p.id, p.name, p.unit || '', bal, e.orders.size, rec.n, rec.sum, status, reasons.join('; '),
    /* to be filled in by a person: */ '', '', '', '']);
}
const noCountNeeded = prodRows.filter(r => r[7].startsWith('no known')).length;

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'opening-balances.csv'), csv([['product_id', 'product', 'unit', 'current_balance', 'finished_orders_touching', 'receipts_logged', 'receipts_total', 'status', 'reasons',
  'BASIS (physical_count | accepted_unverified | derived)', 'COUNTED_OR_ACCEPTED_QTY', 'APPROVED_BY', 'APPROVED_AT'], ...prodRows]));
fs.writeFileSync(path.join(outDir, 'legacy-orders.csv'), csv([['order_id', 'vessel', 'finished_on', 'stock_applied_flag', 'tracked_lines', 'proof_level', 'concerns'], ...orderRows]));
const countReq = prodRows.filter(r => r[7] === 'COUNT REQUIRED').length, review = prodRows.filter(r => r[7].startsWith('REVIEW')).length;
md.push(`# Dockline legacy stock report`, ``, `Backup exported: ${backup.exportedAt || 'unknown'} · generated ${new Date().toISOString()}`, ``,
  `**Nothing in this report is a verified balance.** Dockline never stored how much it deducted per line, so no historical deduction can be proven from the data. This report only says where the data looks questionable.`, ``,
  `## Tracked products: ${tracked.length}`, `| Status | Products |`, `|---|---|`, `| COUNT REQUIRED | ${countReq} |`, `| REVIEW (history cannot be proven) | ${review} |`, `| no known concern (no history) | ${noCountNeeded} |`, ``,
  `## Finished orders: ${counts.finished}`, `| Proof level | Orders |`, `|---|---|`,
  `| not deducted (stock never taken off) | ${orderRows.filter(r => r[5] === 'not deducted').length} |`,
  `| unproven — with concerns | ${orderRows.filter(r => r[5] === 'unproven — with concerns').length} |`,
  `| unproven — derivable from current lines | ${orderRows.filter(r => r[5] === 'unproven — derivable from current lines').length} |`, ``,
  `"Derivable" means the deduction can be recomputed from the order's current lines; it is still not proof, because a line may have been edited after the order was finished.`, ``,
  `## Products needing a physical count first`, ...(prodRows.filter(r => r[7] === 'COUNT REQUIRED').map(r => `- **${r[1]}** (${r[3]} ${r[2]}) — ${r[8]}`)), ...(countReq ? [] : ['_none_']), ``,
  `## Not recoverable from any data`, `- Manual stock overwrites (Stock screen / product form) and deleted receipts leave no history.`, `- Anything changed on another device that was overwritten by a stale sync.`, ``,
  `## Next step`, `Fill in the last four columns of opening-balances.csv (basis, counted/accepted quantity, who approved, when). Only rows you approve become opening balances.`);
fs.writeFileSync(path.join(outDir, 'stock-legacy-report.md'), md.join('\n') + '\n');
console.log(md.slice(0, 22).join('\n'));
