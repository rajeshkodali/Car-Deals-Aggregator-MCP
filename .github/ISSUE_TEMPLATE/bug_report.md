---
name: Bug report
about: Report a bug in Car Deals Aggregator MCP
title: "[bug] "
labels: bug
assignees: ''
---

## Describe the bug

<!-- Clear, concise description -->

## To reproduce

Tool call that triggered it (sanitize ZIPs/PII as you like):

```json
{
  "name": "search_car_deals",
  "arguments": { "zip": "...", "make": "...", "model": "..." }
}
```

## Expected vs actual

**Expected:**
**Actual:**

## Environment

- Commit / version:
- Node version (`node --version`):
- OS / platform:
- Which source(s) misbehaved? (cars.com / autotrader / kbb / carmax / carvana)

## Logs

```
<paste relevant [MCP] stderr lines and any error envelope here>
```

## Sample output (optional)

If the bug is in a parsed listing field (price, mileage, URL), paste a
single redacted listing block. **Do not paste seller phone numbers or
real VINs.**
