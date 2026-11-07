'use strict';
/**
 * The API of OpenVibe.Mail.
 *
 * The rules these tests hold: a person may do everything with their own addresses and nothing at all with somebody
 * else's; a burner made without an account is read with its token; a message body is never in an answer and never
 * in a log line.
 */
const test = require('node:test');
const assert = require('node:assert');
const { boot } = require('./helpers/boot');

test('a person makes a mask, and the mask is theirs', async (t) => {
    const s = await boot();
    t.after(() => s.close());
    const alice = s.network.addUser('alice');

    const made = await s.post('/api/v1/masks', { as: alice, json: { label: 'Amazon', purpose: 'shopping' } });
    assert.strictEqual(made.status, 201);
    assert.match(made.body.mask.address, /^amazon\.[a-z0-9]{4}@mask\.openvibe\.email$/);
    assert.strictEqual(made.body.mask.label, 'Amazon');
    assert.strictEqual(made.body.mask.enabled, true);

    const list = await s.get('/api/v1/masks', { as: alice });
    assert.strictEqual(list.status, 200);
    assert.strictEqual(list.body.masks.length, 1);

    const rows = await s.db.many('SELECT envelope FROM event_outbox ORDER BY id');
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].envelope.event_type, 'mail.mask.created');
});

test('another person does not find the mask', async (t) => {
    const s = await boot();
    t.after(() => s.close());
    const alice = s.network.addUser('alice');
    const bob = s.network.addUser('bob');

    const made = await s.post('/api/v1/masks', { as: alice, json: { label: 'Amazon' } });
    const id = made.body.mask.id;

    const seen = await s.get(`/api/v1/masks/${id}`, { as: bob });
    assert.strictEqual(seen.status, 404);
    assert.strictEqual(seen.body.code, 'mail.not_found');

    const list = await s.get('/api/v1/masks', { as: bob });
    assert.strictEqual(list.body.masks.length, 0);
});

test('a mask without a token is not found', async (t) => {
    const s = await boot();
    t.after(() => s.close());
    const made = await s.post('/api/v1/masks', { json: { label: 'Amazon' } });
    assert.strictEqual(made.status, 401);
});

test('turning a mask off makes the mail server forget it', async (t) => {
    const s = await boot();
    t.after(() => s.close());
    const alice = s.network.addUser('alice');

    const made = await s.post('/api/v1/masks', { as: alice, json: { label: 'Amazon' } });
    const id = made.body.mask.id;

    const off = await s.del(`/api/v1/masks/${id}`, { as: alice });
    assert.strictEqual(off.status, 200);
    assert.strictEqual(off.body.mask.enabled, false);
    assert.ok(s.mail.calls.invalidateCaches >= 1, 'the mail server was told to forget the address');

    const again = await s.del(`/api/v1/masks/${id}`, { as: alice });
    assert.strictEqual(again.status, 404);
});

test('a person has twenty masks and no more', async (t) => {
    const s = await boot();
    t.after(() => s.close());
    const alice = s.network.addUser('alice');

    for (let i = 0; i < 20; i++) {
        const made = await s.post('/api/v1/masks', { as: alice, json: { label: `site${i}` } });
        assert.strictEqual(made.status, 201);
    }
    const over = await s.post('/api/v1/masks', { as: alice, json: { label: 'one more' } });
    assert.strictEqual(over.status, 409);
    assert.strictEqual(over.body.code, 'mail.mask_limit');
});

test('a burner made without an account is read with its token', async (t) => {
    const s = await boot();
    t.after(() => s.close());

    const made = await s.post('/api/v1/burners', { json: { expires: '10m' } });
    assert.strictEqual(made.status, 201);
    assert.strictEqual(made.body.burner.owner, null);
    assert.match(made.body.burner.address, /^[a-z0-9]{8}@burn[12]\.openvibe\.email$/);
    assert.ok(made.body.token, 'the token comes back once');
    assert.ok(made.body.token.startsWith('mbt_'));

    const without = await s.get(`/api/v1/burners/${made.body.burner.id}/messages`);
    assert.strictEqual(without.status, 404);

    const withToken = await s.get(`/api/v1/burners/${made.body.burner.id}/messages`, { token: made.body.token });
    assert.strictEqual(withToken.status, 200);
    assert.deepStrictEqual(withToken.body.messages, []);
});

test('a burner without an account lives for ten minutes', async (t) => {
    const s = await boot();
    t.after(() => s.close());

    const made = await s.post('/api/v1/burners', { json: { expires: '7d' } });
    assert.strictEqual(made.status, 400);
    assert.strictEqual(made.body.code, 'mail.anon_expiry');
});

