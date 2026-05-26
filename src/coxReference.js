'use strict';

// Cox Automotive's canonical make/model code reference.
//
// `https://www.kbb.com/cars-for-sale/bonnet-reference/searchoptions` returns
// the full set of codes the Cox /rest/lsc/listing endpoint accepts:
//   payload.makeCode[]     - {code, name, kbbName, models[]}
//     models[]             - {code, name, ...}
//   payload.bodystyles[]   - {code, name, categories}
//   payload.fuelTypeGroup[]- {code, name, ...}
//   etc.
//
// Why this is necessary: make/model codes don't follow a consistent rule.
// Hyundai is "HYUND" (5 chars), Toyota is "TOYOTA" (full), Ferrari is "FER"
// (3 chars). Models are even more chaotic: "Sonata" → "SONATA", "Ioniq 5" →
// "HYUIONIQ5" (3-char ATC make abbrev + model), "Elantra Coupe" → "HYUELANCPE".
// There's no algorithm — it's just data. We fetch the table once per process.
//
// Same Akamai posture as the listing endpoint: KBB serves it cleanly to Node
// fetch; Autotrader's host blocks. We always go through KBB for the lookup
// and apply the codes to both /rest/lsc/listing hosts (they share the codebase).

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';
const REFERENCE_URL = 'https://www.kbb.com/cars-for-sale/bonnet-reference/searchoptions';

const { fetchWithTimeout } = require('./httpClient.js');

let cachedReference = null;
let inFlight = null;

function normalize(s) {
    return String(s || '').toLowerCase().replace(/[\s\-_]+/g, '');
}

async function fetchReference() {
    const res = await fetchWithTimeout(REFERENCE_URL, {
        headers: {
            'user-agent': UA,
            'accept': 'application/json',
            'accept-language': 'en-US,en;q=0.9',
            'referer': 'https://www.kbb.com/'
        }
    }, { timeoutMs: 8_000, label: 'Cox reference' });
    if (res.status !== 200) throw new Error(`Cox reference HTTP ${res.status}`);
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { throw new Error('Cox reference returned non-JSON'); }
    const payload = data && data.payload;
    if (!payload || !Array.isArray(payload.makeCode)) {
        throw new Error('Cox reference response shape unexpected');
    }
    return buildIndex(payload);
}

function buildIndex(payload) {
    // Build lookup tables keyed by normalized name. Per-make, also index models.
    const makesByName = new Map();        // normalized make name -> { code, name, models }
    const makesByCode = new Map();        // code -> { code, name, models }
    for (const m of payload.makeCode || []) {
        const modelsByName = new Map();
        for (const md of (m.models || [])) {
            modelsByName.set(normalize(md.name), { code: md.code, name: md.name });
        }
        const entry = { code: m.code, name: m.name, models: modelsByName };
        makesByName.set(normalize(m.name), entry);
        if (m.kbbName) makesByName.set(normalize(m.kbbName), entry);
        makesByCode.set(m.code, entry);
    }

    function lookupMake(name) {
        if (!name) return null;
        return makesByName.get(normalize(name)) || null;
    }
    function lookupModel(makeName, modelName) {
        if (!makeName || !modelName) return null;
        const make = lookupMake(makeName);
        if (!make) return null;
        return make.models.get(normalize(modelName)) || null;
    }

    return { lookupMake, lookupModel, makesByCode, _payload: payload };
}

async function getReference({ refresh = false } = {}) {
    if (refresh) cachedReference = null;
    if (cachedReference) return cachedReference;
    if (inFlight) return inFlight;
    inFlight = fetchReference()
        .then(idx => { cachedReference = idx; return idx; })
        .finally(() => { inFlight = null; });
    return inFlight;
}

async function lookupMakeCode(name) {
    try {
        const ref = await module.exports.getReference();
        const m = ref.lookupMake(name);
        return m ? m.code : null;
    } catch (err) {
        console.error(`[coxReference] lookupMakeCode failed: ${err.message}`);
        return null;
    }
}

async function lookupModelCode(makeName, modelName) {
    try {
        const ref = await module.exports.getReference();
        const m = ref.lookupModel(makeName, modelName);
        return m ? m.code : null;
    } catch (err) {
        console.error(`[coxReference] lookupModelCode failed: ${err.message}`);
        return null;
    }
}

function _clearCache() { cachedReference = null; inFlight = null; }
function _setCache(idx) { cachedReference = idx; }

module.exports = {
    getReference,
    lookupMakeCode,
    lookupModelCode,
    buildIndex,
    normalize,
    _clearCache,
    _setCache
};
