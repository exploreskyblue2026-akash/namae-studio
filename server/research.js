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

function gated(cfg, source, keyNames, id, label) {
  if (!cfg.sources[source]) return pending(id, 'Source is off in Admin.', label);
  if (!keyNames.some(k => cfg.keys[k])) return pending(id, 'Not connected. Add a key in Admin.', label);
  return pending(id, 'Key saved. Adapter not built yet.', label);
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

async function run(name, cfg, llm, context) {
  const results = [
    cfg.sources.rdap ? await rdap(name) : pending('domain', 'Source is off in Admin.', 'RDAP'),
    await aiCheck(cfg, llm, 'sound', llm.checkSound, name, context),
    await aiCheck(cfg, llm, 'origin', llm.checkOrigin, name, context),
    await aiCheck(cfg, llm, 'similar', llm.checkSimilar, name, context),
    gated(cfg, 'euipo', ['euipo_client_id', 'euipo_client_secret'], 'trademark', 'EUIPO / USPTO'),
    pending('social', 'No social adapter yet.', 'Platforms')
  ];
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
