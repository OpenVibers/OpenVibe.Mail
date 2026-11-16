'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot } = require('./helpers/boot');

// /metrics (2026-11-16, Report's stats for every site): Prometheus on the host reads it over loopback. It carries the
// release, the HTTP counts and the process's own numbers; a request a proxy relayed is turned away as if it were absent.
async function checkMetrics(base, service) {
    assert.equal((await fetch(base + '/api/health')).status, 200);
    const r = await fetch(base + '/metrics');
    assert.equal(r.status, 200, 'loopback reads /metrics');
    assert.equal(r.headers.get('cache-control'), 'no-store');
    const text = await r.text();
    assert.match(text, new RegExp(`release_info\\{service="${service}",release="[^"]+"\\} 1`), 'the release it runs');
    assert.match(text, /http_requests_total\{[^}]*route="\/api\/health"/, 'the request just made is counted');
    assert.match(text, /nodejs_eventloop_lag_seconds/, 'the event loop lag (stalls look like a slow database)');
    for (const h of [{ 'X-Forwarded-For': '203.0.113.9' }, { 'CF-Connecting-IP': '203.0.113.9' }, { Forwarded: 'for=203.0.113.9' }]) {
        assert.equal((await fetch(base + '/metrics', { headers: h })).status, 404, `relayed (${Object.keys(h)[0]}) is not served`);
    }
}

test('GET /metrics: the release, HTTP counts and process numbers, to loopback only', async (t) => {
    const s = await boot(); t.after(() => s.close());
    await checkMetrics(s.base, 'mail');
});
