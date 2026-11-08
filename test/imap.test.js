'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { sql } = require('openvibe-sdk/db');
const { createSafeLookup } = require('openvibe-shared/egress');
const { boot } = require('./helpers/boot');
const { createClient, assertPublicTarget } = require('../server/imap/client');
const { sealSecret, openSecret } = require('../server/domain/imap-secrets');
const { validateInput, plainError } = require('../server/domain/imap-connections');
const { runImapPull } = require('../server/jobs/imap-pull');

const SECRET = 'app-pass-do-not-leak';

/** A stand-in for server/imap/client.js: the test decides what the test connection and each poll see. */
function fakeImap({ testError = null, testResult = { uid_validity: '7', uid_next: 1 }, openError = null, sessions = [] } = {}) {
    const calls = { tested: 0, opened: 0 };
    return {
        calls,
        async testConnection() {
            calls.tested += 1;
            if (testError) throw testError;
            return testResult;
        },
        async createSession(args) {
            calls.opened += 1;
            if (openError) throw openError;
            const session = sessions.shift();
            if (!session) throw new Error('no fake session left');
            session.args = args;
            return session;
        },
    };
}

function fakeSession({ uidValidity = '7', uidNext = 10, messages = [], highestUid = null } = {}) {
    const calls = { fetch: 0, close: 0 };
    return {
        uidValidity,
        uidNext,
        calls,
        async fetchNew({ afterUid = 0, limit = 50 } = {}) {
            calls.fetch += 1;
            const fresh = messages.filter((m) => m.uid > afterUid).sort((a, b) => a.uid - b.uid).slice(0, limit);
            const highest = highestUid == null ? messages.reduce((max, m) => Math.max(max, m.uid), afterUid) : highestUid;
            return { messages: fresh, highestUid: highest };
        },
        async close() { calls.close += 1; },
    };
}

function message(uid, subject = `Subject ${uid}`, from = 'sender@example.net') {
    return { uid, id: `imap:${uid}`, threadId: `imap:${uid}`, subject, from: [from], receivedAt: '2026-11-08T10:00:00.000Z', text: `body ${uid}` };
}

/** A person with a mailbox, Inbox AI on and one connected IMAP mailbox. */
async function connect(s, imap, { host = 'imap.example.net', username = 'person@example.net', password = SECRET } = {}) {
    const alice = s.network.addUser('alice');
    await s.post('/api/v1/masks', { as: alice, json: { label: 'shop' } });
    await s.put('/api/v1/me/mail/ai-settings', { as: alice, json: { enabled: true } });
    const made = await s.post('/api/v1/me/mail/imap-mailboxes', { as: alice, json: { host, port: 993, username, password } });
    assert.strictEqual(made.status, 201, made.text);
    return { alice, mailbox: made.body.mailbox };
}

/** Make every connection due now and drop the run lease: a second run in a test must not wait five minutes. */
async function makeDue(db) {
    await db.exec(sql`UPDATE mail_imap_mailboxes SET next_sync_at = now() - interval '1 second'`);
    await db.exec(sql`DELETE FROM mail_settings WHERE key = 'imap_pull_lease'`);
}

test('TLS is required, a private target is refused, and the seal is bound to its owner', async () => {
    assert.throws(
        () => createClient({ host: 'imap.example.net', username: 'u', password: 'p', secure: false }),
        (err) => err.code === 'IMAP_TLS_REQUIRED',
    );
    assert.throws(() => validateInput({ host: '127.0.0.1', username: 'u', password: 'p' }), /host name/);
    assert.throws(() => validateInput({ host: 'localhost', username: 'u', password: 'p' }), /host name/);
    assert.throws(() => validateInput({ host: 'imap.example.net', username: 'u', password: '' }), /app password/);
    assert.deepStrictEqual(validateInput({ host: 'IMAP.Gmail.com.', port: '993', username: ' u@example.net ', password: 'x' }), {
        host: 'imap.gmail.com', port: 993, username: 'u@example.net', password: 'x',
    });

    // A name that answers a private address is refused by the resolver the TLS socket uses.
    const privateLookup = createSafeLookup({ lookup: (_host, _opts, cb) => cb(null, [{ address: '10.0.0.5', family: 4 }]) });
    await assert.rejects(
        assertPublicTarget('imap.example.net', { lookup: privateLookup }),
        (err) => err.code === 'EGRESS_DENIED',
    );

    const key = Buffer.alloc(32, 9).toString('base64');
    const sealed = sealSecret({ key, owner: 'alice', id: 'imap_1', plaintext: SECRET });
    assert.ok(!sealed.includes(SECRET));
    assert.strictEqual(openSecret({ key, owner: 'alice', id: 'imap_1', sealed }), SECRET);
    assert.throws(() => openSecret({ key, owner: 'bob', id: 'imap_1', sealed }), (err) => err.code === 'IMAP_SECRET_UNREADABLE');
});

