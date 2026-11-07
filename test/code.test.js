'use strict';
/**
 * The code extractor: the one place a message body is read.
 *
 * A burner exists to receive a code, so the extractor has to find the code in a message it has never seen. It must
 * also not find a code where there is none: a wrong code is worse than no code.
 */
const test = require('node:test');
const assert = require('node:assert');
const { extractCode, htmlToText } = require('../server/stalwart/code');

test('a labelled code in the text', () => {
    const found = extractCode({ subject: 'Verify your email', text: 'Your verification code is 482913. It expires in 10 minutes.' });
    assert.ok(found);
    assert.strictEqual(found.code, '482913');
});

test('a labelled code in the subject', () => {
    const found = extractCode({ subject: 'Your code: 731204', text: 'Hello.' });
    assert.ok(found);
    assert.strictEqual(found.code, '731204');
});

test('a code in an html body', () => {
    const html = '<html><body><p>Your one-time code is <b>918273</b></p><script>var x=1;</script></body></html>';
    const found = extractCode({ subject: 'Sign in', html });
    assert.ok(found);
    assert.strictEqual(found.code, '918273');
});

test('a code standing alone on a line', () => {
    const found = extractCode({ subject: 'Hello', text: 'Hi there.\n\n551209\n\nThanks.' });
    assert.ok(found);
    assert.strictEqual(found.code, '551209');
});

test('the subject alone, when it is only the code', () => {
    const found = extractCode({ subject: '482913', text: '' });
    assert.ok(found);
    assert.strictEqual(found.code, '482913');
});

test('no code in a message without one', () => {
    const found = extractCode({ subject: 'Your receipt', text: 'Thank you for your order of 3 items, total 12.50.' });
    assert.strictEqual(found, null);
});

test('a year is not a code', () => {
    assert.strictEqual(extractCode({ subject: 'Hello', text: 'Call us in 2026 for support.' }), null);
});

test('a year is a code when it is labelled', () => {
    const found = extractCode({ subject: 'Your code', text: 'Your verification code is 2026.' });
    assert.ok(found);
    assert.strictEqual(found.code, '2026');
});

test('a longer number is not a code', () => {
    assert.strictEqual(extractCode({ subject: 'Order', text: 'Your order number 48291312345 has shipped.' }), null);
});

test('a phone number is not a code', () => {
    assert.strictEqual(extractCode({ subject: 'Call us', text: 'Call 5551234567 for support.' }), null);
});

test('a labelled code wins over a bare number', () => {
    const found = extractCode({ subject: 'Sign in', text: 'Order 123456 shipped. Your verification code is 482913.' });
    assert.ok(found);
    assert.strictEqual(found.code, '482913');
});

test('html becomes readable text', () => {
    const text = htmlToText('<div>Hello<br>world</div><style>p{color:red}</style>');
    assert.ok(text.includes('Hello'));
    assert.ok(text.includes('world'));
    assert.ok(!text.includes('color:red'));
});

test('html entities are decoded', () => {
    const found = extractCode({ subject: '', html: '<p>Your code is&nbsp;<b>778899</b></p>' });
    assert.ok(found);
    assert.strictEqual(found.code, '778899');
});
