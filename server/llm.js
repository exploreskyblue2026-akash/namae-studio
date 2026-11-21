'use strict';
// AI adapter (Google Gemini REST). Model names change over time: set the model in Admin → Connections,
// or GEMINI_MODEL / GEMINI_IMAGE_MODEL env vars (env vars survive free-tier restarts; Admin settings don't).

// Text generation is provider-pluggable (Gemini or OpenRouter, picked in Admin) so the person can
// switch models/providers to compare output quality or work around one provider having an off
// day, without any code change. Image generation always uses the Gemini key directly (see
// generateImage below) since consistent image output across arbitrary OpenRouter models isn't
// something that can be relied on the same way.
async function call(cfg, prompt, opts = {}) {
  const provider = (cfg.llm && cfg.llm.provider) || 'gemini';
  if (provider === 'openrouter') return callOpenRouter(cfg, prompt, opts);
  return callGemini(cfg, prompt, opts);
}

// Pulls a JSON array of objects out of a model's raw text reply. Gemini reliably returns the
// requested "[{...}, {...}]" shape, but other providers/models (seen with GPT-5 via OpenRouter)
// sometimes "helpfully" collapse a single-item reply down to a bare "{...}" object instead of
// wrapping it in an array, or occasionally emit several "{...}" objects back to back with no
// enclosing brackets at all. Any of those are still perfectly good data - only our brackets-only
// regex was too strict - so this tries, in order: a real array, a single object (wrapped into a
// 1-item array), then multiple back-to-back top-level objects. Throws only if none of those parse.
function extractJsonArray(text) {
  const arrMatch = text.match(/\[[\s\S]*\]/);
  if (arrMatch) {
    try { return JSON.parse(arrMatch[0]); } catch (e) { /* fall through to other shapes */ }
  }
  // Collect every top-level {...} object in the text (handles one bare object, or several
  // concatenated ones with nothing joining them).
  const objs = [];
  let depth = 0, start = -1;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '{') { if (depth === 0) start = i; depth++; }
    else if (c === '}') { depth--; if (depth === 0 && start !== -1) { objs.push(text.slice(start, i + 1)); start = -1; } }
  }
  if (objs.length) {
    const parsed = [];
    for (const s of objs) { try { parsed.push(JSON.parse(s)); } catch (e) { /* skip malformed fragment */ } }
    if (parsed.length) return parsed;
  }
  throw new Error('AI reply was not valid JSON: ' + text.slice(0, 120));
}

