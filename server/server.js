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
      keys: { gemini: '', euipo_client_id: '', euipo_client_secret: '', uspto: '', whoisxml: '', tavily: '' },
      sources: { rdap: true, euipo: false, uspto: false, whoisxml: false, llm: false, tavily: false },
      llm: { model: 'gemini-3.5-flash-lite' },
      uiText: {}
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
const ENV_KEYS = { gemini: 'GEMINI_API_KEY', euipo_client_id: 'EUIPO_CLIENT_ID', euipo_client_secret: 'EUIPO_CLIENT_SECRET', uspto: 'USPTO_API_KEY', whoisxml: 'WHOISXML_API_KEY', tavily: 'TAVILY_API_KEY' };
const SOURCE_KEYS = { llm: ['gemini'], euipo: ['euipo_client_id', 'euipo_client_secret'], uspto: ['uspto'], whoisxml: ['whoisxml'], tavily: ['tavily'] };
function cfg() {
  const keys = { ...db.config.keys };
  for (const k of Object.keys(ENV_KEYS)) if (process.env[ENV_KEYS[k]]) keys[k] = process.env[ENV_KEYS[k]].trim();
  const sources = { ...db.config.sources };
  for (const [src, ks] of Object.entries(SOURCE_KEYS)) if (ks.every(k => keys[k])) sources[src] = true;
  const llm = { ...db.config.llm };
  if (process.env.GEMINI_MODEL) llm.model = process.env.GEMINI_MODEL.trim();
  if (process.env.GEMINI_IMAGE_MODEL) llm.imageModel = process.env.GEMINI_IMAGE_MODEL.trim();
  else if (!llm.imageModel) llm.imageModel = 'gemini-2.5-flash-image';
  return { ...db.config, keys, sources, llm };
}
const uiText = () => ({ ...C.UI_DEFAULT, ...db.config.uiText });
const llmReady = () => { const c = cfg(); return !!(c.sources.llm && c.keys.gemini); };

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
    market: '', classes: [], segments: [], refs: [], dirs: [],
    suggest: { classes: [], segments: [] }, names: [], final: null
  };
}
function addName(p, dir, n, m, extra = {}) {
  const d = C.dirs.find(x => x.id === dir);
  const obj = {
    id: uid('n'), dir, dirLabel: d ? d.label : 'Your names', color: d ? d.color : '#000',
    n, m, status: 'suggested', visual: '', visualImage: '', visualError: '', variants: [], research: null, ...extra
  };
  p.names.push(obj); return obj;
}
// Pool fallback: used only when the AI isn't connected, or the AI call fails/returns too few.
// These are generic seed examples, not tailored to any specific brief.
function generateFor(p, dir, count) {
  const d = C.dirs.find(x => x.id === dir); if (!d) return 0;
  const used = p.names.map(x => x.n.toLowerCase());
  const fresh = d.pool.filter(([n]) => !used.includes(n.toLowerCase())).sort(() => Math.random() - 0.5).slice(0, count);
  fresh.forEach(([n, m]) => addName(p, dir, n, m));
  return fresh.length;
}
// Primary path: ask the AI to invent names tailored to this project's actual brief and the
// chosen direction's style. Only drops to the generic catalog pool when the AI isn't connected
// or returns fewer than asked for.
async function generateMoreFor(p, dir, count) {
  const d = C.dirs.find(x => x.id === dir); if (!d) return 0;
  const context = p.restatement || p.brief || '';
  let got = 0;
  if (llmReady()) {
    const avoid = p.names.map(x => x.n);
    const pairs = await llm.generateNames(cfg(), d.label, context, avoid, count);
    pairs.forEach(([n, m]) => addName(p, dir, n, m));
    got = pairs.length;
  }
  const need = count - got;
  if (need > 0) got += generateFor(p, dir, need);
  return got;
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
  p.dirs = (Array.isArray(p.dirs) ? p.dirs : []).filter(d => C.dirs.some(x => x.id === d));
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

/* ---------- names ---------- */
app.post('/api/projects/:id/names', auth, async (req, res) => {
  const p = ownProject(req, res); if (!p) return;
  const b = req.body || {};
  if (b.action === 'generate') await generateMoreFor(p, b.dir, 4);
  else if (b.action === 'more') await Promise.all(p.dirs.map(d => generateMoreFor(p, d, 3)));
  else if (b.action === 'regenerate') {
    // Always ask the AI fresh for the currently selected directions. Drops previously
    // AI-suggested names for those directions first (keeping anything the user has actually
    // acted on — kept/shortlisted/locked/rejected) so the page never shows stale/old output,
    // and generates a brand-new full batch every single time this is called.
    p.names = p.names.filter(x => !(x.status === 'suggested' && p.dirs.includes(x.dir)));
    // More directions are now available to pick from, so the per-direction count is capped a
    // little lower as more get selected, but the floor is raised (5, not 4) and the overall
    // target batch size is bigger (16, not 10) so a run gives noticeably more to choose from.
    const perDir = Math.max(5, Math.round(16 / Math.max(1, p.dirs.length)));
    await Promise.all(p.dirs.map(d => generateMoreFor(p, d, perDir)));
  }
  else if (b.action === 'reshuffle') p.names.sort(() => Math.random() - 0.5);
  else if (b.action === 'own') {
    const n = String(b.n || '').trim().slice(0, 40);
    if (!n) return res.status(400).json({ error: 'Type a name first' });
    if (p.names.some(x => x.n.toLowerCase() === n.toLowerCase())) return res.status(400).json({ error: 'Already in the list' });
    addName(p, b.dir || 'custom', n, String(b.m || 'Your own name.').slice(0, 200), b.parent ? { parent: b.parent } : {});
  } else return res.status(400).json({ error: 'Unknown action' });
  save(); res.json(p);
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
    const context = p.restatement || p.brief || '';
    const pairs = await llm.generateVariations(cfg(), n.n, n.m, kind, context);
    names = pairs.map(([v]) => v);
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
  const context = p.restatement || p.brief || '';
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
  if (!llmReady()) { n.visualError = 'AI is not connected. Add a Gemini key in Admin.'; save(); return res.json(p); }
  const context = p.restatement || p.brief || '';
  const prompt = `Create a single clean brand visual / logo concept image for a brand named "${n.n}" (${n.m}). Business: ${context || 'not specified'}. Visual style: ${style || 'modern, minimal, professional'}. The image should look like a brand mark or mood board tile: no surrounding text or mockup frame, just the visual itself.`;
  try {
    n.visualImage = await llm.generateImage(cfg(), prompt);
  } catch (e) {
    n.visualImage = '';
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
  return { keys, sources: cfg().sources, llm: cfg().llm, llmModelFromEnv: !!process.env.GEMINI_MODEL, uiText: uiText(), llmReady: llmReady() };
}
app.get('/api/admin/config', auth, adminOnly, (req, res) => res.json(configView()));

app.put('/api/admin/config', auth, adminOnly, (req, res) => {
  const b = req.body || {};
  Object.entries(b.keys || {}).forEach(([k, v]) => {
    if (k in db.config.keys && typeof v === 'string' && v.trim()) db.config.keys[k] = v.trim();
  });
  (b.clear || []).forEach(k => { if (k in db.config.keys) db.config.keys[k] = ''; });
  Object.entries(b.sources || {}).forEach(([k, v]) => { if (k in db.config.sources) db.config.sources[k] = !!v; });
  if (b.llm && typeof b.llm.model === 'string' && b.llm.model.trim()) db.config.llm.model = b.llm.model.trim().slice(0, 80);
  save(); res.json(configView());
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
