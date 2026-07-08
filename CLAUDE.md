# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `npm run test:unit` — full offline `node:test` suite (~230ms, 125 tests). Use this for CI and local iteration.
- `node --test test/apiClient.test.js` — run a single test file. Append `--test-name-pattern="<regex>"` to scope to one test.
- `npm start` — boot the MCP server over stdio (entry: `src/server.js`).
- `npm test` — **live** Puppeteer smoke against Cars.com. Hits the network, slow, do not run in CI.

## Presenting Results

**Always show full, plain URLs in the table — never hidden behind link text.**

1. Every listing row must have the raw `https://...` URL visible in the table cell (not `[Link](url)`, not a numbered list below the table).
2. One URL per car — if the same listing appears on multiple sources, pick one: Cars.com > Autotrader > KBB. Never duplicate rows or show two links for the same car.
3. Sanity check: if a user reading in a plain monospace terminal would only see the word "Link", you've done it wrong.

**Default search behavior:** Always include all 5 sources (`cars.com`, `autotrader`, `kbb`, `carmax`, `carvana`) and set `maxResults` ≥ 50 unless the user says otherwise.

## Architecture (v3)

Two-tier strategy per source:

1. **`src/apiClient.js` — direct `fetch` to internal JSON/GraphQL APIs.** Fast, structured, no browser. Tried first.
2. **`src/scraper.js` — Puppeteer + stealth.** Fallback when (1) errors or returns 0 listings.

`src/server.js` orchestrates: `searchCarscom` / `searchAutotrader` / `searchKBB` / `searchCarmax` / `searchCarvana`. The first three try fetch first and fall through to Puppeteer **only on a thrown error** (HTTP non-200, AkamaiBlockError, schema mismatch, or timeout). A clean 200 with zero results does NOT trigger fallback — that just spends a Puppeteer launch on a query the user phrased narrowly. **CarMax** tries its JSON API first, falls through to a *no-Puppeteer* HTML-extract fallback (`fetchCarmaxFromHtml`) on the same error-only conditions — see CarMax section. **Carvana** is API-only; the SRP HTML page is Cloudflare-gated, so a fallback would require Puppeteer and hasn't been built. KBB and Autotrader share Cox Automotive's `/rest/lsc/listing` endpoint under different hosts (see KBB section below). **Result dedup is scoped to Autotrader ↔ KBB only** — same `listingId` from both is collapsed to one (Autotrader wins). Cars.com, CarMax, and Carvana all have independent inventory and are never deduped against anything. Cars.com uses `/vehicledetail/{id}/` URLs which don't match the Cox `listingId=` pattern, so they pass through untouched.

### Per-source CARFAX-filter capability

| Filter        | Cars.com   | Autotrader | KBB | CarMax              | Carvana |
|---------------|------------|------------|-----|---------------------|---------|
| `oneOwner`    | ✗ (note)   | ✓          | ✓   | ✓ (`singleOwner`)   | ✗       |
| `noAccidents` | ✗ (note)   | ✓          | ✓   | ✗                   | ✗       |
| `personalUse` | ✓          | ✓          | ✓   | ✗                   | ✗       |

When the caller passes a CARFAX filter and a source can't enforce it per-listing, `server.js` **skips that source entirely** rather than returning unfiltered rows that would render with badges they can't back up. The rendered output surfaces a one-line caveat (`> carvana: oneOwner=true not enforceable`). Cox endpoints (Autotrader/KBB) post-filter on `vhrPreview`.

> **Cars.com `oneOwner` / `noAccidents` note:** Cars.com's GraphQL `SearchResultsPageSearch` operation accepts `one_owner` and `no_accidents` filter values, but sending either causes the response to come back as a "ghost" — `totalListings=0` and empty `analytics.context` — which drops every real listing. So `buildCarscomFilters()` in `apiClient.js` deliberately does NOT send those two filters, and the capability table therefore marks Cars.com as **not** supporting them. Result: a request with `oneOwner: true` skips Cars.com entirely (with the caveat in the output) rather than silently returning unfiltered Cars.com rows. `personalUse` works fine and IS sent. We also do not propagate caller intent into per-listing CARFAX flags for any source — that prior behavior produced badges that claimed verification we couldn't back up.

### Per-listing EV surcharge

Each source mapper populates a normalized `fuelType` on `CarListing` from source-specific fields:

- Cars.com → `analytics.context.fuel_type`
- Autotrader / KBB (Cox) → `fuelType.code` or `fuelType.name`
- CarMax → `engineType` or `fuelType`
- Carvana → `fuelType`

`normalizeFuelType()` collapses these to one of `electric | plug_in_hybrid | hybrid | gas | diesel | flex_fuel | hydrogen | null`. The EV surcharge is applied per-listing: only `electric` and `plug_in_hybrid` rows get the `EV surcharge $X/yr` line in the monthly cost. Listings whose source didn't expose fuelType (`null`) fall back to the request-level `fuelType` hint with the same per-listing label so the user sees the imprecision.

In parallel with listing searches, the server fires three independent enrichments:
1. `estimateInsurance` (Zebra) — ZIP-area median monthly across 3-5 carriers.
2. `lookupSalesTax` (TaxJar widget) — ZIP-level combined city+county+state+district sales tax.
3. State-level static lookups for EV surcharge and registration estimate.

