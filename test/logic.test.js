const test = require('node:test');
const assert = require('node:assert');
const L = require('../lib/logic.js');

const reef = Object.assign(L.makeTank('Reef', 'reef', []), { volume: 75 });
const config = { tanks: [reef], rodi: Object.assign({}, L.DEFAULT_CONFIG.rodi, { includeTanks: ['reef'] }) };
const base = (over = {}) => ({ config, entries: [], rodiLogs: [], today: '2026-11-05', ...over });

test('time-based filter goes warn then crit', () => {
  const f = { name: 'Sediment', installed: '2026-06-01', lifeDays: 180, basis: 'feed' };
  assert.equal(L.filterUsage(base(), f).st, 'warn');           // 157/180 days = 87%
  assert.equal(L.filterUsage(base({ today: '2026-12-01' }), f).st, 'crit');
  assert.equal(L.filterUsage(base({ today: '2026-07-01' }), f).st, 'ok');
});

test('usage = RODI log + top-off estimate; feed water adds waste ratio', () => {
  const rodiLogs = [
    { date: '2026-11-01', kind: 'water_change', source: 'auto', gallons: 10 },
    { date: '2026-11-02', kind: 'topoff', gallons: 5 },
    { date: '2026-10-01', kind: 'topoff', gallons: 99 }, // before install
  ];
  const f = { name: 'Carbon', installed: '2026-10-26', lifeGallons: 100, basis: 'feed' };
  const u = L.filterUsage(base({ rodiLogs }), f);
  // product = 10 WC + 5 refill + 1 gal/day * 10 days = 25; feed = 25 * (1 + 3) = 100
  assert.deepEqual(u.breakdown, { water_change: 10, topoff: 5, other: 0, topoffEst: 10 });
  assert.equal(u.gal, 100);
  assert.equal(u.st, 'crit');
});

test('water changes in RODI tanks become auto RODI log rows (% converted by volume)', () => {
  const entries = [
    { id: 'a', tank: 'reef', date: '2026-11-01', waterChange: { percent: 20 } },
    { id: 'b', tank: 'reef', date: '2026-11-02', waterChange: { gallons: 10 } },
    { id: 'c', tank: 'other', date: '2026-11-02', waterChange: { gallons: 5 } },
    { id: 'd', tank: 'reef', date: '2026-11-03', values: { ca: 420 } },
  ];
  const logs = L.autoRodiLogs(base({ entries }));
  assert.deepEqual(Object.keys(logs), ['wc-a', 'wc-b']);
  assert.equal(logs['wc-a'].gallons, 15);
  assert.equal(logs['wc-b'].kind, 'water_change');
});

test('normalizeEntry moves water change / Rowaphos events into fields', () => {
  const e = L.normalizeEntry({ tank: 'reef', date: '2026-06-10', values: {}, doses: {}, events: [
    { type: 'water_change', gallons: 10 }, { type: 'rowaphos', grams: 75 }, { type: 'note', text: 'Levelled the reactor' }] });
  assert.deepEqual(e.waterChange, { gallons: 10 });
  assert.deepEqual(e.gfo, { grams: 75 });
  assert.deepEqual(e.events, [{ type: 'note', text: 'Levelled the reactor' }]);
  assert.deepEqual(L.normalizeEntry(e), e); // idempotent
});

test('DI flags on TDS out above limit', () => {
  const f = { name: 'DI', installed: '2026-08-01', tdsCheck: true, basis: 'product' };
  assert.equal(L.filterUsage(base({ rodiLogs: [{ date: '2026-11-01', tdsOut: 0 }] }), f).st, 'ok');
  assert.equal(L.filterUsage(base({ rodiLogs: [{ date: '2026-11-01', tdsOut: 2 }] }), f).st, 'crit');
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
