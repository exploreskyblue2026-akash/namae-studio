'use strict';
// AI adapter (Google Gemini REST). Model names change over time: set the model in Admin → Connections,
// or GEMINI_MODEL / GEMINI_IMAGE_MODEL env vars (env vars survive free-tier restarts; Admin settings don't).

async function call(cfg, prompt, opts = {}) {
  const key = cfg.keys.gemini;
  if (!key) throw new Error('No AI key saved');
  const model = (cfg.llm && cfg.llm.model) || 'gemini-3.5-flash-lite';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`;
  const generationConfig = { temperature: opts.temperature ?? 1.0 };
  // Forces the model to emit valid JSON with no surrounding markdown (code fences, bullet
  // markers, bold-asterisks, etc.) - callers that parse a JSON array/object out of the reply
  // pass this, since the free-text version occasionally wraps the JSON in something that breaks
  // a plain JSON.parse (this was the actual cause of intermittent "not good" AI results: a
  // parse failure silently fell back to the generic catalog pool instead of the AI's real answer).
  if (opts.json) generationConfig.responseMimeType = 'application/json';
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig }),
    signal: AbortSignal.timeout(opts.timeoutMs ?? 25000)
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
  const text = await call(cfg, `Based on this business understanding, suggest 6 ${what} as a JSON array of short strings. Return only the JSON.\n\nUnderstanding: ${understanding}`, { json: true });
  const m = text.match(/\[[\s\S]*\]/);
  if (!m) return [];
  try { return JSON.parse(m[0]).map(x => String(x).slice(0, 60)).slice(0, 8); }
  catch (e) { return []; }
}

async function ping(cfg) { return call(cfg, 'Reply with the word ok.'); }

// Returns { status: 'Clear'|'Review', summary } by asking the model for strict JSON.
// Throws on a network/API failure so the caller can fall back to Pending.
async function checkJSON(cfg, prompt) {
  const text = await call(cfg, prompt + '\n\nReply with ONLY a JSON object, no other text: {"status":"Clear" or "Review","summary":"one short plain sentence"}', { json: true });
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('AI reply was not JSON');
  const j = JSON.parse(m[0]);
  const status = j.status === 'Review' ? 'Review' : 'Clear';
  return { status, summary: String(j.summary || '').slice(0, 240) || 'No concern found.' };
}

// Returns { status: 'Clear'|'Review', bullets: string[] } - short bullet points instead of a
// paragraph, for research cards the person should be able to scan in a few seconds.
async function checkBulletsJSON(cfg, prompt) {
  const text = await call(cfg, prompt + '\n\nReply with ONLY a JSON object, no other text: {"status":"Clear" or "Review","bullets":["short bullet point","short bullet point","short bullet point"]}', { json: true });
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('AI reply was not JSON');
  const j = JSON.parse(m[0]);
  const status = j.status === 'Review' ? 'Review' : 'Clear';
  const bullets = Array.isArray(j.bullets) ? j.bullets.map(x => String(x).trim().slice(0, 140)).filter(Boolean).slice(0, 4) : [];
  return { status, bullets: bullets.length ? bullets : ['No concern found.'] };
}

async function checkSound(cfg, name, context) {
  return checkBulletsJSON(cfg, `Brand name: "${name}". Business: ${context}\nJudge how this name sounds and feels. Give short bullet points (a few words each, not sentences) covering: ease of pronunciation, ease of spelling, memorability, and tone fit for the business. Say "Review" only if there is a real pronunciation, spelling, or tone problem.`);
}

async function checkOrigin(cfg, name, context) {
  return checkBulletsJSON(cfg, `Brand name: "${name}". Business: ${context}\nGive short bullet points (a few words each, not sentences) covering: the word's literal meaning, its linguistic origin/language, and - if it's an invented or fused word - what parts it's built from and their function. Say "Review" only if it means something negative, offensive, or confusing in a widely spoken language.`);
}

async function checkSimilar(cfg, name, context) {
  return checkJSON(cfg, `Brand name: "${name}". Business: ${context}\nFrom your knowledge, is there a well-known existing brand, product, or company with an identical or very similar name that could cause confusion? Say "Review" and name it if so; otherwise say "Clear" and note that no close match is known. This is a knowledge check, not a live trademark search.`);
}

// Used when a live source (RDAP / EUIPO / USPTO / a social-handle API) is off or unavailable,
// or alongside a live result as a second opinion. Always framed as a knowledge-based guess, not
// a verified live lookup, so the UI label can be honest about what kind of signal this is.
async function checkDomainAI(cfg, name, context) {
  return checkJSON(cfg, `Domain: "${name.toLowerCase().replace(/[^a-z0-9]/g, '')}.com". Business: ${context}\nFrom your training knowledge (not a live lookup), is this likely to already be a well-known, long-established domain or brand? Say "Review" only if you recognize it as an existing well-known site; otherwise say "Clear" and note that it is not a domain you recognize as taken. Be clear this is not a live availability check.`);
}

