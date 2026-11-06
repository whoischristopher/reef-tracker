const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Sync = require('../lib/sync.js');
const L = require('../lib/logic.js');

/* A tiny in-memory stand-in for the parts of GitHub's Git Data API that the sync uses. */
function fakeGitHub({ token = 'tok', repo = 'me/reef-data', empty = false } = {}) {
  const trees = {}, commits = {}, refs = {}, calls = [];
  const hash = (o) => crypto.createHash('sha1').update(JSON.stringify(o)).digest('hex');
  const putTree = (files) => { const sha = hash(Object.entries(files).sort()); trees[sha] = files; return sha; };
  if (!empty) {
    const t = putTree({ 'README.md': 'my notes\n' });
    const c = hash({ t, root: true }); commits[c] = { tree: t, parents: [], message: 'init' }; refs.main = c;
  }
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      calls.push(`${req.method} ${req.url}`);
      if (req.headers.authorization !== `Bearer ${token}`) return send(401, { message: 'Bad credentials' });
      const pre = `/repos/${repo}`;
      if (!req.url.startsWith(pre)) return send(404, { message: 'Not Found' });
      const p = req.url.slice(pre.length), b = body ? JSON.parse(body) : null;
      let m;
      if (req.method === 'GET' && (m = p.match(/^\/git\/ref\/heads\/(.+)$/))) {
        if (empty) return send(409, { message: 'Git Repository is empty.' });
        return refs[m[1]] ? send(200, { object: { sha: refs[m[1]] } }) : send(404, { message: 'Not Found' });
      }
      if (req.method === 'GET' && (m = p.match(/^\/git\/commits\/(\w+)$/))) return send(200, { sha: m[1], tree: { sha: commits[m[1]].tree } });
      if (req.method === 'POST' && p === '/git/trees') {
        const files = Object.assign({}, trees[b.base_tree]);
        b.tree.forEach((e) => { files[e.path] = e.content; });
        return send(201, { sha: putTree(files) });
      }
      if (req.method === 'POST' && p === '/git/commits') { const sha = hash(b); commits[sha] = { tree: b.tree, parents: b.parents, message: b.message }; return send(201, { sha }); }
      if (req.method === 'PATCH' && (m = p.match(/^\/git\/refs\/heads\/(.+)$/))) { refs[m[1]] = b.sha; return send(200, { object: { sha: b.sha } }); }
      send(404, { message: 'Not Found' });
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    server, calls, url: `http://127.0.0.1:${server.address().port}`,
    head: () => trees[commits[refs.main].tree], headCommit: () => commits[refs.main], commitCount: () => Object.keys(commits).length,
  })));
}

function sampleState() {
  const t = L.makeTank('Display Reef', 'reef', []); t.volume = 75;
  t.doses.push({ key: 'mg_dose', label: 'Magnesium', unit: 'ml' });
  const config = { tanks: [t], rodi: { ...L.DEFAULT_CONFIG.rodi, includeTanks: [t.id] } };
  const entries = [
    { id: 'a', tank: t.id, date: '2026-10-01', values: { po4: 0.3, alk: 8.5 }, doses: {}, events: [], note: '' },
    { id: 'b', tank: t.id, date: '2026-10-15', values: { po4: 0.2, alk: 8.7 }, doses: { mg_dose: 90 }, waterChange: { gallons: 15 }, events: [], note: 'Added blenny, "snails"' },
    { id: 'c', tank: t.id, date: '2026-11-01', values: { po4: 0.12, alk: 8.9 }, doses: {}, gfo: { grams: 75 }, events: [], note: '' },
  ];
  const filters = L.clone(L.DEFAULT_FILTERS); filters[0].installed = '2026-09-01';
  const rodi = Object.entries(L.autoRodiLogs({ config, entries })).map(([id, d]) => ({ id, ...d }));
  return { config, entries, filters, rodi };
}

