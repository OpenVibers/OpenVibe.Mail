'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { CATEGORIES, validateTriage, triageMailbox, createDraft } = require('../server/domain/inbox-ai');
const { boot } = require('./helpers/boot');
const { runInboxAi } = require('../server/jobs/inbox-ai');
const { sql } = require('openvibe-sdk/db');

test('accepts only the five mailbox categories and bounded thread summaries', () => {
    assert.deepStrictEqual(CATEGORIES, ['needs_reply', 'to_read', 'receipts', 'newsletters', 'other']);
    assert.deepStrictEqual(validateTriage({ category: 'receipts', summary: 'Order delivered' }), {
        category: 'receipts', summary: 'Order delivered', draft: null,
    });
    assert.strictEqual(validateTriage({ category: 'spam', summary: 'x' }), null);
    assert.strictEqual(validateTriage({ category: 'to_read', summary: 'x', draft: 'unsolicited' }), null);
    assert.strictEqual(validateTriage({ category: 'needs_reply', summary: 'x' }), null);
});

test('opt-out prevents the analyzer from seeing any message', async () => {
    let calls = 0;
    const result = await triageMailbox({ consent: false, messages: [{ id: 'private', body: 'secret' }], analyze: async () => { calls++; } });
    assert.deepStrictEqual(result, { state: 'opted_out', items: [] });
    assert.strictEqual(calls, 0);
});

test('draft creation stays inert and a needs-reply result requires a draft', () => {
    const draft = createDraft({ threadId: 't1', to: 'person@example.net', subject: 'Re: Hello', body: 'Thanks!' });
    assert.strictEqual(draft.state, 'draft');
    assert.strictEqual(Object.hasOwn(draft, 'send'), false);
    assert.deepStrictEqual(validateTriage({ category: 'needs_reply', summary: 'They asked a question', draft: 'Thanks!' }), {
        category: 'needs_reply', summary: 'They asked a question', draft: 'Thanks!',
    });
});

test('batch triage is consent gated and stores one validated result per thread', async (t) => {
    let sends = 0;
    const s = await boot({ smtp: { sendMessage: async () => { sends++; return { ok: true }; } } });
    t.after(() => s.close());
    const alice = s.network.addUser('alice');
    const made = await s.post('/api/v1/masks', { as: alice, json: { label: 'shop' } });
    const mailbox = await s.db.value('SELECT address FROM mail_mailboxes WHERE owner_subject = $1', [alice.subject]);
    const message = s.mail.deliver({ mailboxAddress: mailbox, to: made.body.mask.address, from: 'seller@openvibe.email', subject: 'Order update', text: 'marker private body' });
    let calls = 0;
    await runInboxAi({ db: s.db, stalwart: s.mail, analyze: async () => { calls++; return { category: 'receipts', summary: 'Order updated' }; } });
    assert.strictEqual(calls, 0, 'the setting starts off');
    await s.db.exec(sql`DELETE FROM mail_settings WHERE key = 'inbox_ai_lease'`);
    await s.put('/api/v1/me/mail/ai-settings', { as: alice, json: { enabled: true } });
    const result = await runInboxAi({ db: s.db, stalwart: s.mail, analyze: async ({ owner, message: input }) => {
        calls++;
        assert.strictEqual(owner, alice.subject);
        assert.match(input.text, /marker private body/);
        return { category: 'needs_reply', summary: 'Seller needs an answer', draft: 'Please confirm.' };
    } });
    assert.strictEqual(result.triaged, 1);
    const page = await s.get('/api/v1/me/mail/triage', { as: alice });
    assert.strictEqual(page.body.counts.needs_reply, 1);
    assert.strictEqual(page.body.threads[0].message_id, message.id);
    assert.strictEqual(page.body.threads[0].draft_state, 'draft');
    assert.strictEqual(calls, 1);
    assert.strictEqual(sends, 0, 'triage and draft storage never send mail');
    const threadId = page.body.threads[0].thread_id;
    const edited = await s.put(`/api/v1/me/mail/triage/${threadId}/draft`, { as: alice, json: { subject: 'Re: Order update', body: 'Edited reply' } });
    assert.strictEqual(edited.status, 200);
    assert.strictEqual(sends, 0, 'editing a draft never sends it');
    const sent = await s.post(`/api/v1/me/mail/triage/${threadId}/send`, { as: alice, json: { subject: 'Re: Order update', body: 'Edited reply' } });
    assert.strictEqual(sent.status, 200);
    assert.strictEqual(sends, 1, 'only the explicit send action calls SMTP');
    assert.ok(!s.logs().some((line) => line.includes('marker private body')));
});

test('rules are owner-scoped, journal category changes, and undo restores the prior triage', async (t) => {
    const s = await boot();
    t.after(() => s.close());
    const alice = s.network.addUser('alice');
    const bob = s.network.addUser('bob');
    const made = await s.post('/api/v1/masks', { as: alice, json: { label: 'shop' } });
    const mailbox = await s.db.value('SELECT address FROM mail_mailboxes WHERE owner_subject = $1', [alice.subject]);
    s.mail.deliver({ mailboxAddress: mailbox, to: made.body.mask.address, from: 'seller@openvibe.email', subject: 'Your order', text: 'Receipt body' });
    await s.put('/api/v1/me/mail/ai-settings', { as: alice, json: { enabled: true } });
    const created = await s.post('/api/v1/me/mail/ai-rules', { as: alice, json: {
        name: 'Shop receipts', match_from: 'seller@openvibe.email', category: 'receipts', enabled: true,
    } });
    assert.strictEqual(created.status, 201);
    assert.strictEqual((await s.get('/api/v1/me/mail/ai-rules', { as: bob })).body.rules.length, 0);
    const report = await runInboxAi({ db: s.db, stalwart: s.mail, analyze: async () => ({ category: 'to_read', summary: 'Order receipt' }) });
    assert.strictEqual(report.triaged, 1);
    const receipts = await s.get('/api/v1/me/mail/receipts', { as: alice });
    assert.strictEqual(receipts.body.receipts.length, 1);
    assert.strictEqual(receipts.body.receipts[0].merchant, 'seller@openvibe.email');
    const journal = await s.get('/api/v1/me/mail/ai-journal', { as: alice });
    assert.strictEqual(journal.body.entries.length, 1);
    assert.strictEqual(journal.body.entries[0].previous_category, 'to_read');
    const undone = await s.post(`/api/v1/me/mail/ai-journal/${journal.body.entries[0].id}/undo`, { as: alice });
    assert.strictEqual(undone.status, 200);
    const triage = await s.get('/api/v1/me/mail/triage', { as: alice });
    assert.strictEqual(triage.body.threads[0].category, 'to_read');
    assert.ok((await s.get('/api/v1/me/mail/ai-journal', { as: alice })).body.entries[0].undone_at);
});
