'use strict';
// Research runner. Each check returns { id, label, status, items, note?, source } - "items" is a
// short bullet list the UI renders directly (no paragraph parsing needed), "note" is an optional
// one-line caveat shown smaller/muted below the list. Where a real free live source exists it
// answers on its own; the AI is only asked when that live source is off or failed, so the card
// stays short and isn't padded with a redundant "AI note" once a live source already answered.
//
// What's actually live, and why, as of this build:
// - Domain: RDAP (ICANN's standard, built for automated lookups) across several TLDs. No key.
// - Trademark: the US Patent and Trademark Office's own public search backend
//   (tmsearch.uspto.gov) is called directly with the same query shape their own site uses -
//   captured by inspecting their site's own network traffic. No key, no login, official USPTO
//   data. EUIPO (EU trademarks) needs the user's own free dev.euipo.europa.eu credentials plus
//   their product's exact base URL before it can be wired in the same way - not guessed here.
// - Social: no platform offers a real "is this handle free" API. This is a best-effort HTTP
//   probe of each platform's public profile URL, labeled honestly as best-effort, since
//   platforms can rate-limit or block automated checks.
// - Similar brands: a live web search via Tavily (free tier, needs TAVILY_API_KEY), with the AI
//   reading the real results to name which match is real and its category/country. Falls back
//   to AI-only (knowledge, not a live search) if no Tavily key is set.
// - Sound & feel / Origin & meaning: inherently a linguistic judgment call, not a registry fact,
//   so these stay AI-only, returned as short bullets.

