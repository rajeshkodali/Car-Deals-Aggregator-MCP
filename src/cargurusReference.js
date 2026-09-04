'use strict';

// CarGurus's CarSelector reference API (make/model name -> internal ID).
//
// CarGurus's search URLs identify make/model via opaque IDs (`m28` for
// Hyundai, `d3120` for Ioniq 5) in the `makeModelTrimPaths` query param —
// there's no algorithmic mapping from name to ID, same situation as Cox's
// make/model codes (see coxReference.js).
//
// Unlike Cox's reference endpoint, CarGurus's `/Cars/api/1.0/carselector/
// listMakes.action` and `listModels.action` sit behind the same DataDome
// TLS/HTTP2-fingerprint block as the rest of cargurus.com — plain Node
// `fetch` gets HTTP 406 even with headers copied verbatim from a real
// captured browser session (verified 2026-09-04). Only a real browser
// engine gets through. So, unlike coxReference.js, callers must supply an
// already-open Puppeteer `page` (reusing the same browser session as the
// actual search scrape, rather than paying for a second browser launch).
//
// Discovered from a live HAR capture:
//   /Users/rkodali/Downloads/www.cargurus.com_Archive [26-09-04 06-15-16].har

let cachedMakes = null; // Map<normalizedName, id> | null
const modelCache = new Map(); // makeId -> Map<normalizedName, id>

function normalize(s) {
    return String(s || '').toLowerCase().replace(/[\s\-_]+/g, '');
}

async function fetchJson(page, url) {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20_000 });
    const text = await page.evaluate(() => document.body.innerText);
    let data;
    try { data = JSON.parse(text); } catch { throw new Error(`CarGurus reference returned non-JSON for ${url}`); }
    return data;
}

async function getMakesIndex(page) {
    if (cachedMakes) return cachedMakes;
    const data = await fetchJson(page, 'https://www.cargurus.com/Cars/api/1.0/carselector/listMakes.action?searchType=USED');
    if (!data || !Array.isArray(data.makes)) throw new Error('CarGurus listMakes response shape unexpected');
    const idx = new Map();
    for (const m of data.makes) idx.set(normalize(m.name), m.id);
    cachedMakes = idx;
    return idx;
}

async function getModelsIndex(page, makeId) {
    if (modelCache.has(makeId)) return modelCache.get(makeId);
    const data = await fetchJson(page, `https://www.cargurus.com/Cars/api/1.0/carselector/listModels.action?searchType=USED&makeId=${encodeURIComponent(makeId)}`);
    if (!data || !Array.isArray(data.models)) throw new Error('CarGurus listModels response shape unexpected');
    const idx = new Map();
    for (const m of data.models) idx.set(normalize(m.name), m.id);
    modelCache.set(makeId, idx);
    return idx;
}

// Resolves make/model names to CarGurus's makeId/modelId using the supplied
// Puppeteer page. Either id may come back null on a miss or lookup failure
// — callers fall back to an unfiltered (or make-only) search rather than
// throwing, since a code-table miss shouldn't fail the whole search.
async function resolveMakeModel(page, make, model) {
    let makeId = null, modelId = null;
    if (make) {
        try {
            const makes = await getMakesIndex(page);
            makeId = makes.get(normalize(make)) || null;
        } catch (err) {
            console.error(`[cargurusReference] listMakes lookup failed: ${err.message}`);
        }
    }
    if (makeId && model) {
        try {
            const models = await getModelsIndex(page, makeId);
            modelId = models.get(normalize(model)) || null;
        } catch (err) {
            console.error(`[cargurusReference] listModels lookup failed: ${err.message}`);
        }
    }
    return { makeId, modelId };
}

function _clearCache() { cachedMakes = null; modelCache.clear(); }

module.exports = { resolveMakeModel, normalize, _clearCache };
