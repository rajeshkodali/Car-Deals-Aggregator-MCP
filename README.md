# Car Deals Aggregator MCP

> **Search used and new car listings from Cars.com, Autotrader, KBB, CarMax, and Carvana with AI assistants — and get a rough monthly-cost estimate (loan + insurance + tax + fees) for each result**

An MCP (Model Context Protocol) server that aggregates car listings from five sources. Calls each site's internal JSON/GraphQL API directly when possible (fast), and falls back to Puppeteer scraping when needed (reliable). Flexible filters: search by zip alone, by free-text keyword, by make/model, by price/year/mileage, by deal rating, by body style, by fuel type, or by CARFAX history.

Each result also includes an **estimated monthly total cost** = amortized loan (with sales tax financed into principal) + ZIP-area median insurance (sourced from The Zebra's free calculator) + monthly-amortized state EV surcharge and registration estimate. The insurance figure is ZIP- and demographics-based only; vehicle make/model/year is not an input — the rendered output makes this clear.

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)

---

## Quick Start

### Prerequisites

- **Node.js 22+** (uses global `fetch`)
- **Chrome/Chromium** installed (Puppeteer is used as a fallback and to acquire the cars.com API key)
  - If Chrome is not in the default location, set `PUPPETEER_EXECUTABLE_PATH` to your Chrome/Chromium binary

### Installation

```bash
git clone https://github.com/rkodali/Car-Deals-Aggregator-MCP.git
cd Car-Deals-Aggregator-MCP
npm install
```

### Using with MCP Clients

Configure your MCP client (Claude Desktop, VS Code, GitHub Copilot, etc.) to use this server:

**Claude Desktop** (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS):

```json
{
  "mcpServers": {
    "car-deals-aggregator": {
      "command": "node",
      "args": ["/absolute/path/to/Car-Deals-Aggregator-MCP/src/server.js"]
    }
  }
}
```

**Other MCP clients**: use `command: node`, `args: ["<absolute-path>/src/server.js"]`.

### Testing Standalone

```bash
# Smoke test the Puppeteer Cars.com scraper
npm test

# Hit the API clients directly
node -e "
const { fetchCarscom, fetchAutotrader } = require('./src/apiClient');
(async () => {
  const params = { zip: '98052', priceMax: 30000, yearMin: 2022, dealRating: 'great' };
  const [cars, autotrader] = await Promise.all([
    fetchCarscom(params, 5),
    fetchAutotrader(params, 5)
  ]);
  [...cars, ...autotrader].forEach(l => console.log(l.format(), '\n'));
})();
"
```

---

## Architecture

Two-tier strategy per source:

1. **Direct API client** (`src/apiClient.js`) — Node `fetch` to each site's internal JSON/GraphQL endpoint. Sub-second latency, structured JSON responses. Tried first.
2. **Puppeteer scraper** (`src/scraper.js`) — `puppeteer-extra` + stealth plugin. Slower (~10s per source) but resilient. Used as fallback when the direct API errors or is blocked.

For each source, the orchestrator (`src/server.js`) attempts direct fetch first and falls through to Puppeteer on any failure (Cars.com / Autotrader / KBB). CarMax and Carvana are fetch-only — no Puppeteer fallback. KBB and Autotrader share Cox Automotive's listing endpoint under different hosts.

| Source     | Direct API                | Puppeteer fallback | Notes |
|------------|:-------------------------:|:------------------:|------|
| Cars.com   | GraphQL (POST `graph.cars.com/graphql/api`) | Yes | Requires dynamic `x-api-key` (see below) |
| Autotrader | REST (GET `autotrader.com/collections/lcServices/rest/lsc/listing`) | Yes | No auth required |
| KBB        | REST (GET `kbb.com/rest/lsc/listing?channel=KBB`) | Yes | Same Cox endpoint as Autotrader |
| CarMax     | REST (GET `carmax.com/cars/api/search/run`) | No | Self-owned inventory only; no radius filter (`shipping=-1`) |
| Carvana    | REST (POST `apik.carvana.io/merch/search/api/v2/search`) | No | Nationwide inventory; no radius filter; model name must be ALL-CAPS |

In parallel with the listing searches, the server also fires The Zebra's free insurance-rate calculator and computes a per-listing amortized loan payment, then renders the totals in the response.

### Cars.com `x-api-key`

Cars.com's GraphQL endpoint requires a public-client `x-api-key` header. The key isn't sensitive — it ships in the cars.com homepage JS bundle — but it can rotate. We acquire it dynamically:

1. Launch a headless browser, navigate to `https://www.cars.com/`.
2. Intercept the first `graph.cars.com` request and read `x-api-key` from its headers.
3. Cache in memory for the process lifetime.
4. On `Missing API Key` / 401 / 403, clear the cache and retry once.

Cold acquisition takes ~1–2s; subsequent calls add no overhead. Stability check (2026-05-14): same key returned across two probes 60s apart.

### Cost estimates

For each listing with a parseable price, the server appends a monthly-cost breakdown:

```
Est. monthly: ~$555 loan + ~$170 insurance + ~$33 fees = ~$758/mo
  (72mo @ 5.5% APR, 10% down, 10.40% tax financed)
```

The math:

- **Loan** — pure amortization. Sales tax is **financed into the principal** (standard auto-loan practice): `financedPrincipal = price × (1 + salesTaxRate)`. Down payment defaults to 10% of `financedPrincipal`. Defaults: 7% APR, 60 months. All overridable via `downPayment`, `apr`, `loanTermMonths` tool inputs.
- **Insurance** — `POST https://www.thezebra.com/car-calculator/results/`. Body takes `AgeBucket`, `HomeOwnership`, `CurrentlyInsuredStatus`, `Zipcode`. We parse all `<span class="rate__amount">` values from `quotes_html` and report the **median** (plus low/high). Shown once at the top of the output, not repeated per listing. **Vehicle is not an input** — Zebra's calculator is ZIP- and demographic-only.
- **Sales tax** — `GET https://taxjar.netlify.app/.netlify/functions/calculator?zip={zip}&country=US`. TaxJar's public widget calculator. Returns ZIP-level combined city + county + state + district rate. Verified across 8 ZIPs in 8 states. Caveat: returns the *general retail* rate; a few states (NC, AL) tax vehicles differently — disclaimed in output.
- **Fees** — state EV surcharge (when `fuelType` is `ev`/`electric`/`plugin_hybrid`) + state registration estimate, both annual, divided by 12. Static tables in `src/feeData.js`, sourced from NCSL and state DOL/DMV pages. Coarse — actual registration fees are weight- or value-based.

All three remote calls (insurance, tax, listings) run in parallel and each fails independently. If any one breaks, the corresponding line drops from the output but the rest still renders.

**Opt out:** pass `includeEstimates: false` to skip everything.

### Bot protection (Akamai)

- **Autotrader REST**: Akamai blocks `curl` after the first request (HTTP 200 with HTML "page unavailable", not 403). Node 22+ `fetch` (undici) is currently not blocked — different TLS/H2 fingerprint. Fragile, but it works today.
- **Cars.com HTML pages**: 403 from Node `fetch` directly, but the GraphQL backend at `graph.cars.com` is open with the right headers.
- **Block detection**: We treat HTTP 200 + body string `page unavailable` as a block (Autotrader's pattern), and any 403/401/non-200 status as failure (Cars.com's pattern). Both fall through to Puppeteer.

---

## Features

- **Direct JSON/GraphQL APIs** for sub-second searches when not blocked
- **Puppeteer fallback** with stealth plugin when direct APIs fail
- **Flexible search**: only `zip` is required — search by free-text keyword, make/model, price/year/mileage, deal rating, condition, or CARFAX history
- **CARFAX-style filters**: 1-Owner, No Accidents, Personal Use (server-side filtering on Cars.com; post-filter via `vhrPreview` on Autotrader)
- **Multi-source aggregation**: Run all sources in parallel
- **Direct VDP links**: Each result includes a clickable URL to the listing's detail page

---

## MCP Tool: `search_car_deals`

### Parameters

**Listing filters**