test('buildFiles produces the fixed file set, deterministically', () => {
  const s = sampleState();
  const f = Sync.buildFiles(s, '2026-11-06');
  assert.deepEqual(Object.keys(f).sort(), [...Sync.FILES].sort());
  assert.deepEqual(Sync.buildFiles(sampleState(), '2026-11-06'), f);
  const rows = f['parameters.csv'].trim().split('\n');
  assert.equal(rows[0], 'date,tank,param,label,unit,value,target_low,target_high,status');
  assert.equal(rows.length, 7);
  assert.match(f['parameters.csv'], /2026-11-01,Display Reef,po4,Phosphate,ppm,0.12,0.03,0.1,high/);
  assert.match(f['doses.csv'], /2026-10-15,Display Reef,mg_dose,Magnesium,ml,90/);
  assert.match(f['maintenance.csv'], /2026-10-15,Display Reef,water_change,15,,,/);
  assert.match(f['maintenance.csv'], /2026-11-01,Display Reef,gfo,,,75,/);
  assert.match(f['maintenance.csv'], /note,,,,"Added blenny, ""snails"""/);
  assert.match(f['rodi_log.csv'], /2026-10-15,water_change,auto,Display Reef,15,/);
  assert.match(f['filters.csv'], /sediment,Sediment pre-filter,feed,180,,2026-09-01,66,/);
  assert.deepEqual(JSON.parse(f['export.json']).entries.length, 3);
  const d = f['digest.md'];
  assert.match(d, /## Tank: Display Reef/);
  assert.match(d, /\| Phosphate \(ppm\) \| 0\.12 \| 2026-11-01 \|/);
  assert.match(d, /Display Reef Phosphate above target/);
  assert.match(d, /2026-10-15: water change 15\.0 gal; dosed Magnesium 90 ml; note: Added blenny/);
});

test('weeklySlope', () => {
  assert.equal(Sync.weeklySlope([{ date: '2026-01-01', v: 1 }, { date: '2026-01-08', v: 2 }]), null);
  const s = Sync.weeklySlope([{ date: '2026-01-01', v: 1 }, { date: '2026-01-08', v: 2 }, { date: '2026-01-15', v: 3 }]);
  assert.ok(Math.abs(s - 1) < 1e-9);
});

test('pushFiles commits once, keeps other files, skips unchanged trees', async () => {
  const gh = await fakeGitHub();
  try {
    const files = Sync.buildFiles(sampleState(), '2026-11-06');
    const args = { repo: 'me/reef-data', branch: 'main', token: 'tok', files, message: 'sync', apiBase: gh.url };
    const r1 = await Sync.pushFiles(args);
    assert.equal(r1.committed, true);
    assert.equal(gh.head()['README.md'], 'my notes\n');
    assert.equal(gh.head()['digest.md'], files['digest.md']);
    assert.equal(gh.commitCount(), 2);
    const r2 = await Sync.pushFiles(args);
    assert.equal(r2.committed, false);
    assert.equal(gh.commitCount(), 2);
    await Sync.pushFiles({ ...args, dir: '/reef/' , files: { 'digest.md': 'x' } });
    assert.equal(gh.head()['reef/digest.md'], 'x');
  } finally { gh.server.close(); }
});

test('pushFiles explains common failures', async () => {
  const gh = await fakeGitHub();
  const empty = await fakeGitHub({ empty: true });
  try {
    const base = { repo: 'me/reef-data', branch: 'main', files: { a: 'b' }, message: 'm' };
    await assert.rejects(Sync.pushFiles({ ...base, token: 'wrong', apiBase: gh.url }), /401 \(token invalid or expired\)/);
    await assert.rejects(Sync.pushFiles({ ...base, repo: 'me/other', token: 'tok', apiBase: gh.url }), /404 \(repo or branch not found/);
    await assert.rejects(Sync.pushFiles({ ...base, token: 'tok', apiBase: empty.url }), /409 \(repository is empty/);
  } finally { gh.server.close(); empty.server.close(); }
});

test('createSyncer: config validation, debounce and status', async () => {
  const meta = {};
  const common = { readState: sampleState, getVersion: () => 7, getMeta: (k) => meta[k] ?? null, setMeta: (k, v) => { meta[k] = v; }, tz: 'America/Toronto', log: { log() {}, error() {} } };
  assert.equal(Sync.createSyncer({ ...common }).status().configured, false);
  assert.match(Sync.createSyncer({ ...common, repo: 'not-a-repo', token: 't' }).status().error, /owner\/name/);
  assert.match(Sync.createSyncer({ ...common, repo: 'me/x' }).status().error, /TOKEN/);
  const gh = await fakeGitHub();
  try {
    const s = Sync.createSyncer({ ...common, repo: 'me/reef-data', token: 'tok', apiBase: gh.url, debounceMs: 20 });
    assert.equal(s.status().pending, true);
    s.changed(); s.changed(); s.changed();
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(gh.commitCount(), 2, 'three changes in a burst make one commit');
    assert.match(gh.headCommit().message, /data v7, after changes/);
    const st = s.status();
    assert.equal(st.pending, false);
    assert.equal(st.syncedVersion, 7);
    assert.equal(st.lastError, null);
  } finally { gh.server.close(); }
});

test('server: /api/sync pushes to the configured repo', async () => {
  const gh = await fakeGitHub();
  const PORT = 19000 + Math.floor(Math.random() * 1000);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reef-sync-'));
  const proc = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir, GITHUB_SYNC_REPO: 'me/reef-data', GITHUB_SYNC_TOKEN: 'tok', GITHUB_API: gh.url, GITHUB_SYNC_DELAY_MIN: '60' }, stdio: 'pipe',
  });
  const api = async (method, p, body) => {
    const r = await fetch(`http://127.0.0.1:${PORT}${p}`, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, json: await r.json() };
  };
  try {
    for (let i = 0; i < 50; i++) { try { await fetch(`http://127.0.0.1:${PORT}/healthz`); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
    const info = (await api('GET', '/api/info')).json;
    assert.equal(info.sync.configured, true);
    assert.equal(info.sync.repo, 'me/reef-data');
    assert.equal(JSON.stringify(info).includes('tok"'), false, 'token is never exposed');
    const s = sampleState();
    await api('POST', '/api/import', s);
    assert.equal((await api('GET', '/api/sync')).json.pending, true);
    const r = await api('POST', '/api/sync');
    assert.equal(r.status, 200);
    assert.equal(r.json.committed, true);
    assert.equal(r.json.status.pending, false);
    assert.match(gh.head()['parameters.csv'], /Display Reef,po4/);
    assert.equal(JSON.parse(gh.head()['export.json']).entries.length, 3);
  } finally { proc.kill(); gh.server.close(); fs.rmSync(dataDir, { recursive: true, force: true }); }
});
