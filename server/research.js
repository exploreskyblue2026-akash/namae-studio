'use strict';
// Research runner. Each parameter has one adapter. Anything not connected returns Pending with a plain reason.
// Live adapters: RDAP domain check, and the three AI checks (sound, origin, similar) when a Gemini key is set.
// EUIPO, USPTO, WhoisXML, and social remain placeholders pending real integrations.

const LABEL = {
  sound: 'Sound & feel', origin: 'Origin & meaning', similar: 'Similar brands',
  domain: 'Domain', trademark: 'Trademark', social: 'Social'
};
const today = () => new Date().toLocaleDateString();
const pending = (id, summary, source) => ({ id, label: LABEL[id], status: 'Pending', summary, source });

async function rdap(name) {
  const domain = name.toLowerCase().replace(/[^a-z0-9]/g, '') + '.com';
  try {
    const r = await fetch(`https://rdap.org/domain/${domain}`, {
      headers: { accept: 'application/rdap+json' }, signal: AbortSignal.timeout(8000)
    });
    if (r.status === 404) return { id: 'domain', label: LABEL.domain, status: 'Clear', summary: `${domain} not found in RDAP. Confirm with a registrar.`, source: 'RDAP' };
    if (r.ok) return { id: 'domain', label: LABEL.domain, status: 'Review', summary: `${domain} is registered.`, source: 'RDAP' };
    return pending('domain', `RDAP returned ${r.status}.`, 'RDAP');
  } catch (e) {
    return pending('domain', 'Lookup failed. Try again.', 'RDAP');
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

// Dynamic combiner: uses the live web source when it's connected, the AI's best-knowledge
// opinion when it isn't, and both together (live status wins, AI note appended) when both ran.
// This replaces the old flat "not built yet" placeholder with some real signal either way.
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
  const liveTrademarkOn = cfg.sources.euipo && (cfg.keys.euipo_client_id || cfg.keys.uspto);
  const liveTrademark = liveTrademarkOn ? pending('trademark', 'Key saved. Live trademark-registry search not built yet.', 'EUIPO / USPTO') : null;
  const [domainResult, sound, origin, similar, trademarkResult, socialResult] = await Promise.all([
    combined('domain', LABEL.domain, 'RDAP', liveDomain, aiReady, () => llm.checkDomainAI(cfg, name, ctx)),
    aiCheck(cfg, llm, 'sound', llm.checkSound, name, context),
    aiCheck(cfg, llm, 'origin', llm.checkOrigin, name, context),
    aiCheck(cfg, llm, 'similar', llm.checkSimilar, name, context),
    combined('trademark', LABEL.trademark, 'EUIPO / USPTO', liveTrademark, aiReady, () => llm.checkTrademarkAI(cfg, name, ctx)),
    combined('social', LABEL.social, 'Platforms', null, aiReady, () => llm.checkSocialAI(cfg, name, ctx))
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
  if (source === 'llm') {
    try { const t = await llm.ping(cfg); return { ok: true, message: 'AI replied: ' + t.slice(0, 80) }; }
    catch (e) { return { ok: false, message: e.message }; }
  }
  const keys = { euipo: ['euipo_client_id', 'euipo_client_secret'], uspto: ['uspto'], whoisxml: ['whoisxml'] }[source];
  if (!keys) return { ok: false, message: 'Unknown source' };
  const have = keys.some(k => cfg.keys[k]);
  return { ok: have, message: have ? 'Key saved. Live test needs the adapter.' : 'No key saved.' };
}

module.exports = { run, test, rdap };
