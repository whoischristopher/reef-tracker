'use strict';
/*
 * Reef Tracker — self-hosted aquarium log.
 * Zero npm dependencies: Node's built-in http server + node:sqlite.
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const Logic = require('./lib/logic.js');

const PORT = Number(process.env.PORT || 8080);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'reef.db');
const SEED_FILE = process.env.SEED_FILE || ''; // optional: path to an export JSON to load into an empty database
const TZ = process.env.TZ || 'America/Toronto';
const AUTH_USER = process.env.AUTH_USER || '';
const AUTH_PASS = process.env.AUTH_PASS || '';
const NTFY_URL = process.env.NTFY_URL || '';
const NTFY_TOKEN = process.env.NTFY_TOKEN || '';
const WEBHOOK_URL = process.env.WEBHOOK_URL || '';
const NOTIFY_HOUR = Number(process.env.NOTIFY_HOUR ?? 9);
const APP_URL = process.env.APP_URL || '';
const COLLECTIONS = new Set(['config', 'entries', 'filters', 'rodi']);
const ID_RE = /^[A-Za-z0-9_.:-]{1,100}$/;

/* ------------------------------------------------------------- database */
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(DB_FILE);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA busy_timeout = 5000;
  CREATE TABLE IF NOT EXISTS docs (
    collection TEXT NOT NULL,
    id         TEXT NOT NULL,
    data       TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (collection, id)
  );
  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