const LABEL = {
  sound: 'Sound & feel', origin: 'Origin & meaning', similar: 'Similar brands',
  domain: 'Domain', trademark: 'Trademark', social: 'Social'
};
const today = () => new Date().toLocaleDateString();
const pending = (id, item, source) => ({ id, label: LABEL[id], status: 'Pending', items: [].concat(item), source });
const clean = (name) => (name || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// ---------- Domain: RDAP across a few common TLDs ----------
const DOMAIN_TLDS = ['com', 'io', 'ai', 'co', 'net'];
async function rdapOne(domain) {
  try {
    const r = await fetch(`https://rdap.org/domain/${domain}`, {
      headers: {
        accept: 'application/rdap+json',
        // Some authoritative RDAP servers (behind rdap.org's redirect) block requests whose
        // user-agent doesn't look like a browser/known client - without this header all TLDs
        // can fail at once even though rdap.org itself is up.
        'user-agent': 'Mozilla/5.0 (compatible; NamaeStudioBot/1.0; +https://namae-studio.onrender.com)'
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(12000)
    });
    if (r.status === 404) return { domain, free: true };
    if (r.ok) return { domain, free: false };
    return { domain, free: null, code: r.status };
  } catch (e) {
    console.error(`RDAP lookup failed for ${domain}:`, e.message);
    return { domain, free: null, err: true, errMsg: e.message };
  }
}
async function rdap(name) {
  const base = clean(name);
  if (!base) return pending('domain', 'No name to check.', 'RDAP');
  const checks = await Promise.all(DOMAIN_TLDS.map(tld => rdapOne(`${base}.${tld}`)));
  const resolved = checks.filter(c => c.free !== null);
  if (!resolved.length) {
    const reason = checks.find(c => c.errMsg)?.errMsg || checks.find(c => c.code)?.code;
    return pending('domain', `Couldn't reach the domain registry just now${reason ? ' (' + reason + ')' : ''}. Try again in a moment.`, 'RDAP');
  }
  const primary = resolved.find(c => c.domain.endsWith('.com')) || resolved[0];
  const items = resolved.map(c => `${c.domain} — ${c.free ? '✔ Available' : '✘ Taken'}`);
  return { id: 'domain', label: LABEL.domain, status: primary.free ? 'Clear' : 'Review', items, source: 'RDAP' };
}

// ---------- Trademark: USPTO's own public search backend, called directly ----------
// Endpoint and query shape captured live from tmsearch.uspto.gov's own network traffic - this is
// exactly what the official site sends when a person searches a wordmark there. No API key.
const USPTO_ENDPOINT = 'https://tmsearch.uspto.gov/prod-stage-v1-0-0/tmsearch';
async function uspto(name) {
  const q = (name || '').trim();
  if (!q) return pending('trademark', 'No name to check.', 'USPTO');
  const body = {
    query: { bool: { must: [{ bool: { should: [
      { match_phrase: { WM: { query: q, boost: 5 } } },
      { match: { WM: { query: q, boost: 2 } } },
      { match_phrase: { PM: { query: q, boost: 2 } } }
    ] } }] } },
    size: 20, from: 0, track_total_hits: true,
    _source: ['alive', 'wordmark', 'registrationId', 'registrationDate', 'filedDate', 'ownerName', 'markType', 'goodsAndServices']
  };
  try {
    const r = await fetch(USPTO_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://tmsearch.uspto.gov', referer: 'https://tmsearch.uspto.gov/' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000)
    });
    if (!r.ok) return pending('trademark', `USPTO search returned ${r.status}.`, 'USPTO');
    const data = await r.json();
    const hits = data?.hits?.hits || [];
    const want = clean(q);
    const exact = hits.filter(h => clean(h._source?.wordmark) === want);
    const liveExact = exact.filter(h => h._source?.alive);
    if (liveExact.length) {
      const ex = liveExact[0]._source;
      return {
        id: 'trademark', label: LABEL.trademark, status: 'Review',
        items: [`${ex.wordmark} — United States${ex.ownerName ? ' (' + ex.ownerName + ')' : ''}`],
        note: `Active USPTO registration${ex.registrationId ? ' #' + ex.registrationId : ''}.`,
        source: 'USPTO'
      };
    }
    if (exact.length) {
      return {
        id: 'trademark', label: LABEL.trademark, status: 'Clear',
        items: [`No active US trademark for "${q}" (${exact.length} inactive filing${exact.length > 1 ? 's' : ''} on record).`],
        source: 'USPTO'
      };
    }
    return {
      id: 'trademark', label: LABEL.trademark, status: 'Clear',
      items: [`No US trademark on file for "${q}".`],
      source: 'USPTO'
    };
  } catch (e) {
    return pending('trademark', 'USPTO search failed: ' + e.message, 'USPTO');
  }
}

// ---------- Social: best-effort profile-URL probe (no official API exists anywhere for this) ----------
const SOCIAL_PLATFORMS = [
  { label: 'Instagram', url: h => `https://www.instagram.com/${h}/` },
  { label: 'X', url: h => `https://x.com/${h}` },
  { label: 'TikTok', url: h => `https://www.tiktok.com/@${h}` },
  { label: 'YouTube', url: h => `https://www.youtube.com/@${h}` }
];
async function socialProbe(name) {
  const handle = clean(name);
  if (!handle) return pending('social', 'No name to check.', 'Platforms');
  const checks = await Promise.all(SOCIAL_PLATFORMS.map(async (p) => {
    try {
      const r = await fetch(p.url(handle), {
        method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(8000),
        headers: { 'user-agent': 'Mozilla/5.0 (compatible; NamaeStudioBot/1.0; brand-name availability check)' }
      });
      return { label: p.label, taken: r.status === 200, code: r.status };
    } catch (e) { return { label: p.label, taken: null, err: true }; }
  }));
  const resolved = checks.filter(c => c.taken !== null);
  if (!resolved.length) return pending('social', 'Platform checks failed. Try again.', 'Platforms');
  const taken = resolved.filter(c => c.taken);
  const items = resolved.map(c => `${c.label} — ${c.taken ? '✘ Taken' : '✔ Available'}`);
  return {
    id: 'social', label: LABEL.social, status: taken.length ? 'Review' : 'Clear', items,
    note: 'Best-effort - platforms can block automated checks; confirm manually.',
    source: 'Platforms'
  };
}

// ---------- Similar brands: live web search via Tavily, read by the AI to name actual brands ----------
// A raw search hit ("found a page mentioning this word") isn't useful on its own - the person
// needs to know WHICH existing brand/company it is, WHAT category, and WHERE, so they can judge
// whether it actually competes with them. When the AI is available, it reads the real search
// results and extracts that; when it isn't, we fall back to listing the raw page titles.
async function tavilySimilar(cfg, llm, name) {
  const key = cfg.keys.tavily;
  if (!key) return null;
  try {
    const r = await fetch('https://api.tavily.com/search', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ api_key: key, query: `"${name}" brand OR company OR product OR app`, search_depth: 'basic', max_results: 5, include_raw_content: false }),
      signal: AbortSignal.timeout(10000)
    });
    if (!r.ok) return pending('similar', `Web search returned ${r.status}.`, 'Web search');
    const data = await r.json();
    const hits = (data.results || []).filter(x => x.title && x.url);
    if (!hits.length) {
      return { id: 'similar', label: LABEL.similar, status: 'Clear', items: [`No existing brand, product, or company found online matching "${name}".`], source: 'Web search' };
    }
    if (cfg.sources.llm && cfg.keys.gemini) {
      try {
        const { matches } = await llm.extractBrandMatches(cfg, name, hits);
        if (matches.length) {
          const items = matches.map(m => `${m.name} — ${m.category || 'unknown category'}${m.country ? ' — ' + m.country : ''}`);
          return { id: 'similar', label: LABEL.similar, status: 'Review', items, source: 'Web search + AI' };
        }
        return { id: 'similar', label: LABEL.similar, status: 'Clear', items: [`No real brand/company match found for "${name}" in the search results.`], source: 'Web search + AI' };
      } catch (e) { /* fall through to the raw listing below */ }
    }
    const items = hits.slice(0, 3).map(h => `${h.title} — ${h.url}`);
    return {
      id: 'similar', label: LABEL.similar, status: 'Review', items,
      note: 'Review manually to confirm if any is a real competing brand.',
      source: 'Web search'
    };
  } catch (e) {
    return pending('similar', 'Web search failed: ' + e.message, 'Web search');
  }
}