test('connecting tests first, seals the password, and no answer or log carries it', async (t) => {
    const imap = fakeImap();
    const s = await boot({ imap });
    t.after(() => s.close());
    const alice = s.network.addUser('alice');
    await s.post('/api/v1/masks', { as: alice, json: { label: 'shop' } });

    // Inbox AI is off: a connection is refused before any outbound socket opens.
    const off = await s.post('/api/v1/me/mail/imap-mailboxes', {
        as: alice, json: { host: 'imap.example.net', username: 'person@example.net', password: SECRET },
    });
    assert.strictEqual(off.status, 409);
    assert.strictEqual(imap.calls.tested, 0);

    await s.put('/api/v1/me/mail/ai-settings', { as: alice, json: { enabled: true } });
    const made = await s.post('/api/v1/me/mail/imap-mailboxes', {
        as: alice, json: { host: 'imap.example.net', username: 'person@example.net', password: SECRET },
    });
    assert.strictEqual(made.status, 201, made.text);
    assert.strictEqual(imap.calls.tested, 1);

    const listed = await s.get('/api/v1/me/mail/imap-mailboxes', { as: alice });
    assert.strictEqual(listed.status, 200);
    assert.strictEqual(listed.body.mailboxes.length, 1);
    for (const answer of [made.text, listed.text]) assert.ok(!answer.includes(SECRET), 'the password is in an answer');
    assert.ok(!s.logs().join('\n').includes(SECRET), 'the password is in a log line');

    const sealed = await s.db.value('SELECT secret FROM mail_imap_mailboxes WHERE owner_subject = $1', [alice.subject]);
    assert.notStrictEqual(sealed, SECRET);
    assert.ok(!String(sealed).includes(SECRET));
    assert.strictEqual(openSecret({ key: s.config.secrets.key, owner: alice.subject, id: listed.body.mailboxes[0].id, sealed }), SECRET);
});

test('a failed test leaves no row and answers one plain sentence', async (t) => {
    const refused = Object.assign(new Error(`AUTHENTICATIONFAILED for ${SECRET}`), { authenticationFailed: true });
    const imap = fakeImap({ testError: refused });
    const s = await boot({ imap });
    t.after(() => s.close());
    const alice = s.network.addUser('alice');
    await s.post('/api/v1/masks', { as: alice, json: { label: 'shop' } });
    await s.put('/api/v1/me/mail/ai-settings', { as: alice, json: { enabled: true } });

    const made = await s.post('/api/v1/me/mail/imap-mailboxes', {
        as: alice, json: { host: 'imap.example.net', username: 'person@example.net', password: SECRET },
    });
    assert.strictEqual(made.status, 422);
    assert.match(made.body.detail, /Could not sign in/);
    assert.ok(!made.text.includes(SECRET));
    assert.ok(!s.logs().join('\n').includes(SECRET));
    const rows = await s.db.many(sql`SELECT id FROM mail_imap_mailboxes`);
    assert.strictEqual(rows.length, 0, 'a failed test must not save a connection');
    assert.strictEqual(plainError(refused), 'Could not sign in. Check the username and the app password.');
});