async function checkTrademarkAI(cfg, name, context) {
  return checkJSON(cfg, `Brand name: "${name}". Business: ${context}\nFrom your knowledge, could this name conflict with a well-known registered trademark in this business category? Say "Review" and name the conflict if you know of one; otherwise say "Clear" and note that a formal trademark register search is still needed. This is a knowledge-based opinion, not a live trademark registry search.`);
}

async function checkSocialAI(cfg, name, context) {
  return checkJSON(cfg, `Brand name: "${name}". Business: ${context}\nFrom your knowledge, is "${name}" likely already a well-known, widely-used handle or account name on major social platforms (Instagram, X, TikTok)? Say "Review" only if you recognize it as an existing well-known account; otherwise say "Clear" and note that handle availability still needs a live check. This is a knowledge-based opinion, not a live platform check.`);
}

// Reads real Tavily search-result snippets and picks out which ones, if any, actually describe
// an existing brand/company/product by this name - and what category it's in - instead of just
// reporting "found a page mentioning this word." Throws on failure so the caller can fall back
// to listing the raw search hits instead.
async function extractBrandMatches(cfg, name, hits) {
  const list = hits.map((h, i) => `${i + 1}. "${h.title}" - ${h.url}\n${(h.content || '').slice(0, 220)}`).join('\n\n');
  const prompt = `Web search results for the name "${name}":\n\n${list}\n\nLook at these results and decide which ones, if any, describe a REAL existing brand, company, or product actually named "${name}" or something extremely close to it - not just a page that happens to use the word, an unrelated meaning, or a person's name. For each real match found, give its name as actually used, the industry/category it's in in a few words (e.g. "footwear", "software", "coffee shop"), and the country it's based in or associated with if the results make that clear (otherwise leave it blank).\nReply with ONLY a JSON object, no other text: {"matches":[{"name":"...","category":"...","country":"..."}]} (empty array if no real brand/company match is found).`;
  const text = await call(cfg, prompt, { json: true });
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('AI reply was not JSON');
  const j = JSON.parse(m[0]);
  const matches = Array.isArray(j.matches) ? j.matches
    .map(x => ({ name: String(x.name || '').trim().slice(0, 60), category: String(x.category || '').trim().slice(0, 60), country: String(x.country || '').trim().slice(0, 60) }))
    .filter(x => x.name)
    .slice(0, 6) : [];
  return { matches };
}

// Suggests brand-naming DIRECTIONS (styles) tailored specifically to this business, rather than
// the fixed generic categories (Compound, Metaphor, etc.) - these are meant to feel like they
// were invented for this exact brand, not picked off a shelf. Shown alongside the fixed list,
// never replacing it, so there's always something to pick from even if this call fails.
async function suggestDirections(cfg, context, count = 4) {
  const seed = Math.random().toString(36).slice(2, 8);
  const prompt = `Business: ${context}\nInvent ${count} short, distinct brand-naming DIRECTIONS/STYLES tailored specifically to THIS business - not generic categories like "compound words" or "metaphor", but styles that reflect this business's own personality, industry, and audience. (Creativity seed: ${seed}; ignore this number.)\nFor each direction give: a short style label (2-4 words, title case) and a one-sentence hint describing what kind of names it would produce.\nReply with ONLY a JSON array, no other text: [{"label":"...","hint":"..."}, ...]`;
  try {
    const text = await call(cfg, prompt, { temperature: 1.1, json: true, timeoutMs: 25000 });
    const m = text.match(/\[[\s\S]*\]/);
    if (!m) throw new Error('AI reply was not a JSON array: ' + text.slice(0, 120));
    const arr = JSON.parse(m[0]);
    return arr
      .map(x => ({ label: String(x.label || '').trim().slice(0, 40), hint: String(x.hint || '').trim().slice(0, 160) }))
      .filter(x => x.label)
      .slice(0, count);
  } catch (e) {
    console.error('AI suggestDirections failed:', e.message);
    return [];
  }
}