test('a person makes a burner of their own, and nobody else may read it', async (t) => {
    const s = await boot();
    t.after(() => s.close());
    const alice = s.network.addUser('alice');
    const bob = s.network.addUser('bob');

    const made = await s.post('/api/v1/burners', { as: alice, json: { expires: '1h' } });
    assert.strictEqual(made.status, 201);
    assert.strictEqual(made.body.burner.owner, alice.subject);
    assert.strictEqual(made.body.token, null, 'a burner of a person needs no token');

    const mine = await s.get(`/api/v1/burners/${made.body.burner.id}/messages`, { as: alice });
    assert.strictEqual(mine.status, 200);

    const theirs = await s.get(`/api/v1/burners/${made.body.burner.id}/messages`, { as: bob });
    assert.strictEqual(theirs.status, 404);
});

test('a person has five burners alive at once', async (t) => {
    const s = await boot();
    t.after(() => s.close());
    const alice = s.network.addUser('alice');

    for (let i = 0; i < 5; i++) {
        const made = await s.post('/api/v1/burners', { as: alice, json: { expires: '1h' } });
        assert.strictEqual(made.status, 201);
    }
    const over = await s.post('/api/v1/burners', { as: alice, json: { expires: '1h' } });
    assert.strictEqual(over.status, 409);
    assert.strictEqual(over.body.code, 'mail.burner_limit');
});

test('the code endpoint gives the code that arrived', async (t) => {
    const s = await boot();
    t.after(() => s.close());
    const alice = s.network.addUser('alice');

    const made = await s.post('/api/v1/burners', { as: alice, json: { expires: '1h' } });
    const burner = made.body.burner;

    s.mail.deliver({
        mailboxAddress: burner.address,
        to: burner.address,
        subject: 'Your verification code',
        text: 'Your verification code is 918273. It expires in 10 minutes.',
    });

    const code = await s.get(`/api/v1/burners/${burner.id}/code`, { as: alice });
    assert.strictEqual(code.status, 200);
    assert.strictEqual(code.body.code, '918273');
    assert.ok(code.body.received_at);
});

test('the code endpoint says so when no code has arrived', async (t) => {
    const s = await boot();
    t.after(() => s.close());
    const alice = s.network.addUser('alice');

    const made = await s.post('/api/v1/burners', { as: alice, json: { expires: '1h' } });
    const code = await s.get(`/api/v1/burners/${made.body.burner.id}/code`, { as: alice });
    assert.strictEqual(code.status, 404);
    assert.strictEqual(code.body.code, 'mail.no_code');
});

test('an agent gets an inbox, and the messages sent to it', async (t) => {
    const s = await boot();
    t.after(() => s.close());
    const alice = s.network.addUser('alice');

    const made = await s.post('/api/v1/agent-inboxes', { as: alice, json: { agent_id: 'Helper' } });
    assert.strictEqual(made.status, 201);
    const inbox = made.body.agent_inbox;
    assert.match(inbox.address, /^helper\.[a-z0-9]+@openvibe\.email$/);

    const again = await s.post('/api/v1/agent-inboxes', { as: alice, json: { agent_id: 'helper' } });
    assert.strictEqual(again.body.agent_inbox.id, inbox.id, 'the same agent gets the same inbox');

    const mailbox = await s.db.value('SELECT address FROM mail_mailboxes WHERE owner_subject = $1', [alice.subject]);
    s.mail.deliver({ mailboxAddress: mailbox, to: inbox.address, subject: 'A question', text: 'What is the weather?' });

    const messages = await s.get(`/api/v1/agent-inboxes/${inbox.id}/messages`, { as: alice });
    assert.strictEqual(messages.status, 200);
    assert.strictEqual(messages.body.messages.length, 1);
    assert.strictEqual(messages.body.messages[0].subject, 'A question');
    assert.strictEqual(messages.body.messages[0].preview, undefined, 'a list of messages carries no preview');
});

test('another person does not find an agent inbox', async (t) => {
    const s = await boot();
    t.after(() => s.close());
    const alice = s.network.addUser('alice');
    const bob = s.network.addUser('bob');

    const made = await s.post('/api/v1/agent-inboxes', { as: alice, json: { agent_id: 'helper' } });
    const seen = await s.get(`/api/v1/agent-inboxes/${made.body.agent_inbox.id}/messages`, { as: bob });
    assert.strictEqual(seen.status, 404);
});

test('no message body is ever written to a log line', async (t) => {
    const s = await boot();
    t.after(() => s.close());
    const alice = s.network.addUser('alice');

    const made = await s.post('/api/v1/burners', { as: alice, json: { expires: '1h' } });
    const burner = made.body.burner;
    s.mail.deliver({
        mailboxAddress: burner.address,
        to: burner.address,
        subject: 'Your verification code',
        text: 'Your verification code is 918273. The secret phrase is hunter2 and nobody may read it.',
        html: '<p>Your verification code is 918273.</p>',
    });

    await s.get(`/api/v1/burners/${burner.id}/code`, { as: alice });
    await s.get(`/api/v1/burners/${burner.id}/messages`, { as: alice });

    const logs = s.logs().join('\n');
    assert.ok(logs.length >= 0);
    assert.ok(!logs.includes('hunter2'), 'the body of a message is not in a log line');
    assert.ok(!logs.includes('918273'), 'not even the code is in a log line');
});