Results bundle these into a per-listing total: `loan + insurance + monthly fees`. Sales tax is **financed into the loan principal** (standard auto-loan practice), so the loan figure already includes amortized tax. The "fees" line is the EV surcharge + registration estimate divided by 12.

### Tool schema

`search_car_deals` — only `zip` is required. Everything else is optional.

**Listing filters:** `make`, `model`, `keyword` (free text), `yearMin/Max`, `priceMax`, `mileageMax`, `searchRadius`, `condition` (`new`/`used`), `dealRating` (`great`/`good`/`fair`), `oneOwner`, `noAccidents`, `personalUse`, `bodyStyle` (`sedan`/`suv`/`truck`/`coupe`/`hatchback`/`convertible`/`wagon`/`minivan`/`van`), `fuelType` (`gas`/`hybrid`/`ev`/`plugin_hybrid`/`diesel`), `maxResults`, `sources`. Default sources: `['cars.com', 'autotrader']`. KBB, CarMax, and Carvana are opt-in.

> **dealRating coverage:** `great` and `good` filter on all three sources (Cars.com via `deal_ratings` GraphQL filter; Autotrader + KBB via Cox `dealType=greatprice|goodprice` plus a defensive post-filter on the per-listing rating). `fair` only filters on Cars.com — Cox's JS bundle declares only `greatprice` and `goodprice` as filter values, so on Autotrader/KBB we silently no-op rather than send a value the API ignores. Per-listing dealRating still appears in the result text.

