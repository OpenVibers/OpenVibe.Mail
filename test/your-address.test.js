'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

// 11-09: a person's mailbox is named after their account id (01m3…@openvibe.email), and settings showed that with
// nothing suggesting a real name; compose sent new mail from it. Now settings says what that address is and suggests
// the person's username as a name, and a new message goes out from their named address when they have one.
const inbox = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'inbox.js'), 'utf8');
const compose = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'compose.js'), 'utf8');

test('settings explain the random mailbox address and suggest a name', () => {
    assert.match(inbox, /Your mailbox\\'s own address is a random one, so it says nothing about you\./);
    assert.match(inbox, /You are ' \+ named\.address \+ '\. Another name here becomes an alias of it\./);
    assert.match(inbox, /fetch\('\/auth\/me'/, 'the suggestion comes from the signed-in username');
    assert.match(inbox, /if \(u && u\.length >= 3 && !addressName\.value\) addressName\.value = u;/, 'only a suggestion, never over what was typed');
});

test('the suggestion fits the server rule for names', () => {
    const toName = (username) => String(username).toLowerCase().replace(/[._\s]+/g, '-').replace(/[^a-z0-9-]+/g, '').replace(/-+/g, '-').slice(0, 32).replace(/^-+|-+$/g, '');
    assert.ok(inbox.includes(".replace(/[._\\s]+/g, '-').replace(/[^a-z0-9-]+/g, '').replace(/-+/g, '-').slice(0, 32).replace(/^-+|-+$/g, '')"), 'the same mapping as below');
    assert.strictEqual(toName('ovprobe_merge_keep'), 'ovprobe-merge-keep');
    assert.strictEqual(toName('JapaneseOldGuy'), 'japaneseoldguy');
    assert.strictEqual(toName('__x.y__'), 'x-y');
    ['ovprobe_merge_keep', 'JapaneseOldGuy', 'a.b.c', 'x'.repeat(40) + '_'].map(toName).forEach((n) => assert.match(n, /^[a-z0-9]+(?:-[a-z0-9]+)*$/));
});

test('a new message goes out from the named address, not the random one', () => {
    assert.match(compose, /var named = addresses\.find\(function \(a\) \{ return a\.kind === 'name'; \}\); if \(named\) from\.value = named\.address;/);
    const at = compose.indexOf('var named = addresses.find');
    assert.ok(at > compose.indexOf('if (p.from) from.value = p.from;'), 'a reply still answers from the address the mail came to');
});