// ---------- AI-only checks (sound/origin always; domain/trademark/social/similar as fallback) ----------
async function aiCheck(cfg, llm, id, fn, name, context) {
  if (!cfg.sources.llm) return pending(id, 'AI check is off in Admin.', 'AI');
  if (!cfg.keys.gemini) return pending(id, 'Not connected. Add the AI key in Admin.', 'AI');
  try {
    const { status, bullets } = await fn(cfg, name, context || 'No business context given.');
    return { id, label: LABEL[id], status, items: bullets, source: 'AI' };
  } catch (e) {
    return pending(id, 'AI check failed: ' + e.message, 'AI');
  }
}
// Wraps the plain {status, summary} knowledge-based checks (checkDomainAI/checkTrademarkAI/
// checkSocialAI/checkSimilar) into the same items-list shape, clearly labeled as knowledge, not
// a live check, for when the live source itself is off or failed.
async function aiFallbackItems(id, checkFn, cfg, llm, name, ctx) {
  const { status, summary } = await checkFn(cfg, name, ctx);
  return { id, label: LABEL[id], status, items: [summary + ' (AI knowledge, not a live check.)'], source: 'AI' };
}
// Uses the live result as-is when it answered definitively (no redundant AI note padding it
// out); only asks the AI when the live source is off/unavailable or failed outright.
async function liveOrFallback(id, live, aiReady, aiFn) {
  if (live && live.status !== 'Pending') return live;
  if (aiReady) {
    try { return await aiFn(); } catch (e) { /* fall through to the live Pending explanation */ }
  }
  if (live) return live;
  return pending(id, aiReady ? 'Live source failed and the AI check also failed. Try again.' : 'Live source is off, and AI is not connected.', LABEL[id]);
}

async function run(name, cfg, llm, context) {
  const ctx = context || 'No business context given.';
  const aiReady = !!(cfg.sources.llm && cfg.keys.gemini);
  const [liveDomain, liveTrademark, liveSocial, liveSimilar, sound, origin] = await Promise.all([
    cfg.sources.rdap ? rdap(name) : null,
    uspto(name),
    socialProbe(name),
    tavilySimilar(cfg, llm, name),
    aiCheck(cfg, llm, 'sound', llm.checkSound, name, context),
    aiCheck(cfg, llm, 'origin', llm.checkOrigin, name, context)
  ]);
  const [domainResult, trademarkResult, socialResult, similarResult] = await Promise.all([
    liveOrFallback('domain', liveDomain, aiReady, () => aiFallbackItems('domain', llm.checkDomainAI, cfg, llm, name, ctx)),
    liveOrFallback('trademark', liveTrademark, aiReady, () => aiFallbackItems('trademark', llm.checkTrademarkAI, cfg, llm, name, ctx)),
    liveOrFallback('social', liveSocial, aiReady, () => aiFallbackItems('social', llm.checkSocialAI, cfg, llm, name, ctx)),
    liveOrFallback('similar', liveSimilar, aiReady, () => aiFallbackItems('similar', llm.checkSimilar, cfg, llm, name, ctx))
  ]);
  const results = [domainResult, sound, origin, similarResult, trademarkResult, socialResult];
  const verdict = results.some(r => r.status === 'Blocked') ? 'Stop'
    : results.every(r => r.status === 'Clear') ? 'Go' : 'Check';
  return { date: today(), verdict, results };
}

async function test(source, cfg, llm) {
  if (source === 'rdap') {
    const r = await rdap('namaestudiotest');
    return { ok: r.status !== 'Pending', message: r.status !== 'Pending' ? 'RDAP reachable' : r.items[0] };
  }
  if (source === 'uspto') {
    const r = await uspto('namaestudiotest');
    return { ok: r.status !== 'Pending', message: r.status !== 'Pending' ? 'USPTO search reachable: ' + r.items[0] : r.items[0] };
  }
  if (source === 'social') {
    const r = await socialProbe('namaestudiotest');
    return { ok: r.status !== 'Pending', message: r.items.join('; ') };
  }
  if (source === 'tavily') {
    const have = !!cfg.keys.tavily;
    if (!have) return { ok: false, message: 'No key saved.' };
    const r = await tavilySimilar(cfg, llm, 'namaestudiotest brand');
    return { ok: !!r && r.status !== 'Pending', message: r ? r.items.join('; ') : 'No response.' };
  }
  if (source === 'llm') {
    try { const t = await llm.ping(cfg); return { ok: true, message: 'AI replied: ' + t.slice(0, 80) }; }
    catch (e) { return { ok: false, message: e.message }; }
  }
  const keys = { euipo: ['euipo_client_id', 'euipo_client_secret'], whoisxml: ['whoisxml'] }[source];
  if (!keys) return { ok: false, message: 'Unknown source' };
  const have = keys.some(k => cfg.keys[k]);
  return { ok: have, message: have ? 'Key saved. Live EUIPO search needs the product base URL from your dev.euipo.europa.eu dashboard before it can be wired in.' : 'No key saved.' };
}

module.exports = { run, test, rdap, uspto, socialProbe };
