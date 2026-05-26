// Distance between two US ZIP codes in miles.
//
// Uses Zippopotam.us — a free, public, undocumented JSON service for ZIP centroids.
// Same posture as our other free-endpoint integrations (TaxJar, Zebra): no auth,
// could break or rate-limit, wrapped at the call site so failures fail-open
// (we keep the listing rather than dropping it on geocode failure).

const ZIPPOPOTAM_BASE = 'https://api.zippopotam.us/us/';

const { fetchWithTimeout } = require('./httpClient.js');

const cache = new Map(); // zip -> { lat, lon } | null (negative cache for unresolvable)
let inFlight = new Map(); // zip -> Promise<coords|null>

async function fetchZipCoords(zip) {
    const res = await fetchWithTimeout(`${ZIPPOPOTAM_BASE}${encodeURIComponent(zip)}`, {
        headers: { 'accept': 'application/json' }
    }, { timeoutMs: 8_000, label: `zip ${zip}` });
    if (res.status === 404) return null;
    if (res.status !== 200) throw new Error(`zip lookup HTTP ${res.status}`);
    const data = await res.json();
    const place = Array.isArray(data?.places) ? data.places[0] : null;
    if (!place) return null;
    const lat = parseFloat(place.latitude);
    const lon = parseFloat(place.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    return { lat, lon };
}

async function getZipCoords(zip) {
    const key = String(zip || '').trim();
    if (!/^\d{5}$/.test(key)) return null;
    if (cache.has(key)) return cache.get(key);
    if (inFlight.has(key)) return inFlight.get(key);
    const p = fetchZipCoords(key)
        .then(coords => { cache.set(key, coords); return coords; })
        .catch(err => {
            console.error(`[zipDistance] lookup failed for ${key}: ${err.message}`);
            return null; // negative-cached only on a definitive 404; transient errors retry next call
        })
        .finally(() => { inFlight.delete(key); });
    inFlight.set(key, p);
    return p;
}

function haversineMiles(a, b) {
    const R = 3958.7613; // earth radius in miles
    const toRad = (deg) => deg * Math.PI / 180;
    const dLat = toRad(b.lat - a.lat);
    const dLon = toRad(b.lon - a.lon);
    const lat1 = toRad(a.lat);
    const lat2 = toRad(b.lat);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

// Returns distance in miles, or null if either ZIP can't be resolved.
async function distanceMiles(zipA, zipB) {
    if (zipA === zipB) return 0;
    const [a, b] = await Promise.all([getZipCoords(zipA), getZipCoords(zipB)]);
    if (!a || !b) return null;
    return haversineMiles(a, b);
}

module.exports = {
    getZipCoords,
    distanceMiles,
    haversineMiles,
    _cache: cache, // exposed for tests
    _resetCache: () => { cache.clear(); inFlight.clear(); }
};
