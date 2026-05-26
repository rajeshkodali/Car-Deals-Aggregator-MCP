'use strict';

// Tiny fetch wrapper that enforces an upstream-call timeout.
//
// Why: every external dependency in this codebase (Cox, Cars.com GraphQL,
// CarMax, Carvana, Zebra, TaxJar, Zippopotam) is an undocumented public
// surface. A hung server is the most realistic availability failure mode,
// and the MCP server fans these requests out in parallel — one stuck
// branch would otherwise pin a worker indefinitely.
//
// AbortController.timeout is Node 17.3+ and convenient, but we use the
// long form so unit tests can assert .signal was forwarded.

const DEFAULT_TIMEOUT_MS = 15_000;

class TimeoutError extends Error {
    constructor(label, ms) {
        super(`${label} timed out after ${ms}ms`);
        this.name = 'TimeoutError';
        this.code = 'ETIMEDOUT';
    }
}

async function fetchWithTimeout(url, options = {}, { timeoutMs = DEFAULT_TIMEOUT_MS, label = 'fetch' } = {}) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    // Allow callers to pass their own signal (e.g. parent task cancellation)
    // — we wire ours in via `any` if available, otherwise just use ours.
    const signal = options.signal && AbortSignal.any
        ? AbortSignal.any([options.signal, ctl.signal])
        : ctl.signal;
    try {
        return await fetch(url, { ...options, signal });
    } catch (e) {
        if (e?.name === 'AbortError') throw new TimeoutError(label, timeoutMs);
        throw e;
    } finally {
        clearTimeout(timer);
    }
}

module.exports = { fetchWithTimeout, TimeoutError, DEFAULT_TIMEOUT_MS };
