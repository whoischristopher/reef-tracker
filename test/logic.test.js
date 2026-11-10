const test = require('node:test');
const assert = require('node:assert');
const L = require('../lib/logic.js');

const reef = Object.assign(L.makeTank('Reef', 'reef', []), { volume: 75 });
const config = { tanks: [reef], rodi: Object.assign({}, L.DEFAULT_CONFIG.rodi) };
const base = (over = {}) => ({ config, entries: [], rodiLogs: [], today: '2026-11-05', ...over });

test('time-based filter goes warn then crit', () => {
  const f = { name: 'Sediment', installed: '2026-06-01', lifeDays: 180, basis: 'feed' };
  assert.equal(L.filterUsage(base(), f).st, 'warn');           // 157/180 days = 87%
  assert.equal(L.filterUsage(base({ today: '2026-12-01' }), f).st, 'crit');
  assert.equal(L.filterUsage(base({ today: '2026-07-01' }), f).st, 'ok');
});

test('usage = logged RODI + daily estimate before the first logged batch; feed adds waste ratio', () => {
  const f = { name: 'Carbon', installed: '2026-10-26', lifeGallons: 100, basis: 'feed' };
  // only history rows so far: the estimate runs to today (10 days)
  let rodiLogs = [
    { date: '2026-10-30', source: 'history', gallons: 10 },
    { date: '2026-10-01', source: 'history', gallons: 99 }, // before install
  ];
  let u = L.filterUsage(base({ rodiLogs }), f);
  assert.deepEqual(u.breakdown, { logged: 10, estimate: 10, estDays: 10 });
  assert.equal(u.gal, 80); // (10 + 10) * (1 + 3)
  // first hand-logged batch on 11-01 stops the estimate there (6 days)
  rodiLogs = [...rodiLogs, { date: '2026-11-01', source: 'manual', gallons: 5 }, { date: '2026-11-03', source: 'manual', tdsOut: 0 }];
  u = L.filterUsage(base({ rodiLogs }), f);
  assert.deepEqual(u.breakdown, { logged: 15, estimate: 6, estDays: 6 });
  assert.equal(u.gal, 84);
  assert.equal(u.st, 'warn');
});

test('older RODI rows migrate to production rows', () => {
  const auto = { date: '2026-11-01', kind: 'water_change', source: 'auto', entryId: 'x', tank: 'reef', gallons: 10, note: 'Reef water change' };
  assert.deepEqual(L.migrateRodiRow(auto), { date: '2026-10-30', gallons: 10, source: 'history', note: 'Estimated: made for the 2026-11-01 water change' });
  assert.deepEqual(L.migrateRodiRow({ date: '2026-11-02', kind: 'topoff', source: 'manual', gallons: 5 }), { date: '2026-11-02', source: 'manual', gallons: 5 });
  assert.deepEqual(L.migrateRodiRow({ date: '2026-11-02', tdsOut: 0 }), { date: '2026-11-02', tdsOut: 0, source: 'manual' });
  const cur = { date: '2026-11-02', gallons: 5, source: 'manual' };
  assert.equal(L.migrateRodiRow(cur), cur); // unchanged rows are returned as-is
  const once = L.migrateRodiRow(auto);
  assert.equal(L.migrateRodiRow(once), once); // idempotent
});

test('normalizeEntry moves water change / Rowaphos events into fields', () => {
  const e = L.normalizeEntry({ tank: 'reef', date: '2026-06-10', values: {}, doses: {}, events: [
    { type: 'water_change', gallons: 10 }, { type: 'rowaphos', grams: 75 }, { type: 'note', text: 'Levelled the reactor' }] });
  assert.deepEqual(e.waterChange, { gallons: 10 });
  assert.deepEqual(e.gfo, { grams: 75 });
  assert.deepEqual(e.events, [{ type: 'note', text: 'Levelled the reactor' }]);
  assert.deepEqual(L.normalizeEntry(e), e); // idempotent
});

test('DI: crit above the TDS limit, warn at half of it', () => {
  const f = { name: 'DI', installed: '2026-10-20', tdsCheck: true, basis: 'product' };
  assert.equal(L.filterUsage(base({ rodiLogs: [{ date: '2026-11-01', tdsOut: 0 }] }), f).st, 'ok');
  assert.equal(L.filterUsage(base({ rodiLogs: [{ date: '2026-11-01', tdsOut: 0.5 }] }), f).st, 'warn');
  assert.equal(L.filterUsage(base({ rodiLogs: [{ date: '2026-11-01', tdsOut: 2 }] }), f).st, 'crit');
  // the latest reading wins
  assert.equal(L.filterUsage(base({ rodiLogs: [{ date: '2026-11-02', tdsOut: 0 }, { date: '2026-11-01', tdsOut: 2 }] }), f).st, 'ok');
});

