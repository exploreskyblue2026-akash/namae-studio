'use strict';
// AI adapter (Google Gemini REST). Model names change over time: set the model in Admin → Connections.

async function call(cfg, prompt) {
  const key = cfg.keys.gemini;
  if (!key) throw new Error('No AI key saved');
  const model = (cfg.llm && cfg.llm.model) || 'gemini-3.8-flash';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
    signal: AbortSignal.timeout(20000)
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error?.message || `AI returned ${r.status}`);
  return (j.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('').trim();
}

async function restate(cfg, text) {
  return call(cfg, `Restate this business in two plain sentences, in your own words. Do not reuse its exact phrasing.\n\nBusiness: ${text}`);
}

async function suggest(cfg, field, understanding) {
  const what = field === 'classes' ? 'trademark product or service areas' : 'target customer segments';
  const text = await call(cfg, `Based on this business understanding, suggest 6 ${what} as a JSON array of short strings. Return only the JSON.\n\nUnderstanding: ${understanding}`);
  const m = text.match(/\[[\s\S]*\]/);
  if (!m) return [];
  try { return JSON.parse(m[0]).map(x => String(x).slice(0, 60)).slice(0, 8); }
  catch (e) { return []; }
}

async function ping(cfg) { return call(cfg, 'Reply with the word ok.'); }

// Returns { status: 'Clear'|'Review', summary } by asking the model for strict JSON.
// Throws on a network/API failure so the caller can fall back to Pending.
async function checkJSON(cfg, prompt) {
  const text = await call(cfg, prompt + '\n\nReply with ONLY a JSON object, no other text: {"status":"Clear" or "Review","summary":"one short plain sentence"}');
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('AI reply was not JSON');
  const j = JSON.parse(m[0]);
  const status = j.status === 'Review' ? 'Review' : 'Clear';
  return { status, summary: String(j.summary || '').slice(0, 240) || 'No concern found.' };
}

async function checkSound(cfg, name, context) {
  return checkJSON(cfg, `Brand name: "${name}". Business: ${context}\nJudge how this name sounds and feels: is it easy to say, easy to spell, memorable, and does the tone fit the business? Say "Review" only if there is a real pronunciation, spelling, or tone problem.`);
}

async function checkOrigin(cfg, name, context) {
  return checkJSON(cfg, `Brand name: "${name}". Business: ${context}\nCheck the linguistic origin and literal meaning of this word or word-parts in major world languages (English, Spanish, French, Hindi, Mandarin, Arabic, Japanese, German). Say "Review" only if it means something negative, offensive, or confusing in a widely spoken language; otherwise say "Clear" and note any neutral or positive meaning found.`);
}

async function checkSimilar(cfg, name, context) {
  return checkJSON(cfg, `Brand name: "${name}". Business: ${context}\nFrom your knowledge, is there a well-known existing brand, product, or company with an identical or very similar name that could cause confusion? Say "Review" and name it if so; otherwise say "Clear" and note that no close match is known. This is a knowledge check, not a live trademark search.`);
}

// Generates fresh on-brand name candidates when the fixed catalog pool runs out.
// Returns an array of [name, meaning] pairs, or [] on any failure (caller falls back silently).
async function generateNames(cfg, dirLabel, context, avoid, count) {
  const prompt = `Business: ${context}\nDirection/style: ${dirLabel}\nInvent ${count} brand-new, short, brandable names that fit this style and business. Do not reuse any of these existing names: ${avoid.join(', ') || 'none'}.\nReply with ONLY a JSON array, no other text: [{"name":"...","meaning":"one short sentence on the name's meaning or origin"}, ...]`;
  try {
    const text = await call(cfg, prompt);
    const m = text.match(/\[[\s\S]*\]/);
    if (!m) return [];
    const arr = JSON.parse(m[0]);
    return arr
      .map(x => [String(x.name || '').trim().slice(0, 40), String(x.meaning || '').trim().slice(0, 200)])
      .filter(([n]) => n && !avoid.some(a => a.toLowerCase() === n.toLowerCase()))
      .slice(0, count);
  } catch (e) { return []; }
}

module.exports = { restate, suggest, ping, checkSound, checkOrigin, checkSimilar, generateNames };
