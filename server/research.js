'use strict';
// Research runner. Each parameter has one adapter, and where a real free live source exists it
// is combined with the AI's opinion via combined() below, so the AI note is always clearly
// labeled as a note on top of live data rather than standing in for it.
//
// What's actually live, and why, as of this build:
// - Domain: RDAP (ICANN's standard, built for automated lookups) across several TLDs. No key.
// - Trademark: the US Patent and Trademark Office's own public search backend
//   (tmsearch.uspto.gov) is called directly with the same query shape their own site uses -
//   captured by inspecting their site's own network traffic. No key, no login, official USPTO
//   data. EUIPO (EU trademarks) needs the user's own free dev.euipo.europa.eu credentials plus
//   their product's exact base URL before it can be wired in the same way - not guessed here.
// - Social: no platform offers a real "is this handle free" API. This is a best-effort HTTP
//   probe of each platform's public profile URL, labeled honestly as best-effort in the result
//   text, since platforms can rate-limit or block automated checks.
// - Similar brands: a live web search via Tavily (free tier, needs TAVILY_API_KEY) layered under
//   the AI's opinion, so an actual existing brand turns up even if the AI's training data missed
//   or misremembered it. Falls back to AI-only if no Tavily key is set.
// - Sound & feel / Origin & meaning: inherently a linguistic judgment call, not a registry fact,
//   so these stay AI-only.

const LABEL = {
  sound: 'Sound & feel', origin: 'Origin & meaning', similar: 'Similar brands',
  domain: 'Domain', trademark: 'Trademark', social: 'Social'
};
const today = () => new Date().toLocaleDateString();
const pending = (id, summary, source) => ({ id, label: LABEL[id], status: 'Pending', summary, source });
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
  const taken = resolved.filter(c => !c.free).map(c => c.domain);
  const available = resolved.filter(c => c.free).map(c => c.domain);
  const parts = [];
  if (taken.length) parts.push(`${taken.join(', ')} ${taken.length > 1 ? 'are' : 'is'} already taken`);
  if (available.length) parts.push(`${available.join(', ')} ${available.length > 1 ? 'are' : 'is'} still available`);
  return {
    id: 'domain', label: LABEL.domain, status: primary.free ? 'Clear' : 'Review',
    summary: `${parts.join('. ')}. Confirm with a registrar before buying.`, source: 'RDAP'
  };
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
        summary: `USPTO: an active mark "${ex.wordmark}" already exists (owner: ${ex.ownerName || 'unknown'}, reg. ${ex.registrationId || 'pending'}).`,
        source: 'USPTO'
      };
    }
    if (exact.length) {
      return {
        id: 'trademark', label: LABEL.trademark, status: 'Clear',
        summary: `USPTO: ${exact.length} exact-match filing(s) found for "${q}", but none currently active.`,
        source: 'USPTO'
      };
    }
    return {
      id: 'trademark', label: LABEL.trademark, status: 'Clear',
      summary: `USPTO: no exact-match wordmark on file for "${q}".`,
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
  const summary = resolved.map(c => `${c.label} ${c.taken ? 'taken' : 'free'}`).join(', ');
  return {
    id: 'social', label: LABEL.social, status: taken.length ? 'Review' : 'Clear',
    summary: `${summary} (best-effort: platforms can block automated checks - confirm manually before relying on this).`,
    source: 'Platforms'
  };
}

// ---------- Similar brands: live web search via Tavily, read by the AI to name actual brands ----------
// A raw search hit ("found a page mentioning this word") isn't useful on its own - the person
// needs to know WHICH existing brand/company it is and WHAT category it's in, so they can judge
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
      return { id: 'similar', label: LABEL.similar, status: 'Clear', summary: `No existing brand, product, or company found online matching "${name}".`, source: 'Web search' };
    }
    if (cfg.sources.llm && cfg.keys.gemini) {
      try {
        const { matches } = await llm.extractBrandMatches(cfg, name, hits);
        if (matches.length) {
          const list = matches.map(m => `${m.name}${m.category ? ` (${m.category})` : ''}`).join(', ');
          return {
            id: 'similar', label: LABEL.similar, status: 'Review',
            summary: `Already in use by: ${list}. Check these before committing to "${name}".`,
            source: 'Web search + AI'
          };
        }
        return {
          id: 'similar', label: LABEL.similar, status: 'Clear',
          summary: `Web search found pages mentioning "${name}", but none describe a real existing brand, company, or product by this name.`,
          source: 'Web search + AI'
        };
      } catch (e) { /* fall through to the raw listing below */ }
    }
    const top = hits.slice(0, 3).map(h => `${h.title} (${h.url})`).join('; ');
    return {
      id: 'similar', label: LABEL.similar, status: 'Review',
      summary: `Web results mention "${name}": ${top}. Review these manually to see if any is a real competing brand.`,
      source: 'Web search'
    };
  } catch (e) {
    return pending('similar', 'Web search failed: ' + e.message, 'Web search');
  }
}