test('the poll resumes from last_uid and skips a junk message without rereading it', async (t) => {
    // First poll: uid 2 and 4 are read; uid 3 is junk on the remote server and only moves the position.
    const first = fakeSession({ uidValidity: '7', uidNext: 5, messages: [message(2), message(4)], highestUid: 4 });
    const second = fakeSession({ uidValidity: '7', uidNext: 6, messages: [message(5)], highestUid: 5 });
    const imap = fakeImap({ sessions: [first, second] });
    const s = await boot({ imap });
    t.after(() => s.close());
    const { alice } = await connect(s, imap);
    const seen = [];
    const analyze = async ({ owner, message: input }) => {
        assert.strictEqual(owner, alice.subject);
        seen.push(input.uid);
        return { category: 'to_read', summary: `Summary ${input.uid}` };
    };

    const one = await runImapPull({ db: s.db, config: s.config, imap, analyze });
    assert.strictEqual(one.pulled, 2);
    assert.deepStrictEqual(seen, [2, 4]);
    const row = await s.db.maybe(sql`SELECT uid_validity, last_uid FROM mail_imap_mailboxes`);
    assert.strictEqual(row.uid_validity, '7');
    assert.strictEqual(Number(row.last_uid), 4);

    await makeDue(s.db);
    const two = await runImapPull({ db: s.db, config: s.config, imap, analyze });
    assert.strictEqual(two.pulled, 1, 'only the new UID is read');
    assert.deepStrictEqual(seen, [2, 4, 5]);
    assert.strictEqual(Number(await s.db.value(sql`SELECT last_uid FROM mail_imap_mailboxes`)), 5);

    const triage = await s.get('/api/v1/me/mail/triage', { as: alice });
    assert.strictEqual(triage.body.threads.length, 3);
    assert.strictEqual(triage.body.counts.to_read, 3);
    assert.ok(!s.logs().join('\n').includes('body 2'), 'a pulled body is not logged');
});

test('a first poll starts at the UID that existed when the connection was tested', async (t) => {
    // The archive ends at UID 100 when the person connects; UID 101 is mail that arrived afterwards.
    const archive = fakeSession({ uidValidity: '7', uidNext: 101, messages: [message(50), message(100)], highestUid: 100 });
    const fresh = fakeSession({ uidValidity: '7', uidNext: 102, messages: [message(101)], highestUid: 101 });
    const imap = fakeImap({ testResult: { uid_validity: '7', uid_next: 101 }, sessions: [archive, fresh] });
    const s = await boot({ imap });
    t.after(() => s.close());
    const { alice } = await connect(s, imap);
    const seen = [];
    const analyze = async ({ message: input }) => { seen.push(input.uid); return { category: 'other', summary: `S${input.uid}` }; };

    const first = await runImapPull({ db: s.db, config: s.config, imap, analyze });
    assert.strictEqual(first.pulled, 0, 'the provider archive is not triaged');
    assert.strictEqual(Number(await s.db.value(sql`SELECT last_uid FROM mail_imap_mailboxes`)), 100);

    await makeDue(s.db);
    const second = await runImapPull({ db: s.db, config: s.config, imap, analyze });
    assert.strictEqual(second.pulled, 1);
    assert.deepStrictEqual(seen, [101]);
    assert.strictEqual((await s.get('/api/v1/me/mail/triage', { as: alice })).body.threads.length, 1);
});

test('a changed UIDVALIDITY starts over and does not duplicate an already-read UID', async (t) => {
    const first = fakeSession({ uidValidity: '7', uidNext: 3, messages: [message(2)], highestUid: 2 });
    const reset = fakeSession({ uidValidity: '8', uidNext: 3, messages: [message(2)], highestUid: 2 });
    const imap = fakeImap({ sessions: [first, reset] });
    const s = await boot({ imap });
    t.after(() => s.close());
    await connect(s, imap);
    const seen = [];
    const analyze = async ({ message: input }) => { seen.push(input.uid); return { category: 'other', summary: `S${input.uid}` }; };

    await runImapPull({ db: s.db, config: s.config, imap, analyze });
    await makeDue(s.db);
    const again = await runImapPull({ db: s.db, config: s.config, imap, analyze });
    assert.strictEqual(again.pulled, 1, 'the new UIDVALIDITY makes uid 2 a new remote message');
    assert.deepStrictEqual(seen, [2, 2]);
    assert.strictEqual(await s.db.value(sql`SELECT uid_validity FROM mail_imap_mailboxes`), '8');
    const threads = await s.db.many(sql`SELECT thread_id FROM mail_inbox_ai_threads ORDER BY thread_id`);
    assert.strictEqual(threads.length, 2);
});