async function callGemini(cfg, prompt, opts) {
  const key = cfg.keys.gemini;
  if (!key) throw new Error('No Gemini key saved');
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

async function callOpenRouter(cfg, prompt, opts) {
  const key = cfg.keys.openrouter;
  if (!key) throw new Error('No OpenRouter key saved');
  const model = (cfg.llm && cfg.llm.openrouterModel) || 'openai/gpt-4o-mini';
  const body = {
    model,
    messages: [{ role: 'user', content: prompt }],
    temperature: opts.temperature ?? 1.0
  };
  // OpenRouter proxies many different underlying models; not all of them honor
  // response_format, so JSON mode is a best-effort request, not a guarantee the way it is on
  // Gemini - callers' own [...]/{...} extraction regex is still the real safety net either way.
  if (opts.json) body.response_format = { type: 'json_object' };
  const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${key}`,
      'HTTP-Referer': 'https://namae-studio.onrender.com',
      'X-Title': 'Namae Studio'
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(opts.timeoutMs ?? 25000)
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error?.message || `AI (OpenRouter) returned ${r.status}`);
  return (j.choices?.[0]?.message?.content || '').trim();
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
    const arr = extractJsonArray(text);
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
// Naming techniques real branding studios actually rotate through. Previously every call asked
// for the same generic "brandable name" with no structural guidance, which is exactly how you
// get bland, samey output (and the AI's own default bias toward safe compound-word coinages).
// Assigning one technique per call (see generateMoreFor's TECHNIQUES cycling) forces genuine
// structural variety across a batch - some short and punchy, some blended, some borrowed - rather
// than leaving it to chance that one long generic prompt happens to produce a mix.
const TECHNIQUES = {
  punchy: 'A SHORT, PUNCHY invented word - 4 to 7 letters, one or two syllables, easy to say out loud and spell from hearing it once (think: Nike, Zoom, Oro, Vibe). No compound of two full words.',
  blend: 'A BLEND/PORTMANTEAU of two words relevant to the business (fuse the start of one word with the end of another, or overlap a shared sound) - not just the two words stuck together unchanged.',
  real_word: 'A REAL, EXISTING word (English or any other language) used in an unexpected, evocative way for this specific business - not a generic/obvious synonym for what the business does.',
  clipped: 'A CLIPPED/TRUNCATED word - take a longer word connected to the business and cut it down to something crisp and short, the way "Google" came from "googol" or "Lyft" clips "lift".',
  foreign: 'A word or root borrowed from a language other than English that fits the meaning or feeling of the business, adapted to be easy for an English speaker to pronounce and spell.',
  compound: 'A tight compound of two short, relevant words mashed into one - but genuinely tight and brandable, not just two dictionary words taped together.'
};
async function generateNames(cfg, dirLabel, context, avoid, count, technique) {
  // A random seed phrase pushes the model off a deterministic/cached-feeling answer, since
  // the same business + direction would otherwise tend to produce the same obvious names.
  const seed = Math.random().toString(36).slice(2, 8);
  const techLine = technique && TECHNIQUES[technique] ? `\nNaming technique to use for every one of these ${count} names: ${TECHNIQUES[technique]}` : '';
  const prompt = `Business: ${context}\nDirection/style: ${dirLabel}\nInvent ${count} brand-new, brandable names that fit this style and this specific business (not a generic placeholder business).${techLine}\nQuality bar: imagine a real branding studio pitching these to the founder - reject anything that sounds like a random startup-name-generator output (avoid piling on suffixes like "-ify", "-ly", "-io", "-eo", "-ster" just to make a word sound techy). Each name should be easy to say out loud, easy to spell after hearing it once, and should not need the meaning explained to feel appealing.\nBe genuinely varied and creative, not the most obvious or generic option. Do not reuse any of these existing names: ${avoid.join(', ') || 'none'}. (Creativity seed: ${seed}; ignore this number, it is only to vary your output.)\nFor "meaning", give a SHORT phrase (4-8 words) showing the word's fusion or root - not a sentence. Example style: "Lumen + aura: a glow around you" or "Craft + haven, a safe making-place".\nReply with ONLY a JSON array, no other text: [{"name":"...","meaning":"short phrase"}, ...]`;
  // One retry before giving up and falling back to the generic catalog pool - a transient
  // timeout or an occasional malformed reply shouldn't be enough to drop to business-unrelated
  // placeholder names when a second try almost always succeeds.
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const text = await call(cfg, prompt, { temperature: 1.3, json: true, timeoutMs: 35000 });
      const arr = extractJsonArray(text);
      return arr
        .map(x => [String(x.name || '').trim().slice(0, 40), String(x.meaning || '').trim().slice(0, 70)])
        .filter(([n]) => n && !avoid.some(a => a.toLowerCase() === n.toLowerCase()))
        .slice(0, count);
    } catch (e) {
      lastError = e.message;
      console.error(`AI generateNames failed (attempt ${attempt + 1}/2):`, e.message);
    }
  }
  // A plain [] loses WHY it failed, which is how "could not generate more" ends up looking like
  // a mystery instead of (for example) a typo'd model name in Admin. Arrays are objects, so
  // stashing the real error message here costs nothing and lets the caller surface it verbatim
  // instead of guessing "probably rate limited" for every kind of failure.
  const empty = [];
  empty.lastError = lastError;
  return empty;
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

