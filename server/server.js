'use strict';
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const C = require('./catalog');
const research = require('./research');
const llm = require('./llm');

const DB = path.join(__dirname, 'data.json');
// Persistent storage: when DATABASE_URL is set (Render Postgres), the whole app state is kept
// as one JSON blob in a single-row table there, so it survives free-tier restarts and redeploys.
// Without it, falls back to the local data.json file (wiped on every restart on Render's free tier).
const DATABASE_URL = process.env.DATABASE_URL || '';
let pgPool = null;
if (DATABASE_URL) {
  const { Pool } = require('pg');
  pgPool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });
}
async function pgLoad() {
  await pgPool.query('CREATE TABLE IF NOT EXISTS store (id INT PRIMARY KEY, data JSONB NOT NULL)');
  const r = await pgPool.query('SELECT data FROM store WHERE id = 1');
  if (r.rows.length) return r.rows[0].data;
  const d = seed();
  await pgPool.query('INSERT INTO store (id, data) VALUES (1, $1)', [d]);
  return d;
}
async function pgSave(data) {
  await pgPool.query('UPDATE store SET data = $1 WHERE id = 1', [data]);
}
const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

const now = () => new Date().toISOString();
const uid = p => p + crypto.randomBytes(6).toString('hex');
const hash = (pw, salt) => crypto.scryptSync(pw, salt, 64).toString('hex');
const pub = u => ({ id: u.id, name: u.name, email: u.email, role: u.role, active: u.active });
const mask = v => (v ? '••••' + String(v).slice(-4) : '');

function seed() {
  const salt = crypto.randomBytes(16).toString('hex');
  const pw = process.env.ADMIN_PASSWORD || 'change-me-now';
  const email = (process.env.ADMIN_ID || 'admin@skyblue.local').trim().toLowerCase();
  console.log(`First run. Admin login: ${email} / ${pw}  (set ADMIN_ID and ADMIN_PASSWORD before first start)`);
  return {
    users: [{ id: 'u_admin', email, name: 'Admin', role: 'admin', active: true, salt, pwHash: hash(pw, salt), created: now() }],
    sessions: {}, projects: [], logs: [],
    config: {
      keys: { gemini: '', openrouter: '', euipo_client_id: '', euipo_client_secret: '', uspto: '', whoisxml: '', tavily: '' },
      sources: { rdap: true, euipo: false, uspto: false, whoisxml: false, llm: false, tavily: false },
      // provider picks which text-generation API is used (image generation always uses the
      // Gemini key directly, regardless of this). Switching provider/model needs no code change.
      llm: { provider: 'gemini', model: 'gemini-3.5-flash-lite', openrouterModel: 'openai/gpt-4o-mini' },
      uiText: {},
      founderInfo: ''
    }
  };
}
function loadFile() {
  try { return JSON.parse(fs.readFileSync(DB, 'utf8')); }
  catch (e) { const d = seed(); fs.writeFileSync(DB, JSON.stringify(d, null, 2)); return d; }
}
let db = null; // populated by init() below before the server starts accepting requests
// Fire-and-forget: routes call save() synchronously without awaiting it, same as the old
// writeFileSync did. With Postgres this is now an async write; errors are logged, not thrown,
// so one failed save doesn't crash a request that already got its response.
function save() {
  if (pgPool) { pgSave(db).catch(e => console.error('DB save failed:', e.message)); return; }
  const tmp = DB + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(db, null, 2)); fs.renameSync(tmp, DB);
}

