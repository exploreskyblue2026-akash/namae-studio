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

module.exports = { restate, suggest, ping };
