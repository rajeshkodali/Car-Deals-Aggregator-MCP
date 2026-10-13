# Endpoint Research

Detailed external endpoint contracts, HAR-derived request details, source-specific
parsing notes, and observed bot-protection behavior live here. Treat the
implementation and offline tests as authoritative when this research becomes
stale. HAR captures may contain sensitive data and must not be committed.

## Current Contracts

- Cox: Autotrader and KBB share `/rest/lsc/listing`; model codes are make-prefixed,
  history/deal filters require post-filtering, and later-page `{}` ends pagination.
- Cars.com: use the minimal GraphQL SRP query with a dynamically acquired API key.
  Do not send `one_owner` or `no_accidents`; post-filter explicit radii by seller ZIP.
- CarMax: use its JSON search API, with the SRP's `const cars` payload as an
  error-only, single-page HTML fallback. It has no strict radius filter.
- Carvana: use its v2 search API, resolve exact model casing through v4 suggest,
  and use `vehicleId` for VDP URLs. It has no strict radius or history support.
- CarGurus: use stealth Puppeteer only because DataDome blocks Node fetch. Resolve
  opaque make/model IDs in the existing browser page; tiles are single-page and
  location hydration may leave some `location` fields null.
- Zebra's rate calculator is ZIP/demographic-only; parse all quoted rates and
  report their median. It can intermittently block requests, so omit estimates
  on failure.
- When `ZIP_TAX_API_KEY` is configured, sales tax uses the documented zip.tax
  postal-code API first. It refuses redirects so its API key cannot be forwarded
  to another host. TaxJar's widget is the unauthenticated fallback and returns
  stringified general-retail rate fields. ZIP geocoding uses Zippopotam.us; all
  of these integrations must fail gracefully.

## Protection Summary

| Source | Node fetch behavior | Required handling |
|---|---|---|
| Autotrader/KBB listing | Usually works; Akamai can return HTTP 200 HTML | Detect `page unavailable` and use the defined fallback |
| Autotrader reference | Blocked | Use KBB's shared reference endpoint |
| Cars.com SRP HTML | HTTP 403 | Use GraphQL and refresh the key once on auth failure |
| CarMax/Carvana APIs | Works | Use only verified request shapes |
| CarGurus | HTTP 406/DataDome | Use stealth Puppeteer only |
| Zebra | Intermittent 403 | Omit estimate on failure |
| zip.tax | Keyed, documented API | Refuse redirects and fall back to TaxJar on failure |
| TaxJar/Zippopotam | Worked in observed tests | Treat as undocumented and fail gracefully |

Node's undici fingerprint has historically passed Cox requests where curl did
not. This is fragile: do not treat copied headers, cookies, or light rate
limiting as a permanent bypass. Consult existing tests before changing fallback
or filter behavior.