| Parameter      | Type     | Required | Description |
|----------------|----------|----------|-------------|
| `zip`          | string   | ✅       | ZIP code for location-based search |
| `make`         | string   | ❌       | Manufacturer (Toyota, Honda, Ford, ...) |
| `model`        | string   | ❌       | Model (Camry, Civic, F-150, ...) |
| `keyword`      | string   | ❌       | Free-text keyword (`"hybrid"`, `"AWD"`, `"leather"`) |
| `yearMin`      | integer  | ❌       | Minimum model year |
| `yearMax`      | integer  | ❌       | Maximum model year |
| `priceMax`     | integer  | ❌       | Maximum price in USD |
| `mileageMax`   | integer  | ❌       | Maximum mileage |
| `searchRadius` | integer  | ❌       | Search radius in miles (default 50) |
| `condition`    | string   | ❌       | `"new"` or `"used"` (default `"used"`) |
| `dealRating`   | string   | ❌       | `"great"`, `"good"`, or `"fair"`. `great` / `good` filter all three sources (Cars.com `deal_ratings` filter; Autotrader/KBB Cox `dealType=greatprice\|goodprice` + post-filter). `fair` only filters Cars.com — Cox doesn't expose a fair-price filter. |
| `bodyStyle`    | string   | ❌       | `sedan` / `suv` / `truck` / `coupe` / `hatchback` / `convertible` / `wagon` / `minivan` / `van` |
| `fuelType`     | string   | ❌       | `gas` / `hybrid` / `ev` / `plugin_hybrid` / `diesel` |
| `oneOwner`     | boolean  | ❌       | CARFAX 1-Owner only |
| `noAccidents`  | boolean  | ❌       | No accidents reported |
| `personalUse`  | boolean  | ❌       | Personal use only (no rental/fleet) |
| `maxResults`   | integer  | ❌       | Max results per source (default 10) |
| `sources`      | array    | ❌       | `["cars.com", "autotrader", "kbb", "carmax", "carvana"]` (default: cars.com + autotrader; KBB / CarMax / Carvana are opt-in) |

**Cost-estimate inputs** (all optional; sensible defaults applied)

| Parameter           | Type     | Default      | Description |
|---------------------|----------|--------------|-------------|
| `ageBucket`         | string   | `"45 to 54"` | Driver age bracket. Must be one of: `Below 18`, `18 to 24`, `25 to 34`, `35 to 44`, `45 to 54`, `55 to 64`, `above 65`. |
| `homeOwner`         | boolean  | `true`       | Whether the driver owns their home (used for Zebra estimate) |
| `currentlyInsured`  | boolean  | `true`       | Whether the driver currently has insurance (used for Zebra estimate) |
| `downPayment`       | integer  | 10% of price | Down payment in USD |
| `loanTermMonths`    | integer  | `60`         | Loan term in months |
| `apr`               | number   | `7`          | Annual percentage rate (e.g. `7` for 7%) |
| `includeEstimates`  | boolean  | `true`       | Set to `false` to skip both loan and insurance calculations |

### Example queries

```json
{ "zip": "98052", "yearMin": 2022, "priceMax": 30000, "dealRating": "great" }
{ "zip": "94102", "keyword": "hybrid AWD", "priceMax": 35000 }
{ "zip": "98052", "make": "Hyundai", "model": "Ioniq 5", "oneOwner": true, "noAccidents": true }
{ "zip": "60601", "condition": "new", "make": "Toyota", "model": "RAV4 Hybrid" }

// shop-by-category with estimates
{ "zip": "98033", "priceMax": 35000, "bodyStyle": "suv", "fuelType": "ev", "ageBucket": "35 to 44" }
```

### Example response

```
**Estimated insurance (98033, 45 to 54):** ~$417/mo (median of 3 carriers; range $363–$501).
_ZIP- and demographic-based only — not vehicle-specific. Source: thezebra.com._

**Sales tax (KIRKLAND, WA):** 10.40% combined
(state 6.50% + county 0.50% + city 1.10% + district 2.30%).
_General retail rate; some states tax vehicles differently. Source: taxjar.com._

**Annual fees (WA):** EV surcharge $300/yr, registration ~$95/yr. _Coarse state-level estimates._

2024 Hyundai Ioniq 5 SEL
  Price: $25,380
  Mileage: 21,370 mi.
  Dealer: Lithia Hyundai of Seattle
  Location: Seattle, WA
  Source: Autotrader
  https://www.autotrader.com/cars-for-sale/vehicledetails.xhtml?listingId=776479652
  Est. monthly: ~$502 loan + ~$417 insurance + ~$33 fees = ~$952/mo
    (60mo @ 7% APR, 10% down, 10.40% tax financed)
```

---

## Supported sources

| Source     | Price | Mileage | Deal Rating | Dealer/Location | CARFAX Filters | URL |
|------------|:-----:|:-------:|:-----------:|:---------------:|:--------------:|:---:|
| Cars.com   | ✅    | ✅      | ✅          | ⚠️ partial       | ✅ server-side  | ✅ |
| Autotrader | ✅    | ✅      | ✅ (`priceBadge.label`) | ✅ | ✅ via `vhrPreview` | ✅ |
| KBB        | ✅    | ✅      | ✅ (`pricingDetail.dealIndicator`) | ✅ | ✅ via `vhrPreview` | ✅ |
| CarMax     | ✅    | ✅      | ❌          | CarMax store    | ⚠️ `singleOwner` badge only | ✅ |
| Carvana    | ✅    | ✅      | ✅ via `KeepMovingPrice` tag | nationwide | ❌ (all reconditioned) | ✅ |

