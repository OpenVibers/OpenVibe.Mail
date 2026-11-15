'use strict';
/**
 * The browser check (11-15): a path openvibe.email does not have showed nginx's bare 404 page (no language) and
 * /favicon.ico was a 404 on every visit. The app answers the icon, and /404.html (the page the vhost shows in place of
 * every path it does not pass on) is the site's own page with a language, still a 404.
 *   node --test test/notfound-favicon.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { boot } = require('./helpers/boot');

test('/favicon.ico and /favicon.svg answer the app icon', async (t) => {
    const s = await boot();
    t.after(() => s.close());
    const r = await s.get('/favicon.ico');
    assert.strictEqual(r.status, 200);
    assert.match(r.headers.get('content-type'), /image\/svg\+xml/);
    assert.ok(r.text.startsWith('<svg'), 'an SVG');
    assert.strictEqual((await s.get('/favicon.svg')).status, 200);
});

test('/404.html is the site\'s own not-found page, with a language, as a 404', async (t) => {
    const s = await boot();
    t.after(() => s.close());
    const r = await s.get('/404.html');
    assert.strictEqual(r.status, 404);
    assert.match(r.text, /<html[^>]* lang="en"/);
    assert.ok(r.text.includes('Not found') && r.text.includes('href="/"'));
    assert.match(String(r.headers.get('cache-control')), /no-store/);
});

test('the vhost shows /404.html in place of the paths it does not pass on, and passes the icon', () => {
    const conf = fs.readFileSync(path.join(__dirname, '..', 'deploy', 'nginx', 'openvibe.email.conf'), 'utf8');
    assert.match(conf, /error_page 404 \/404\.html;/);
    assert.match(conf, /location = \/404\.html \{\s*internal;\s*proxy_pass http:\/\/127\.0\.0\.1:5250;/);
    assert.match(conf, /location ~ \^\/favicon\\\.\(ico\|svg\)\$ \{/);
});
