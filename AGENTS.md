# Agent guidance

This repository is a CommonJS, Node 22+ MCP server for searching car listings.
Read [CLAUDE.md](CLAUDE.md) for search defaults, source capabilities, fallback
policies, result presentation, and endpoint research. Keep those details there
as the shared reference rather than duplicating them in this file. When older
research conflicts with current behavior, verify `src/` and `test/` and update
CLAUDE.md alongside the implementation.

## Commands

- `npm run test:unit` runs the offline `node:test` suite. Run it after code changes.
- `npm run lint` checks `src/` and `test/`.
- `node --test --test-name-pattern="<regex>" test/apiClient.test.js` narrows a test run.
- `npm start` starts the MCP server over stdio from `src/server.js`.
- `npm test` is a live, networked Puppeteer smoke test. Do not run it in CI.

## Working conventions

- Use `require` and `module.exports` and preserve the stdio MCP protocol.
  Diagnostics belong on stderr, not stdout.
- Add offline tests for new search, parsing, filter, or orchestration logic.
  Mock network calls; do not make unit tests depend on live marketplaces.
- Keep filters and badges honest: never infer vehicle-history or drivetrain
  verification from caller intent, keywords, or trim names, and never silently
  return listings that fail a hard constraint. Report source exclusions.
- Do not add unused Cars.com GraphQL fields or assume an undocumented endpoint
  or filter works without verification.
- HAR captures may contain sensitive data and must not be committed. Generated
  live-search output belongs in the gitignored `results/` directory.
