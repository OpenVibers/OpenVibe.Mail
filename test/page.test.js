'use strict';
/**
 * openvibe.email's page (Opus, 11-07): / is the page with the ten-minute address, its files are served by content
 * hash, Shared's files come from /shared, and the page has its own strict policy.
 *   node --test test/page.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const { boot } = require('./helpers/boot');
const { asset, siteIdentity } = require('../server/http/pages');

test('the navbar takes its service and name from the Contracts site block', () => {
    assert.deepStrictEqual(siteIdentity({ id: 'mail', site: { name: 'Email' } }), { service: 'mail', name: 'OpenVibe.Email' });
    assert.deepStrictEqual(siteIdentity({ id: 'mail', site: { name: 'OpenVibe.Post' } }), { service: 'mail', name: 'OpenVibe.Post' }, 'a brand name is not doubled');
    assert.deepStrictEqual(siteIdentity(null), { service: 'mail', name: 'OpenVibe.Email' }, 'before the manifest is pinned, the page keeps the names it shipped with');
});

test('/ is the page: the ten-minute address, the honest cards, the navbar, a strict policy', async (t) => {
    const s = await boot();
    t.after(() => s.close());
    const r = await s.get('/');
    assert.strictEqual(r.status, 200);
    assert.match(r.headers.get('content-type'), /text\/html/);
    for (const marker of ['data-mail-burner', 'Get a 10-minute address', 'data-mail-mine', 'Inboxes for your agents', 'navbar-mount', '/shared/']) {
        assert.ok(r.text.includes(marker), marker);
    }
    // Masks and own inboxes are not offered as if they worked today: each card says Later.
    assert.strictEqual((r.text.match(/class="ml-soon">Later</g) || []).length, 2);
    assert.doesNotMatch(r.text, /<form[^>]*action="\/api/, 'nothing posts to the API without the script');
    const csp = r.headers.get('content-security-policy') || '';
    assert.match(csp, /frame-ancestors 'none'/);
    assert.match(csp, /default-src 'self'/);
    assert.match(csp, /form-action 'self' https:\/\/openvibe\.network/);
});

test('the page\'s files are served by content hash, and Shared\'s from /shared', async (t) => {
    const s = await boot();
    t.after(() => s.close());
    const css = await s.get(asset('css/mail.css'));
    assert.strictEqual(css.status, 200);
    assert.match(css.headers.get('cache-control') || '', /immutable/);
    const js = await s.get(asset('js/mail.js'));
    assert.strictEqual(js.status, 200);
    assert.match(js.text, /\/api\/v1\/burners/);
    const stale = await s.get('/js/mail.js?v=0000000000');
    assert.strictEqual(stale.status, 200);
    assert.doesNotMatch(stale.headers.get('cache-control') || '', /immutable/, 'a wrong hash is not cached for a year');
    const navbar = await s.get('/shared/navbar.js');
    assert.strictEqual(navbar.status, 200);
    const missing = await s.get('/js/nope.js');
    assert.strictEqual(missing.status, 404);
});
