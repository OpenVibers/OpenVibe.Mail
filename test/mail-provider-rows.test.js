'use strict';
/**
 * The owner's mail rows (plan §AB.16 and §AB.18, 2026-11-13: "email configuration and all our email providers and
 * setup"):
 *
 *   - every provider is one row: all of its fields share one x-required-for, so the Setup tab shows it once;
 *   - every field has plain words, a 30+ character description, an https page to get it at, and a test;
 *   - the test of a provider is one cheap authenticated read, from a recorded answer, and never sends;
 *   - a provider that refuses answers in one line, with the key cut out of it;
 *   - the DNS check reads MX, SPF, DKIM, DMARC and BIMI live and names the record to add with its exact value;
 *   - a secret is write-only and is never echoed by a test, a summary or a log line.
 */
const assert = require('assert');
const express = require('express');
const http = require('http');
const net = require('net');
const { lintSchema, OWNER_INPUT_GROUPS } = require('openvibe-shared/config');
const { testDb } = require('./helpers/db');
const { createSettings, SENDING_SCHEMA, RECEIVING_SCHEMA, DNS_SCHEMA } = require('../server/config-store');
const { PROVIDERS, DNS_PROVIDER, SENDING_NAMESPACE, RECEIVING_NAMESPACE, DNS_NAMESPACE } = require('../server/mail-providers');
const { PROBES } = require('../server/mail-probes');

const USR = 'usr_01J8Z3Q4R5S6T7V8W9X0Y1Z2A3';
const KEKS = { current: 'k1', keys: { k1: Buffer.alloc(32, 9) } };
const quiet = { log() {}, info() {}, warn() {}, error() {} };

/** The answers the providers gave the day they were taken. */
const RECORDED = {
    'https://api.postmarkapp.com/senders': { body: { SenderSignatures: [{ FromEmail: 'hello@openvibe.email', Confirmed: true, DKIMVerified: true }] } },
    'https://api.resend.com/domains': { body: { data: [{ name: 'openvibe.email', status: 'verified' }] } },
    'https://api.mailgun.net/v3/domains': { body: { items: [{ name: 'openvibe.email' }], total_count: 1 } },
    'https://api.sendgrid.com/v3/scopes': { body: { scopes: ['mail.send', 'mail.settings.read'] } },
    'https://api.brevo.com/v3/account': { body: { email: 'owner@openvibe.email', plan: 'starter' } },
    'https://api.cloudflare.com/client/v4/zones': { body: { success: true, result: [{ id: 'zone_1', name: 'openvibe.email' }] } },
    'https://api.cloudflare.com/client/v4/zones/zone_1/email/routing/rules': { body: { success: true, result: [{ id: 'rule_1', name: 'to the inbox', enabled: true }] } },
    'https://email.eu-west-1.amazonaws.com/v2/email/identities': { body: { Identities: [{ IdentityType: 'DOMAIN', Identity: 'openvibe.email' }] } },
};

/** A fetch that answers with the recorded answers and refuses anything else. */
function recordedFetch(calls, answers = RECORDED) {
    return async (url, options = {}) => {
        const href = String(url);
        const match = Object.keys(answers).find((prefix) => href.startsWith(prefix));
        if (!match) {
            calls.push({ url: href, matched: false });
            throw new Error(`no recorded answer for ${href}`);
        }
        calls.push({ url: href, method: options.method || 'GET', headers: options.headers || {}, matched: true });
        const entry = answers[match];
        const text = typeof entry.body === 'string' ? entry.body : JSON.stringify(entry.body);
        const status = entry.status || 200;
        return {
            ok: status < 400, status,
            headers: { get: () => 'application/json' },
            async text() { return text; },
            async json() { return JSON.parse(text); },
        };
    };
}

