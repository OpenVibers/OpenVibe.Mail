'use strict';
// A link opens the composer filled in (11-13): /inbox?compose=1&to=…&cc=…&subject=…&body=…. It only fills the box (the
// person still presses Send); addresses that are not addresses are dropped; every field is bounded; without compose=1
// nothing opens. compose.js is the page's own script, run here with a stand-in window.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'compose.js'), 'utf8');
const window = {};
vm.runInNewContext(src, { window, URLSearchParams, document: {} });
// Plain copies: the script's arrays come from its own context, which strict equality tells apart.
const fromQuery = (q) => { const p = window.MailCompose.fromQuery(q); return p == null ? p : JSON.parse(JSON.stringify(p)); };

test('a compose link fills the box', () => {
    const p = fromQuery('?compose=1&to=ada%40example.com,%20bob%40example.org&cc=cy%40example.net&subject=Hello&body=Line%20one%0ALine%20two');
    assert.deepStrictEqual(p, { to: ['ada@example.com', 'bob@example.org'], cc: ['cy@example.net'], bcc: [], subject: 'Hello', text: 'Line one\nLine two' });
});

test('without compose=1 nothing opens', () => {
    assert.strictEqual(fromQuery('?to=ada%40example.com'), null);
    assert.strictEqual(fromQuery(''), null);
    assert.strictEqual(fromQuery('?folder=inbox'), null);
});

test('only addresses, at most twenty, and bounded words', () => {
    const p = fromQuery(`?compose=1&to=${encodeURIComponent('not an address, <x>@y, ok@example.com, "q"@z.org')}&subject=${'s'.repeat(900)}&body=${'b'.repeat(30000)}`);
    assert.deepStrictEqual(p.to, ['ok@example.com']);
    assert.strictEqual(p.subject.length, 500);
    assert.strictEqual(p.text.length, 20000);
    const many = Array.from({ length: 30 }, (_, i) => `p${i}@example.com`).join(',');
    assert.strictEqual(fromQuery(`?compose=1&to=${many}`).to.length, 20);
    assert.deepStrictEqual(fromQuery('?compose=1').to, []);
});
