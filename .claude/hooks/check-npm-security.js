#!/usr/bin/env node
'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function parseJson(text, fallback) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function deny(reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  }));
  process.exit(0);
}

function skillName(payload) {
  const input = payload.tool_input || {};
  return input.skill || input.name || input.skill_name || 'unknown';
}

function summarize(audit) {
  const vulns = audit && typeof audit === 'object' ? audit.vulnerabilities : null;
  if (!vulns || typeof vulns !== 'object') return '';

  const rows = [];
  for (const [name, info] of Object.entries(vulns)) {
    const severity = String(info?.severity || '').toLowerCase();
    if (severity !== 'high' && severity !== 'critical') continue;
    const via = Array.isArray(info?.via)
      ? info.via
          .map((item) => (typeof item === 'string' ? item : item?.title || item?.name))
          .filter(Boolean)
          .slice(0, 3)
          .join('; ')
      : '';
    const fix = info?.fixAvailable
      ? (typeof info.fixAvailable === 'object'
        ? `fix: ${info.fixAvailable.name}@${info.fixAvailable.version}`
        : 'fix available')
      : 'no automatic fix';
    rows.push(`- ${name} [${severity}] ${via ? `— ${via} ` : ''}(${fix})`);
  }
  return rows.slice(0, 20).join('\n');
}

const payload = parseJson(readStdin(), {});
const cwd = payload.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();

if (!fs.existsSync(path.join(cwd, 'package.json'))) {
  process.exit(0);
}

let result;
try {
  result = execFileSync('npm', ['audit', '--omit=dev', '--audit-level=high', '--json'], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60_000,
  });
} catch (err) {
  if (err.status === null || err.code === 'ENOENT') {
    process.stderr.write(`npm-security-gate: skipped (${err.code || err.message})\n`);
    process.exit(0);
  }
  result = err.stdout || '';
  const audit = parseJson(result, null);
  if (!audit || audit.error) {
    process.stderr.write(`npm-security-gate: audit did not run (${err.message})\n`);
    process.exit(0);
  }

  const meta = audit.metadata?.vulnerabilities || {};
  const high = Number(meta.high || 0);
  const critical = Number(meta.critical || 0);
  if (high + critical === 0 && err.status !== 1) {
    process.exit(0);
  }

  const detail = summarize(audit);
  deny(
    [
      `Blocked skill "${skillName(payload)}": npm audit found HIGH/CRITICAL runtime vulnerabilities.`,
      `Counts: critical=${critical} high=${high}.`,
      'Apply security fixes (`npm audit --omit=dev --audit-level=high`, then `npm audit fix`) and re-run unit tests before using skills.',
      detail,
    ].filter(Boolean).join('\n'),
  );
}

process.exit(0);
