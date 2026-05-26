'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const httpClientPath = require.resolve('../src/httpClient.js');

function loadFresh() {
    delete require.cache[httpClientPath];
    return require('../src/httpClient.js');
}

test('fetchWithTimeout forwards options + a signal to the underlying fetch', async () => {
    const { fetchWithTimeout } = loadFresh();
    let captured = null;
    const prev = global.fetch;
    global.fetch = async (url, opts) => { captured = { url, opts }; return { status: 200 }; };
    try {
        await fetchWithTimeout('https://example/x', { method: 'GET', headers: { 'x-foo': '1' } }, { timeoutMs: 100, label: 'test' });
    } finally {
        global.fetch = prev;
    }
    assert.equal(captured.url, 'https://example/x');
    assert.equal(captured.opts.method, 'GET');
    assert.equal(captured.opts.headers['x-foo'], '1');
    assert.ok(captured.opts.signal, 'a signal should be attached');
    assert.equal(captured.opts.signal.aborted, false);
});

test('fetchWithTimeout aborts and throws TimeoutError when fetch hangs', async () => {
    const { fetchWithTimeout, TimeoutError } = loadFresh();
    const prev = global.fetch;
    // Hang until the signal fires; throw the matching AbortError so the
    // wrapper translates to TimeoutError.
    global.fetch = (url, opts) => new Promise((_, reject) => {
        opts.signal.addEventListener('abort', () => {
            const e = new Error('aborted');
            e.name = 'AbortError';
            reject(e);
        });
    });
    try {
        await assert.rejects(
            fetchWithTimeout('https://example/hang', {}, { timeoutMs: 25, label: 'hang test' }),
            (err) => err instanceof TimeoutError && /hang test timed out/.test(err.message) && err.code === 'ETIMEDOUT'
        );
    } finally {
        global.fetch = prev;
    }
});

test('fetchWithTimeout passes through non-abort errors unchanged', async () => {
    const { fetchWithTimeout } = loadFresh();
    const prev = global.fetch;
    global.fetch = async () => { throw new Error('econnrefused'); };
    try {
        await assert.rejects(fetchWithTimeout('https://example/x'), /econnrefused/);
    } finally {
        global.fetch = prev;
    }
});

test('fetchWithTimeout uses the default 15s when no opts given', async () => {
    const { fetchWithTimeout, DEFAULT_TIMEOUT_MS } = loadFresh();
    assert.equal(DEFAULT_TIMEOUT_MS, 15_000);
    let signalSeen = null;
    const prev = global.fetch;
    global.fetch = async (_u, opts) => { signalSeen = opts.signal; return { status: 200 }; };
    try {
        await fetchWithTimeout('https://example/y');
    } finally {
        global.fetch = prev;
    }
    assert.ok(signalSeen, 'signal should still be wired even with default opts');
});