`);
const q = {
  all: db.prepare('SELECT collection, id, data FROM docs'),
  byColl: db.prepare('SELECT id, data FROM docs WHERE collection = ?'),
  get: db.prepare('SELECT data FROM docs WHERE collection = ? AND id = ?'),
  put: db.prepare(`INSERT INTO docs (collection, id, data, updated_at) VALUES (?, ?, ?, ?)
                   ON CONFLICT(collection, id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`),
  del: db.prepare('DELETE FROM docs WHERE collection = ? AND id = ?'),
  delAll: db.prepare('DELETE FROM docs'),
  count: db.prepare('SELECT COUNT(*) AS n FROM docs'),
  getMeta: db.prepare('SELECT value FROM meta WHERE key = ?'),
  setMeta: db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'),
};
const getMeta = (k) => { const r = q.getMeta.get(k); return r ? r.value : null; };
const bump = () => q.setMeta.run('version', String(Number(getMeta('version') || 0) + 1));
const now = () => new Date().toISOString();

function putDoc(coll, id, data) {
  if (coll === 'entries') { data = Logic.normalizeEntry(data); delete data.id; }
  q.put.run(coll, id, JSON.stringify(data), now());
}
/**
 * Keep the RODI log in step with the tank logs: every water change in a tank that
 * uses RODI water has a matching auto row (id "wc-<entry id>"). Runs after any
 * change to entries or settings.
 */
function syncRodi() {
  const cfgRow = q.get.get('config', 'main');
  const entries = q.byColl.all('entries').map((r) => Object.assign({ id: r.id }, JSON.parse(r.data)));
  const want = Logic.autoRodiLogs({ config: cfgRow ? JSON.parse(cfgRow.data) : null, entries });
  let changed = 0;
  for (const r of q.byColl.all('rodi')) {
    const d = JSON.parse(r.data);
    if (d.source !== 'auto') continue;
    if (!want[r.id]) { q.del.run('rodi', r.id); changed++; }
    else if (JSON.stringify(want[r.id]) !== r.data) { q.put.run('rodi', r.id, JSON.stringify(want[r.id]), now()); changed++; }
    delete want[r.id];
  }
  for (const [id, d] of Object.entries(want)) { q.put.run('rodi', id, JSON.stringify(d), now()); changed++; }
  return changed;
}
function readState() {
  const s = { config: null, entries: [], filters: [], rodi: [], version: Number(getMeta('version') || 0) };
  for (const r of q.all.all()) {
    const d = Object.assign({ id: r.id }, JSON.parse(r.data));
    if (r.collection === 'config') { if (r.id === 'main') s.config = JSON.parse(r.data); }
    else s[r.collection].push(d);
  }
  return s;
}
function replaceAll(state) {
  db.exec('BEGIN');
  try {
    q.delAll.run();
    if (state.config) putDoc('config', 'main', state.config);
    for (const coll of ['entries', 'filters', 'rodi']) {
      for (const d of state[coll] || []) {
        const { id, ...rest } = d;
        if (coll === 'rodi' && rest.source === 'auto') continue; // regenerated below
        putDoc(coll, id && ID_RE.test(id) ? id : crypto.randomUUID(), rest);
      }
    }
    syncRodi();
    bump();
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

// First start: empty log with generic RODI stages, or an export file if SEED_FILE is set.
if (q.count.get().n === 0) {
  if (SEED_FILE && fs.existsSync(SEED_FILE)) {
    const seed = JSON.parse(fs.readFileSync(SEED_FILE, 'utf8'));
    replaceAll(seed);
    console.log(`Loaded ${path.basename(SEED_FILE)}: ${seed.entries.length} entries`);
  } else {
    replaceAll({ config: Logic.DEFAULT_CONFIG, entries: [], filters: Logic.DEFAULT_FILTERS, rodi: [] });
    console.log('Initialised an empty log');
  }
}
// Migrate older data (water changes / GFO stored as events, RODI usage not logged).
{
  let migrated = 0;
  db.exec('BEGIN');
  for (const r of q.byColl.all('entries')) {
    const before = JSON.parse(r.data), after = Logic.normalizeEntry(before); delete after.id;
    if (JSON.stringify(after) !== JSON.stringify(before)) { q.put.run('entries', r.id, JSON.stringify(after), now()); migrated++; }
  }
  for (const r of q.byColl.all('rodi')) { // manual rows written before rows had a kind
    const d = JSON.parse(r.data);
    if (!d.kind) { d.kind = d.gallons != null ? 'other' : 'tds'; d.source = 'manual'; q.put.run('rodi', r.id, JSON.stringify(d), now()); migrated++; }
  }
  const synced = syncRodi();
  if (migrated || synced) bump();
  db.exec('COMMIT');
  if (migrated || synced) console.log(`Migrated ${migrated} rows; ${synced} RODI log rows synced from water changes`);
}
function bulkAdd(entries, config, replaceTank) {
  db.exec('BEGIN');
  try {
    if (replaceTank) db.prepare("DELETE FROM docs WHERE collection = 'entries' AND json_extract(data, '$.tank') = ?").run(replaceTank);
    if (config) putDoc('config', 'main', config);
    for (const e of entries) { const { id, ...rest } = e; putDoc('entries', crypto.randomUUID(), rest); }
    syncRodi();
    bump();
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}
function deleteTank(tankId) {
  db.exec('BEGIN');
  try {
    const removed = db.prepare("DELETE FROM docs WHERE collection = 'entries' AND json_extract(data, '$.tank') = ?").run(tankId).changes;
    const cur = q.get.get('config', 'main');
    if (cur) {
      const c = JSON.parse(cur.data);
      c.tanks = (c.tanks || []).filter((t) => t.id !== tankId);
      if (c.rodi && Array.isArray(c.rodi.includeTanks)) c.rodi.includeTanks = c.rodi.includeTanks.filter((x) => x !== tankId);
      putDoc('config', 'main', c);
    }
    syncRodi();
    bump();
    db.exec('COMMIT');
    return removed;
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

/* ------------------------------------------------------------- notifications */
function currentAlerts() {
  const s = readState();
  const ctx = { config: s.config, entries: s.entries, rodiLogs: s.rodi, today: Logic.todayIn(TZ) };
  const cfg = s.config || Logic.DEFAULT_CONFIG;
  const alerts = Logic.filterAlerts(ctx, s.filters).filter((a) => a.lvl !== 'info');
  cfg.tanks.forEach((t) => alerts.push(...Logic.paramAlerts(ctx, t.id)));
  return alerts;
}
const notifyConfigured = () => Boolean(NTFY_URL || WEBHOOK_URL);
async function sendNotification(title, lines, priority) {
  const body = lines.join('\n');
  const results = [];
  const attempt = async (name, fn) => {
    try { const r = await fn(); results.push(`${name} ${r.ok ? 'OK' : 'HTTP ' + r.status}`); }
    catch (e) { results.push(`${name} failed: ${e.cause?.code || e.message}`); }
  };
  if (NTFY_URL) {
    // HTTP headers must be Latin-1, so the title stays ASCII; the body is UTF-8.
    const headers = { Title: title.replace(/[^\x20-\x7e]/g, ''), Priority: priority || 'default', Tags: 'fish' };
    if (NTFY_TOKEN) headers.Authorization = `Bearer ${NTFY_TOKEN}`;
    if (APP_URL) headers.Click = APP_URL;
    await attempt('ntfy', () => fetch(NTFY_URL, { method: 'POST', headers, body, signal: AbortSignal.timeout(10000) }));
  }
  if (WEBHOOK_URL) {
    await attempt('webhook', () => fetch(WEBHOOK_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title, message: body, url: APP_URL || undefined }), signal: AbortSignal.timeout(10000) }));
  }
  return results;
}
async function dailyCheck(force) {
  if (!notifyConfigured()) return { sent: false, reason: 'No NTFY_URL or WEBHOOK_URL configured' };
  const today = Logic.todayIn(TZ);
  const alerts = currentAlerts();
  if (!alerts.length && !force) { q.setMeta.run('lastNotified', today); return { sent: false, reason: 'No alerts' }; }
  const crit = alerts.some((a) => a.lvl === 'crit');
  const lines = alerts.length ? alerts.map((a) => `${a.lvl === 'crit' ? '⛔' : '⚠️'} ${a.title} — ${a.detail}`) : ['✅ No alerts right now. Notifications are working.'];
  const results = await sendNotification(alerts.length ? `Reef Tracker: ${alerts.length} alert${alerts.length > 1 ? 's' : ''}` : 'Reef Tracker test', lines, crit ? 'high' : 'default');
  q.setMeta.run('lastNotified', today);
  return { sent: true, alerts: alerts.length, results };
}
setInterval(() => {
  const hour = Number(new Intl.DateTimeFormat('en-CA', { timeZone: TZ, hour: '2-digit', hourCycle: 'h23' }).format(new Date()));
  if (hour === NOTIFY_HOUR && getMeta('lastNotified') !== Logic.todayIn(TZ)) {
    dailyCheck(false).then((r) => console.log('Daily alert check:', JSON.stringify(r))).catch((e) => console.error('Daily alert check failed:', e.message));
  }
}, 60 * 1000).unref();

/* ------------------------------------------------------------- http */
const STATIC = {
  '/': ['public/index.html', 'text/html; charset=utf-8'],
  '/index.html': ['public/index.html', 'text/html; charset=utf-8'],
  '/logic.js': ['lib/logic.js', 'text/javascript; charset=utf-8'],
};
function send(res, code, body, type) {
  const isObj = typeof body === 'object' && !Buffer.isBuffer(body);
  res.writeHead(code, { 'Content-Type': type || (isObj ? 'application/json' : 'text/plain; charset=utf-8'), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(isObj ? JSON.stringify(body) : body);
}
function readBody(req, limit = 10 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(Object.assign(new Error('Body too large'), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('Body must be a JSON object');
        resolve(v);
      } catch (e) { reject(Object.assign(e, { status: 400 })); }
    });
    req.on('error', reject);
  });
}
function authorized(req) {
  if (!AUTH_USER) return true;
  const h = req.headers.authorization || '';
  if (!h.startsWith('Basic ')) return false;
  const [u, ...p] = Buffer.from(h.slice(6), 'base64').toString('utf8').split(':');
  const a = Buffer.from(`${u}:${p.join(':')}`), b = Buffer.from(`${AUTH_USER}:${AUTH_PASS}`);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  try {
    if (p === '/healthz') return send(res, 200, { ok: true });
    if (!authorized(req)) { res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Reef Tracker"' }); return res.end('Authentication required'); }

    if (req.method === 'GET' && STATIC[p]) {
      const [file, type] = STATIC[p];
      return send(res, 200, fs.readFileSync(path.join(__dirname, file)), type);
    }
    if (req.method === 'GET' && p === '/api/state') return send(res, 200, readState());
    if (req.method === 'GET' && p === '/api/version') return send(res, 200, { version: Number(getMeta('version') || 0) });
    if (req.method === 'GET' && p === '/api/info') return send(res, 200, { notify: { configured: notifyConfigured(), ntfy: Boolean(NTFY_URL), webhook: Boolean(WEBHOOK_URL), hour: NOTIFY_HOUR, tz: TZ, lastNotified: getMeta('lastNotified') } });
    if (req.method === 'GET' && p === '/api/export') {
      const s = readState(); delete s.version;
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Disposition': `attachment; filename="reef-tracker-${Logic.todayIn(TZ)}.json"` });
      return res.end(JSON.stringify(s, null, 1));
    }
    if (req.method === 'POST' && p === '/api/import') {
      const body = await readBody(req);
      if (!Array.isArray(body.entries) || !Array.isArray(body.filters)) return send(res, 400, { error: 'Not a Reef Tracker export (needs entries and filters arrays)' });
      replaceAll({ config: body.config || null, entries: body.entries, filters: body.filters, rodi: body.rodi || [] });
      return send(res, 200, { ok: true, entries: body.entries.length });
    }
    if (req.method === 'POST' && p === '/api/bulk') {
      const body = await readBody(req);
      if (!Array.isArray(body.entries)) return send(res, 400, { error: 'entries array required' });
      if (body.entries.some((e) => !e || typeof e !== 'object' || !e.tank || !/^\d{4}-\d{2}-\d{2}$/.test(e.date || ''))) return send(res, 400, { error: 'Each entry needs tank and date (YYYY-MM-DD)' });
      bulkAdd(body.entries, body.config && typeof body.config === 'object' ? body.config : null, body.replaceTank || null);
      return send(res, 200, { ok: true, added: body.entries.length });
    }
    const td = p.match(/^\/api\/tanks\/([^/]+)\/delete$/);
    if (req.method === 'POST' && td) return send(res, 200, { ok: true, removedEntries: deleteTank(decodeURIComponent(td[1])) });
    if (req.method === 'POST' && p === '/api/notify/test') return send(res, 200, await dailyCheck(true));

    const m = p.match(/^\/api\/doc\/([a-z]+)(?:\/([^/]+))?$/);
    if (m) {
      const coll = m[1], id = m[2] ? decodeURIComponent(m[2]) : null;
      if (!COLLECTIONS.has(coll)) return send(res, 404, { error: 'Unknown collection' });
      if (id !== null && !ID_RE.test(id)) return send(res, 400, { error: 'Bad id' });
      const after = () => { if (coll === 'entries' || coll === 'config') syncRodi(); bump(); };
      if (coll === 'rodi' && id !== null) {
        const cur = q.get.get('rodi', id);
        if (cur && JSON.parse(cur.data).source === 'auto') return send(res, 409, { error: 'This row comes from a water change — edit or delete the tank log entry instead' });
      }
      if (req.method === 'POST' && id === null) {
        const body = await readBody(req); delete body.id;
        if (coll === 'rodi') { if (body.source === 'auto') return send(res, 400, { error: 'source auto is reserved' }); body.source = 'manual'; }
        const newId = crypto.randomUUID();
        putDoc(coll, newId, body); after();
        return send(res, 201, { id: newId });
      }
      if (id === null) return send(res, 405, { error: 'Method not allowed' });
      if (req.method === 'PUT') { const body = await readBody(req); delete body.id; if (coll === 'rodi') body.source = 'manual'; putDoc(coll, id, body); after(); return send(res, 200, { id }); }
      if (req.method === 'PATCH') {
        const cur = q.get.get(coll, id);
        if (!cur) return send(res, 404, { error: 'Not found' });
        const body = await readBody(req); delete body.id;
        putDoc(coll, id, Object.assign(JSON.parse(cur.data), body)); after();
        return send(res, 200, { id });
      }
      if (req.method === 'DELETE') { q.del.run(coll, id); after(); return send(res, 200, { id }); }
    }
    send(res, 404, { error: 'Not found' });
  } catch (e) {
    console.error(req.method, p, e);
    send(res, e.status || 500, { error: e.status ? e.message : 'Server error' });
  }
});
server.listen(PORT, () => console.log(`Reef Tracker listening on :${PORT} (data: ${DB_FILE}, TZ ${TZ}, notifications ${notifyConfigured() ? 'on at ' + NOTIFY_HOUR + ':00' : 'off'})`));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { server.close(); db.close(); process.exit(0); });
