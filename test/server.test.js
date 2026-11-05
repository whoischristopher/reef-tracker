const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 18000 + Math.floor(Math.random() * 1000);
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reef-'));
let proc;
const api = async (method, p, body) => {
  const r = await fetch(`http://127.0.0.1:${PORT}${p}`, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: r.headers.get('content-type')?.includes('json') ? await r.json() : await r.text() };
};

test.before(async () => {
  proc = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir }, stdio: 'pipe' });
  for (let i = 0; i < 50; i++) { try { await fetch(`http://127.0.0.1:${PORT}/healthz`); return; } catch { await new Promise((r) => setTimeout(r, 100)); } }
  throw new Error('server did not start');
});
test.after(() => { proc.kill(); fs.rmSync(dataDir, { recursive: true, force: true }); });

test('starts empty with generic RODI stages', async () => {
  const s = (await api('GET', '/api/state')).json;
  assert.equal(s.entries.length, 0);
  assert.equal(s.filters.length, 4);
  assert.deepEqual(s.config.tanks, []);
});

test('bulk import, replace, and tank delete', async () => {
  const L = require('../lib/logic.js');
  const t = L.makeTank('Reef', 'reef', []);
  const config = { tanks: [t], rodi: { ...L.DEFAULT_CONFIG.rodi, includeTanks: [t.id] } };
  const mk = (date, ca) => ({ tank: t.id, date, values: { ca }, doses: {}, events: [], note: '' });
  assert.equal((await api('POST', '/api/bulk', { entries: [mk('2026-01-01', 420), mk('2026-01-02', 430)], config })).status, 200);
  assert.equal((await api('GET', '/api/state')).json.entries.length, 2);
  await api('POST', '/api/bulk', { entries: [mk('2026-02-01', 440)], replaceTank: t.id });
  let s = (await api('GET', '/api/state')).json;
  assert.equal(s.entries.length, 1);
  assert.equal((await api('POST', '/api/bulk', { entries: [{ tank: t.id, date: 'bad' }] })).status, 400);
  const d = (await api('POST', `/api/tanks/${t.id}/delete`)).json;
  assert.equal(d.removedEntries, 1);
  s = (await api('GET', '/api/state')).json;
  assert.equal(s.entries.length, 0);
  assert.deepEqual(s.config.tanks, []);
  assert.deepEqual(s.config.rodi.includeTanks, []);
});

test('create, patch, delete a document and bump version', async () => {
  const v0 = (await api('GET', '/api/version')).json.version;
  const { json: { id } } = await api('POST', '/api/doc/rodi', { date: '2026-11-05', gallons: 5 });
  await api('PATCH', `/api/doc/rodi/${id}`, { tdsOut: 0 });
  let s = (await api('GET', '/api/state')).json;
  assert.deepEqual(s.rodi.find((r) => r.id === id), { id, date: '2026-11-05', gallons: 5, tdsOut: 0, source: 'manual' });
  await api('DELETE', `/api/doc/rodi/${id}`);
  s = (await api('GET', '/api/state')).json;
  assert.ok(!s.rodi.some((r) => r.id === id));
  assert.ok(s.version > v0);
});

test('water changes create RODI log rows that follow the entry', async () => {
  const L = require('../lib/logic.js');
  const t = Object.assign(L.makeTank('Reef', 'reef', []), { volume: 50 });
  const config = { tanks: [t], rodi: { ...L.DEFAULT_CONFIG.rodi, includeTanks: [t.id] } };
  // old-style events are migrated to the waterChange field on the way in
  await api('POST', '/api/bulk', { config, replaceTank: t.id, entries: [
    { tank: t.id, date: '2026-10-01', values: {}, doses: {}, events: [{ type: 'water_change', gallons: 10 }, { type: 'rowaphos', grams: 75 }], note: '' },
    { tank: t.id, date: '2026-10-08', values: {}, doses: {}, waterChange: { percent: 20 }, events: [], note: '' },
  ] });
  let s = (await api('GET', '/api/state')).json;
  const e1 = s.entries.find((e) => e.date === '2026-10-01');
  assert.deepEqual([e1.waterChange, e1.gfo, e1.events], [{ gallons: 10 }, { grams: 75 }, []]);
  let auto = s.rodi.filter((r) => r.source === 'auto').sort((a, b) => (a.date < b.date ? -1 : 1));
  assert.deepEqual(auto.map((r) => r.gallons), [10, 10]);
  // auto rows can't be deleted directly
  assert.equal((await api('DELETE', `/api/doc/rodi/${auto[0].id}`)).status, 409);
  // editing the entry updates its row; deleting the entry removes it
  await api('PATCH', `/api/doc/entries/${e1.id}`, { waterChange: { gallons: 12 } });
  s = (await api('GET', '/api/state')).json;
  assert.equal(s.rodi.find((r) => r.entryId === e1.id).gallons, 12);
  await api('DELETE', `/api/doc/entries/${e1.id}`);
  s = (await api('GET', '/api/state')).json;
  assert.equal(s.rodi.filter((r) => r.source === 'auto').length, 1);
  // tank no longer uses RODI -> its rows go away
  await api('PUT', '/api/doc/config/main', { ...config, rodi: { ...config.rodi, includeTanks: [] } });
  s = (await api('GET', '/api/state')).json;
  assert.equal(s.rodi.filter((r) => r.source === 'auto').length, 0);
  await api('POST', `/api/tanks/${t.id}/delete`);
});

test('rejects unknown collections and bad bodies', async () => {
  assert.equal((await api('PUT', '/api/doc/users/x', { a: 1 })).status, 404);
  const r = await fetch(`http://127.0.0.1:${PORT}/api/doc/entries/x`, { method: 'PUT', body: '[1,2]' });
  assert.equal(r.status, 400);
});

test('export then import round-trips', async () => {
  const exp = (await api('GET', '/api/export')).json;
  const n = exp.entries.length;
  const r = await api('POST', '/api/import', exp);
  assert.equal(r.json.entries, n);
  assert.equal((await api('GET', '/api/state')).json.entries.length, n);
});

test('serves the app and shared logic', async () => {
  assert.match((await api('GET', '/')).json, /Reef Tracker/);
  assert.match((await api('GET', '/logic.js')).json, /filterUsage/);
});
