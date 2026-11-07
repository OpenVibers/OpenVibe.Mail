'use strict';

/**
 * The M1 acceptance test against the real Stalwart binary and PostgreSQL. Blobs go to a temporary local directory
 * (M1's fs store); with STALWART_BLOB_STORE=s3 the same run uses MinIO.
 *
 * It is the one place the directory views meet the server that reads them:
 *   * SMTP to a burner lands, and /code returns the code;
 *   * after expiry the burner's mail is deleted and the address bounces;
 *   * mail to a disabled mask bounces;
 *   * somebody else gets 404 for a mask, a burner and an agent inbox;
 *   * no message body (and no code) is written to the service's log.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const http = require('http');

const { start, testEnv, waitFor, sleep } = require('./helpers/stalwart');
const { createClient } = require('../../deploy/stalwart/apply');
const { ensureDatabase, resetSchema, urlFor } = require('./helpers/pg');
const { ensureBucket, listKeys } = require('./helpers/s3');
const { send, sendMany } = require('./helpers/smtp');
const { startNetwork } = require('../helpers/network');

const env = testEnv();
Object.assign(process.env, env);

let stalwart;
let network;
let store;
let server;
let base;
let logs;
let built;

const configLib = require('../../server/config');
const { openDb, createStore } = require('../../server/db');
const { createApp } = require('../../server/app');
const { createStalwartClient } = require('../../server/stalwart/client');
const { runDue } = require('../../server/jobs/purge');

function blobFiles() {
    if (!stalwart || !stalwart.blobDir) return 0;
    let count = 0;
    for (const entry of fs.readdirSync(stalwart.blobDir, { recursive: true, withFileTypes: true })) {
        if (entry.isFile()) count += 1;
    }
    return count;
}

/**
 * Ask the mail server to run its blob purge now. On its normal schedule it runs once a day, so the acceptance test
 * would otherwise see the message's blob for up to a day after the account is gone.
 */
async function purgeBlobs() {
    const client = createClient({
        url: stalwart.url,
        user: stalwart.env.STALWART_ADMIN_USER,
        password: stalwart.env.STALWART_ADMIN_PASSWORD,
    });
    await client.one('x:Task/set', {
        create: {
            purge: {
                '@type': 'StoreMaintenance',
                maintenanceType: 'purgeBlob',
                status: { '@type': 'Pending' },
            },
        },
    }, 'pb');
}

function captureLog() {
    const lines = [];
    const push = (...a) => lines.push(a.map((x) => String(x)).join(' '));
    return { lines, log: { log: push, info: push, warn: push, error: push } };
}

async function call(method, p, o = {}) {
    const headers = { ...(o.headers || {}) };
    if (o.as) headers.authorization = `Bearer ${network.userToken(o.as)}`;
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
    return { status: res.status, body: parsed, text };
}

async function waitForCode(id, o = {}) {
    let last = null;
    for (let i = 0; i < 40; i++) {
        last = await call('GET', `/api/v1/burners/${id}/code`, o);
        if (last.status === 200) return last;
        await sleep(250);
    }
    return last;
}

async function waitForMessages(id, o = {}) {
    let last = null;
    for (let i = 0; i < 40; i++) {
        last = await call('GET', `/api/v1/burners/${id}/messages`, o);
        if (last.status === 200 && last.body.messages.length) return last;
        await sleep(250);
    }
    return last;
}

async function waitForAgentMessages(id, o = {}) {
    let last = null;
    for (let i = 0; i < 40; i++) {
        last = await call('GET', `/api/v1/agent-inboxes/${id}/messages`, o);
        if (last.status === 200 && last.body.messages.length) return last;
        await sleep(250);
    }
    return last;
}