// API keys: Render environment variables win over keys typed in Admin.
// Env vars persist across restarts; keys saved in data.json do not on the free tier.
const ENV_KEYS = { gemini: 'GEMINI_API_KEY', openrouter: 'OPENROUTER_API_KEY', euipo_client_id: 'EUIPO_CLIENT_ID', euipo_client_secret: 'EUIPO_CLIENT_SECRET', uspto: 'USPTO_API_KEY', whoisxml: 'WHOISXML_API_KEY', tavily: 'TAVILY_API_KEY' };
const SOURCE_KEYS = { llm: ['gemini'], euipo: ['euipo_client_id', 'euipo_client_secret'], uspto: ['uspto'], whoisxml: ['whoisxml'], tavily: ['tavily'] };
// Canonical key shape. A project's persisted config (in Postgres/data.json) was written before
// some of these keys existed (e.g. 'openrouter' was added after projects were already live), so
// without this, db.config.keys is missing newer fields entirely - which crashed the Connections
// tab (it iterates a fixed label list and dereferences `.set` on each key, so a genuinely
// missing key throws instead of just showing "not set").
const KEY_DEFAULTS = { gemini: '', openrouter: '', euipo_client_id: '', euipo_client_secret: '', uspto: '', whoisxml: '', tavily: '' };
function ensureKeyShape() {
  let changed = false;
  for (const k of Object.keys(KEY_DEFAULTS)) if (!(k in db.config.keys)) { db.config.keys[k] = KEY_DEFAULTS[k]; changed = true; }
  if (typeof db.config.founderInfo !== 'string') { db.config.founderInfo = ''; changed = true; } // predates this field
  if (changed) save();
}
function cfg() {
  ensureKeyShape();
  const keys = { ...db.config.keys };
  for (const k of Object.keys(ENV_KEYS)) if (process.env[ENV_KEYS[k]]) keys[k] = process.env[ENV_KEYS[k]].trim();
  const sources = { ...db.config.sources };
  for (const [src, ks] of Object.entries(SOURCE_KEYS)) if (ks.every(k => keys[k])) sources[src] = true;
  // Either provider's key is enough to flip text-generation on - SOURCE_KEYS above only checks
  // the Gemini key since it predates OpenRouter support.
  if (keys.openrouter) sources.llm = true;
  // Model/provider choice is a preference, not a secret, and Postgres now persists Admin's saved
  // config reliably across restarts - so unlike API keys (still env-overridable below, since
  // those are legitimately meant to be locked server-side), the model/provider fields are always
  // whatever was last saved in Admin. Env vars no longer silently pin or disable them.
  const llm = { ...db.config.llm };
  if (process.env.GEMINI_IMAGE_MODEL) llm.imageModel = process.env.GEMINI_IMAGE_MODEL.trim();
  else if (!llm.imageModel) llm.imageModel = 'gemini-2.5-flash-image';
  return { ...db.config, keys, sources, llm };
}
const uiText = () => ({ ...C.UI_DEFAULT, ...db.config.uiText });
const llmReady = () => {
  const c = cfg();
  if (!c.sources.llm) return false;
  return c.llm.provider === 'openrouter' ? !!c.keys.openrouter : !!c.keys.gemini;
};

/* ---------- auth ---------- */
function auth(req, res, next) {
  const token = (req.headers.authorization || '').replace(/^Bearer /, '');
  const s = db.sessions[token];
  const u = s && db.users.find(x => x.id === s.userId);
  if (!u || !u.active) return res.status(401).json({ error: 'Sign in again' });
  req.user = u; req.token = token; next();
}
function adminOnly(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admins only' });
  next();
}

// Activity log: every successful change, per user.
app.use('/api', (req, res, next) => {
  if (req.method === 'GET' || req.path === '/login') return next();
  res.on('finish', () => {
    if (res.statusCode < 400 && req.user) {
      db.logs.push({ id: uid('l'), userId: req.user.id, at: now(), action: `${req.method} ${req.path}` });
      if (db.logs.length > 5000) db.logs.splice(0, db.logs.length - 5000);
      save();
    }
  });
  next();
});

app.post('/api/login', (req, res) => {
  const email = String((req.body || {}).email || '').trim().toLowerCase();
  const password = String((req.body || {}).password || '');
  const u = db.users.find(x => x.email === email && x.active);
  if (!u || !crypto.timingSafeEqual(Buffer.from(hash(password, u.salt), 'hex'), Buffer.from(u.pwHash, 'hex'))) {
    return res.status(401).json({ error: 'Wrong email or password' });
  }
  const token = crypto.randomBytes(24).toString('hex');
  db.sessions[token] = { userId: u.id, created: now() }; save();
  res.json({ token, user: pub(u) });
});
app.post('/api/logout', auth, (req, res) => { delete db.sessions[req.token]; save(); res.json({ ok: true }); });

app.get('/api/bootstrap', auth, (req, res) => {
  res.json({
    me: pub(req.user),
    projects: db.projects.filter(p => p.ownerId === req.user.id),
    catalog: C.pub,
    uiText: uiText(),
    llmReady: llmReady()
  });
});

app.put('/api/me', auth, (req, res) => {
  const name = String((req.body || {}).name || '').trim().slice(0, 60);
  if (name) req.user.name = name;
  save(); res.json(pub(req.user));
});