/** The settings on a temporary database, with the recorded answers behind them. */
async function makeSettings(opts = {}) {
    const calls = [];
    const db = (await testDb()).db;
    const settings = createSettings({
        db,
        config: { inbound: { mx: ['mx1.openvibe.email', 'mx2.openvibe.email'] } },
        env: {},
        keks: KEKS,
        log: quiet,
        fetchImpl: opts.fetchImpl || recordedFetch(calls, opts.answers),
        probes: opts.probes || null,
        lookups: opts.lookups || null,
    });
    await settings.ready;
    const actor = { type: 'user', id: USR };
    const set = async (namespace, values, secrets = []) => {
        const store = settings.stores[namespace];
        if (values && Object.keys(values).length) await store.apply(values, { actor });
        for (const [key, value] of Object.entries(secrets)) await store.setSecret(key, value, { actor });
    };
    return { db, settings, calls, set };
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// ── the rows ──────────────────────────────────────────────────────────────────────────────────────────────────────────

test('every mail provider is one row with plain words, a page to get it at, and a test', async () => {
    const schemas = { [SENDING_NAMESPACE]: SENDING_SCHEMA, [RECEIVING_NAMESPACE]: RECEIVING_SCHEMA, [DNS_NAMESPACE]: DNS_SCHEMA };
    const providers = [...PROVIDERS, DNS_PROVIDER];
    assert.ok(providers.length >= 9, 'the sending providers, the relay, the receiving side and the DNS check are all here');
    for (const provider of providers) {
        assert.ok(provider.keys.length, `${provider.name} has a field`);
        assert.ok(provider.unlocks && provider.unlocks.length > 20, `${provider.name} says in plain words what it opens`);
        assert.ok(/^https:\/\//.test(provider.get_it_at), `${provider.name} names an https page`);
        assert.ok(provider.get_it_how && provider.get_it_how.length > 20, `${provider.name} says how to get it`);
        const namespace = provider === DNS_PROVIDER ? DNS_NAMESPACE : PROVIDERS.includes(provider) && provider.id === 'cloudflare-routing' ? RECEIVING_NAMESPACE : SENDING_NAMESPACE;
        const schema = schemas[namespace];
        const required = new Set();
        for (const key of provider.keys) {
            const prop = schema.properties[key.name];
            assert.ok(prop, `${key.name} is a field of ${namespace}`);
            assert.ok(prop.title && prop.title.length > 3, `${key.name} has a title`);
            assert.ok(prop.description && prop.description.length >= 30, `${key.name} has a description of 30 characters or more`);
            const owner = prop['x-owner-input'];
            assert.ok(owner, `${key.name} is an owner input`);
            assert.deepStrictEqual(Object.keys(owner).sort(), ['get_it_at', 'get_it_how', 'group', 'test', 'unlocks'], `${key.name} carries exactly the five members`);
            assert.strictEqual(owner.group, 'email', `${key.name} is in the email group`);
            assert.ok(OWNER_INPUT_GROUPS[owner.group], 'the email group is one the shared list knows');
            assert.ok(owner.unlocks && owner.unlocks.length > 10, `${key.name} says what it opens`);
            assert.ok(/^https:\/\//.test(owner.get_it_at), `${key.name} names an https page`);
            assert.strictEqual(owner.test, true, `${key.name} has a test`);
            required.add(prop['x-required-for']);
        }
        assert.strictEqual(required.size, 1, `${provider.name} is one row: its fields share one x-required-for`);
    }
});

test('the schemas pass the shared lint', async () => {
    for (const schema of [SENDING_SCHEMA, RECEIVING_SCHEMA, DNS_SCHEMA]) {
        const problems = lintSchema(schema);
        assert.deepStrictEqual(problems, [], `the schema of ${schema.title} is clean`);
    }
});

// ── the tests of the providers ──────────────────────────────────────────────────────────────────────────────────

test('a provider test reads the provider once and never sends', async () => {
    const { settings, calls, set } = await makeSettings();
    await set('sending', {}, { resend_api_key: 're_sentinel' });
    const answer = await settings.test(SENDING_NAMESPACE, 'resend_api_key');
    assert.strictEqual(answer.ok, true, answer.message);
    assert.ok(/Resend answered/.test(answer.message), 'the answer says what Resend said');
    assert.ok(!answer.message.includes('re_sentinel'), 'the key is not in the answer');
    const reads = calls.filter((call) => call.matched);
    assert.strictEqual(reads.length, 1, 'one read, no more');
    assert.strictEqual(reads[0].method, 'GET', 'the read is a GET: nothing is sent');
    assert.strictEqual(reads[0].headers.authorization, 'Bearer re_sentinel', 'the key is used as the provider asks');
});

test('every sending provider has a read of its own that never sends', async () => {
    // The SMTP relay is proved on its own below, against a small server that answers here: the probe opens no
    // socket to the internet in a test.
    const { settings, calls, set } = await makeSettings({
        probes: { smtp: async () => ({ ok: true, detail: 'the relay at smtp.example.com:587 accepted the sign-in (no letter was sent).' }) },
    });
    await set('receiving', { cloudflare_email_routing_domain: 'openvibe.email' }, { cloudflare_email_routing_token: 'cf-sentinel' });
    await set('sending', {
        ses_region: 'eu-west-1',
        smtp_host: 'smtp.example.com',
        smtp_port: '587',
        smtp_user: 'owner@openvibe.email',
    }, {
        ses_access_key_id: 'AKIA-sentinel',
        ses_secret_access_key: 'wJalr-sentinel',
        postmark_server_token: 'pm-sentinel',
        resend_api_key: 're-sentinel',
        mailgun_api_key: 'key-sentinel',
        sendgrid_api_key: 'SG-sentinel',
        brevo_api_key: 'xkeysib-sentinel',
        smtp_password: 'smtp-sentinel',
    });
    const answered = [];
    for (const provider of [...PROVIDERS]) {
        const key = provider.keys[0].name;
        const answer = await settings.test(provider.id === 'cloudflare-routing' ? RECEIVING_NAMESPACE : SENDING_NAMESPACE, key);
        assert.strictEqual(answer.ok, true, `${provider.name}: ${answer.message}`);
        assert.ok(!/sentinel/.test(answer.message), `${provider.name} keeps its keys out of the answer`);
        answered.push(provider.name);
    }
    assert.strictEqual(answered.length, 8, 'seven sending rows and the receiving row all answered');
    for (const call of calls.filter((c) => c.matched)) {
        assert.ok(['GET', 'POST'].includes(call.method), 'no provider was asked to send');
    }
    // Amazon SES is asked for its identities with a signed request, not for a message.
    const ses = calls.find((c) => c.url.startsWith('https://email.eu-west-1.amazonaws.com'));
    assert.ok(ses, 'Amazon SES was asked');
    assert.ok(/AWS4-HMAC-SHA256/.test(String(ses.headers.authorization)), 'the request is signed the way Amazon asks');
});

test('the SMTP relay signs in and stops: no letter is sent', async () => {
    const seen = [];
    const server = net.createServer((socket) => {
        socket.write('220 smtp.example.com ready\r\n');
        let buffer = '';
        socket.on('data', (chunk) => {
            buffer += chunk.toString('utf8');
            let index = buffer.indexOf('\r\n');
            while (index >= 0) {
                const line = buffer.slice(0, index);
                buffer = buffer.slice(index + 2);
                seen.push(line);
                if (/^EHLO/i.test(line)) socket.write('250-smtp.example.com\r\n250 AUTH PLAIN\r\n');
                else if (/^AUTH/i.test(line)) socket.write('235 2.7.0 signed in\r\n');
                else if (/^QUIT/i.test(line)) { socket.write('221 bye\r\n'); socket.end(); }
                else socket.write('250 ok\r\n');
                index = buffer.indexOf('\r\n');
            }
        });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    try {
        const answer = await PROBES.smtp({ host: '127.0.0.1', port: String(port), user: 'owner@example.com', password: 'secret-sentinel' }, {});
        assert.strictEqual(answer.ok, true);
        assert.ok(/accepted the sign-in/.test(answer.detail));
        assert.ok(seen.some((line) => /^AUTH PLAIN/i.test(line)), 'the relay was asked for the sign-in');
        assert.ok(!seen.some((line) => /^MAIL FROM/i.test(line)), 'no letter was started');
        assert.ok(!seen.some((line) => /^DATA/i.test(line)), 'no letter was sent');
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
});

test('a provider that refuses answers in one line, with the key cut out', async () => {
    const answers = { ...RECORDED, 'https://api.resend.com/domains': { status: 401, body: { message: 'API key is invalid' } } };
    const { settings, set } = await makeSettings({ answers });
    await set('sending', {}, { resend_api_key: 're_sentinel' });
    const answer = await settings.test(SENDING_NAMESPACE, 'resend_api_key');
    assert.strictEqual(answer.ok, false);
    assert.ok(answer.message.startsWith('failed — '), 'the answer says it failed');
    assert.ok(/Resend said/.test(answer.message), 'the answer names the provider');
    assert.ok(!answer.message.includes('re_sentinel'), 'the key is not in the answer');
    assert.ok(answer.message.length < 300, 'the answer is one line');
});

test('a provider without its key says which key to paste first', async () => {
    const { settings } = await makeSettings();
    const answer = await settings.test(SENDING_NAMESPACE, 'postmark_server_token');
    assert.strictEqual(answer.ok, false);
    assert.ok(/paste the Postmark server token first/.test(answer.message), answer.message);
});

// ── the DNS check ───────────────────────────────────────────────────────────────────────────────────────────────

test('the DNS check reads the records live and names the missing one with its exact value', async () => {
    const lookups = {
        txt: async (host) => ({
            'example.com': ['v=spf1 include:old.example -all'],
            '_dmarc.example.com': [],
            'default._bimi.example.com': [],
            '_domainkey.example.com': [],
        }[host] || []),
        mx: async () => [],
    };
    const { settings, set } = await makeSettings({ lookups });
    await set('sending', {}, { resend_api_key: 're_sentinel' });
    await set('dns', { dns_check_domain: 'example.com' });
    const answer = await settings.test(DNS_NAMESPACE, 'dns_check_domain');
    assert.strictEqual(answer.ok, false, 'something is missing');
    assert.ok(answer.message.includes('v=spf1 include:sendgrid.net -all'), 'the SPF record to add is named with its exact value');
    assert.ok(answer.message.includes('_dmarc.example.com'), 'the DMARC record to add is named');
    assert.ok(answer.message.includes('v=DMARC1; p=none; rua=mailto:dmarc@example.com'), 'the DMARC value to add is exact');
    assert.ok(answer.message.includes('DKIM'), 'the DKIM record is named too');
    assert.ok(answer.message.length <= 300, 'the answer fits the Setup tab');
    const dmarc = answer.lines.find((line) => line.name === 'DMARC');
    assert.strictEqual(dmarc.add.type, 'TXT');
    assert.strictEqual(dmarc.add.name, '_dmarc.example.com');
});

test('the DNS check says so when every record is there', async () => {
    const lookups = {
        txt: async (host) => ({
            'example.com': ['v=spf1 include:sendgrid.net -all'],
            '_dmarc.example.com': ['v=DMARC1; p=none; rua=mailto:dmarc@example.com'],
            'default._bimi.example.com': ['v=BIMI1; l=https://example.com/logo.svg'],
            '_domainkey.example.com': ['v=DKIM1; k=rsa; p=abc'],
        }[host] || []),
        mx: async () => [{ exchange: 'mx1.openvibe.email', priority: 10 }],
    };
    const { settings, set } = await makeSettings({ lookups });
    await set('dns', { dns_check_domain: 'example.com' });
    const answer = await settings.test(DNS_NAMESPACE, 'dns_check_domain');
    assert.strictEqual(answer.ok, true, answer.message);
    assert.ok(/SPF ok/.test(answer.message), answer.message);
});

// ── the route the Setup tab calls ──────────────────────────────────────────────────────────────────────────────

test('the test route answers one line, in the shape the Setup tab reads', async () => {
    const { settings, set } = await makeSettings();
    await set('sending', {}, { resend_api_key: 're_sentinel' });
    const app = express();
    app.use(express.json({ limit: '64kb' }));
    settings.mount(app, { guard: (req, res, next) => next(), log: quiet });
    const server = await new Promise((resolve) => {
        const s = http.createServer(app);
        s.listen(0, '127.0.0.1', () => resolve(s));
    });
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
        const res = await fetch(`${base}/internal/config/mail.sending/test/resend_api_key`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
        const body = await res.json();
        assert.strictEqual(res.status, 200);
        assert.strictEqual(body.ok, true, body.message);
        assert.ok(typeof body.message === 'string' && body.message.length > 10, 'the answer is a line the Setup tab shows');
        assert.ok(!body.message.includes('re_sentinel'), 'the key is not in the answer');
        const missing = await fetch(`${base}/internal/config/mail.sending/test/nope`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
        assert.strictEqual(missing.status, 404);
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
});

(async () => {
    let failed = 0;
    for (const t of tests) {
        try {
            await t.fn();
            console.log(`ok — ${t.name}`);
        } catch (err) {
            failed += 1;
            console.error(`not ok — ${t.name}`);
            console.error(String(err && err.stack ? err.stack : err).split('\n').slice(0, 6).join('\n'));
        }
    }
    console.log(`${tests.length - failed}/${tests.length} checks passed`);
    process.exit(failed ? 1 : 0);
})();