test.before(async () => {
    await ensureDatabase(env);
    await resetSchema(env);
    if (String(env.STALWART_BLOB_STORE || 'fs').toLowerCase() === 's3') ensureBucket();
    stalwart = await start({ env });

    network = await startNetwork();
    const databaseUrl = urlFor(env.STALWART_TEST_DB || 'ov_mail_test', env);
    const config = configLib.load({
        ...env,
        NODE_ENV: 'test',
        DATABASE_URL: databaseUrl,
        DATABASE_DIRECT_URL: databaseUrl,
        OV_NETWORK_URL: network.url,
        OV_NETWORK_INTERNAL_URL: network.url,
        OV_NETWORK_ISSUER: network.url,
        MAIL_BASE_DOMAIN: 'openvibe.test',
        MAIL_MASK_DOMAIN: 'mask.openvibe.test',
        BURNER_DOMAINS: 'burn1.openvibe.test,burn2.openvibe.test',
        STALWART_URL: stalwart.url,
        STALWART_ADMIN_PASSWORD: env.STALWART_ADMIN_PASSWORD,
        MAIL_API_RATE_LIMIT_PER_MIN: '100000',
        MAIL_MAX_MASKS: '20',
        MAIL_MAX_LIVE_BURNERS: '5',
        MAIL_MAX_LIVE_ANON_BURNERS: '1000',
        MAIL_BURNERS_PER_IP_HOUR: '1000',
    });
    const db = await openDb(config);
    store = createStore(db);

    const captured = captureLog();
    logs = captured.lines;
    const realStalwart = createStalwartClient({ config, log: captured.log });
    built = await createApp({ config, store, stalwart: realStalwart, log: captured.log });
    await built.ctx.keys.ensure();

    server = await new Promise((resolve) => {
        const s = http.createServer(built.app);
        s.listen(0, '127.0.0.1', () => resolve(s));
    });
    base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
    if (server) await new Promise((r) => server.close(r));
    if (network) await network.close();
    if (store) await store.close();
    if (stalwart) await stalwart.stop();
});

test('SMTP to a burner lands, the code endpoint returns it, and the log has no body', async () => {
    const alice = network.addUser('alice');
    const made = await call('POST', '/api/v1/burners', { as: alice, json: { expires: '1h' } });
    assert.strictEqual(made.status, 201);
    const burner = made.body.burner;

    const code = '918273';
    const secret = 'hunter2-do-not-log-this';
    await send({
        port: stalwart.smtpPort,
        to: burner.address,
        subject: 'Your verification code',
        text: `Your verification code is ${code}. The secret phrase is ${secret}.`,
    });

    const found = await waitForCode(burner.id, { as: alice });
    assert.strictEqual(found.status, 200);
    assert.strictEqual(found.body.code, code);

    const messages = await waitForMessages(burner.id, { as: alice });
    assert.strictEqual(messages.status, 200);
    assert.ok(messages.body.messages.length >= 1);
    assert.strictEqual(messages.body.messages[0].preview, undefined, 'a message summary has no preview');
    assert.strictEqual(messages.body.messages[0].body, undefined, 'a message summary has no body');

    const text = logs.join('\n');
    assert.ok(!text.includes(secret), 'no message body is in a log line');
    assert.ok(!text.includes(code), 'not even the code is in a log line');

    const events = await store.db.many("SELECT envelope FROM event_outbox WHERE envelope->>'event_type' = 'mail.received'");
    assert.ok(events.length >= 1);
    assert.ok(!('subject' in events[0].envelope.payload), 'mail.received carries no subject');
    assert.ok(!('body' in events[0].envelope.payload), 'mail.received carries no body');

    if (stalwart.env.STALWART_BLOB_STORE === 's3') {
        assert.ok(listKeys().length > 0, 'Stalwart wrote the message into the S3 blob store');
    } else {
        assert.ok(blobFiles() > 0, 'Stalwart wrote the message onto the local filesystem blob store');
        assert.match(stalwart.blobDir, /ov-mail-blobs-/);
    }
});

test('a burner made for one message stops accepting after the first', async () => {
    const alice = network.addUser('alice');
    const made = await call('POST', '/api/v1/burners', { as: alice, json: { expires: '1h', first_message_only: true } });
    const burner = made.body.burner;

    await send({ port: stalwart.smtpPort, to: burner.address, subject: 'one', text: 'code 112233' });
    const messages = await waitForMessages(burner.id, { as: alice });
    assert.strictEqual(messages.status, 200);

    await sleep(500);
    await assert.rejects(
        send({ port: stalwart.smtpPort, to: burner.address, subject: 'two', text: 'code 445566' }),
        (err) => err.refused === true && err.smtp && err.smtp.code === 550,
        'the second message is refused',
    );
});

