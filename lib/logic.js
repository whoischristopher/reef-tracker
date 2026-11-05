/* Shared logic for the browser (window.Logic) and the server (require). No dependencies. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Logic = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const DAY = 86400000;
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  /* Presets used when adding a tank. Targets are common starting points; edit per tank. */
  const TANK_PRESETS = {
    reef: {
      label: 'Reef (saltwater)', rodi: true,
      params: [
        { key: 'ca', label: 'Calcium', unit: 'ppm', low: 400, high: 450, dp: 0 },
        { key: 'po4', label: 'Phosphate', unit: 'ppm', low: 0.03, high: 0.10, dp: 2 },
        { key: 'no3', label: 'Nitrate', unit: 'ppm', low: 2, high: 10, dp: 1 },
        { key: 'alk', label: 'Alkalinity', unit: 'dKH', low: 8, high: 10, dp: 1 },
        { key: 'mg', label: 'Magnesium', unit: 'ppm', low: 1250, high: 1400, dp: 0 },
        { key: 'sal', label: 'Salinity', unit: 'SG', low: 1.024, high: 1.026, dp: 3 },
      ],
    },
    freshwater: {
      label: 'Freshwater', rodi: false,
      params: [
        { key: 'ph', label: 'pH', unit: '', low: 6.8, high: 7.8, dp: 1 },
        { key: 'gh', label: 'GH', unit: 'dGH', low: 4, high: 12, dp: 0 },
        { key: 'kh', label: 'KH', unit: 'dKH', low: 3, high: 8, dp: 0 },
        { key: 'nh3', label: 'Ammonia', unit: 'ppm', low: 0, high: 0.25, dp: 2 },
        { key: 'no2', label: 'Nitrite', unit: 'ppm', low: 0, high: 0.25, dp: 2 },
        { key: 'no3', label: 'Nitrate', unit: 'ppm', low: 0, high: 20, dp: 0 },
      ],
    },
    african_cichlid: {
      label: 'African cichlid', rodi: false,
      params: [
        { key: 'ph', label: 'pH', unit: '', low: 7.8, high: 8.6, dp: 1 },
        { key: 'gh', label: 'GH', unit: 'dGH', low: 10, high: 18, dp: 0 },
        { key: 'kh', label: 'KH', unit: 'dKH', low: 10, high: 18, dp: 0 },
        { key: 'no3', label: 'Nitrate', unit: 'ppm', low: 0, high: 20, dp: 0 },
      ],
    },
    custom: { label: 'Custom (no parameters)', rodi: false, params: [] },
  };
  const clone = (o) => JSON.parse(JSON.stringify(o));
  function slug(s) { return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'x'; }
  function uniqueKey(base, taken) { let k = slug(base), n = 2; const set = new Set(taken); while (set.has(k)) k = `${slug(base)}_${n++}`; return k; }
  function makeTank(name, presetKey, existingIds) {
    const pr = TANK_PRESETS[presetKey] || TANK_PRESETS.custom;
    return { id: uniqueKey(name, existingIds || []), name: String(name).trim(), volume: null, kind: presetKey, trackGfo: presetKey === 'reef', params: clone(pr.params), doses: [] };
  }

  const DEFAULT_CONFIG = {
    tanks: [],
    rodi: { topoffPerDay: 1, wasteRatio: 3, includeTanks: [], tdsLimit: 1, warnPct: 80 },
  };
  /* Generic RODI stages created on first start. */
  const DEFAULT_FILTERS = [
    { id: 'sediment', order: 1, name: 'Sediment pre-filter', lifeDays: 180, lifeGallons: null, basis: 'feed', tdsCheck: false, installed: null, history: [], notes: 'Typical 3–6 months; sooner if output pressure drops or it turns brown.' },
    { id: 'carbon', order: 2, name: 'Carbon block', lifeDays: 180, lifeGallons: null, basis: 'feed', tdsCheck: false, installed: null, history: [], notes: 'Protects the membrane from chlorine/chloramine. Add the rated gallons from the cartridge spec.' },
    { id: 'membrane', order: 3, name: 'RO membrane', lifeDays: 730, lifeGallons: null, basis: 'product', tdsCheck: false, installed: null, history: [], notes: 'Typical 2–3 years. Rising TDS before the DI stage (rejection below ~95%) is the real signal.' },
    { id: 'di', order: 4, name: 'DI resin', lifeDays: null, lifeGallons: null, basis: 'product', tdsCheck: true, installed: null, history: [], notes: 'Replace when TDS out rises above the limit (or the resin changes colour).' },
  ];

  const toMs = (d) => { const [y, m, dd] = d.split('-').map(Number); return Date.UTC(y, m - 1, dd); };
  const msToStr = (ms) => new Date(ms).toISOString().slice(0, 10);
  const daysBetween = (a, b) => Math.round((toMs(b) - toMs(a)) / DAY);
  const fmtDate = (d) => { if (!d) return '—'; const [y, m, dd] = d.split('-').map(Number); return `${MON[m - 1]} ${dd}, ${y}`; };
  const fmtNum = (v, dp) => (v == null || isNaN(v) ? '—' : Number(v).toLocaleString('en-CA', { minimumFractionDigits: dp ?? 0, maximumFractionDigits: dp ?? 2 }));
  /** YYYY-MM-DD in a given IANA time zone (or the runtime's local zone). */
  function todayIn(tz) {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz || undefined, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
    const g = (t) => parts.find((p) => p.type === t).value;
    return `${g('year')}-${g('month')}-${g('day')}`;
  }

  const cfgOf = (ctx) => ctx.config || DEFAULT_CONFIG;
  const tankOf = (ctx, id) => cfgOf(ctx).tanks.find((t) => t.id === id) || cfgOf(ctx).tanks[0] || null;
  const rodiOf = (ctx) => Object.assign({}, DEFAULT_CONFIG.rodi, cfgOf(ctx).rodi || {});

  function status(p, v) {
    if (v == null) return 'na';
    if (p.low != null && v < p.low) return 'low';
    if (p.high != null && v > p.high) return 'high';
    return 'ok';
  }
  const tracksGfo = (t) => !!t && (t.trackGfo != null ? t.trackGfo : t.kind === 'reef');
  /** Gallons of a water change on an entry (converts % using the tank volume); null if unknown. */
  function entryWcGallons(ctx, e) {
    const wc = e && e.waterChange; if (!wc) return null;
    if (wc.gallons != null) return Number(wc.gallons);
    const t = tankOf(ctx, e.tank); const vol = t && t.volume;
    return vol && wc.percent != null ? Math.round((vol * wc.percent) / 100 * 10) / 10 : null;
  }
  function wcText(wc, gal) {
    if (!wc) return '';
    if (wc.gallons != null) return `${fmtNum(wc.gallons, 1)} gal`;
    if (wc.percent != null) return `${fmtNum(wc.percent, 0)}%${gal != null ? ` (${fmtNum(gal, 1)} gal)` : ''}`;
    return 'yes';
  }
  /**
   * Older data kept water changes and GFO as events; move them into the dedicated
   * waterChange {gallons, percent} and gfo {grams} fields. Idempotent.
   */
  function normalizeEntry(e) {
    const out = clone(e);
    out.values = out.values || {}; out.doses = out.doses || {};
    let wc = out.waterChange ? Object.assign({}, out.waterChange) : null;
    let gfo = out.gfo ? Object.assign({}, out.gfo) : null;
    const add = (o, k, v) => { if (v != null && !isNaN(v)) o[k] = (o[k] != null ? Number(o[k]) : 0) + Number(v); };
    out.events = (out.events || []).filter((ev) => {
      if (ev.type === 'water_change') { wc = wc || {}; add(wc, 'gallons', ev.gallons); add(wc, 'percent', ev.percent); return false; }
      if (ev.type === 'rowaphos' || ev.type === 'gfo') { gfo = gfo || {}; add(gfo, 'grams', ev.grams); return false; }
      return true;
    });
    if (wc) out.waterChange = wc; else delete out.waterChange;
    if (gfo) out.gfo = gfo; else delete out.gfo;
    out.note = out.note || '';
    return out;
  }
  /** RODI log rows generated from water changes in tanks that use RODI water. id -> doc */
  function autoRodiLogs(ctx) {
    const r = rodiOf(ctx), incl = new Set(r.includeTanks || []), out = {};
    ctx.entries.forEach((e) => {
      if (!incl.has(e.tank) || !e.waterChange || !e.id) return;
      const gal = entryWcGallons(ctx, e), t = tankOf(ctx, e.tank);
      out[`wc-${e.id}`] = { date: e.date, kind: 'water_change', source: 'auto', entryId: e.id, tank: e.tank, gallons: gal,
        note: `${t ? t.name : e.tank} water change` + (gal == null ? ' — set the tank volume to convert %' : '') };
    });
    return out;
  }
  function evText(ev) {
    if (ev.type === 'water_change') return ev.gallons != null ? `Water change ${fmtNum(ev.gallons, 0)} gal` : ev.percent != null ? `Water change ${fmtNum(ev.percent, 0)}%` : 'Water change';
    if (ev.type === 'rowaphos' || ev.type === 'gfo') return `GFO ${fmtNum(ev.grams, 0)} g`;
    if (ev.type === 'maintenance') return `Maintenance: ${ev.text}`;
    return ev.text;
  }

  /**
   * How far through its life a RODI stage is.
   * ctx: {config, entries, rodiLogs, today}
   */
  function filterUsage(ctx, f) {
    if (!f.installed) return null;
    const r = rodiOf(ctx), today = ctx.today;
    const days = Math.max(0, daysBetween(f.installed, today));
    const since = ctx.rodiLogs.filter((l) => l.date >= f.installed && l.date <= today && l.gallons != null && l.gallons !== '');
    const sum = (k) => since.filter((l) => (l.kind || 'other') === k).reduce((a, l) => a + (Number(l.gallons) || 0), 0);
    const breakdown = { water_change: sum('water_change'), topoff: sum('topoff'), other: sum('other') + sum('production'), topoffEst: (Number(r.topoffPerDay) || 0) * days };
    const product = breakdown.water_change + breakdown.topoff + breakdown.other + breakdown.topoffEst;
    const gal = f.basis === 'feed' ? product * (1 + (Number(r.wasteRatio) || 0)) : product;
    const pDays = f.lifeDays ? days / f.lifeDays : 0;
    const pGal = f.lifeGallons ? gal / f.lifeGallons : 0;
    let tdsOver = null;
    if (f.tdsCheck) {
      const last = [...ctx.rodiLogs].sort((a, b) => (a.date < b.date ? -1 : 1)).reverse()
        .find((l) => l.date >= f.installed && l.tdsOut != null && l.tdsOut !== '');
      if (last && Number(last.tdsOut) > Number(r.tdsLimit)) tdsOver = last;
    }
    const pct = Math.max(pDays, pGal);
    let due = null;
    if (f.lifeDays) due = toMs(f.installed) + f.lifeDays * DAY;
    if (f.lifeGallons && days > 3 && gal > 0) {
      const rate = gal / days, remain = f.lifeGallons - gal;
      const gDue = toMs(today) + Math.max(0, remain / rate) * DAY;
      due = due ? Math.min(due, gDue) : gDue;
    }
    const warn = (r.warnPct || 80) / 100;
    const st = pct >= 1 || tdsOver ? 'crit' : pct >= warn ? 'warn' : 'ok';
    return { days, gal, product, breakdown, pDays, pGal, pct, st, due, tdsOver, driver: pGal > pDays ? 'usage' : 'time' };
  }

  /** Structured alerts: [{lvl:'crit'|'warn'|'info', kind, title, detail}] */
  function filterAlerts(ctx, filters) {
    const out = [];
    filters.forEach((f) => {
      const u = filterUsage(ctx, f);
      if (!u) { out.push({ lvl: 'info', kind: 'filter', title: f.name, detail: 'set the install date to start tracking.' }); return; }
      if (u.st === 'crit') out.push({ lvl: 'crit', kind: 'filter', title: `Replace ${f.name}`, detail: u.tdsOver ? `TDS out read ${u.tdsOver.tdsOut} ppm on ${fmtDate(u.tdsOver.date)}` : `${Math.round(u.pct * 100)}% of rated ${u.driver === 'usage' ? 'capacity' : 'life'} used` });
      else if (u.st === 'warn') out.push({ lvl: 'warn', kind: 'filter', title: `${f.name} due soon`, detail: `${Math.round(u.pct * 100)}% used, projected ${fmtDate(msToStr(u.due))}` });
    });
    return out;
  }
  function paramAlerts(ctx, tankId) {
    const t = tankOf(ctx, tankId), out = [];
    if (!t) return out;
    const es = ctx.entries.filter((e) => e.tank === t.id).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    t.params.forEach((p) => {
      const last = [...es].reverse().find((e) => e.values && e.values[p.key] != null);
      if (!last) return;
      const v = last.values[p.key], st = status(p, v);
      if (st !== 'ok') out.push({ lvl: 'warn', kind: 'param', title: `${t.name} ${p.label} ${st === 'high' ? 'above' : 'below'} target`, detail: `${fmtNum(v, p.dp)} ${p.unit} on ${fmtDate(last.date)} (target ${fmtNum(p.low, p.dp)}–${fmtNum(p.high, p.dp)})` });
    });
    return out;
  }

  /* ------------------------------------------------------------------ import (paste / CSV) */
  const ALIASES = {
    ca: ['calcium', 'ca'], po4: ['phosphate', 'po4', 'phos'], no3: ['nitrate', 'no3'], no2: ['nitrite', 'no2'],
    nh3: ['ammonia', 'nh3', 'nh4'], alk: ['alkalinity', 'alk', 'dkh'], kh: ['kh', 'carbonatehardness'],
    gh: ['gh', 'generalhardness'], ph: ['ph'], mg: ['magnesium', 'mg'], sal: ['salinity', 'sg', 'specificgravity'],
    k: ['potassium', 'k'], temp: ['temperature', 'temp'],
  };
  const norm = (s) => String(s || '').toLowerCase().replace(/\(.*?\)/g, '').replace(/[^a-z0-9]/g, '');
  const unitOf = (h) => { const m = String(h || '').match(/\(([^)]+)\)/); return m ? m[1].trim() : ''; };
  const cleanLabel = (h) => String(h || '').replace(/\(.*?\)/g, '').replace(/\s+/g, ' ').trim();

  function parseTable(text) {
    const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    const tab = lines.some((l) => l.includes('\t'));
    if (tab) return lines.map((l) => l.split('\t').map((c) => c.trim()));
    // CSV with quotes
    const rows = []; let row = [], cell = '', q = false; const src = lines.join('\n');
    for (let i = 0; i < src.length; i++) {
      const ch = src[i];
      if (q) { if (ch === '"' && src[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') q = false; else cell += ch; }
      else if (ch === '"') q = true;
      else if (ch === ',') { row.push(cell.trim()); cell = ''; }
      else if (ch === '\n') { row.push(cell.trim()); rows.push(row); row = []; cell = ''; }
      else cell += ch;
    }
    row.push(cell.trim()); rows.push(row);
    return rows;
  }
  const pad = (n) => String(n).padStart(2, '0');
  function parseDate(s) {
    s = String(s || '').trim(); if (!s) return null;
    let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T].*)?$/);
    if (m) return valid(+m[1], +m[2], +m[3]);
    m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
    if (m) { let a = +m[1], b = +m[2]; if (a > 12) [a, b] = [b, a]; return valid(+m[3], a, b); }
    if (/[a-z]/i.test(s) && /\d{4}/.test(s)) { const d = new Date(s); if (!isNaN(d)) return valid(d.getFullYear(), d.getMonth() + 1, d.getDate()); }
    return null;
    function valid(y, mo, d) { return y > 1990 && y < 2100 && mo >= 1 && mo <= 12 && d >= 1 && d <= 31 ? `${y}-${pad(mo)}-${pad(d)}` : null; }
  }
  function parseNum(s) {
    const t = String(s ?? '').trim().replace(/,/g, '').replace(/^[<>~≈]\s*/, '');
    if (t === '') return { empty: true };
    if (/^-?\d+(\.\d+)?$/.test(t) || /^-?\.\d+$/.test(t)) return { v: Number(t) };
    let m = t.match(/^(\d+(?:\.\d+)?)\s*[-–]\s*(\d+(?:\.\d+)?)$/);
    if (m) return { v: (Number(m[1]) + Number(m[2])) / 2, note: `read as ${t}` };
    if (parseDate(t)) return { date: true };
    return { text: t };
  }
  /** Turn free text into structured events/doses where possible. */
  function classifyText(text, doses, onUnknownDose) {
    const t = String(text || '').trim(); const out = { events: [], doses: {} };
    if (!t) return out;
    let m;
    if ((m = t.match(/(\d+(?:\.\d+)?)\s*(?:us\s*)?gal(?:lon)?s?\.?\s+(?:of\s+)?water\s*change/i))) out.events.push({ type: 'water_change', gallons: Number(m[1]) });
    else if ((m = t.match(/(\d+(?:\.\d+)?)\s*%\s*water\s*change/i))) out.events.push({ type: 'water_change', percent: Number(m[1]) });
    else if ((m = t.match(/(\d+(?:\.\d+)?)\s*(?:l|litres?|liters?)\s+water\s*change/i))) out.events.push({ type: 'water_change', gallons: Math.round(Number(m[1]) / 3.785 * 10) / 10 });
    else if (/water\s*change/i.test(t)) out.events.push({ type: 'water_change' });
    if ((m = t.match(/(\d+(?:\.\d+)?)\s*g\s+(?:of\s+)?(?:new\s+)?(?:rowa\w*|gfo|phosban|phosguard)/i))) out.events.push({ type: 'gfo', grams: Number(m[1]) });
    else if (/\b(?:replaced?|changed?|new)\b.*\b(?:gfo|rowa\w*)\b/i.test(t)) out.events.push({ type: 'gfo' });
    const re = /(?:\b(add(?:ed)?|dosed?)\s+)?(\d+(?:\.\d+)?)\s*(ml|g|drops?|caps?)\s+(?:of\s+)?([a-z][a-z0-9 \-]*?)(?=\s*(?:,|;|\.|\band\b|$))/gi;
    while ((m = re.exec(t))) {
      if (/^(?:new\s+)?(?:rowa|gfo|phosban|phosguard)/i.test(m[4])) continue;
      const name = norm(m[4]);
      let d = (doses || []).find((x) => { const n = norm(x.label); return n && (n === name || n.includes(name) || name.includes(n)); });
      // "Added 30g of buffer" for a product the tank doesn't track yet: create it.
      if (!d && m[1] && onUnknownDose) d = onUnknownDose(m[4].trim(), m[3].toLowerCase());
      if (d) out.doses[d.key] = (out.doses[d.key] || 0) + Number(m[2]);
    }
    if (!out.events.length && !Object.keys(out.doses).length) out.events.push(/filter|service|clean/i.test(t) && t.length < 60 ? { type: 'maintenance', text: t } : { type: 'note', text: t });
    return out;
  }
  const isHeaderRow = (r) => r.some((c) => c && parseNum(c).text !== undefined && !parseDate(c));
  /** Guess what each pasted column is for this tank. */
  function guessMapping(rows, tank) {
    const hasHeader = rows.length > 0 && isHeaderRow(rows[0]);
    const header = hasHeader ? rows[0] : [];
    const body = hasHeader ? rows.slice(1) : rows;
    const ncol = Math.max(0, ...rows.map((r) => r.length));
    const used = new Set(); let dateCol = -1;
    const map = [];
    for (let c = 0; c < ncol; c++) {
      const h = header[c] || '';
      const vals = body.map((r) => r[c]).filter((v) => v);
      const dateShare = vals.length ? vals.filter((v) => parseDate(v)).length / vals.length : 0;
      const numShare = vals.length ? vals.filter((v) => parseNum(v).v !== undefined).length / vals.length : 0;
      const n = norm(h);
      let item = { col: c, header: h || `Column ${c + 1}`, kind: 'ignore', key: null };
      if (dateCol < 0 && (/date|day/.test(n) || dateShare >= 0.6)) { item.kind = 'date'; dateCol = c; }
      else if (n) {
        const p = (tank.params || []).find((p) => !used.has('p:' + p.key) && (norm(p.label) === n || p.key === n || (ALIASES[p.key] || []).includes(n)));
        const d = !p && (tank.doses || []).find((d) => !used.has('d:' + d.key) && (norm(d.label) === n || norm(d.label).includes(n) || n.includes(norm(d.label))));
        if (p) { item.kind = 'param'; item.key = p.key; used.add('p:' + p.key); }
        else if (/water ?change|^wc/.test(n) && !used.has('wc')) { item.kind = /%|pct|percent/i.test(h) ? 'wc_pct' : 'wc_gal'; used.add('wc'); }
        else if (/gfo|rowa|phosban|phosguard/.test(n) && !used.has('gfo')) { item.kind = 'gfo'; used.add('gfo'); }
        else if (d) { item.kind = 'dose'; item.key = d.key; used.add('d:' + d.key); }
        else if (/\((ml|g|drops?)\)|dos/i.test(h)) item.kind = 'newdose';
        else if (numShare >= 0.5) item.kind = 'newparam';
        else if (vals.length) item.kind = 'notes';
      } else if (vals.length) item.kind = numShare >= 0.5 ? 'newparam' : 'notes';
      map.push(item);
    }
    return { hasHeader, map };
  }
  /**
   * Convert pasted rows to entries for one tank.
   * Returns {entries, newParams, newDoses, warnings, skipped}. Does not mutate tank.
   */
  function convertRows(rows, mapping, tank) {
    const { hasHeader, map } = mapping;
    const body = hasHeader ? rows.slice(1) : rows;
    const params = clone(tank.params || []), doses = clone(tank.doses || []);
    const newParams = [], newDoses = [], warnings = [];
    const cols = map.map((m) => Object.assign({}, m));
    cols.forEach((m) => {
      if (m.kind === 'newparam') { const key = uniqueKey(cleanLabel(m.header) || 'param', params.map((p) => p.key)); const p = { key, label: cleanLabel(m.header) || key, unit: unitOf(m.header), low: null, high: null, dp: 2 }; params.push(p); newParams.push(p); m.kind = 'param'; m.key = key; }
      if (m.kind === 'newdose') { const key = uniqueKey(cleanLabel(m.header) || 'dose', doses.map((d) => d.key)); const d = { key, label: cleanLabel(m.header) || key, unit: unitOf(m.header) || 'ml' }; doses.push(d); newDoses.push(d); m.kind = 'dose'; m.key = key; }
    });
    const dateCol = cols.find((m) => m.kind === 'date');
    if (!dateCol) warnings.push('No date column selected — every row needs a date.');
    const onUnknownDose = (name, unit) => {
      const label = name.charAt(0).toUpperCase() + name.slice(1);
      const ex = doses.find((d) => norm(d.label) === norm(label)); if (ex) return ex;
      const d = { key: uniqueKey(label, doses.map((x) => x.key)), label, unit: unit === 'drop' ? 'drops' : unit };
      doses.push(d); newDoses.push(d); return d;
    };
    const entries = []; let prevDate = null, skipped = 0;
    body.forEach((r, i) => {
      if (!r.some((c) => c)) return;
      let date = dateCol ? parseDate(r[dateCol.col]) : null;
      if (dateCol && r[dateCol.col] && !date) warnings.push(`Row ${i + 1}: couldn’t read date “${r[dateCol.col]}”.`);
      const inherited = !date;
      if (!date) date = prevDate;
      const e = { tank: tank.id, date, values: {}, doses: {}, events: [], note: '' };
      const notes = [];
      cols.forEach((m) => {
        const raw = r[m.col]; if (raw == null || raw === '') return;
        if (m.kind === 'param' || m.kind === 'dose') {
          const pn = parseNum(raw);
          const label = m.kind === 'param' ? (params.find((p) => p.key === m.key) || {}).label : (doses.find((d) => d.key === m.key) || {}).label;
          if (pn.v !== undefined) { (m.kind === 'param' ? e.values : e.doses)[m.key] = pn.v; if (pn.note) notes.push(`${label} ${pn.note}`); }
          else if (pn.date) {
            const dm = raw.match(/^\d{4}[-/.](\d{1,2})[-/.](\d{1,2})/);
            if (dm && m.kind === 'param') { const a = +dm[1], b = +dm[2]; e.values[m.key] = (a + b) / 2; notes.push(`${label} read as ${a}-${b}`); warnings.push(`Row ${i + 1}: ${label} “${raw}” looks like a range Sheets turned into a date; imported as ${(a + b) / 2}.`); }
            else warnings.push(`Row ${i + 1}: ${label} “${raw}” isn’t a number; skipped.`);
          } else { const c = classifyText(pn.text, doses, onUnknownDose); e.events.push(...c.events); Object.assign(e.doses, c.doses); }
        } else if (m.kind === 'wc_gal' || m.kind === 'wc_pct' || m.kind === 'gfo') {
          const pn = parseNum(raw);
          if (pn.v !== undefined) e.events.push(m.kind === 'gfo' ? { type: 'gfo', grams: pn.v } : { type: 'water_change', [m.kind === 'wc_pct' ? 'percent' : 'gallons']: pn.v });
          else if (pn.text && /^(y|yes|x|✓|true)$/i.test(pn.text)) e.events.push(m.kind === 'gfo' ? { type: 'gfo' } : { type: 'water_change' });
          else if (pn.text) { const c = classifyText(pn.text, doses, onUnknownDose); e.events.push(...c.events); Object.assign(e.doses, c.doses); }
        } else if (m.kind === 'notes') { const c = classifyText(raw, doses, onUnknownDose); e.events.push(...c.events); for (const [k, v] of Object.entries(c.doses)) e.doses[k] = v; }
      });
      e.note = notes.join('; ');
      if (!Object.keys(e.values).length && !Object.keys(e.doses).length && !e.events.length) return;
      if (!date) { skipped++; return; }
      prevDate = date;
      const prev = entries[entries.length - 1];
      const clash = prev && (Object.keys(e.values).some((k) => k in prev.values) || Object.keys(e.doses).some((k) => k in prev.doses));
      if (prev && prev.date === date && (inherited || !clash) && !clash) {
        Object.assign(prev.values, e.values); Object.assign(prev.doses, e.doses); prev.events.push(...e.events);
        if (e.note) prev.note = prev.note ? `${prev.note}; ${e.note}` : e.note;
      } else entries.push(e);
    });
    if (skipped) warnings.push(`${skipped} row${skipped > 1 ? 's' : ''} had data but no date before them and were skipped.`);
    return { entries: entries.map(normalizeEntry), newParams, newDoses, warnings };
  }


  return { normalizeEntry, autoRodiLogs, entryWcGallons, wcText, tracksGfo, DAY, MON, DEFAULT_CONFIG, DEFAULT_FILTERS, TANK_PRESETS, makeTank, uniqueKey, slug, clone, parseTable, guessMapping, convertRows, classifyText, parseDate, toMs, msToStr, daysBetween, fmtDate, fmtNum, todayIn, status, evText, filterUsage, filterAlerts, paramAlerts, tankOf, rodiOf };
});