test('disconnect deletes the credential, and the pulled summaries only when asked', async (t) => {
    const a = fakeSession({ uidValidity: '7', uidNext: 3, messages: [message(1)], highestUid: 1 });
    const b = fakeSession({ uidValidity: '7', uidNext: 3, messages: [message(1)], highestUid: 1 });
    const imap = fakeImap({ sessions: [a, b] });
    const s = await boot({ imap });
    t.after(() => s.close());
    const alice = s.network.addUser('alice');
    await s.post('/api/v1/masks', { as: alice, json: { label: 'shop' } });
    await s.put('/api/v1/me/mail/ai-settings', { as: alice, json: { enabled: true } });
    const one = await s.post('/api/v1/me/mail/imap-mailboxes', { as: alice, json: { host: 'imap.one.example', username: 'one@example.net', password: SECRET } });
    const two = await s.post('/api/v1/me/mail/imap-mailboxes', { as: alice, json: { host: 'imap.two.example', username: 'two@example.net', password: SECRET } });
    assert.strictEqual(one.status, 201);
    assert.strictEqual(two.status, 201);

    await runImapPull({ db: s.db, config: s.config, imap, analyze: async ({ message: input }) => ({ category: 'other', summary: `S${input.uid}` }) });
    assert.strictEqual((await s.get('/api/v1/me/mail/triage', { as: alice })).body.threads.length, 2);

    const keep = await s.del(`/api/v1/me/mail/imap-mailboxes/${one.body.mailbox.id}`, { as: alice });
    assert.strictEqual(keep.status, 200);
    assert.strictEqual(keep.body.summaries_deleted, 0);
    assert.strictEqual((await s.get('/api/v1/me/mail/triage', { as: alice })).body.threads.length, 2, 'summaries stay unless asked');
    const threads = await s.db.many(sql`SELECT thread_id, imap_mailbox_id FROM mail_inbox_ai_threads`);
    const kept = threads.find((row) => row.thread_id.startsWith(`imap:${one.body.mailbox.id}:`));
    assert.ok(kept, 'the kept summary is still there');
    assert.strictEqual(kept.imap_mailbox_id, null, 'the kept row no longer points at a deleted connection');

    const gone = await s.del(`/api/v1/me/mail/imap-mailboxes/${two.body.mailbox.id}?delete_triage=1`, { as: alice });
    assert.strictEqual(gone.status, 200);
    assert.strictEqual(gone.body.summaries_deleted, 1);
    assert.strictEqual((await s.get('/api/v1/me/mail/triage', { as: alice })).body.threads.length, 1);
    assert.strictEqual((await s.db.many(sql`SELECT id FROM mail_imap_mailboxes`)).length, 0);
    assert.strictEqual((await s.get('/api/v1/me/mail/imap-mailboxes', { as: alice })).body.mailboxes.length, 0);
});

test('a failed poll reports one plain sentence, never the provider text or the password', async (t) => {
    const openError = Object.assign(new Error(`LOGIN failed for ${SECRET}`), { authenticationFailed: true });
    const imap = fakeImap({ openError });
    const s = await boot({ imap });
    t.after(() => s.close());
    await connect(s, imap);

    const report = await runImapPull({
        db: s.db, config: s.config, imap, analyze: async () => ({ category: 'other', summary: 'x' }),
    });
    assert.strictEqual(report.failed, 1);
    const error = await s.db.value(sql`SELECT last_error FROM mail_imap_mailboxes`);
    assert.match(error, /Could not sign in/);
    assert.ok(!String(error).includes(SECRET));
    assert.ok(!s.logs().join('\n').includes(SECRET));
});

test('the entry point loads, the route mounts, and a short seal key is refused at boot', () => {
    const entry = require('../server/index');
    assert.strictEqual(typeof entry.main, 'function');
    const { mountImap } = require('../server/http/imap-routes');
    assert.strictEqual(typeof mountImap, 'function');
    const { createApi } = require('../server/http/api');
    assert.strictEqual(typeof createApi, 'function');
    const { load } = require('../server/config');
    assert.throws(() => load({ BURNER_DOMAINS: 'burn.example', MAIL_SECRETS_KEY: 'too-short' }), /32 bytes/);
});

test('without MAIL_SECRETS_KEY there is nothing to seal and the route says so', async (t) => {
    const s = await boot({ env: { MAIL_SECRETS_KEY: '' } });
    t.after(() => s.close());
    const alice = s.network.addUser('alice');
    await s.post('/api/v1/masks', { as: alice, json: { label: 'shop' } });
    await s.put('/api/v1/me/mail/ai-settings', { as: alice, json: { enabled: true } });
    const made = await s.post('/api/v1/me/mail/imap-mailboxes', {
        as: alice, json: { host: 'imap.example.net', username: 'person@example.net', password: SECRET },
    });
    assert.strictEqual(made.status, 503);
    assert.match(made.body.detail, /not configured/);
});
