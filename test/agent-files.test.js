'use strict';
/**
 * The machine-readable front door (SEO-2/SEO-3/SEO-33): /.well-known/agent.json, /openapi.json, /llms.txt and
 * /llms-full.txt. They name the one public page and the public API only; /inbox and /admin/mail/providers are a
 * person's or the owner's and must not appear.
 */
const test = require('node:test');
const assert = require('node:assert');
const { boot } = require('./helpers/boot');

test('the agent files describe only the public page and API', async (t) => {
    const s = await boot();
    t.after(() => s.close());

    const llms = await s.get('/llms.txt');
    assert.strictEqual(llms.status, 200);
    assert.match(llms.headers.get('content-type'), /^text\/plain/);
    assert.ok(llms.text.startsWith('# OpenVibe.Mail\n'), 'llms.txt starts with the site heading');
    assert.ok(llms.text.includes('> Your own address and domain, masks'), 'it says what the site is, in the home page\'s words');
    assert.doesNotMatch(llms.text, /Receive only|nothing here sends mail|M1 has/, 'no stale words from before person mail');
    for (const url of ['https://openvibe.email/', 'https://openvibe.email/openapi.json', 'https://openvibe.email/.well-known/agent.json', 'https://openvibe.email/llms-full.txt']) {
        assert.ok(llms.text.includes(url), `llms.txt links ${url}`);
    }
    for (const privatePath of ['/inbox', '/admin/']) assert.ok(!llms.text.includes(privatePath), `llms.txt does not name ${privatePath}`);

    const full = await s.get('/llms-full.txt');
    assert.strictEqual(full.status, 200);
    assert.match(full.headers.get('content-type'), /^text\/plain/);
    assert.ok(full.text.startsWith('# OpenVibe.Mail\n'), 'llms-full.txt opens with the site heading');
    assert.ok(full.text.length > 500, `llms-full.txt carries the page (${full.text.length} characters)`);
    assert.ok(full.text.includes('## Pages'));
    assert.ok(full.text.includes('An address for every sign-up'), 'the home page text');
    assert.ok(full.text.includes('URL: https://openvibe.email/'));
    assert.ok(full.text.includes('URL: https://openvibe.email/openapi.json'));

    const agent = await s.get('/.well-known/agent.json');
    assert.strictEqual(agent.status, 200);
    assert.match(agent.headers.get('content-type'), /^application\/json/);
    assert.strictEqual(agent.body.id, 'mail');
    assert.strictEqual(agent.body.home, 'https://openvibe.email');
    assert.strictEqual(agent.body.openapi, 'https://openvibe.email/openapi.json');
    assert.strictEqual(agent.body.llmsFull, 'https://openvibe.email/llms-full.txt');
    assert.ok(!JSON.stringify(agent.body).includes('/inbox'), 'the manifest names no private page');

    const doc = await s.get('/openapi.json');
    assert.strictEqual(doc.status, 200);
    assert.match(doc.headers.get('content-type'), /^application\/json/);
    assert.strictEqual(doc.body.openapi, '3.1.0');
    assert.ok(doc.body.paths['/api/v1/masks'], 'the public mask routes are there');
    for (const [path, operations] of Object.entries(doc.body.paths)) {
        assert.ok(!path.startsWith('/internal/'), `${path} is not a loopback route`);
        for (const [method, operation] of Object.entries(operations)) {
            const visibility = [].concat(operation['x-openvibe-visibility'] || []);
            assert.ok(!(visibility.length && visibility.every((v) => v === 'internal')), `${method} ${path} is not internal-only`);
        }
    }
});
