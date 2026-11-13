'use strict';
/**
 * The Companion (the browser extension) and the person's masks (Seven Domains plan R2 item 12).
 *
 * The rules these tests hold: the Companion holds the Network's Dock token for the public client
 * 'companion', scoped to 'mail.mask.manage'; with that scope it manages that person's own masks and
 * nothing else; without it, nothing; and its origin is allowed by CORS so the extension can ask.
 */
const test = require('node:test');
const assert = require('node:assert');
const { boot } = require('./helpers/boot');

const EXTENSION_ORIGIN = 'chrome-extension://bjcjcfcecpkkmfndegkjekoipdmbgakd';

test("the Companion manages the person's masks with the mask scope", async (t) => {
    const s = await boot({ env: { MAIL_EXTENSION_ORIGINS: EXTENSION_ORIGIN } });
    t.after(() => s.close());
    const alice = s.network.addUser('alice');
    const token = s.network.dockToken(alice);

    const made = await s.post('/api/v1/masks', { bearer: token, json: { label: 'acme-shop.com', purpose: 'companion' } });
    assert.strictEqual(made.status, 201, JSON.stringify(made.body));
    assert.match(made.body.mask.address, /@mask\.openvibe\.email$/);
    assert.strictEqual(made.body.mask.label, 'acme-shop.com');

    const list = await s.get('/api/v1/masks', { bearer: token });
    assert.strictEqual(list.status, 200);
    assert.strictEqual(list.body.masks.length, 1);

    const id = made.body.mask.id;
    const off = await s.post(`/api/v1/masks/${id}/disable`, { bearer: token });
    assert.strictEqual(off.status, 200);
    assert.strictEqual(off.body.mask.enabled, false);
});

test("the Companion sees the person's masks and nobody else's", async (t) => {
    const s = await boot({ env: { MAIL_EXTENSION_ORIGINS: EXTENSION_ORIGIN } });
    t.after(() => s.close());
    const alice = s.network.addUser('alice');
    const bob = s.network.addUser('bob');
    await s.post('/api/v1/masks', { as: alice, json: { label: 'acme-shop.com' } });
    await s.post('/api/v1/masks', { as: bob, json: { label: 'other-shop.com' } });

    const seen = await s.get('/api/v1/masks', { bearer: s.network.dockToken(alice) });
    assert.strictEqual(seen.status, 200);
    assert.deepStrictEqual(seen.body.masks.map((m) => m.label), ['acme-shop.com']);
});

test('a Companion token without the mask scope may not manage masks', async (t) => {
    const s = await boot({ env: { MAIL_EXTENSION_ORIGINS: EXTENSION_ORIGIN } });
    t.after(() => s.close());
    const alice = s.network.addUser('alice');
    const without = s.network.dockToken(alice, { scope: 'dock activity' });
    const made = await s.post('/api/v1/masks', { bearer: without, json: { label: 'acme-shop.com' } });
    assert.strictEqual(made.status, 403);
    assert.strictEqual(made.body.code, 'mail.capability_missing');
    assert.strictEqual((await s.get('/api/v1/masks', { bearer: without })).status, 403);
});

test("a Dock token for another client is not the Companion's", async (t) => {
    const s = await boot({ env: { MAIL_EXTENSION_ORIGINS: EXTENSION_ORIGIN } });
    t.after(() => s.close());
    const alice = s.network.addUser('alice');
    const other = s.network.dockToken(alice, { scope: 'mail.mask.manage', clientId: 'some-other-client' });
    const made = await s.post('/api/v1/masks', { bearer: other, json: { label: 'acme-shop.com' } });
    assert.strictEqual(made.status, 401);
});

test("the extension's origin is allowed by CORS, and another origin is not", async (t) => {
    const s = await boot({ env: { MAIL_EXTENSION_ORIGINS: EXTENSION_ORIGIN } });
    t.after(() => s.close());
    const alice = s.network.addUser('alice');
    const token = s.network.dockToken(alice);

    const ok = await s.get('/api/v1/masks', { bearer: token, origin: EXTENSION_ORIGIN });
    assert.strictEqual(ok.status, 200);
    assert.strictEqual(ok.headers.get('access-control-allow-origin'), EXTENSION_ORIGIN);

    const stranger = await s.get('/api/v1/masks', { bearer: token, origin: 'https://evil.example.net' });
    assert.strictEqual(stranger.headers.get('access-control-allow-origin'), null);
});

test('Firefox installs (moz-extension://*) are allowed when the service is told', async (t) => {
    const s = await boot({ env: { MAIL_EXTENSION_ORIGINS: 'moz-extension://*' } });
    t.after(() => s.close());
    const alice = s.network.addUser('alice');
    const origin = 'moz-extension://0f9e2b7c-4a1d-4d5e-9c3b-2f7a6d1e8b44';
    const ok = await s.get('/api/v1/masks', { bearer: s.network.dockToken(alice), origin: origin });
    assert.strictEqual(ok.headers.get('access-control-allow-origin'), origin);
});

test('without the setting, no extension origin is allowed', async (t) => {
    const s = await boot();
    t.after(() => s.close());
    const alice = s.network.addUser('alice');
    const ok = await s.get('/api/v1/masks', { bearer: s.network.dockToken(alice), origin: EXTENSION_ORIGIN });
    assert.strictEqual(ok.headers.get('access-control-allow-origin'), null);
});

test('the origins come from the environment only, and a website origin in the list is refused', async (t) => {
    // No store id is written in the code: the list is the environment's, and the service checks it is an
    // extension origin before it opens anything. A website origin would let a site read a person's masks.
    const configLib = require('../server/config');
    const env = (origins) => ({ NODE_ENV: 'test', MAIL_BASE_DOMAIN: 'openvibe.email', MAIL_MASK_DOMAIN: 'mask.openvibe.email', BURNER_DOMAINS: 'burn1.openvibe.email', MAIL_EXTENSION_ORIGINS: origins });
    const config = configLib.load(env(`${EXTENSION_ORIGIN},moz-extension://*`));
    assert.deepStrictEqual(config.extensionOrigins, [EXTENSION_ORIGIN, 'moz-extension://*']);
    assert.throws(() => configLib.load(env('https://evil.example.net')), /MAIL_EXTENSION_ORIGINS/);
    assert.throws(() => configLib.load(env('chrome-extension://not-an-id')), /MAIL_EXTENSION_ORIGINS/);
});
