'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { CATEGORIES, validateTriage, triageMailbox, createDraft } = require('../server/domain/inbox-ai');

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