/* ---------- projects ---------- */
function ownProject(req, res) {
  const p = db.projects.find(x => x.id === req.params.id);
  if (!p) { res.status(404).json({ error: 'Project not found' }); return null; }
  if (p.ownerId !== req.user.id) { res.status(403).json({ error: 'Not your project' }); return null; }
  return p;
}
function newProject(ownerId, name) {
  return {
    id: uid('p'), ownerId, name, created: new Date().toLocaleDateString(),
    brief: '', restatement: '', restating: false, confirmed: false,
    market: '', classes: [], segments: [], refs: [], dirs: [], customDirs: [],
    suggest: { classes: [], segments: [] }, names: [], final: null
  };
}
// Looks up a direction by id in the fixed catalog first, then in this project's own AI-tailored
// custom directions (which aren't in the global catalog since they're specific to one business).
function dirInfo(p, dir) {
  return C.dirs.find(x => x.id === dir) || (p.customDirs || []).find(x => x.id === dir);
}
// Builds the business context fed to every AI call that needs to understand the business.
// Previously every one of these calls (name generation, direction suggestions, variations,
// research, visuals) only ever saw `p.restatement` - an AI-COMPRESSED two-sentence summary of
// the user's original brief (see llm.restate) - or the raw brief if restating hadn't run yet.
// Market and target-segment info the user fills in elsewhere in the project (p.market,
// p.segments) never reached the naming prompt at all, even though it's exactly the kind of
// specific detail that pushes a model away from generic names. This folds that in.
function buildContext(p, dir) {
  const parts = [];
  // The raw brief is the richest source (the user's own words, full detail); the restatement is
  // an AI-compressed 2-sentence paraphrase of it, generated only to show the user "here's what I
  // understood" - using it as the PRIMARY source for generation (as this used to do) throws away
  // exactly the specific detail that keeps names from feeling generic. Prefer the original brief;
  // fall back to the restatement only if the brief is somehow missing.
  if (p.brief) parts.push(p.brief);
  else if (p.restatement) parts.push(p.restatement);
  if (p.market) parts.push(`Target market: ${p.market}`);
  if (Array.isArray(p.segments) && p.segments.length) parts.push(`Target customer segments: ${p.segments.join(', ')}`);
  // The Founder-style direction is only meaningful if it's actually about THIS founder - a
  // generic business brief alone gives the AI nothing to personalize, which is exactly why it
  // used to fall back to canned pool examples (Mira & Co., Nora Lane) with no connection to the
  // real person. Admin → Founder lets the user paste in (or upload a photo/text of) the actual
  // founder's name, story or personality once; fold it in only for this direction so it doesn't
  // leak into unrelated directions.
  if (dir === 'founder' && cfg().founderInfo) parts.push(`Founder background (use this, do not invent a generic founder persona): ${cfg().founderInfo}`);
  return parts.join('\n');
}
function addName(p, dir, n, m, extra = {}) {
  const d = dirInfo(p, dir);
  const obj = {
    id: uid('n'), dir, dirLabel: d ? d.label : 'Your names', color: d ? d.color : '#000',
    n, m, status: 'suggested', visual: '', visualImages: [], visualError: '', variants: [], research: null, ...extra
  };
  p.names.push(obj); return obj;
}
// Pool fallback: used only when the AI isn't connected, or the AI call fails/returns too few.
// These are generic seed examples, not tailored to any specific brief. Custom (AI-tailored)
// directions have no pool of their own - they rely on the AI entirely, by design.
function generateFor(p, dir, count) {
  const d = dirInfo(p, dir); if (!d || !d.pool || !d.pool.length) return 0;
  const used = p.names.map(x => x.n.toLowerCase());
  const fresh = d.pool.filter(([n]) => !used.includes(n.toLowerCase())).sort(() => Math.random() - 0.5).slice(0, count);
  fresh.forEach(([n, m]) => addName(p, dir, n, m));
  return fresh.length;
}
// Primary path: ask the AI to invent names tailored to this project's actual brief and the
// chosen direction's style. Only drops to the generic catalog pool when the AI isn't connected
// or returns fewer than asked for.
// Max names asked for in a single AI call. Asking for a big batch (e.g. 24) in one shot makes
// the model collapse into permuting a handful of root words (Bricol/Bricola/Bricolo/Bricolae...)
// instead of genuinely distinct ideas - several smaller independent calls, each with its own
// random seed, give far more real variety for the same total count.
const NAME_CHUNK = 4;
// Runs `fn` over `items` with at most `limit` in flight at once. Firing every chunk of a big
// name batch at the provider simultaneously (e.g. 6 calls for a 24-name request) can trip a
// provider's per-second rate limit, especially on a free/trial key - capping concurrency keeps
// the diversity benefit of several small calls without bursting past that limit.
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      try { results[idx] = await fn(items[idx], idx); }
      catch (e) { results[idx] = []; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
async function generateMoreFor(p, dir, count) {
  const d = dirInfo(p, dir); if (!d) return { added: 0, lastError: null };
  const context = buildContext(p, dir);
  let got = 0;
  let lastError = null;
  if (llmReady()) {
    const styleDesc = d.hint ? `${d.label} — ${d.hint}` : d.label;
    const chunks = [];
    let remaining = count;
    while (remaining > 0) { chunks.push(Math.min(NAME_CHUNK, remaining)); remaining -= NAME_CHUNK; }
    // Each chunk is assigned a different naming technique (short & punchy, blend, clipped word,
    // foreign root, etc.) in rotation instead of every chunk getting the same generic ask - this
    // is what actually produces structural variety in a batch (some short and punchy, some
    // blended, some borrowed) rather than N calls that all tend toward the same safe shape.
    const techs = llm.TECHNIQUE_KEYS || [];
    const results = await mapLimit(chunks, 3, (c, i) => llm.generateNames(cfg(), styleDesc, context, p.names.map(x => x.n), c, techs[i % techs.length]));
    const seen = new Set(p.names.map(x => x.n.toLowerCase()));
    for (const pairs of results) {
      if (pairs.lastError) lastError = pairs.lastError; // surfaces the real cause (e.g. a bad model name) instead of a generic guess
      for (const [n, m] of pairs) {
        const key = n.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        addName(p, dir, n, m);
        got++;
      }
    }
    // The parallel fan-out can still come up short (a transient rate limit, a timeout on one
    // chunk) - one more sequential, single call for exactly the shortfall is far less likely to
    // hit the same limit than the batch that just did, so try that before giving up to the
    // catalog pool. This matters most for AI-suggested custom directions, which have an
    // intentionally empty pool (no fallback at all) - without this, a single failed chunk could
    // silently cap the whole batch at whatever the other chunks happened to return.
    if (got < count) {
      try {
        const pairs = await llm.generateNames(cfg(), styleDesc, context, p.names.map(x => x.n), count - got, techs[Math.floor(Math.random() * techs.length)]);
        if (pairs.lastError) lastError = pairs.lastError;
        for (const [n, m] of pairs) {
          const key = n.toLowerCase();
          if (seen.has(key)) continue;
          seen.add(key);
          addName(p, dir, n, m);
          got++;
        }
      } catch (e) { lastError = e.message; }
    }
  }
  const need = count - got;
  if (need > 0) got += generateFor(p, dir, need);
  return { added: got, lastError };
}
// Splits a total into `buckets` whole-number parts that sum back to exactly `total`, as evenly
// as possible - used so a name-generation run always produces a clean, predictable batch size
// (e.g. exactly 24, or exactly +8 on "generate more") regardless of how many directions are
// selected, instead of a number that drifts with rounding.
function splitCount(total, buckets) {
  const n = Math.max(1, buckets);
  const base = Math.floor(total / n);
  let rem = total - base * n;
  const out = [];
  for (let i = 0; i < n; i++) { out.push(base + (rem > 0 ? 1 : 0)); if (rem > 0) rem--; }
  return out;
}
const nameOf = (p, id) => p.names.find(x => x.id === id);

app.post('/api/projects', auth, (req, res) => {
  const n = db.projects.filter(p => p.ownerId === req.user.id).length + 1;
  const name = String((req.body || {}).name || `Project ${n}`).slice(0, 80);
  const p = newProject(req.user.id, name);
  db.projects.unshift(p); save(); res.json(p);
});

app.put('/api/projects/:id', auth, async (req, res) => {
  const p = ownProject(req, res); if (!p) return;
  const b = req.body || {};
  // Note: this route used to auto-generate 3 names the first time a direction was toggled on.
  // That meant a direction only ever got named once, ever; if that one shot landed during an
  // AI hiccup (wrong model, timeout) it fell back to the generic catalog pool, and — now that
  // state persists in Postgres — those stale/generic names stuck around forever with no way to
  // ever regenerate them. Toggling a direction here is just a selection now; actual generation
  // happens explicitly via the 'regenerate' action below, triggered by the Names page's
  // loading screen, so it always asks the AI fresh instead of silently reusing old results.
  ['name', 'brief', 'restatement', 'confirmed', 'restating', 'market', 'classes', 'segments', 'refs', 'dirs'].forEach(k => {
    if (b[k] !== undefined) p[k] = b[k];
  });
  p.dirs = (Array.isArray(p.dirs) ? p.dirs : []).filter(d => C.dirs.some(x => x.id === d) || (p.customDirs || []).some(x => x.id === d));
  save(); res.json(p);
});

app.delete('/api/projects/:id', auth, (req, res) => {
  const p = ownProject(req, res); if (!p) return;
  db.projects = db.projects.filter(x => x !== p); save(); res.json({ ok: true });
});

app.post('/api/projects/:id/understand', auth, async (req, res) => {
  const p = ownProject(req, res); if (!p) return;
  const text = String((req.body || {}).text || '').trim();
  if (text.length < 10) return res.status(400).json({ error: 'Write a few words first' });
  p.brief = text; p.restating = true;
  let connected = llmReady();
  let aiError = '';
  if (connected) {
    try { p.restatement = await llm.restate(cfg(), text); }
    catch (e) { connected = false; aiError = e.message; console.error('AI restate failed:', e.message); }
  }
  save(); res.json({ project: p, connected, aiError });
});

app.post('/api/projects/:id/suggest', auth, async (req, res) => {
  const p = ownProject(req, res); if (!p) return;
  const field = (req.body || {}).field;
  if (!['classes', 'segments'].includes(field)) return res.status(400).json({ error: 'Unknown field' });
  if (llmReady() && p.restatement) {
    try { p.suggest[field] = await llm.suggest(cfg(), field, p.restatement); }
    catch (e) { return res.status(502).json({ error: 'AI suggestion failed: ' + e.message }); }
  }
  save(); res.json(p);
});

// Custom, AI-tailored direction styles for this specific business - shown alongside (never
// instead of) the fixed catalog directions, so there's always something to pick from.
const CUSTOM_DIR_COLORS = ['#2FBF71', '#2E8BFF', '#FF6B6B', '#9B6BFF', '#FFD84D', '#FF9A3D'];
app.post('/api/projects/:id/directions/suggest', auth, async (req, res) => {
  const p = ownProject(req, res); if (!p) return;
  if (llmReady() && p.restatement) {
    try {
      const context = buildContext(p);
      const suggestions = await llm.suggestDirections(cfg(), context, 4);
      p.customDirs = suggestions.map((s, i) => ({
        id: 'customdir_' + i, label: s.label, hint: s.hint,
        color: CUSTOM_DIR_COLORS[i % CUSTOM_DIR_COLORS.length], pool: []
      }));
    } catch (e) { return res.status(502).json({ error: 'AI direction suggestion failed: ' + e.message }); }
  }
  save(); res.json(p);
});

/* ---------- names ---------- */
app.post('/api/projects/:id/names', auth, async (req, res) => {
  const p = ownProject(req, res); if (!p) return;
  const b = req.body || {};
  let requested = 0, added = 0, lastError = null; // surfaced to the client so it can warn on a shortfall - with the real reason - instead of silently showing fewer names than asked for
  if (b.action === 'generate') {
    requested = 4;
    const r = await generateMoreFor(p, b.dir, 4);
    added = r.added; lastError = r.lastError;
  }
  else if (b.action === 'more') {
    // Fixed total of 8 new names per click (a clean multiple of 4, matching the names grid's
    // 4-per-row layout), split evenly across whichever directions are selected - not "N per
    // direction", so the total added stays predictable how ever many directions are picked.
    requested = 8;
    const counts = splitCount(8, p.dirs.length);
    const rs = await Promise.all(p.dirs.map((d, i) => generateMoreFor(p, d, counts[i])));
    added = rs.reduce((a, r) => a + r.added, 0);
    lastError = (rs.find(r => r.lastError) || {}).lastError || null;
  }
  else if (b.action === 'regenerate') {
    // Always ask the AI fresh for the currently selected directions. Drops previously
    // AI-suggested names for those directions first (keeping anything the user has actually
    // acted on — kept/shortlisted/locked/rejected) so the page never shows stale/old output,
    // and generates a brand-new full batch every single time this is called.
    p.names = p.names.filter(x => !(x.status === 'suggested' && p.dirs.includes(x.dir)));
    // First run targets 24 names total (a clean multiple of 4), or more if many directions are
    // selected (at least 2 per direction), split evenly so the total is always predictable.
    requested = Math.max(24, p.dirs.length * 2);
    const counts = splitCount(requested, p.dirs.length);
    const rs = await Promise.all(p.dirs.map((d, i) => generateMoreFor(p, d, counts[i])));
    added = rs.reduce((a, r) => a + r.added, 0);
    lastError = (rs.find(r => r.lastError) || {}).lastError || null;
  }
  else if (b.action === 'reshuffle') p.names.sort(() => Math.random() - 0.5);
  else if (b.action === 'own') {
    const n = String(b.n || '').trim().slice(0, 40);
    if (!n) return res.status(400).json({ error: 'Type a name first' });
    if (p.names.some(x => x.n.toLowerCase() === n.toLowerCase())) return res.status(400).json({ error: 'Already in the list' });
    addName(p, b.dir || 'custom', n, String(b.m || 'Your own name.').slice(0, 200), b.parent ? { parent: b.parent } : {});
  } else return res.status(400).json({ error: 'Unknown action' });
  save();
  res.json(requested > added ? { ...p, _genShortfall: { requested, added, reason: lastError } } : p);
});

app.patch('/api/projects/:id/names/:nid', auth, (req, res) => {
  const p = ownProject(req, res); if (!p) return;
  const n = nameOf(p, req.params.nid); if (!n) return res.status(404).json({ error: 'Name not found' });
  const b = req.body || {};
  if (b.visual !== undefined) n.visual = String(b.visual).slice(0, 300);
  if (b.status !== undefined) {
    if (!['suggested', 'kept', 'shortlisted', 'locked', 'rejected'].includes(b.status)) return res.status(400).json({ error: 'Bad status' });
    if (b.status === 'locked') { p.names.forEach(x => { if (x.status === 'locked') x.status = 'shortlisted'; }); p.final = n.id; }
    else if (p.final === n.id) p.final = null;
    n.status = b.status;
  }
  save(); res.json(p);
});

app.post('/api/projects/:id/names/:nid/variations', auth, async (req, res) => {
  const p = ownProject(req, res); if (!p) return;
  const n = nameOf(p, req.params.nid); if (!n) return res.status(404).json({ error: 'Name not found' });
  const kind = (req.body || {}).kind === 'new' ? 'new' : 'similar';
  const wantCount = kind === 'new' ? 3 : 4;
  let names = [];
  if (llmReady()) {
    // One small call PER variation, run in parallel, instead of one call asking for all of
    // them at once - a single batch call tends to produce the same root word with different
    // suffixes (Joinjoi/Jointot/Jointmoi); independent calls give each variation its own idea.
    const context = buildContext(p, n.dir);
    const results = await Promise.all(Array.from({ length: wantCount }, () =>
      llm.generateVariations(cfg(), n.n, n.m, kind, context, n.dirLabel, 1)));
    const seen = new Set();
    for (const pairs of results) {
      for (const [v] of pairs) {
        const key = v.toLowerCase();
        if (seen.has(key) || key === n.n.toLowerCase()) continue;
        seen.add(key);
        names.push(v);
      }
    }
  }
  if (names.length < wantCount) {
    const fallback = kind === 'new' ? C.newElementVariants(n.n, wantCount) : C.similarVariants(n.n, wantCount);
    for (const v of fallback) { if (names.length >= wantCount) break; if (!names.includes(v)) names.push(v); }
  }
  n.variants = names.slice(0, wantCount);
  save(); res.json(p);
});

app.post('/api/projects/:id/names/:nid/research', auth, async (req, res) => {
  const p = ownProject(req, res); if (!p) return;
  const n = nameOf(p, req.params.nid); if (!n) return res.status(404).json({ error: 'Name not found' });
  const context = buildContext(p, n.dir);
  try { n.research = await research.run(n.n, cfg(), llm, context); }
  catch (e) { return res.status(502).json({ error: 'Research failed: ' + e.message }); }
  save(); res.json(p);
});

app.post('/api/projects/:id/names/:nid/visualise', auth, async (req, res) => {
  const p = ownProject(req, res); if (!p) return;
  const n = nameOf(p, req.params.nid); if (!n) return res.status(404).json({ error: 'Name not found' });
  const style = String((req.body || {}).style || '').trim().slice(0, 200);
  n.visual = style;
  n.visualError = '';
  n.visualImages = [];
  if (!llmReady()) { n.visualError = 'AI is not connected. Add a Gemini key in Admin.'; save(); return res.json(p); }
  const context = buildContext(p, n.dir);
  // A strong, consistent base prompt is always built from the actual brand data (name, meaning,
  // direction, business) regardless of what the user types in the style box - that field only
  // adds an optional extra direction on top, so quality never depends on the user happening to
  // write a good prompt themselves. These are WORDMARKS only (the name itself, stylized) - no
  // separate pictorial icon/symbol - per request. A wide (not square) aspect is requested so the
  // full word fits the wide preview tile without being cropped.
  const base = `A WORDMARK logo for a brand named exactly "${n.n}" - the stylized typography of this word IS the entire logo. Do not add any separate icon, symbol, or pictorial mark next to it - just the word itself, artfully lettered. Meaning behind the name: ${n.m}. Business: ${context || 'not specified'}. Brand direction/style: ${n.dirLabel || 'modern'}.` +
    (style ? ` Additional direction from the brand owner: ${style}.` : ' Use a clean, premium aesthetic appropriate to the business.') +
    ' Wide, landscape-oriented composition with generous empty margin on all sides so the full word is never cropped. Plain or very softly colored background, no mockup frame, no surrounding UI chrome, no extra text beyond the brand name itself.';
  const variants = [
    'Typography style: bold, geometric sans-serif lettering.',
    'Typography style: elegant serif or script lettering.',
    'Typography style: modern minimalist lettering with unconventional letter-spacing or a distinctive letterform.'
  ];
  try {
    const results = await Promise.allSettled(variants.map(v => llm.generateImage(cfg(), `${base} ${v}`)));
    n.visualImages = results.filter(r => r.status === 'fulfilled').map(r => r.value);
    if (!n.visualImages.length) {
      const failed = results.find(r => r.status === 'rejected');
      n.visualError = failed ? failed.reason.message : 'Image generation failed.';
      console.error('Image generation failed for all variants:', n.visualError);
    }
  } catch (e) {
    n.visualError = e.message;
    console.error('Image generation failed:', e.message);
  }
  save(); res.json(p);
});

/* ---------- admin ---------- */
app.get('/api/admin/users', auth, adminOnly, (req, res) => res.json(db.users.map(pub)));

app.post('/api/admin/users', auth, adminOnly, (req, res) => {
  const b = req.body || {};
  const email = String(b.email || '').trim().toLowerCase();
  if (!email.includes('@')) return res.status(400).json({ error: 'Enter a valid email' });
  if (db.users.some(u => u.email === email)) return res.status(400).json({ error: 'Email already exists' });
  if (String(b.password || '').length < 8) return res.status(400).json({ error: 'Password needs 8+ characters' });
  const salt = crypto.randomBytes(16).toString('hex');
  const u = {
    id: uid('u'), email, name: String(b.name || email.split('@')[0]).slice(0, 60),
    role: b.role === 'admin' ? 'admin' : 'member', active: true, salt,
    pwHash: hash(String(b.password), salt), created: now()
  };
  db.users.push(u); save(); res.json(pub(u));
});

app.patch('/api/admin/users/:id', auth, adminOnly, (req, res) => {
  const u = db.users.find(x => x.id === req.params.id);
  if (!u) return res.status(404).json({ error: 'User not found' });
  const b = req.body || {};
  if (b.name !== undefined) u.name = String(b.name).slice(0, 60);
  if (b.role !== undefined) u.role = b.role === 'admin' ? 'admin' : 'member';
  if (b.active !== undefined) {
    if (u.id === req.user.id && !b.active) return res.status(400).json({ error: 'You cannot disable yourself' });
    u.active = !!b.active;
  }
  if (b.password) {
    if (String(b.password).length < 8) return res.status(400).json({ error: 'Password needs 8+ characters' });
    u.salt = crypto.randomBytes(16).toString('hex'); u.pwHash = hash(String(b.password), u.salt);
  }
  save(); res.json(pub(u));
});

app.get('/api/admin/logs', auth, adminOnly, (req, res) => {
  const uidq = req.query.userId;
  res.json(db.logs.filter(l => !uidq || l.userId === uidq).slice(-300).reverse());
});

function configView() {
  const keys = {};
  Object.entries(cfg().keys).forEach(([k, v]) => { keys[k] = { set: !!v, hint: mask(v), fromEnv: !!process.env[ENV_KEYS[k]] }; });
  return { keys, sources: cfg().sources, llm: cfg().llm, uiText: uiText(), llmReady: llmReady(), founderInfo: cfg().founderInfo || '' };
}
app.get('/api/admin/config', auth, adminOnly, (req, res) => res.json(configView()));

app.put('/api/admin/config', auth, adminOnly, (req, res) => {
  ensureKeyShape(); // legacy configs may predate newer key names (e.g. 'openrouter')
  const b = req.body || {};
  // Temporary diagnostic: logs which key *names* (never the values) actually arrived in this
  // request and what the saved shape looks like right after, to track down a report of a saved
  // key not sticking without needing direct DB access.
  console.log('[admin/config PUT] received key names:', Object.keys(b.keys || {}), 'llm:', b.llm);
  Object.entries(b.keys || {}).forEach(([k, v]) => {
    if (k in db.config.keys && typeof v === 'string' && v.trim()) db.config.keys[k] = v.trim();
  });
  (b.clear || []).forEach(k => { if (k in db.config.keys) db.config.keys[k] = ''; });
  Object.entries(b.sources || {}).forEach(([k, v]) => { if (k in db.config.sources) db.config.sources[k] = !!v; });
  if (b.llm && typeof b.llm.model === 'string' && b.llm.model.trim()) db.config.llm.model = b.llm.model.trim().slice(0, 80);
  if (b.llm && typeof b.llm.openrouterModel === 'string' && b.llm.openrouterModel.trim()) db.config.llm.openrouterModel = b.llm.openrouterModel.trim().slice(0, 80);
  if (b.llm && ['gemini', 'openrouter'].includes(b.llm.provider)) db.config.llm.provider = b.llm.provider;
  if (typeof b.founderInfo === 'string') db.config.founderInfo = b.founderInfo.slice(0, 4000);
  console.log('[admin/config PUT] after save, openrouter key set:', !!db.config.keys.openrouter, 'provider:', db.config.llm.provider);
  save(); res.json(configView());
});

// Accepts an uploaded photo/screenshot (as a data: URL) for Admin -> Founder, reads it via Gemini
// vision, and appends the extracted description to the saved founder text - the same pattern as
// typing it directly, just sourced from an image instead. Uses its own larger body-size limit
// (the app's global express.json limit is 1mb, far too small for a photo) scoped to just this
// route, rather than widening the limit everywhere.
app.put('/api/admin/founder-image', auth, adminOnly, express.json({ limit: '12mb' }), async (req, res) => {
  const dataUrl = String((req.body || {}).dataUrl || '');
  if (!dataUrl.startsWith('data:image/')) return res.status(400).json({ error: 'Not an image' });
  if (!cfg().keys.gemini) return res.status(400).json({ error: 'Add a Gemini key in Admin first (image reading always uses the Gemini key, regardless of text provider)' });
  try {
    const desc = await llm.describeImage(cfg(), dataUrl);
    db.config.founderInfo = `${db.config.founderInfo || ''}${db.config.founderInfo ? '\n' : ''}[From uploaded image] ${desc}`.slice(0, 4000);
    save();
    res.json(configView());
  } catch (e) { res.status(502).json({ error: 'Could not read image: ' + e.message }); }
});

app.put('/api/admin/ui-text', auth, adminOnly, (req, res) => {
  const t = (req.body || {}).uiText || {};
  Object.entries(t).forEach(([k, v]) => { if (k in C.UI_DEFAULT) db.config.uiText[k] = String(v).slice(0, 200); });
  save(); res.json(uiText());
});

app.post('/api/admin/test/:source', auth, adminOnly, async (req, res) => {
  res.json(await research.test(req.params.source, cfg(), llm));
});

/* ---------- fallbacks ---------- */
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));
app.use((err, req, res, next) => res.status(400).json({ error: 'Bad request' }));

const PORT = process.env.PORT || 3000;
async function init() {
  if (pgPool) {
    try { db = await pgLoad(); console.log('Storage: Postgres (persists across restarts).'); }
    catch (e) { console.error('Postgres connect/load failed, falling back to local file storage:', e.message); db = loadFile(); }
  } else {
    db = loadFile();
    console.log('Storage: local file (data.json). This is wiped on every restart on Render\'s free tier — set DATABASE_URL to persist.');
  }
  app.listen(PORT, () => console.log(`Namae Studio running on http://localhost:${PORT}`));
}
init();
