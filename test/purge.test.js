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
    s.mail.deliver({ mailboxAddress: burner.address, to: burner.address, subject: 'code', text: 'Your code is 445566' });

    await s.db.exec("UPDATE mail_burners SET expires_at = now() - interval '1 minute' WHERE id = $1", [burner.id]);
    const before = s.mail.calls.invalidateCaches;
    const report = await runDue({ db: s.db, stalwart: s.mail, events: null, now: () => Date.now() });

    assert.strictEqual(report.expired, 1);
    assert.strictEqual(report.messagesDeleted, 1);
    assert.ok(s.mail.calls.invalidateCaches > before, 'the mail server forgot the expired address');
    assert.ok(s.mail.calls.destroyAccount >= 1, 'the burner account was destroyed');
    assert.strictEqual(await s.db.value('SELECT count(*)::int FROM mail_burners WHERE id = $1', [burner.id]), 0);
    assert.strictEqual(s.mail.mailboxes.has(burner.address.toLowerCase()), false);
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
    const before = broken.calls.invalidateCaches;
    const report = await runDue({ db: s.db, stalwart: broken, events: null, now: () => Date.now() });

    assert.strictEqual(report.expired, 0);
    assert.ok(broken.calls.invalidateCaches > before, 'the expired address still leaves the cache even though its mail was not deleted');
    assert.strictEqual(await s.db.value('SELECT count(*)::int FROM mail_burners WHERE id = $1', [made.body.burner.id]), 1);
});

test('a mask whose life has run out is disabled, and the mail server is told once', async (t) => {
    const s = await boot();
    t.after(() => s.close());
    const alice = s.network.addUser('alice');

    const made = await s.post('/api/v1/masks', { as: alice, json: { purpose: 'one purchase', expires_days: 1 } });
    assert.strictEqual(made.status, 201);
    await s.db.exec("UPDATE mail_masks SET expires_at = now() - interval '1 minute' WHERE id = $1", [made.body.mask.id]);

    const before = s.mail.calls.invalidateCaches;
    const report = await runDue({ db: s.db, stalwart: s.mail, events: null, now: () => Date.now() });
    assert.strictEqual(report.masksDisabled, 1);
    assert.ok(s.mail.calls.invalidateCaches > before, 'the mail server forgot the disabled address');
    assert.strictEqual(await s.db.value('SELECT enabled FROM mail_masks WHERE id = $1', [made.body.mask.id]), false);

    const listed = await s.get('/api/v1/me/mail', { as: alice });
    assert.strictEqual(listed.body.masks[0].state, 'expired');
});
