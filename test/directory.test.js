'use strict';
/**
 * The directory view is the whole privacy model: one row means deliver, no row means bounce. These tests hold the
 * view to that without needing Stalwart.
 */
const test = require('node:test');
const assert = require('node:assert');
const { boot } = require('./helpers/boot');
const { ensurePoolMailbox, setPoolAddress } = require('../server/domain/mailboxes');

const rowFor = (s, address) => s.db.value('SELECT count(*)::int FROM mail_directory_accounts WHERE address = $1', [address]);
const nameFor = (s, address) => s.db.value('SELECT name FROM mail_directory_accounts WHERE address = $1', [address]);

test('a mask resolves while it is on, and not after it is turned off', async (t) => {
    const s = await boot();
    t.after(() => s.close());
    const alice = s.network.addUser('alice');

    const mask = (await s.post('/api/v1/masks', { as: alice, json: { label: 'shop' } })).body.mask;
    assert.strictEqual(await rowFor(s, mask.address), 1);
    const mailbox = await s.db.value('SELECT address FROM mail_mailboxes WHERE owner_subject = $1', [alice.subject]);
    assert.strictEqual(await nameFor(s, mask.address), mailbox);

    await s.del(`/api/v1/masks/${mask.id}`, { as: alice });
    assert.strictEqual(await rowFor(s, mask.address), 0);
});

test('a burner resolves until it expires, and the mailbox itself always resolves', async (t) => {
    const s = await boot();
    t.after(() => s.close());
    const alice = s.network.addUser('alice');

    const burner = (await s.post('/api/v1/burners', { as: alice, json: { expires: '1h' } })).body.burner;
    assert.strictEqual(await rowFor(s, burner.address), 1);
    const mailbox = await s.db.value('SELECT address FROM mail_mailboxes WHERE owner_subject = $1', [alice.subject]);
    assert.strictEqual(await rowFor(s, mailbox), 1, 'the account primary address resolves');

    await s.db.exec("UPDATE mail_burners SET expires_at = now() - interval '1 second' WHERE id = $1", [burner.id]);
    assert.strictEqual(await rowFor(s, burner.address), 0);
});

test('an account-less burner resolves to the pool mailbox', async (t) => {
    const s = await boot();
    t.after(() => s.close());
    await s.db.tx(async (t) => {
        const pool = await ensurePoolMailbox(t, { baseDomain: s.config.addresses.base });
        await setPoolAddress(t, pool);
    });

    const made = await s.post('/api/v1/burners', { json: { expires: '10m' } });
    const burner = made.body.burner;
    assert.strictEqual(await rowFor(s, burner.address), 1);
    const pool = await s.db.value("SELECT address FROM mail_mailboxes WHERE owner_subject = 'service:burner-pool'");
    assert.strictEqual(await nameFor(s, burner.address), pool);
});

test('an agent inbox resolves to its owner mailbox', async (t) => {
    const s = await boot();
    t.after(() => s.close());
    const alice = s.network.addUser('alice');

    const inbox = (await s.post('/api/v1/agent-inboxes', { as: alice, json: { agent_id: 'helper' } })).body.agent_inbox;
    const mailbox = await s.db.value('SELECT address FROM mail_mailboxes WHERE owner_subject = $1', [alice.subject]);
    assert.strictEqual(await rowFor(s, inbox.address), 1);
    assert.strictEqual(await nameFor(s, inbox.address), mailbox);
});