// Generates fresh on-brand name candidates when the fixed catalog pool runs out.
// Returns an array of [name, meaning] pairs, or [] on any failure (caller falls back silently,
// but the error is logged server-side so a persistent failure shows up in the Render logs).
async function generateNames(cfg, dirLabel, context, avoid, count) {
  // A random seed phrase pushes the model off a deterministic/cached-feeling answer, since
  // the same business + direction would otherwise tend to produce the same obvious names.
  const seed = Math.random().toString(36).slice(2, 8);
  const prompt = `Business: ${context}\nDirection/style: ${dirLabel}\nInvent ${count} brand-new, short, brandable names that fit this style and this specific business (not a generic placeholder business). Be genuinely varied and creative, not the most obvious or generic option. Do not reuse any of these existing names: ${avoid.join(', ') || 'none'}. (Creativity seed: ${seed}; ignore this number, it is only to vary your output.)\nFor "meaning", give a SHORT phrase (4-8 words) showing the word's fusion or root - not a sentence. Example style: "Lumen + aura: a glow around you" or "Craft + haven, a safe making-place".\nReply with ONLY a JSON array, no other text: [{"name":"...","meaning":"short phrase"}, ...]`;
  // One retry before giving up and falling back to the generic catalog pool - a transient
  // timeout or an occasional malformed reply shouldn't be enough to drop to business-unrelated
  // placeholder names when a second try almost always succeeds.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const text = await call(cfg, prompt, { temperature: 1.3, json: true, timeoutMs: 35000 });
      const m = text.match(/\[[\s\S]*\]/);
      if (!m) throw new Error('AI reply was not a JSON array: ' + text.slice(0, 120));
      const arr = JSON.parse(m[0]);
      return arr
        .map(x => [String(x.name || '').trim().slice(0, 40), String(x.meaning || '').trim().slice(0, 70)])
        .filter(([n]) => n && !avoid.some(a => a.toLowerCase() === n.toLowerCase()))
        .slice(0, count);
    } catch (e) {
      console.error(`AI generateNames failed (attempt ${attempt + 1}/2):`, e.message);
    }
  }
  return [];
}

// Image generation via Gemini's native image model ("Nano Banana"). Imagen is retired; this is
// the current replacement, reached through the same generateContent endpoint and API key.
async function generateImage(cfg, prompt) {
  const key = cfg.keys.gemini;
  if (!key) throw new Error('No AI key saved');
  const model = (cfg.llm && cfg.llm.imageModel) || 'gemini-2.5-flash-image';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { responseModalities: ['TEXT', 'IMAGE'] }
    }),
    signal: AbortSignal.timeout(30000)
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error?.message || `Image AI returned ${r.status}`);
  const parts = j.candidates?.[0]?.content?.parts || [];
  const img = parts.find(p => p.inlineData && p.inlineData.data);
  if (!img) throw new Error('No image returned by the model');
  return `data:${img.inlineData.mimeType || 'image/png'};base64,${img.inlineData.data}`;
}

// Generates name variations (spelling twists or a new word-part swapped in) via the AI, so
// variations reflect the actual name's meaning and the brief, not just a fixed letter-swap
// algorithm. Falls back to [] on any failure; caller uses the deterministic algorithm instead.
async function generateVariations(cfg, name, meaning, kind, context, dirLabel) {
  const ask = kind === 'new'
    ? `Invent 3 variations of the brand name "${name}" (meaning: ${meaning}) by swapping in a different word-part while keeping the start of the name recognizable.`
    : `Invent 4 variations of the brand name "${name}" (meaning: ${meaning}) by tweaking its spelling or sound — similar enough to still feel like the same name.`;
  const seed = Math.random().toString(36).slice(2, 8);
  const styleLine = dirLabel ? `\nStay aligned with this name's own style/direction: ${dirLabel}.` : '';
  const prompt = `Business: ${context || 'not specified'}\n${ask}${styleLine}\n(Creativity seed: ${seed}; ignore this number.)\nFor "meaning", give a SHORT phrase (4-8 words), not a sentence.\nReply with ONLY a JSON array, no other text: [{"name":"...","meaning":"short phrase"}, ...]`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const text = await call(cfg, prompt, { temperature: 1.2, json: true, timeoutMs: 30000 });
      const m = text.match(/\[[\s\S]*\]/);
      if (!m) throw new Error('AI reply was not a JSON array: ' + text.slice(0, 120));
      const arr = JSON.parse(m[0]);
      return arr.map(x => [String(x.name || '').trim().slice(0, 40), String(x.meaning || '').trim().slice(0, 70)]).filter(([n]) => n);
    } catch (e) {
      console.error(`AI generateVariations failed (attempt ${attempt + 1}/2):`, e.message);
    }
  }
  return [];
}

module.exports = { restate, suggest, ping, checkSound, checkOrigin, checkSimilar, checkDomainAI, checkTrademarkAI, checkSocialAI, extractBrandMatches, suggestDirections, generateNames, generateImage, generateVariations };