**Cost-estimate inputs (all optional, defaults applied):** `ageBucket` (Zebra's exact buckets — `Below 18`, `18 to 24`, `25 to 34`, `35 to 44`, `45 to 54`, `55 to 64`, `above 65`; default `45 to 54`), `homeOwner` (default `true`), `currentlyInsured` (default `true`), `downPayment` (default 10% of price), `loanTermMonths` (default `60`), `apr` (default `7`), `includeEstimates` (default `true`).

The tool description nudges the LLM to ask the user for budget, ZIP, body style, and fuel preference up front when shopping for a car.

## API endpoints — what we learned (2026-05-14)

### Autotrader

`GET https://www.autotrader.com/collections/lcServices/rest/lsc/listing?...&zip={zip}`

- Returns `{ listings: [...] }` JSON, no auth required.
- Flexible query params (all optional except `zip`): `makeCode`, `modelCode`, `startYear`, `endYear`, `maxPrice`, `maxMileage`, `searchRadius`, `sortBy` (`relevance`, `derivedpriceASC`, `distanceASC`, ...), `dealType` (`greatprice` | `goodprice` — there is no `fairprice`; the JS bundle only declares the two), `listingTypes` (`USED`/`NEW`), `keywordPhrases` (free text), `bodyStyleCode`, `fuelTypeGroup`, `numRecords`.
- Discovered from HAR: `/Users/rkodali/Downloads/www.autotrader.com.har` (63 MB, cookies stripped).

#### `modelCode` is make-prefixed
Autotrader's model codes are concatenations of the make + model: `EV6` → `KIAEV6`, `IONIQ5` → `HYUNDAIIONIQ5`, `CAMRY` → `TOYOTACAMRY`. Without the prefix the API silently falls back to **all-make results** (e.g. asking for `modelCode=EV6` returns Kia Souls and K5s). Code in `src/apiClient.js:fetchAutotrader` prepends the make automatically when both are provided.

#### Listing URL is not in the response
Autotrader's listing payload has **no `vdpUrl` field**. Construct URLs from the `id`:
```
https://www.autotrader.com/cars-for-sale/vehicledetails.xhtml?listingId=${l.id}
```
Pattern verified to redirect to the canonical VDP.

#### `vhrPreview` carries CARFAX flags
Owner/accident flags live in a top-level array `vhrPreview`:
```json
"vhrPreview": ["NO_SALVAGE_TITLE", "NO_ACCIDENTS_REPORTED", "ONE_OWNER" | "NO_ONE_OWNER"]
```
Parse via `array.includes(...)`. There is no `ownerHistory` object — earlier code that read `l.ownerHistory?.oneOwner` was always `false`.

#### Server-side filter is unreliable
Sending `oneOwner=true` and `noAccidents=true` as query params **does not actually filter** — the response still includes vehicles whose `vhrPreview` is `NO_ONE_OWNER`. We post-filter on `vhrPreview` in `fetchAutotrader` after parsing. We apply the same defense-in-depth pattern to `dealRating` (post-filter on `priceBadge.label` / `pricingDetail.dealIndicator` — case-insensitive match against `great` / `good`).

### Cars.com

`POST https://graph.cars.com/graphql/api`

- GraphQL operation `SearchResultsPageSearch`.
- **Requires an `x-api-key` header** — a public-client key shipped in the cars.com homepage. Without it the server returns `403 Missing API Key`. Also requires `x-cars-platform: cars_responsive` and `x-cars-trip-id: <uuid>` (any UUID works).
- **Acquired dynamically.** `src/apiClient.js:getCarscomApiKey()` launches a headless browser, navigates to `https://www.cars.com/`, intercepts the first `graph.cars.com` request and reads `x-api-key` from its headers. Cached in a module-level variable for the process lifetime. On `Missing API Key`/401/403 from a real query, the cache is cleared and the request retried once. Cold acquisition takes ~1-2s; warm calls add no overhead.
- **Stability check (2026-05-14):** same key returned across two probes 60s apart. Treated as stable but still re-acquired on failure.
- **Cold-start race (known flake):** on a fresh browser, the homepage's first GraphQL call sometimes fires *after* our 30s wait window. Visible as `Could not intercept x-api-key from cars.com`. Retry usually succeeds. Hardening idea: also listen on `response` and parse the same headers — would close the race. Not yet implemented.
- Variables shape:
  ```js
  {
    page, pageSize, searchInstanceId, sort: 'BEST_MATCH_DESC',
    selectedSearchFilters: [
      { filter: 'area', zipCode, radiusMiles },
      { filter: 'stock_type', value: 'used' },
      { filter: 'makes', values: ['toyota'] },
      { filter: 'models', values: ['toyota-camry'] }, // make-prefixed slug
      { filter: 'list_price_max', value: '25000' },
      { filter: 'mileage_max', value: '40000' },
      { filter: 'year_min', value: '2022' },
      { filter: 'deal_ratings', values: ['great'] },
      { filter: 'one_owner', value: 'true' },
      { filter: 'keyword', value: 'hybrid' },
      // ...
    ]
  }
  ```
- Response shape: `data.srpSearch.{ metadata: { totalListings, totalPages }, results: [{ __typename: 'SrpListingGridCard', listingId, analytics: { context: <stringified JSON> } }] }`. Listing details (year/make/model/price/mileage/vin) live inside the JSON-stringified `analytics.context`.
- Discovered from HAR: `/Users/rkodali/Downloads/www.cars.com.har` (88 MB, cookies stripped).
- The full SRP query in the HAR is ~13 KB; we use a minimal version that asks only for `metadata { totalListings totalPages }` and `results { listingId analytics { context } }`. Adjust `src/apiClient.js:CARSCOM_SRP_QUERY` if you need more fields.

#### Cars.com response does NOT expose CARFAX flags directly
Probed schema: `analytics.context` (a JSON-stringified blob with `year`, `make`, `model`, `price`, `mileage`, `vin`, `seller`, etc.) does NOT contain `oneOwner`, `noAccidents`, or `personalUse` fields. The `body` field is type `Stack` (rendered card content with badges) but introspection failed (`children` is not a queryable field). Rather than reverse-engineer the badge structure, we **trust the server-side filter**: when the caller passes `oneOwner: true`/`noAccidents: true`, we send those filters in the GraphQL request and propagate the caller's intent into the returned listing's flags. Verified (2026-05-14) that Cars.com's server-side filter actually works (sending both filters drops result count from 6 → 1 in spot-checks).

#### Cars.com `area` filter leaks listings far outside the requested radius (2026-05-15)
Real-world reproduction: searching `zip=98033, searchRadius=100` for Hyundai Ioniq 5 returned 34 listings, **20 of them outside 100mi** — Oregon (97xxx ZIPs ~150-210mi away), California (94103 ~810mi), Colorado (80538 ~1,200mi), Maryland (20613 ~2,700mi). The server-side `area` filter is unreliable.

**Fix:** post-filter on haversine distance from `params.zip` to each listing's `analytics.context.seller.zip`. Implemented in `fetchCarscom` via `src/zipDistance.js`. Listings whose seller ZIP is >`searchRadius` miles from the search ZIP are dropped. Fail-open: if either ZIP can't be resolved, the listing is kept (better to over-include than over-drop). Verified live (2026-05-15): the same 34→16 query collapsed correctly to only WA ZIPs.

Cox endpoints (Autotrader/KBB) don't appear to have this leak — their `searchRadius` is honored — so we only post-filter Cars.com.

### KBB (2026-05-15)

`GET https://www.kbb.com/rest/lsc/listing?...&channel=KBB&zip={zip}`

KBB and Autotrader are both Cox Automotive properties and share the **same `/rest/lsc/listing` endpoint** under different hosts. Discovered from `/Users/rkodali/Downloads/www.kbb.com.har` (160 MB, cookies stripped). Only meaningful KBB-specific param is `channel=KBB`. Response headers carry `x-fwd-svc: atc` — they're literally proxying through Autotrader's backend.

The query params and most of the response shape are identical to Autotrader. `src/apiClient.js` shares one `buildCoxListingQuery` + `mapCoxListing` + `fetchCoxListings` helper trio between `fetchAutotrader` and `fetchKbb`. Differences absorbed in `mapCoxListing` via a `flavor` arg:

| Field | Autotrader | KBB |
|---|---|---|
| `make` / `model` | `makeName` / `modelName` strings | `make.name` / `model.name` objects (also `.code`) |
| Deal flag | `priceBadge.label` | `pricingDetail.dealIndicator` |
| VDP host | `autotrader.com` | `kbb.com` |

`vhrPreview` works identically (`ONE_OWNER`, `NO_ACCIDENTS_REPORTED`, `PERSONAL_USE`, etc.) — same post-filter logic. Listing URL is constructed the same way: `https://www.kbb.com/cars-for-sale/vehicledetails.xhtml?listingId=${l.id}`.

The Puppeteer fallback (`scrapeKBB` in `src/scraper.js`) is still wired in case the Cox endpoint blocks or schemas drift.

## Insurance estimates (2026-05-15)

`POST https://www.thezebra.com/car-calculator/results/`

The Zebra is a free public quote-comparison site. Their car-insurance-rates calculator endpoint takes ZIP + a few demographic inputs and returns a median monthly across 3-5 carriers. We use it as the insurance estimate.

- **Body shape (exact strings — Zebra is picky about casing):**
  ```json
  {
    "AgeBucket": "45 to 54",   // Below 18 | 18 to 24 | 25 to 34 | 35 to 44 | 45 to 54 | 55 to 64 | above 65
    "HomeOwnership": true,
    "CurrentlyInsuredStatus": true,
    "Zipcode": "98033"
  }
  ```
- **Headers needed:** `content-type: application/json`, `origin: https://www.thezebra.com`, `referer: .../auto-insurance/how-to-shop/car-insurance-rates-city/`, `x-zebra-client-identifier: zfront`. No auth, no cookies.
- **Response:**
  ```json
  { "rate": 362.62, "quotes_html": "<div class=\"...quote-card\">...<span class=\"rate__amount\">362.62</span>...</div>..." }
  ```
- **Important:** the top-level `rate` field is just the *cheapest* carrier, not the average. We parse all `<span class="rate__amount">` values from `quotes_html` and report the **median** plus low/high. Code: `src/insuranceClient.js:parseRatesFromHtml` + `median`.
- **Vehicle make/model is NOT an input.** Zebra's calculator is ZIP- + demographic-only. The estimate disclaimer in the rendered output makes this clear: `_ZIP- and demographic-based only — not vehicle-specific. Source: thezebra.com._`
- **Discovered from HAR:** `/Users/rkodali/Downloads/www.thezebra.com.har` (615 KB).
- **Failure mode:** server.js wraps `estimateInsurance` in `.catch(...)` — if the call fails for any reason, we log and continue without an estimate. Listings still render with loan-only payments.

## Sales tax + state fees (2026-05-15)

`GET https://taxjar.netlify.app/.netlify/functions/calculator?zip={zip}&country=US`

TaxJar publishes a public widget calculator (the same one that powers their marketing-page sales-tax-by-zip tool). It's a Netlify function fronting their published rate data — no auth, no API key. Returns combined city+county+state+district rate plus the breakdown.

- **Discovered from HAR:** `/Users/rkodali/Downloads/www.taxjar.com.har` (12 MB).
- **Headers needed:** `accept: application/json, ...`, `origin: https://www.taxjar.com`, `referer: https://www.taxjar.com/sales-tax-calculator`. Standard browser-ish UA.
- **Response shape:**
  ```json
  { "rate": {
      "state": "WA", "zip": "98033", "city": "KIRKLAND", "county": "KING",
      "combined_rate": "0.104",
      "state_rate": "0.065", "county_rate": "0.005", "city_rate": "0.011",
      "combined_district_rate": "0.023"
  } }
  ```
  All rate fields are **stringified decimals**. Code in `src/feeClient.js:lookupSalesTax` parses to numbers.
- **Verified across 8 ZIPs** (WA, CA, NY, IL, FL, OR, TX, GA): correct combined rates, including OR's 0% (no sales tax).
- **Caveat we disclaim:** TaxJar returns the **general retail** rate. A handful of states (NC's 3% Highway Use Tax, AL's 2% statewide motor-vehicle rate, a few others) tax vehicle purchases at a different rate. We don't model that override — the rendered output says "general retail rate; some states tax vehicles differently."
- **Caching:** per-ZIP cache for the process lifetime (`src/feeClient.js`).
- **Failure mode:** wrapped in `.catch` at the call site. If TaxJar is down or schema-changed, listings render without the sales-tax line, with no monthly-fee adjustment from tax.

### State EV surcharge + registration (`src/feeData.js`)

Static tables, refreshed manually. Sources noted in the file header:
- EV annual surcharge: NCSL "Special Fees on Plug-In Hybrid and Electric Vehicles" — ~30 states have one. WA $300/yr, GA $213/yr, TX $200/yr, etc. Stored as `0` for explicit no-fee states, `null` is reserved for "not modeled."
- Registration estimate: per-state DOL/DMV typical passenger-car fee. Coarse — actual fees are weight- or value-based and we don't model that. Output labels these as estimates.
- Lookups via `evSurchargeAnnual(state)` and `registrationEstimateAnnual(state)`.

EV surcharge is only applied when `params.fuelType` is `ev`, `electric`, or `plugin_hybrid`. (Strictly speaking some states treat plug-in hybrids differently — we use the BEV number for both. Documented in the file.)

**Limitations we're honest about:**
- No first-year vs steady-state distinction (CA's first-year VLF is steeper than renewal — averaged in).
- No weight-based or value-based registration math.
- No local-jurisdiction registration add-ons.
- TaxJar covers all 50 states + DC, but its motor-vehicle-specific rates differ in ~5 states (we use general retail).

## Loan calculator (2026-05-15)

`src/loanCalculator.js` is pure math, no I/O. Standard amortization:

```
M = P * r * (1+r)^n / ((1+r)^n - 1)
```

Two exported functions:

- **`monthlyPayment({price, downPayment, apr, termMonths})`** — straight loan math. Defaults: 10% down, 7% APR, 60mo. Returns `null` for invalid inputs, `0` when down payment ≥ price, and handles 0% APR via straight-line.
- **`totalCostBreakdown({price, downPayment, apr, termMonths, salesTaxRate, evSurchargeAnnual, registrationAnnual, isElectric})`** — integration point used by `server.js`. Finances tax into principal: `financedPrincipal = price × (1 + salesTaxRate)`. Default downPayment becomes 10% of `financedPrincipal` (not bare `price`) to keep the loan ratio consistent. EV surcharge and registration are amortized as separate `/mo` fees, not financed (they're paid annually, not at purchase). Returns `{loanMonthly, evMonthly, registrationMonthly, monthlyFees, financedPrincipal, salesTaxDollars, ...}`.

Also exports `parsePrice("$23,491")` → `23491` since listing prices come in formatted.

## Bot protection — observed behavior across endpoints

This section is the canonical reference for which endpoints work from Node's `fetch` and which need Puppeteer or special handling. Updated as we learn things — supersedes any older notes.

### Autotrader listing API (2026-05-14)

| Client | Result |
|---|---|
| `curl` | First request 200 with JSON. Subsequent requests blocked: HTTP 200 with HTML "Autotrader - page unavailable" (~3.7 KB). Block persists across UA changes and 30s waits. |
| Node 22+ `fetch` (undici) | 5/5 sequential requests with different make/model/zip succeeded. **Not blocked.** No cookies needed. |

### Autotrader `searchoptions` reference (2026-05-15)

- **Akamai-blocked** even from Node `fetch`. Returns the HTML "page unavailable" sentinel.
- **KBB serves the same content unblocked** at `https://www.kbb.com/cars-for-sale/bonnet-reference/searchoptions`. Cox shares the make/model code list across hosts, so `src/coxReference.js` always queries KBB and applies the codes to Autotrader requests.

### Cars.com GraphQL API (2026-05-14)

- Direct `fetch` to `https://www.cars.com/shopping/results/...` (the SRP HTML page) is blocked: **HTTP 403 ~5KB body**. Different protection than Autotrader's listing API.
- Direct `fetch` to `https://graph.cars.com/graphql/api` with the right `x-api-key` works fine. The block is on the HTML page, not the GraphQL backend.

### KBB listing API (2026-05-15)

- Same Cox endpoint as Autotrader, different host. **Not blocked from Node fetch** in our tests. Same posture as Autotrader: detect via the `page unavailable` body string, not status code.

### CarMax search API (2026-05-17)

- `GET https://www.carmax.com/cars/api/search/run?uri=...&zipCode=...&take=...&sort=bestmatch&shipping=-1`
- **Not blocked from Node fetch.** No auth, no cookies. Same-origin in the browser but works cross-origin from Node.
- Filters encoded in a `uri` query param as a URL-encoded path+QS: `/cars/{make}/{model}/{bodyStyle}/{engineType}?price=N&mileage=0-N&year=YYYY-YYYY`. Make/model/body/engine slugs are lowercase hyphenated (e.g. `nissan`, `rogue`, `suvs`, `electric`).
- **CarMax inventory is self-owned only** — they buy vehicles at auction and resell. Does not carry all makes. Hyundai Ioniq 5, most non-domestic EVs, and many import brands are absent or very rare. Do not expect results for niche/EV makes.
- No CARFAX one-owner or no-accident data. `highlights: ['singleOwner']` is CarMax's own badge; `priorUseDescriptions` lists fleet/rental prior use. No `noAccidents` equivalent.
- No radius filter — `shipping=-1` returns all nearby + transferable. `distance` field in each listing is miles from the searched ZIP to the nearest CarMax store.
- VDP URL: `https://www.carmax.com/car/{stockNumber}`
- HAR: `/Users/rkodali/Downloads/www.carmax.com.har`

#### CarMax SRP HTML fallback (2026-05-22)

`fetchCarmaxFromHtml(params, maxResults)` parses the CarMax SRP HTML page when the JSON API returns 0 listings or errors. The SRP at `https://www.carmax.com{uri}?zipCode=...&distance=...` server-renders the listing array as a global JS variable for SEO + first paint:

```html
<script>
  const cars = [{"stockNumber":28417658,"vin":"...","year":2024,"make":"Toyota",
                 "model":"Camry","trim":"XSE","basePrice":34998.0,"mileage":5141,
                 "storeName":"Renton","storeCity":"Renton","stateAbbreviation":"WA",
                 "highlights":["singleOwner","lowMiles"], ...}, ...]
</script>
```

- Same `uri` builder as the API (`buildCarmaxUri`), used as the actual SRP path. Just append `&zipCode=` + `&distance=` for store-radius filtering.
- **Field names match the API exactly** (`basePrice`, `stockNumber`, `storeCity`, `highlights`, `priorUseDescriptions`, ...) — both code paths share `mapCarmaxItem` so the output `CarListing` shape is identical.
- **Not Cloudflare-gated.** Verified live (2026-05-22) — plain Node `fetch` returns 200 with the embedded array.
- **Page is single-page only** — capped at 24 listings (CarMax's page size). `?skip=` is ignored on the SRP, so this fallback can't paginate. Fine for fallback duty.
- Extraction regex: `const cars\s*=\s*(\[[\s\S]*?\]);` then `JSON.parse`. The body is JSON-compatible (CarMax serializes via `JSON.stringify`).
- Live-verified: API → 0/throw → HTML fallback returns real listings (e.g. 5 Toyota Camrys near 98033).

### Carvana search API (2026-05-17)

- `POST https://apik.carvana.io/merch/search/api/v2/search`
- **Not blocked from Node fetch** (no auth token, no cookie required). Headers needed: `content-type: application/json`, `origin: https://www.carvana.com`, `correlation-context: browserCookieId=<any-uuid>`, `x-cvna-sebs-srp: true`.
- Request body JSON: `{ filters: { price, year, mileage, bodyStyles, fuelTypes, makes }, pagination: { page, pageSize }, sortBy, zip5, requestedFeatures, analyticsData, browserCookieId }`.
- `makes` filter is `[{ name: "Hyundai", parentModels: [{ name: "IONIQ 5" }] }]` — **model name is exact-match against Carvana's stored casing**, which is inconsistent across the catalog. Title-case for plain word-models (`Camry`, `Corolla`, `4Runner`, `C-HR`) and all-caps for stylized names (`RAV4`, `IONIQ 5`, `EV6`, `ID.4`). Forced uppercasing of all models *breaks* anything stored title-case (e.g. `CAMRY` returns 0). The code resolves user-supplied model strings via Carvana's typeahead — `resolveCarvanaModelName(make, model)` GETs `https://apik.carvana.io/merch/search/api/v4/suggest?query=<make> <model>` and reads the canonical casing from the first suggestion whose `filters.makes[].name` matches the user's make: `suggestions[].filters.makes[].parentModels[0].name`. Cached per `(make, model)` pair for the process lifetime. On miss the user's input passes through unchanged. Live-verified across `rav4`, `RAV4`, `Camry`, `CAMRY`, `Ioniq 5`, `ioniq 5`, `ev6`, `4runner`, `c-hr`.
  - `/v4/suggest` is a plain GET, no auth, no cookies, no headers required (we still send `origin`/`referer`/UA defensively). Tiny response, fast.
- **Nationwide inventory, no radius filter.** Carvana delivers nationwide; `drivingMiles` in the response is distance to nearest hub, not a filter. Do not pass `searchRadius` — it is silently ignored.
- **`LocationBasedPrefiltering` in `requestedFeatures` suppresses all results** — do not include it. Use only `['ExcludeFacetData', 'HideImpossibleCombos', 'LoanTermPricing']`.
- No one-owner / no-accident fields. Carvana inspects and reconditions all vehicles. `vehicleTags` contains `KeepMovingPrice` (= "Great Deal", priced below KBB) and `RecentPriceDrop`.
- `price.kbbValue` is present per listing — useful for deal comparison.
- **Response shape:** `{ inventory: { vehicles: [...] }, searchRequestId, financeInfo, userDeliveryInfo }`. The vehicles array is at `data.inventory.vehicles`, NOT `data.vehicles`.
- **VDP URL uses `vehicleId`**, not `vdpSlug`. Multiple cars share the same `vdpSlug` (e.g. all 2024 Ioniq 5 SELs share `2024-hyundai-ioniq-5-sel`). Use `https://www.carvana.com/vehicle/{vehicleId}` for unique per-car links.
- HAR: `/Users/rkodali/Downloads/www.carvana.com.har` (initial 2026-05-17 capture — original v2 search endpoint discovery), `/Users/rkodali/Downloads/22_may_2026www.carvana.com.har` (2026-05-22 — `/v4/suggest` typeahead discovery)

### TaxJar calculator (2026-05-15)

- Endpoint at `taxjar.netlify.app/.netlify/functions/calculator` — different infrastructure (Netlify, not Akamai). **Not blocked.** No auth, no cookies, simple GET.

### Zippopotam.us ZIP geocoder (2026-05-15)

- `GET https://api.zippopotam.us/us/{zip}`. Free, public, undocumented. No auth, no cookies. Returns `{ places: [{ latitude, longitude, ... }] }` for valid ZIPs, **HTTP 404 for unknown**. Used by `src/zipDistance.js` to compute haversine distance for the Cars.com radius post-filter. **Not blocked** in our tests. Same fragility class as the other free endpoints — wrapped fail-open at the call site.

### The Zebra calculator (2026-05-15)

- `POST https://www.thezebra.com/car-calculator/results/`. **Intermittently 403s from Node fetch**, even with the same headers that worked in the captured HAR (Cloudflare-style bot challenge HTML body). Worked in mid-session live tests but blocked us later in the same session.
- `src/server.js` wraps `estimateInsurance` in `.catch` — when Zebra blocks, listings render without the insurance line and the user sees only loan + fees. Honest degradation.
- Hardening idea: rotate UA / `sec-ch-ua-*` headers; add a small backoff. Not implemented.

### Block detection

The Akamai block on Autotrader returns **HTTP 200 with HTML, not 403**. Detect by body string, not status:

```js
const isAkamaiBlock = (text) => typeof text === 'string' && text.includes('page unavailable');
```

Cars.com 403 is a normal status check.

### Why curl gets blocked but Node fetch does not

- Akamai checks TLS JA3 and HTTP/2 frame fingerprint, not just headers/cookies.
- `curl`'s ClientHello is in Akamai's bot signature DB.
- Node's `undici` presents a different fingerprint that's currently not flagged.
- **Fragile.** Akamai can add the undici fingerprint anytime. The Puppeteer fallback is the safety net.

### What does not matter (in our tests)

- Cookies. Zero cookies sent; HARs were exported without sensitive data; APIs still returned 200 from Node.
- Full Chrome header set (`sec-ch-ua-*`, `sec-fetch-*`, `priority`, `newrelic`). Minimal headers sufficed for Autotrader. Cars.com only needed UA + content-type + origin + referer + the three `x-cars-*` / `x-api-key` headers.
- Light rate limiting (sub-second sequential requests were fine).

## Repository orientation

- `src/server.js` — MCP server entry, stdio transport, exposes `search_car_deals`. Orchestrates fetch-first / Puppeteer-fallback per source. Computes per-listing loan + ZIP-area insurance in parallel with the searches. Also exports `searchCarscom` / `searchAutotrader` / `searchKBB` for tests; `main()` is guarded by `require.main === module`.
- `src/apiClient.js` — Node `fetch` clients for Autotrader (`fetchAutotrader`), KBB (`fetchKbb`), and Cars.com (`fetchCarscom`). Autotrader + KBB share `buildCoxListingQuery` / `mapCoxListing` / `fetchCoxListings`. Also exports `getCarscomApiKey({ refresh })` for forced re-acquisition. `fetchCarscom` calls `module.exports.getCarscomApiKey(...)` so tests can stub the key without launching Puppeteer.
- `src/insuranceClient.js` — `estimateInsurance({zip, ageBucket, homeOwner, currentlyInsured})` against The Zebra. Returns `{medianMonthly, lowMonthly, highMonthly, carrierCount, ...}`.
- `src/feeClient.js` — `lookupSalesTax(zip)` against TaxJar's widget calculator. Returns `{combinedRate, stateRate, countyRate, cityRate, districtRate, state, county, city}` with per-process per-ZIP cache.
- `src/feeData.js` — static state-level tables: EV annual surcharge and registration estimate. Source URLs in the file header.
- `src/loanCalculator.js` — pure `monthlyPayment(...)`, `parsePrice(...)`, and `totalCostBreakdown(...)` (the integration helper that finances tax into principal and amortizes annual fees).
- `src/zipDistance.js` — `getZipCoords(zip)` + `distanceMiles(zipA, zipB)` against Zippopotam.us (free, no auth, undocumented). In-memory cache for the process lifetime. Used by `fetchCarscom` to post-filter out-of-radius listings. Fail-open: lookup failures keep the listing rather than drop it.
- `src/scraper.js` — Puppeteer + `puppeteer-extra-plugin-stealth` HTML scrapers for Cars.com, Autotrader, KBB. Each call launches its own browser. Exports `CarListing` class.
- `test/` — `node:test` suite, runs offline, ~165ms. See "Tests" below.
- `mcp.json` / `server.json` — MCP marketplace metadata.
- HAR files (cookies stripped):
  - `/Users/rkodali/Downloads/www.autotrader.com.har` (63 MB)
  - `/Users/rkodali/Downloads/www.cars.com.har` (88 MB)
  - `/Users/rkodali/Downloads/www.kbb.com.har` (160 MB)
  - `/Users/rkodali/Downloads/www.carmax.com.har`
  - `/Users/rkodali/Downloads/www.carvana.com.har`, `/Users/rkodali/Downloads/22_may_2026www.carvana.com.har`
  - `/Users/rkodali/Downloads/www.thezebra.com.har` (615 KB)
  - `/Users/rkodali/Downloads/www.taxjar.com.har` (12 MB)

## Tests

`npm run test:unit` runs the full `node:test` suite (`node --test test/*.test.js`). 125 tests, fully offline, ~230ms. Files:

- `test/loanCalculator.test.js` — pure math, edge cases, `totalCostBreakdown` (tax-financed-into-principal, EV surcharge gating, default down-payment ratio).
- `test/insuranceClient.test.js` — Zebra request body shape, HTML rate parsing, median for odd/even counts, fallback to top-level `rate`, error paths.
- `test/feeClient.test.js` — TaxJar URL construction, response parsing, per-ZIP cache, OR zero-rate handling, error paths.
- `test/feeData.test.js` — every state present in both tables, values are non-negative integers, case-insensitive lookups.
- `test/apiClient.test.js` — `fetchAutotrader` (URL/QS construction, `vhrPreview`, post-filter, model-code prefixing, body/fuel mapping, dealRating mapping, AkamaiBlockError), `fetchKbb` (Cox shape variations, channel=KBB, KBB-specific URL host, dealType post-filter), `fetchCarscom` (filter construction, `analytics.context`, auth-failure retry, body/fuel slugs, **radius post-filter drops out-of-range seller ZIPs, fail-open on unresolvable / missing ZIPs**), `fetchCarmax` (uri slug construction, make/model/body/fuel segments, maxResults, error paths), `fetchCarvana` (request body filters, make+parentModels shape, dealRating from vehicleTags, error paths).
- `test/zipDistance.test.js` — `haversineMiles` correctness, `getZipCoords` parsing/caching/404/input validation, `distanceMiles` short-circuit + fail-open behavior.
- `test/server.test.js` — orchestration: fetch success, 0-listings → Puppeteer fallback, fetch throws → fallback, both fail → `{error}` envelope, KBB fetch path. Stubs `apiClient`/`scraper`/`insuranceClient`/`loanCalculator`/`feeClient`/`feeData` via `require.cache` priming **before** loading `server.js` (the destructured imports at the top of server.js capture function references at load time — mutating the fake exports after the require has no effect).

`npm test` is still the live Puppeteer Cars.com smoke. Don't run it in CI.

## Conventions

- CommonJS (`"type": "commonjs"` in package.json). Use `require` / `module.exports`.
- Node 22+ assumed (uses global `fetch`).
- Add tests under `test/` for any new logic in `apiClient` / `insuranceClient` / `loanCalculator` / `server` orchestration. Keep them offline (mock `global.fetch`).
- Don't add unnecessary fallbacks beyond fetch → Puppeteer. Don't pad the Cars.com query with fields we don't use.
- Don't claim insurance estimates are vehicle-aware. Zebra's calculator takes ZIP + demographics only; the disclaimer in the rendered output stays.

## Known issues / hardening ideas

1. **Cold-start race in `getCarscomApiKey()`.** Race between Puppeteer's request listener and the page firing a `graph.cars.com` POST. Hits ~10% of cold starts. Fix: also bind a `response` listener and read the same headers — first one to fire wins. Not yet done.
2. **No retry/backoff on Autotrader Akamai block.** If it ever does block undici, we go straight to Puppeteer. That's fine for correctness, but adding a 1s + 5s backoff before fallback would let transient blocks recover faster.
3. **Cars.com response shape didn't expose CARFAX flags.** We trust the server-side filter (verified working). If that filter ever silently breaks, we'd return wrong results without knowing. A future probe of the GraphQL schema (via introspection or HAR re-capture) could expose the badge fields and let us double-check post-fetch.
4. **The Zebra calculator endpoint is undocumented.** Same fragility class as the cars.com / autotrader fetches — they could change the body shape, add auth, or rate-limit. `estimateInsurance` is wrapped in `.catch` at the call site so failure degrades gracefully (listings still render with loan-only payments).
5. **Cars.com / Autotrader body & fuel filter values weren't exercised in the recorded HARs.** We inferred slug/code names from URL params and JS bundles. If queries return 0 listings unexpectedly, double-check the slug/code mappings in `CARS_BODY_STYLE_SLUGS` / `AT_BODY_STYLE_CODES` etc. in `src/apiClient.js`.
6. **TaxJar widget endpoint is undocumented.** Same posture as the other fetches — could break. Wrapped in `.catch`; failure removes the tax line and zeroes the financed-tax adjustment. Output downgrades cleanly to "loan + insurance" only.
7. **Vehicle sales tax differs from retail in ~5 states** (NC, AL, plus a few). We use TaxJar's general retail rate everywhere — disclaimed in the rendered output. Building the override table is possible but adds maintenance for marginal gain.
8. **State EV surcharge + registration tables are static and rot.** Refresh annually or when state legislation changes. The file headers in `src/feeData.js` carry a "last verified" date and source URLs.
9. **Registration estimates are coarse.** CA's 0.65% Vehicle License Fee + first-year-vs-renewal split, weight-based fees in WA/MN/etc., aren't modeled. The output labels these as estimates.
10. **`npm audit` is clean; keep it that way.** As of 2026-07-08 the tree has **0 vulnerabilities**. CI's gate is `npm audit --omit=dev --audit-level=high` — it fails only on HIGH/CRITICAL findings in the *runtime* tree, so moderate/dev-only advisories surface via the weekly Dependabot run rather than blocking PRs. History worth knowing: this gate broke once when transitive `ws` (via `puppeteer-core`) and `hono` (via `@modelcontextprotocol/sdk`) picked up HIGH DoS advisories; a plain `npm audit fix` cleared all findings with patch/minor transitive bumps only (no `--force`, no majors). If the gate fails again, try `npm audit fix` first and re-run `npm run test:unit` — only reach for a documented exception if a fix would require a breaking major bump.
11. **Dependabot cooldown = 7 days.** `.github/dependabot.yml` sets `cooldown: default-days: 7` on both the npm and github-actions ecosystems, so freshly-published versions soak for a week before Dependabot proposes them (day-zero supply-chain hardening). The value is also what semgrep's `dependabot-missing-cooldown` rule requires — it wants `>=7`, so don't lower it or the Semgrep job goes red. Practical effect: grouped update PRs land ~a week later than a package's release.