test('TDS-checked stage warns when readings go stale', () => {
  const f = { name: 'DI', installed: '2026-03-06', tdsCheck: true, basis: 'product' };
  // no reading since install
  let u = L.filterUsage(base(), f);
  assert.equal(u.st, 'warn');
  assert.deepEqual(u.tdsStale, { days: 244, last: null });
  let a = L.filterAlerts(base(), [f])[0];
  assert.equal(a.title, 'DI: TDS check due');
  assert.match(a.detail, /no TDS reading since install \(244 days\)/);
  // a reading 20 days ago is fine; 40 days ago is stale
  assert.equal(L.filterUsage(base({ rodiLogs: [{ date: '2026-10-16', tdsOut: 0 }] }), f).st, 'ok');
  u = L.filterUsage(base({ rodiLogs: [{ date: '2026-09-26', tdsOut: 0 }] }), f);
  assert.deepEqual(u.tdsStale, { days: 40, last: '2026-09-26' });
  // a new stage gets the grace period from its install date; 0 turns reminders off
  assert.equal(L.filterUsage(base(), { ...f, installed: '2026-10-20' }).st, 'ok');
  const off = { ...config, rodi: { ...config.rodi, tdsStaleDays: 0 } };
  assert.equal(L.filterUsage(base({ config: off }), f).st, 'ok');
});

test('param alerts use the latest reading only', () => {
  const entries = [
    { tank: 'reef', date: '2026-11-01', values: { po4: 0.3 } },
    { tank: 'reef', date: '2026-11-04', values: { po4: 0.08 } },
    { tank: 'reef', date: '2026-11-04', values: { mg: 1100 } },
  ];
  const a = L.paramAlerts(base({ entries }), 'reef');
  assert.equal(a.length, 1);
  assert.match(a[0].title, /Magnesium below/);
});

test('paste from Google Sheets: header mapping, events in value columns, inherited dates', () => {
  const tsv = [
    '\tCalcium\tPhosphate \tdKH\tESV B-Ionic Mg dosing (ml)',
    '2026/09/28\t\t\t8\t60',
    '\t\t92g Rowas\t\t',
    '\t\t10 gallon Water change\t\t',
    '2026-06-07\t450\t0.75\t10\t',
  ].join('\n');
  const t = L.makeTank('Reef', 'reef', []);
  const rows = L.parseTable(tsv);
  const m = L.guessMapping(rows, t);
  assert.deepEqual(m.map.map((x) => x.kind + (x.key ? ':' + x.key : '')), ['date', 'param:ca', 'param:po4', 'param:alk', 'newdose']);
  const r = L.convertRows(rows, m, t);
  assert.equal(r.entries.length, 2);
  assert.deepEqual(r.entries[0].gfo, { grams: 92 });
  assert.deepEqual(r.entries[0].waterChange, { gallons: 10 });
  assert.deepEqual(r.entries[0].events, []);
  assert.equal(r.newDoses[0].unit, 'ml');
  assert.equal(r.entries[0].doses[r.newDoses[0].key], 60);
});

test('notes column: % water change and "added Xg of" doses (auto-created)', () => {
  const csv = 'Date,pH,KH,Notes\n2023-10-28,8.5,10,"40% water change, added 22g of lake salt and added 10g of buffer"\n2023-10-29,8.4,9,Added 15g of buffer';
  const t = L.makeTank('Cichlid', 'african_cichlid', []);
  const rows = L.parseTable(csv);
  const r = L.convertRows(rows, L.guessMapping(rows, t), t);
  assert.deepEqual(r.newDoses.map((d) => d.label), ['Lake salt', 'Buffer']);
  assert.deepEqual(r.entries[0].waterChange, { percent: 40 });
  assert.deepEqual(r.entries[0].doses, { lake_salt: 22, buffer: 10 });
  assert.deepEqual(r.entries[1].doses, { buffer: 15 });
});

test('ranges and Sheets-mangled ranges', () => {
  const t = L.makeTank('Reef', 'reef', []);
  const rows = L.parseTable('Date\tNitrate\n2026-06-07\t10-15\n2026-06-08\t2026-10-15');
  const r = L.convertRows(rows, L.guessMapping(rows, t), t);
  assert.equal(r.entries[0].values.no3, 12.5);
  assert.equal(r.entries[1].values.no3, 12.5);
  assert.equal(r.warnings.length, 1);
});

test('dates in several formats', () => {
  assert.equal(L.parseDate('2026/3/7'), '2026-03-07');
  assert.equal(L.parseDate('11/05/2026'), '2026-11-05');
  assert.equal(L.parseDate('25/10/2026'), '2026-10-25');
  assert.equal(L.parseDate('Nov 5, 2026'), '2026-11-05');
  assert.equal(L.parseDate('hello'), null);
});

test('dedicated water change / GFO columns', () => {
  const t = L.makeTank('Reef', 'reef', []);
  const rows = L.parseTable('Date\tWater change (gal)\tGFO (g)\n2026-11-01\t10\t\n2026-11-02\t\t60');
  const m = L.guessMapping(rows, t);
  assert.deepEqual(m.map.map((x) => x.kind), ['date', 'wc_gal', 'gfo']);
  const r = L.convertRows(rows, m, t);
  assert.deepEqual(r.entries.map((e) => [e.waterChange, e.gfo]), [[{ gallons: 10 }, undefined], [undefined, { grams: 60 }]]);
});
