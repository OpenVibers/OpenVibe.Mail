'use strict';

/**
 * deploy/nginx/openvibe.email.conf is the public door. This test is the static guard: the three server_name lines,
 * the TLS files for the name, and a proxy list limited to the API and the Network sign-in routes (plus the two
 * machine answers). `/` is the page, and its files come from /css/, /js/ and /shared/.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'deploy', 'nginx', 'openvibe.email.conf');
const CONF = fs.readFileSync(FILE, 'utf8');

/** location → block body (the file has no nested braces inside a location). */
function locations() {
    const out = new Map();
    for (const match of CONF.matchAll(/location\s+(?:(?:=|~\*?)\s+)?([^\s{]+)\s*\{([\s\S]*?)\n\s*\}/g)) {
        out.set(match[1], match[2]);
    }
    return out;
}

test('openvibe.email has the three house server_name lines and the existing certificate', () => {
    assert.match(CONF, /server_name openvibe\.email www\.openvibe\.email;/);
    assert.match(CONF, /server_name www\.openvibe\.email;/);
    assert.match(CONF, /server_name openvibe\.email;/);
    assert.match(CONF, /ssl_certificate\s+\/etc\/letsencrypt\/live\/openvibe\.email\/fullchain\.pem;/);
    assert.match(CONF, /ssl_certificate_key\s+\/etc\/letsencrypt\/live\/openvibe\.email\/privkey\.pem;/);
    assert.match(CONF, /include snippets\/security-txt\.conf;/);
});

test('only the page and its files, the API, the machine answers and the sign-in routes are proxied', () => {
    const blocks = locations();
    const proxied = [...blocks.entries()]
        .filter(([, body]) => /proxy_pass\s+http:\/\/127\.0\.0\.1:5250;/.test(body))
        .map(([name]) => name)
        .sort();
    assert.deepStrictEqual(proxied, ['/', '^/(css|js|shared)/', '/api/health', '/api/ready', '/api/v1/', '/auth/', '/auth/me'].sort());

    // A proxy anywhere else (a generic /api/ or / catch-all) would expose more than the door above.
    assert.strictEqual((CONF.match(/proxy_pass\s+/g) || []).length, proxied.length,
        'every proxy_pass belongs to one of the seven locations');
});

test('/ is the page (GET and HEAD only) and unknown paths are not proxied', () => {
    const blocks = locations();
    const root = blocks.get('/');
    assert.ok(root, 'there is an exact / location');
    assert.match(root, /proxy_pass http:\/\/127\.0\.0\.1:5250;/);
    assert.match(root, /limit_except GET HEAD \{ deny all; \}/);
    assert.match(blocks.get('^/(css|js|shared)/'), /limit_except GET HEAD \{ deny all; \}/);
    assert.match(blocks.get('/api/'), /return 404;/);
    assert.doesNotMatch(blocks.get('/api/'), /proxy_pass/);
    assert.match(CONF, /location ~\* \^\/\(metrics\|internal\)\(/);
});

test('the API forwards the client address the way the house does behind Cloudflare', () => {
    assert.match(CONF, /proxy_set_header Host \$host;/);
    assert.match(CONF, /proxy_set_header X-Real-IP \$remote_addr;/);
    assert.match(CONF, /proxy_set_header X-Forwarded-For \$remote_addr;/);
    assert.match(CONF, /proxy_set_header CF-Connecting-IP \$remote_addr;/);
    assert.match(CONF, /proxy_set_header X-Forwarded-Proto \$scheme;/);
    assert.match(CONF, /cloudflare-realip\.conf/, 'the global Cloudflare real-IP include is documented');
    assert.match(CONF, /Strict-Transport-Security/);
    assert.match(CONF, /X-Content-Type-Options nosniff/);
});