test('forged To, Cc and Delivered-To never move a message to another burner', async () => {
    const alice = network.addUser('alice');
    const a = (await call('POST', '/api/v1/burners', { as: alice, json: { expires: '1h' } })).body.burner;
    const b = (await call('POST', '/api/v1/burners', { as: alice, json: { expires: '1h' } })).body.burner;

    await send({
        port: stalwart.smtpPort,
        to: a.address,
        toHeader: b.address,
        cc: b.address,
        extraHeaders: [`Delivered-To: ${b.address}`],
        subject: 'forged headers',
        text: 'Your verification code is 303030',
    });

    const aCode = await waitForCode(a.id, { as: alice });
    assert.strictEqual(aCode.status, 200, 'the real recipient gets its code');
    assert.strictEqual(aCode.body.code, '303030');
    const bMessages = await call('GET', `/api/v1/burners/${b.id}/messages`, { as: alice });
    assert.strictEqual(bMessages.status, 200);
    assert.deepStrictEqual(bMessages.body.messages, [], 'the forged recipient has no message');
    const bCode = await call('GET', `/api/v1/burners/${b.id}/code`, { as: alice });
    assert.strictEqual(bCode.status, 404, 'the forged recipient has no code');
});

test('three hundred messages to one burner do not hide another burner\'s message', async () => {
    const alice = network.addUser('alice');
    const a = (await call('POST', '/api/v1/burners', { as: alice, json: { expires: '1h' } })).body.burner;
    const b = (await call('POST', '/api/v1/burners', { as: alice, json: { expires: '1h' } })).body.burner;

    // Stalwart's default MtaStageData.maxMessages is 10 per SMTP session; use 30 sessions of 10.
    for (let batch = 0; batch < 30; batch++) {
        await sendMany({
            port: stalwart.smtpPort,
            count: 10,
            to: a.address,
            subject: (i) => `bulk ${batch}-${i}`,
            text: 'bulk message',
        });
    }
    await send({
        port: stalwart.smtpPort,
        to: b.address,
        subject: 'the one that matters',
        text: 'Your verification code is 404040',
    });

    const code = await waitForCode(b.id, { as: alice });
    assert.strictEqual(code.status, 200);
    assert.strictEqual(code.body.code, '404040');
});

test('after expiry the burner bounces and its mail is deleted', async () => {
    const alice = network.addUser('alice');
    const made = await call('POST', '/api/v1/burners', { as: alice, json: { expires: '1h' } });
    const burner = made.body.burner;
    await send({ port: stalwart.smtpPort, to: burner.address, subject: 'code', text: 'Your code is 778899' });
    await waitForCode(burner.id, { as: alice });

    const blobsBefore = stalwart.env.STALWART_BLOB_STORE === 's3' ? listKeys().length : blobFiles();
    assert.ok(blobsBefore > 0, 'the message has a blob before the purge');

    await store.db.exec("UPDATE mail_burners SET expires_at = now() - interval '1 second' WHERE id = $1", [burner.id]);
    const report = await runDue({ db: store.db, stalwart: built.ctx.stalwart, events: built.ctx.events, now: () => Date.now() });
    assert.strictEqual(report.expired, 1);

    await purgeBlobs();
    const blobCount = () => (stalwart.env.STALWART_BLOB_STORE === 's3' ? listKeys().length : blobFiles());
    await waitFor(async () => blobCount() < blobsBefore, { timeoutMs: 30_000, what: 'the blob purge' });
    assert.ok(blobCount() < blobsBefore, 'the blob purge removed the burner message blob');

    await assert.rejects(
        send({ port: stalwart.smtpPort, to: burner.address, subject: 'late', text: 'too late' }),
        (err) => err.refused === true && err.smtp && err.smtp.code === 550,
        'the expired address bounces',
    );
    assert.strictEqual(await store.db.value('SELECT count(*)::int FROM mail_burners WHERE id = $1', [burner.id]), 0);
});

test('mail to a disabled mask bounces', async () => {
    const alice = network.addUser('alice');
    const made = await call('POST', '/api/v1/masks', { as: alice, json: { label: 'shop' } });
    const mask = made.body.mask;
    await send({ port: stalwart.smtpPort, to: mask.address, subject: 'hello', text: 'a letter' });

    const off = await call('DELETE', `/api/v1/masks/${mask.id}`, { as: alice });
    assert.strictEqual(off.status, 200);
    assert.strictEqual(off.body.mask.enabled, false);

    await assert.rejects(
        send({ port: stalwart.smtpPort, to: mask.address, subject: 'no', text: 'a late letter' }),
        (err) => err.refused === true && err.smtp && err.smtp.code === 550,
        'the disabled mask bounces',
    );
});