test('a typed token is not a session', async (t) => {
    const s = await boot();
    t.after(() => s.close());
    const alice = s.network.addUser('alice');
    const typed = s.network.userToken(alice, { typ: 'mail.read' });

    const made = await s.post('/api/v1/masks', { bearer: typed, json: { label: 'Amazon' } });
    assert.strictEqual(made.status, 401);
});

test('a forged Delivered-To does not move an agent message to another inbox', async (t) => {
    const s = await boot();
    t.after(() => s.close());
    const alice = s.network.addUser('alice');

    const a = (await s.post('/api/v1/agent-inboxes', { as: alice, json: { agent_id: 'alpha' } })).body.agent_inbox;
    const b = (await s.post('/api/v1/agent-inboxes', { as: alice, json: { agent_id: 'beta' } })).body.agent_inbox;
    const mailbox = await s.db.value('SELECT address FROM mail_mailboxes WHERE owner_subject = $1', [alice.subject]);
    s.mail.deliver({
        mailboxAddress: mailbox,
        to: a.address,
        subject: 'for alpha',
        text: 'Your code is 101010',
        headers: [
            { name: 'To', value: b.address },
            { name: 'Cc', value: b.address },
            { name: 'Delivered-To', value: b.address },
        ],
    });

    const alpha = await s.get(`/api/v1/agent-inboxes/${a.id}/messages`, { as: alice });
    assert.strictEqual(alpha.body.messages.length, 1);
    const beta = await s.get(`/api/v1/agent-inboxes/${b.id}/messages`, { as: alice });
    assert.deepStrictEqual(beta.body.messages, [], 'the forged headers name beta but the server delivered to alpha');
});

test('the messages API returns metadata and never a body or HTML', async (t) => {
    const s = await boot();
    t.after(() => s.close());
    const alice = s.network.addUser('alice');

    const made = await s.post('/api/v1/burners', { as: alice, json: { expires: '1h' } });
    const burner = made.body.burner;
    s.mail.deliver({
        mailboxAddress: burner.address,
        to: burner.address,
        subject: 'Your code',
        text: 'Your verification code is 121212',
        html: '<p>Your verification code is <b>121212</b></p>',
    });

    const list = await s.get(`/api/v1/burners/${burner.id}/messages`, { as: alice });
    assert.strictEqual(list.status, 200);
    assert.deepStrictEqual(Object.keys(list.body.messages[0]).sort(), ['from', 'id', 'received_at', 'subject']);
    assert.ok(!('body' in list.body.messages[0]) && !('html' in list.body.messages[0]) && !('preview' in list.body.messages[0]));

    const code = await s.get(`/api/v1/burners/${burner.id}/code`, { as: alice });
    assert.strictEqual(code.status, 200);
    assert.strictEqual(code.body.code, '121212');
    assert.ok(!('body' in code.body) && !('text' in code.body) && !('html' in code.body));
});

test('the global anonymous-burner cap answers 503 with a clear code', async (t) => {
    const s = await boot({ env: {
        MAIL_MAX_LIVE_ANON_BURNERS: '2',
        MAIL_BURNERS_PER_IP_HOUR: '100',
    } });
    t.after(() => s.close());

    assert.strictEqual((await s.post('/api/v1/burners', { json: { expires: '10m' } })).status, 201);
    assert.strictEqual((await s.post('/api/v1/burners', { json: { expires: '10m' } })).status, 201);
    const over = await s.post('/api/v1/burners', { json: { expires: '10m' } });
    assert.strictEqual(over.status, 503);
    assert.strictEqual(over.body.code, 'mail.burner_capacity');
});

test('the global cap holds when two account-less burners race for the last slot', async (t) => {
    const s = await boot({ env: {
        MAIL_MAX_LIVE_ANON_BURNERS: '1',
        MAIL_BURNERS_PER_IP_HOUR: '100',
    } });
    t.after(() => s.close());

    const [first, second] = await Promise.all([
        s.post('/api/v1/burners', { json: { expires: '10m' } }),
        s.post('/api/v1/burners', { json: { expires: '10m' } }),
    ]);
    assert.deepStrictEqual([first.status, second.status].sort(), [201, 503]);
});

test('anonymous burners are limited per IP as well as globally', async (t) => {
    const s = await boot({ env: {
        MAIL_MAX_LIVE_ANON_BURNERS: '100',
        MAIL_BURNERS_PER_IP_HOUR: '2',
    } });
    t.after(() => s.close());

    assert.strictEqual((await s.post('/api/v1/burners', { json: { expires: '10m' } })).status, 201);
    assert.strictEqual((await s.post('/api/v1/burners', { json: { expires: '10m' } })).status, 201);
    const over = await s.post('/api/v1/burners', { json: { expires: '10m' } });
    assert.strictEqual(over.status, 429);
    assert.strictEqual(over.body.code, 'mail.burner_rate');
});
