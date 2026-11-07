'use strict';
/**
 * The purge job: a burner's mail goes when the burner expires, and only then — and a mail server that is down
 * does not lose the work, it only delays it to the next run.
 */
const test = require('node:test');
const assert = require('node:assert');
const { boot } = require('./helpers/boot');
const { runDue } = require('../server/jobs/purge');

test('an expired burner loses its mail and its row, and the directory cache is cleared', async (t) => {
    const s = await boot();
    t.after(() => s.close());
    const alice = s.network.addUser('alice');

    const made = await s.post('/api/v1/burners', { as: alice, json: { expires: '1h' } });
    const burner = made.body.burner;
    const mailbox = await s.db.value('SELECT address FROM mail_mailboxes WHERE owner_subject = $1', [alice.subject]);
    s.mail.deliver({ mailboxAddress: mailbox, to: burner.address, subject: 'code', text: 'Your code is 445566' });

    await s.db.exec("UPDATE mail_burners SET expires_at = now() - interval '1 minute' WHERE id = $1", [burner.id]);
    const before = s.mail.calls.invalidateCaches;
    const report = await runDue({ db: s.db, stalwart: s.mail, events: null, now: () => Date.now() });

    assert.strictEqual(report.expired, 1);
    assert.strictEqual(report.messagesDeleted, 1);
    assert.ok(s.mail.calls.invalidateCaches > before, 'the mail server forgot the expired alias');
    assert.strictEqual(await s.db.value('SELECT count(*)::int FROM mail_burners WHERE id = $1', [burner.id]), 0);
    assert.deepStrictEqual(s.mail.mailboxes.get(mailbox.toLowerCase()), []);
});

test('a failed delete keeps the burner, so the next run deletes the mail', async (t) => {
    const s = await boot();
    t.after(() => s.close());
    const alice = s.network.addUser('alice');

    const made = await s.post('/api/v1/burners', { as: alice, json: { expires: '1h' } });
    await s.db.exec("UPDATE mail_burners SET expires_at = now() - interval '1 minute' WHERE id = $1", [made.body.burner.id]);

    const broken = {
        ...s.mail,
        async listMessages() { throw new Error('the mail server is down'); },
    };
    const report = await runDue({ db: s.db, stalwart: broken, events: null, now: () => Date.now() });

    assert.strictEqual(report.expired, 0);
    assert.strictEqual(await s.db.value('SELECT count(*)::int FROM mail_burners WHERE id = $1', [made.body.burner.id]), 1);
});
