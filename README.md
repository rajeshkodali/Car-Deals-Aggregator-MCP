# Car Deals Aggregator MCP

Search car listings from multiple marketplaces in one MCP tool call, with optional monthly cost estimates.

Supported sources:
- Cars.com
- Autotrader
- KBB
- CarMax
- Carvana

---

## Start In 5 Minutes

### 1) Prerequisites

- Node.js `20+` (Node `22+` recommended — uses global `fetch` from Node 22)
- npm
- Chrome/Chromium available locally (needed for Puppeteer fallback and Cars.com API-key bootstrap)

If Chrome is not auto-detected, set:

```bash
export PUPPETEER_EXECUTABLE_PATH="/absolute/path/to/chrome"
```

### 2) Install

```bash
git clone https://github.com/rkodali/Car-Deals-Aggregator-MCP.git
cd Car-Deals-Aggregator-MCP
npm install
```

### 3) Run checks (recommended)

```bash
npm run test:unit
npm run lint
```

### 4) Run the MCP server

```bash
node src/server.js
```

The server runs over stdio (normal MCP server behavior).

### 5) Add to your MCP client

Example (`Claude Desktop` on macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`):

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

Any MCP client can use:
- `command`: `node`
- `args`: `["/absolute/path/to/src/server.js"]`

---

## Ask In Plain English

You do not need to provide tool JSON.
Just ask naturally, for example:

- "Find used Toyota Camry deals near 98052 under $30k."
- "Show me great-deal EV SUVs around Kirkland, WA with under 40k miles."
- "I want a one-owner, no-accident Honda CR-V within 100 miles of 94103."
- "Compare best hybrid SUVs near 60601 and estimate monthly cost."

Best results come from including:
- ZIP code
- budget
- body style
- fuel preference
- any hard constraints (one-owner, no-accident, max mileage, etc.)

---

## What You Get Back

Each listing includes:
- title/year-make-model
- price and mileage (if source provides them)
- dealer/location (if available)
- source name
- direct listing URL

If `includeEstimates` is not disabled, the output also includes:
- estimated monthly loan payment
- ZIP-level insurance estimate (The Zebra; demographics + ZIP only)
- ZIP-level sales tax estimate (TaxJar widget endpoint)
- monthlyized state EV/registration fee estimate

Important estimate caveats:
- insurance is **not vehicle-specific**
- tax is general retail tax by ZIP (some states tax vehicle purchases differently)
- registration/EV fee values are coarse state-level estimates

---

## How To Ask Better Questions

If you want higher-quality recommendations, include these details in your prompt:

- **Location:** ZIP code (required for useful local results)
- **Budget:** max price you want to pay
- **Vehicle type:** make/model or body style (SUV, sedan, truck, etc.)
- **Powertrain:** gas, hybrid, EV, or plug-in hybrid
- **Condition/history:** used/new, one-owner, no-accident preferences
- **Payment preference:** ask for monthly estimate if you want loan + insurance context

If you do not provide enough detail, the assistant should ask follow-up questions.

---

## Source Behavior (Important)

- Default sources are `cars.com` + `autotrader`. KBB, CarMax, and Carvana are opt-in via `sources`.
- Autotrader and KBB share Cox Automotive's listing backend; duplicate listings (same `listingId`) are collapsed to one (Autotrader wins).
- Radius semantics differ by source:
  - Cars.com, Autotrader, and KBB honor `searchRadius` (Cars.com post-filtered by haversine distance — server-side filter is unreliable)
  - Carvana inventory is **nationwide** — `searchRadius` is ignored
  - CarMax returns nearby + transferable inventory; no strict radius filter
- CarMax tries its JSON API first; on failure falls back to HTML extraction (`fetchCarmaxFromHtml`) — no Puppeteer required.
- Carvana is API-only (no Puppeteer fallback; the SRP is Cloudflare-gated).
- If a requested history/CARFAX filter cannot be enforced for a selected source, that source is **skipped entirely** and a caveat line appears in the output.

---

## Commands

```bash
# Start server
npm start

# Offline unit tests (fast, CI-safe)
npm run test:unit

# Lint with security rules
npm run lint

# Live Puppeteer smoke (networked, slower)
npm test
```

---

## Security and Quality Checks

This repo includes:
- ESLint + `eslint-plugin-security`
- `@typescript-eslint` parser/plugin support in lint config
- CodeQL workflow
- `njsscan` SARIF workflow (GitHub Security tab)
- npm audit job in CI

Note: `eslint-plugin-security` is intentionally noisy for dynamic object access in JS and currently reports warnings, not errors.

---

## Troubleshooting

### Puppeteer or browser launch fails

- Confirm Chrome/Chromium is installed
- Set `PUPPETEER_EXECUTABLE_PATH` explicitly
- Re-run `npm install` to ensure Puppeteer dependencies are present

### Cars.com results fail intermittently

- Cars.com API key is acquired dynamically from homepage traffic
- Retry once; transient acquisition races can happen

### You get fewer results than expected

- Increase `maxResults`
- Include more `sources`
- Relax strict filters (`oneOwner`, `noAccidents`, deal rating, year/price/mileage constraints)

---

## Project Layout

- `src/server.js` - MCP server + `search_car_deals` orchestration
- `src/apiClient.js` - direct API clients for all sources
- `src/scraper.js` - Puppeteer fallbacks
- `src/carListing.js` - listing model/formatting
- `src/loanCalculator.js` - monthly loan math
- `src/insuranceClient.js` - Zebra insurance estimate client
- `src/feeClient.js` / `src/feeData.js` - sales tax + fee estimates
- `src/coxReference.js` - Cox Automotive make/model/body/fuel code reference (fetched once from KBB, cached per process)
- `src/httpClient.js` - `fetchWithTimeout` wrapper enforcing per-call timeouts across all upstream calls
- `src/zipDistance.js` - haversine distance helper for Cars.com radius post-filter
- `test/` - offline unit tests (151 tests, ~230ms)

---

## License

Apache 2.0. See `LICENSE`.