test('another person gets 404 for a mask, a burner and an agent inbox', async () => {
    const alice = network.addUser('alice');
    const bob = network.addUser('bob');

    const mask = (await call('POST', '/api/v1/masks', { as: alice, json: { label: 'private' } })).body.mask;
    const burner = (await call('POST', '/api/v1/burners', { as: alice, json: { expires: '1h' } })).body.burner;
    const inbox = (await call('POST', '/api/v1/agent-inboxes', { as: alice, json: { agent_id: 'weather' } })).body.agent_inbox;

    assert.strictEqual((await call('GET', `/api/v1/masks/${mask.id}`, { as: bob })).status, 404);
    assert.strictEqual((await call('GET', `/api/v1/burners/${burner.id}/messages`, { as: bob })).status, 404);
    assert.strictEqual((await call('GET', `/api/v1/burners/${burner.id}/code`, { as: bob })).status, 404);
    assert.strictEqual((await call('GET', `/api/v1/agent-inboxes/${inbox.id}/messages`, { as: bob })).status, 404);
});

test('an agent inbox receives and reads its own mail', async () => {
    const alice = network.addUser('alice');
    const made = await call('POST', '/api/v1/agent-inboxes', { as: alice, json: { agent_id: 'forecast' } });
    assert.strictEqual(made.status, 201);
    const inbox = made.body.agent_inbox;
    assert.match(inbox.address, /^forecast\.alice@openvibe\.test$/);

    await send({ port: stalwart.smtpPort, to: inbox.address, subject: 'A question', text: 'What is the weather?' });
    const messages = await waitForAgentMessages(inbox.id, { as: alice });
    assert.strictEqual(messages.status, 200);
    assert.strictEqual(messages.body.messages.length, 1);
    assert.strictEqual(messages.body.messages[0].subject, 'A question');
    assert.strictEqual(messages.body.messages[0].body, undefined);
});

test('a forged Delivered-To does not move mail between two agent inboxes on one mailbox', async () => {
    const alice = network.addUser('alice');
    const alpha = (await call('POST', '/api/v1/agent-inboxes', { as: alice, json: { agent_id: 'alpha' } })).body.agent_inbox;
    const beta = (await call('POST', '/api/v1/agent-inboxes', { as: alice, json: { agent_id: 'beta' } })).body.agent_inbox;

    await send({
        port: stalwart.smtpPort,
        to: alpha.address,
        toHeader: beta.address,
        cc: beta.address,
        extraHeaders: [`Delivered-To: ${beta.address}`],
        subject: 'for alpha',
        text: 'What is the weather?',
    });

    const alphaMessages = await waitForAgentMessages(alpha.id, { as: alice });
    assert.strictEqual(alphaMessages.status, 200);
    assert.strictEqual(alphaMessages.body.messages.length, 1);
    const betaMessages = await call('GET', `/api/v1/agent-inboxes/${beta.id}/messages`, { as: alice });
    assert.strictEqual(betaMessages.status, 200);
    assert.deepStrictEqual(betaMessages.body.messages, [], 'the forged headers do not reach beta');
});

test('a ten-minute burner works without an account, read with its token', async () => {
    const made = await call('POST', '/api/v1/burners', { json: { expires: '10m' } });
    assert.strictEqual(made.status, 201);
    assert.strictEqual(made.body.burner.owner, null);
    assert.ok(made.body.token && made.body.token.startsWith('mbt_'));

    await send({ port: stalwart.smtpPort, to: made.body.burner.address, subject: 'Your code', text: 'Your verification code is 667788' });
    const code = await waitForCode(made.body.burner.id, { token: made.body.token });
    assert.strictEqual(code.status, 200);
    assert.strictEqual(code.body.code, '667788');

    const without = await call('GET', `/api/v1/burners/${made.body.burner.id}/code`);
    assert.strictEqual(without.status, 404, 'the burner is not readable without its token');
});