// Reads an uploaded image (a photo of the founder, a handwritten note, a bio page, a screenshot
// of an article - whatever the Admin → Founder upload is) and turns it into plain text describing
// what's relevant to naming: who the founder is, their story, personality, anything brandable.
// Always uses the Gemini key directly via generateContent's multimodal input, same as
// generateImage, regardless of which provider is picked for text generation - a vision-capable
// model name isn't guaranteed to exist/behave consistently across arbitrary OpenRouter models.
async function describeImage(cfg, dataUrl) {
  const key = cfg.keys.gemini;
  if (!key) throw new Error('No Gemini key saved');
  const m = dataUrl.match(/^data:([^;]+);base64,([\s\S]+)$/);
  if (!m) throw new Error('Invalid image data');
  const [, mimeType, data] = m;
  const model = 'gemini-3.5-flash';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`;
  const prompt = 'This image was uploaded to help write brand names for a business, in the style of its founder. Describe, in plain prose (3-6 sentences), anything in this image relevant to that: the founder\'s name if visible or stated, their story, personality, background, or any text/branding shown. If the image has no such content, say so plainly.';
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }, { inlineData: { mimeType, data } }] }] }),
    signal: AbortSignal.timeout(30000)
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error?.message || `Image AI returned ${r.status}`);
  const text = (j.candidates?.[0]?.content?.parts || []).map(p => p.text).filter(Boolean).join(' ').trim();
  if (!text) throw new Error('No description returned by the model');
  return text.slice(0, 1000);
}

// Generates name variations (spelling twists or a new word-part swapped in) via the AI, so
// variations reflect the actual name's meaning and the brief, not just a fixed letter-swap
// algorithm. Falls back to [] on any failure; caller uses the deterministic algorithm instead.
async function generateVariations(cfg, name, meaning, kind, context, dirLabel, count) {
  const n = count || (kind === 'new' ? 3 : 4);
  const ask = kind === 'new'
    ? `Invent ${n} variation${n > 1 ? 's' : ''} of the brand name "${name}" (meaning: ${meaning}) by swapping in a different word-part while keeping the start of the name recognizable. Each one should feel like its own distinct idea, not a minor spelling tweak of another.`
    : `Invent ${n} variation${n > 1 ? 's' : ''} of the brand name "${name}" (meaning: ${meaning}) by tweaking its spelling or sound — similar enough to still feel like the same name, but each one meaningfully different from the others, not just different suffixes on the same root.`;
  const seed = Math.random().toString(36).slice(2, 8);
  const styleLine = dirLabel ? `\nStay aligned with this name's own style/direction: ${dirLabel}.` : '';
  const prompt = `Business: ${context || 'not specified'}\n${ask}${styleLine}\nQuality bar: each one should stay short, easy to say and spell, and genuinely brandable - not a generic startup-name-generator-style tweak (avoid defaulting to suffixes like "-ify", "-ly", "-io", "-eo" just to make it sound different).\n(Creativity seed: ${seed}; ignore this number.)\nFor "meaning", give a SHORT phrase (4-8 words), not a sentence.\nReply with ONLY a JSON array, no other text: [{"name":"...","meaning":"short phrase"}, ...]`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const text = await call(cfg, prompt, { temperature: 1.2, json: true, timeoutMs: 30000 });
      const arr = extractJsonArray(text);
      return arr.map(x => [String(x.name || '').trim().slice(0, 40), String(x.meaning || '').trim().slice(0, 70)]).filter(([n]) => n);
    } catch (e) {
      console.error(`AI generateVariations failed (attempt ${attempt + 1}/2):`, e.message);
    }
  }
  return [];
}

module.exports = { restate, suggest, ping, checkSound, checkOrigin, checkSimilar, checkDomainAI, checkTrademarkAI, checkSocialAI, extractBrandMatches, suggestDirections, generateNames, generateImage, describeImage, generateVariations, TECHNIQUE_KEYS: Object.keys(TECHNIQUES) };
