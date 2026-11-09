'use strict';
/**
 * openvibe.email's page (Opus, 11-07): / is the page with the ten-minute address, its files are served by content
 * hash, Shared's files come from /shared, and the page has its own strict policy.
 *   node --test test/page.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { boot } = require('./helpers/boot');
const { asset, siteIdentity } = require('../server/http/pages');

test('provider admin controls save Stalwart spam score cutoffs', () => {
    const script = fs.readFileSync(path.join(__dirname, '../public/js/mail-providers.js'), 'utf8');
    assert.match(script, /data-spam-form/);
    assert.match(script, /\/api\/v1\/admin\/mail\/spam-settings/);
    assert.match(script, /hold_score/);
    assert.match(script, /refuse_score/);
});

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
    // Masks, your address and the inbox work: no card says Later, and two lead to /inbox. With MAIL_OUTBOUND off (the
    // default) the page says sending to other providers opens next and never "Receive only" or "your own domain comes
    // next" (both stale since 11-08); the description says the same.
    assert.strictEqual((r.text.match(/class="ml-soon">Later</g) || []).length, 0);
    assert.strictEqual((r.text.match(/href="\/inbox"/g) || []).length, 2);
    assert.match(r.text, /Your address<\/h3><p>A name at openvibe\.email, aliases, and your own domain/);
    assert.match(r.text, /sending and forwarding to other providers open next/);
    assert.match(r.text, /<meta name="description" content="[^"…]*Mail arrives today; sending opens next\.">/);
    assert.doesNotMatch(r.text, /Receive only|your own domain come next|\{\{[A-Z_]+\}\}/);
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
    const inboxJs = await s.get(asset('js/inbox.js'));
    assert.strictEqual(inboxJs.status, 200);
    assert.match(inboxJs.text, /Connected mailboxes/, 'Inbox AI shows the connected mailboxes');
    assert.match(inboxJs.text, /imap-mailboxes/);
    const providerJs = await s.get(asset('js/mail-providers.js'));
    assert.strictEqual(providerJs.status, 200);
    for (const marker of ['free_daily', 'price_per_thousand', 'monthly_budget', 'rate_limit_per_minute', 'enabled_kinds', 'lookup_count', 'bounce_rate', 'spend_this_month', 'spam-settings', 'hold_score', 'refuse_score']) {
        assert.ok(providerJs.text.includes(marker), marker);
    }
    const navbar = await s.get('/shared/navbar.js');
    assert.strictEqual(navbar.status, 200);
    const missing = await s.get('/js/nope.js');
    assert.strictEqual(missing.status, 404);
});

test('/release.json is the release manifest open tabs poll, never cached', async (t) => {
    const s = await boot();
    t.after(() => s.close());
    const r = await s.get('/release.json');
    assert.strictEqual(r.status, 200);
    assert.match(r.headers.get('cache-control') || '', /no-cache/);
    const m = JSON.parse(r.text);
    assert.strictEqual(m.service, 'mail');
    assert.ok(typeof m.release === 'string' && m.release.length > 0, 'the deployed commit');
    assert.ok(m.packages && m.packages['openvibe-shared'], 'the platform packages it runs');
});

test('with sending on, the page says how sending works instead of "opens next"', () => {
    const { mailCopy } = require('../server/http/mail-copy');
    const on = mailCopy({ outbound: { enabled: true } });
    const off = mailCopy({ outbound: { enabled: false } });
    assert.match(on.sendLine, /up to 10 recipients a message, 20 a day to start/);
    assert.match(on.sendRule, /checked for spam before it leaves/);
    assert.doesNotMatch(`${on.description} ${on.sendLine} ${on.sendRule}`, /opens? next|closed/);
    assert.match(off.sendRule, /closed for now/);
    assert.strictEqual(on.summary, off.summary, 'what the site is does not change with the switch');
    for (const d of [on.description, off.description]) assert.ok(d.length <= 158, `the description fits the shell: ${d.length}`);
});