async function aiCheck(cfg, llm, id, fn, name, context) {
  if (!cfg.sources.llm) return pending(id, 'AI check is off in Admin.', 'AI');
  if (!cfg.keys.gemini) return pending(id, 'Not connected. Add the AI key in Admin.', 'AI');
  try {
    const { status, summary } = await fn(cfg, name, context || 'No business context given.');
    return { id, label: LABEL[id], status, summary, source: 'AI' };
  } catch (e) {
    return pending(id, 'AI check failed: ' + e.message, 'AI');
  }
}

// Dynamic combiner: uses the live source when it's connected, the AI's best-knowledge opinion
// when it isn't, and both together (live status wins, AI note appended) when both ran.
async function combined(id, label, liveLabel, live, aiReady, aiCheckFn) {
  const liveOk = live && live.status !== 'Pending';
  const ai = aiReady ? await safeAI(aiCheckFn) : null;
  if (liveOk && ai) return { id, label, status: live.status, summary: `${live.summary} AI note: ${ai.summary}`, source: `${liveLabel} + AI` };
  if (liveOk) return { id, label, status: live.status, summary: live.summary, source: liveLabel };
  if (live && ai) return { id, label, status: ai.status, summary: `${live.summary} AI note: ${ai.summary} (knowledge-based, not a live check.)`, source: `${liveLabel} + AI` };
  if (ai) return { id, label, status: ai.status, summary: ai.summary + ' (AI knowledge, not a live check.)', source: 'AI' };
  if (live) return { ...live, id, label };
  return pending(id, aiReady ? 'Live source is off, and the AI check failed. Try again.' : 'Live source is off, and AI is not connected.', liveLabel);
}
async function safeAI(fn) {
  try { return await fn(); } catch (e) { return null; }
}

async function run(name, cfg, llm, context) {
  const ctx = context || 'No business context given.';
  const aiReady = !!(cfg.sources.llm && cfg.keys.gemini);
  const liveDomain = cfg.sources.rdap ? await rdap(name) : null;
  const liveTrademark = await uspto(name);
  const liveSocial = await socialProbe(name);
  const liveSimilar = await tavilySimilar(cfg, llm, name);
  const [domainResult, sound, origin, similar, trademarkResult, socialResult] = await Promise.all([
    combined('domain', LABEL.domain, 'RDAP', liveDomain, aiReady, () => llm.checkDomainAI(cfg, name, ctx)),
    aiCheck(cfg, llm, 'sound', llm.checkSound, name, context),
    aiCheck(cfg, llm, 'origin', llm.checkOrigin, name, context),
    combined('similar', LABEL.similar, 'Web search', liveSimilar, aiReady, () => llm.checkSimilar(cfg, name, ctx)),
    combined('trademark', LABEL.trademark, 'USPTO', liveTrademark, aiReady, () => llm.checkTrademarkAI(cfg, name, ctx)),
    combined('social', LABEL.social, 'Platforms', liveSocial, aiReady, () => llm.checkSocialAI(cfg, name, ctx))
  ]);
  const results = [domainResult, sound, origin, similar, trademarkResult, socialResult];
  const verdict = results.some(r => r.status === 'Blocked') ? 'Stop'
    : results.every(r => r.status === 'Clear') ? 'Go' : 'Check';
  return {
    date: today(), verdict, results,
    pros: results.filter(r => r.status === 'Clear').map(r => r.label),
    cons: results.filter(r => r.status !== 'Clear').map(r => r.label)
  };
}

async function test(source, cfg, llm) {
  if (source === 'rdap') {
    const r = await rdap('namaestudiotest');
    return { ok: r.status !== 'Pending', message: r.status !== 'Pending' ? 'RDAP reachable' : r.summary };
  }
  if (source === 'uspto') {
    const r = await uspto('namaestudiotest');
    return { ok: r.status !== 'Pending', message: r.status !== 'Pending' ? 'USPTO search reachable: ' + r.summary : r.summary };
  }
  if (source === 'social') {
    const r = await socialProbe('namaestudiotest');
    return { ok: r.status !== 'Pending', message: r.summary };
  }
  if (source === 'tavily') {
    const have = !!cfg.keys.tavily;
    if (!have) return { ok: false, message: 'No key saved.' };
    const r = await tavilySimilar(cfg, llm, 'namaestudiotest brand');
    return { ok: !!r && r.status !== 'Pending', message: r ? r.summary : 'No response.' };
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
