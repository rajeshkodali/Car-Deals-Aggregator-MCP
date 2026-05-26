'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const refPath = require.resolve('../src/coxReference.js');
function load() {
    delete require.cache[refPath];
    return require('../src/coxReference.js');
}

function fetchResp({ status = 200, body = '' } = {}) {
    return { status, async text() { return typeof body === 'string' ? body : JSON.stringify(body); } };
}
function withFetchStub(stub, fn) {
    const prev = global.fetch;
    global.fetch = stub;
    return Promise.resolve(fn()).finally(() => { global.fetch = prev; });
}

const SAMPLE_PAYLOAD = {
    success: true,
    payload: {
        makeCode: [
            { code: 'TOYOTA', name: 'Toyota', kbbName: 'toyota', models: [
                { code: 'CAMRY', name: 'Camry' },
                { code: 'RAV4', name: 'RAV4' }
            ]},
            { code: 'HYUND', name: 'Hyundai', kbbName: 'hyundai', models: [
                { code: 'HYUIONIQ5', name: 'Ioniq 5' },
                { code: 'SONATA', name: 'Sonata' }
            ]}
        ]
    }
};

test('buildIndex creates lookup tables keyed by normalized name', () => {
    const ref = load();
    const idx = ref.buildIndex(SAMPLE_PAYLOAD.payload);
    assert.equal(idx.lookupMake('Toyota').code, 'TOYOTA');
    assert.equal(idx.lookupMake('TOYOTA').code, 'TOYOTA');
    assert.equal(idx.lookupMake('toyota').code, 'TOYOTA');
    assert.equal(idx.lookupMake('Hyundai').code, 'HYUND');
    assert.equal(idx.lookupMake('Unknown'), null);
});

test('lookupModel finds models case-insensitively, ignoring spaces and dashes', () => {
    const ref = load();
    const idx = ref.buildIndex(SAMPLE_PAYLOAD.payload);
    assert.equal(idx.lookupModel('Hyundai', 'Ioniq 5').code, 'HYUIONIQ5');
    assert.equal(idx.lookupModel('hyundai', 'IONIQ-5').code, 'HYUIONIQ5');
    assert.equal(idx.lookupModel('Hyundai', 'ioniq5').code, 'HYUIONIQ5');
    assert.equal(idx.lookupModel('Toyota', 'Camry').code, 'CAMRY');
    assert.equal(idx.lookupModel('Toyota', 'NonExistent'), null);
    assert.equal(idx.lookupModel('NonExistentMake', 'Camry'), null);
});

test('normalize collapses spaces, dashes, underscores and lowercases', () => {
    const { normalize } = load();
    assert.equal(normalize('Ioniq 5'), 'ioniq5');
    assert.equal(normalize('IONIQ-5'), 'ioniq5');
    assert.equal(normalize('Plug-in_Hybrid'), 'pluginhybrid');
    assert.equal(normalize(null), '');
});

test('getReference fetches once and caches', async () => {
    const ref = load();
    ref._clearCache();
    let calls = 0;
    await withFetchStub(async () => {
        calls += 1;
        return fetchResp({ body: SAMPLE_PAYLOAD });
    }, async () => {
        const a = await ref.getReference();
        const b = await ref.getReference();
        const c = await ref.getReference();
        assert.equal(a, b);
        assert.equal(b, c);
        assert.equal(a.lookupMake('Toyota').code, 'TOYOTA');
    });
    assert.equal(calls, 1, 'second/third lookups served from cache');
});

test('getReference dedupes concurrent in-flight requests', async () => {
    const ref = load();
    ref._clearCache();
    let calls = 0;
    await withFetchStub(async () => {
        calls += 1;
        await new Promise(r => setTimeout(r, 10));
        return fetchResp({ body: SAMPLE_PAYLOAD });
    }, async () => {
        const [a, b, c] = await Promise.all([
            ref.getReference(),
            ref.getReference(),
            ref.getReference()
        ]);
        assert.equal(a, b);
        assert.equal(b, c);
    });
    assert.equal(calls, 1, 'concurrent calls share one in-flight fetch');
});

test('getReference rejects when response shape is unexpected', async () => {
    const ref = load();
    ref._clearCache();
    await withFetchStub(async () => fetchResp({ body: { success: true, payload: { wrong: 'shape' } } }), async () => {
        await assert.rejects(ref.getReference(), /shape unexpected/);
    });
});

test('getReference rejects on non-200', async () => {
    const ref = load();
    ref._clearCache();
    await withFetchStub(async () => fetchResp({ status: 503, body: 'down' }), async () => {
        await assert.rejects(ref.getReference(), /HTTP 503/);
    });
});

test('lookupMakeCode returns null and logs on fetch failure', async () => {
    const ref = load();
    ref._clearCache();
    const prev = console.error;
    let logged = '';
    console.error = (...args) => { logged += args.join(' '); };
    try {
        await withFetchStub(async () => { throw new Error('network'); }, async () => {
            const code = await ref.lookupMakeCode('Toyota');
            assert.equal(code, null);
            assert.match(logged, /lookupMakeCode failed/);
        });
    } finally {
        console.error = prev;
    }
});

test('lookupMakeCode and lookupModelCode return correct codes via cached reference', async () => {
    const ref = load();
    ref._clearCache();
    ref._setCache(ref.buildIndex(SAMPLE_PAYLOAD.payload));
    assert.equal(await ref.lookupMakeCode('Hyundai'), 'HYUND');
    assert.equal(await ref.lookupModelCode('Hyundai', 'Ioniq 5'), 'HYUIONIQ5');
    assert.equal(await ref.lookupMakeCode('NotARealMake'), null);
});