---

## Repository layout

```
src/
  server.js          # MCP server entry, stdio transport, search_car_deals tool
  apiClient.js       # Direct fetch clients (fetchCarscom, fetchAutotrader, fetchKbb, getCarscomApiKey)
  insuranceClient.js # Zebra car-calculator client; returns median monthly + carrier range
  feeClient.js       # TaxJar widget client; returns ZIP-level combined sales tax rate (cached)
  feeData.js         # Static state-level tables: EV surcharge + registration estimate
  loanCalculator.js  # Pure amortization (monthlyPayment, parsePrice, totalCostBreakdown)
  scraper.js         # Puppeteer + stealth scrapers for Cars.com / Autotrader / KBB (fallback)
  zipDistance.js     # Haversine + Zippopotam.us ZIP geocoder (used to post-filter Cars.com radius)
  coxReference.js    # Cox make/model code lookup (shared by Autotrader + KBB)
test/
  apiClient.test.js
  insuranceClient.test.js
  feeClient.test.js
  feeData.test.js
  loanCalculator.test.js
  server.test.js
  zipDistance.test.js
  coxReference.test.js
mcp.json             # MCP marketplace metadata
server.json          # MCP registry metadata
package.json         # Dependencies (Node 22+, puppeteer, puppeteer-extra)
CLAUDE.md            # Internal notes on API discovery, Akamai, and endpoint quirks
```

---

## Technical notes

### Chrome/Chromium

Puppeteer needs a Chrome/Chromium binary:

- **macOS**: `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`
- **Linux**: usually auto-detected, or `/usr/bin/chromium-browser`
- **Windows**: `C:\Program Files\Google\Chrome\Application\chrome.exe`

If Puppeteer can't find it: `export PUPPETEER_EXECUTABLE_PATH="/path/to/chrome"`

### Conventions

- CommonJS (`"type": "commonjs"` in `package.json`)
- Node 22+ required (uses global `fetch` and `undici`'s TLS/H2 fingerprint)
- Unit tests live under `test/` and run via `npm run test:unit` (built-in `node:test`, no extra dev deps). Suite is fully offline — `global.fetch` is mocked, Puppeteer is stubbed via `require.cache` priming. Currently 125 tests in ~230ms.
- `npm test` is still the live Puppeteer Cars.com smoke. Slow and flaky; don't run in CI.

---

## Development

```bash
# Run the offline unit-test suite (~165ms)
npm run test:unit

# Live Puppeteer smoke against Cars.com (slow, flaky — local-only)
npm test

# Hit the direct API clients
node -e "require('./src/apiClient').fetchCarscom({zip:'98052'},3).then(r=>r.forEach(l=>console.log(l.format())))"
node -e "require('./src/apiClient').fetchAutotrader({zip:'98052'},3).then(r=>r.forEach(l=>console.log(l.format())))"
node -e "require('./src/apiClient').fetchKbb({zip:'98052'},3).then(r=>r.forEach(l=>console.log(l.format())))"

# Hit the insurance client directly
node -e "require('./src/insuranceClient').estimateInsurance({zip:'98033'}).then(r=>console.log(r))"

# Hit the sales-tax client directly
node -e "require('./src/feeClient').lookupSalesTax('98033').then(r=>console.log(r))"

# Run the MCP server locally (stdio)
node src/server.js
```

---

## Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/name`)
3. Add tests where reasonable
4. Commit (`git commit -m 'Add feature'`)
5. Push and open a Pull Request

If a source site changes its API or HTML structure, please include a brief note in the PR describing what broke and how you discovered the fix (HAR file inspection, Puppeteer interception, etc.) — this saves the next person from repeating the same investigation.

---

## License

Apache 2.0 — see [LICENSE](LICENSE). Copyright 2026 Rajesh Kodali.

This project was forked from [SiddarthaKoppaka/car_deals_search_mcp](https://github.com/SiddarthaKoppaka/car_deals_search_mcp) (MIT). MIT is compatible with Apache 2.0; the original copyright notice is retained per MIT's terms.

---

## Links

- **Repository**: https://github.com/rkodali/Car-Deals-Aggregator-MCP
- **Issues**: https://github.com/rkodali/Car-Deals-Aggregator-MCP/issues
- **MCP Protocol**: https://modelcontextprotocol.io
