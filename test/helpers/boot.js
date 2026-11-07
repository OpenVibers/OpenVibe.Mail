'use strict';

/**
 * Boots OpenVibe.Mail on a temporary database with a stand-in for Network and a stand-in for the mail server,
 * captures the log lines, and returns a small HTTP client.
 *
 *   const t = await boot();
 *   t.post('/api/v1/masks', { json: { label: 'amazon' }, as: alice })
 *   t.get('/api/v1/burners/:id/code', { as: alice })
 *   t.logs()        the lines the service wrote
 *   t.mail.deliver(...)   a message arrives
 */
const http = require('http');
const { startNetwork } = require('./network');
const { createFakeStalwart } = require('./stalwart');
const { testDb } = require('./db');

async function boot(opts = {}) {
    const network = await startNetwork();
    const mail = opts.stalwart || createFakeStalwart();
    const captured = [];

    const log = {
        log: (...a) => captured.push(a.map(String).join(' ')),
        info: (...a) => captured.push(a.map(String).join(' ')),
        warn: (...a) => captured.push(a.map(String).join(' ')),
        error: (...a) => captured.push(a.map(String).join(' ')),
    };

    const configLib = require('../../server/config');
    const config = configLib.load({
        NODE_ENV: 'test',
        PORT: '0',
        BASE_URL: 'https://openvibe.email',
        TRUST_PROXY: '1',
        OV_NETWORK_URL: network.url,
        OV_NETWORK_INTERNAL_URL: network.url,
        OV_NETWORK_ISSUER: network.url,
        MAIL_BASE_DOMAIN: 'openvibe.email',
        MAIL_MASK_DOMAIN: 'mask.openvibe.email',
        BURNER_DOMAINS: 'burn1.openvibe.email,burn2.openvibe.email',
        MAIL_API_RATE_LIMIT_PER_MIN: '100000',
        MAIL_MAX_MASKS: '20',
        MAIL_MAX_LIVE_BURNERS: '5',
        MAIL_BURNERS_PER_IP_HOUR: '10',
        MAIL_ANON_BURNER_TTL_MINUTES: '10',
        ...(opts.env || {}),
    });

    const { createStore } = require('../../server/db');
    const store = createStore((await testDb()).db, { now: opts.now });

    const { createApp } = require('../../server/app');
    const built = await createApp({ config, store, stalwart: mail, log });
    await built.ctx.keys.ensure();

    const server = await new Promise((resolve) => {
        const s = http.createServer(built.app);
        s.listen(0, '127.0.0.1', () => resolve(s));
    });
    const base = `http://127.0.0.1:${server.address().port}`;

    async function call(method, p, o = {}) {
        const headers = { ...(o.headers || {}) };
        if (o.as) headers.authorization = `Bearer ${network.userToken(o.as)}`;
        if (o.bearer) headers.authorization = `Bearer ${o.bearer}`;
        if (o.token) headers['x-mail-burner-token'] = o.token;
        let body;
        if (o.json !== undefined) {
            body = JSON.stringify(o.json);
            headers['content-type'] = 'application/json';
        }
        const res = await fetch(`${base}${p}`, { method, headers, body });
        const text = await res.text();
        let parsed = null;
        try { parsed = JSON.parse(text); } catch { /* not json */ }
        return { status: res.status, body: parsed, text, headers: res.headers };
    }

    return {
        network,
        mail,
        store,
        config,
        db: store.db,
        logs: () => captured.slice(),
        clearLogs: () => { captured.length = 0; },
        get: (p, o) => call('GET', p, o),
        post: (p, o) => call('POST', p, o),
        del: (p, o) => call('DELETE', p, o),
        close: async () => {
            await new Promise((r) => server.close(r));
            await network.close();
            await store.close();
        },
    };
}

module.exports = { boot };
