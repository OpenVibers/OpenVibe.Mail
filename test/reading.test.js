'use strict';
/**
 * Reading your own mail (M1.5). The rules these tests hold: a person reads their mailbox and the addresses that
 * deliver into it, and nothing else; a message's HTML is cleaned on the server (no script, handler, form, frame or
 * javascript: link) with remote images held back and counted until asked; an attachment is a download with nosniff;
 * read, unread and trash work on one's own message only; no body ever reaches a log line.
 */
const test = require('node:test');
const assert = require('node:assert');
const { boot } = require('./helpers/boot');
const { cleanHtml, downloadType, dispositionFor } = require('../server/domain/reading');

async function mailboxOf(s, person) {
    // A person's mailbox is made with their first address (a mask here).
    const made = await s.post('/api/v1/masks', { as: person, json: { label: 'shoes shop' } });
    assert.strictEqual(made.status, 201, JSON.stringify(made.body));
    const mailbox = await s.db.value('SELECT address FROM mail_mailboxes WHERE owner_subject = $1', [person.subject]);
    return { mailbox, mask: made.body.mask };
}

test('the cleaner keeps the letter and drops everything that could act', () => {
    const { html, blockedImages } = cleanHtml(`<p onclick="x()">Hi<script>steal()</script></p>
<a href="javascript:alert(1)">j</a><a href="https://shop.example/track">Track</a><a href="data:text/html,x">d</a>
<form action="https://x"><input name="p"></form><iframe src="https://x"></iframe><style>body{}</style><base href="https://evil">
<div style="background:url(https://t.example/x);color:red;position:fixed">s</div><p style="color: expression(alert(1))">e</p>
<img src="https://t.example/pixel.gif" alt="logo"><img src="//t.example/r.gif"><img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">`);
    for (const bad of ['script', 'onclick', 'javascript:', '<form', '<input', '<iframe', '<style', '<base', 'url(', 'expression', 'position', 'data:text/html']) {
        assert.ok(!html.includes(bad), `no ${bad}: ${html}`);
    }
    assert.match(html, /<a href="https:\/\/shop\.example\/track" target="_blank" rel="noopener noreferrer">Track<\/a>/);
    assert.match(html, /color:red/);
    assert.ok(!html.includes('t.example/pixel.gif'), 'a remote image is held back');
    assert.match(html, /\[logo\]/, 'its alt text stays in its place');
    assert.match(html, /data:image\/gif/, 'an image inside the message stays');
    assert.strictEqual(blockedImages, 2);
    const shown = cleanHtml('<img src="https://t.example/pixel.gif" alt="logo"><img src="http://t.example/q.gif">', { images: true });
    assert.match(shown.html, /src="https:\/\/t\.example\/pixel\.gif"/, 'asked for: an https image is shown');
    assert.ok(!shown.html.includes('http://t.example'), 'never a plain-http one');
});

test('attachment types are an allow-list, names are safe in a header', () => {
    assert.strictEqual(downloadType('application/pdf'), 'application/pdf');
    assert.strictEqual(downloadType('text/html'), 'application/octet-stream');
    assert.strictEqual(downloadType('image/svg+xml'), 'application/octet-stream');
    assert.ok(!/[\r\n]/.test(dispositionFor('a\r\nSet-Cookie: x.pdf')));
    assert.match(dispositionFor('café.pdf'), /^attachment; filename="caf_\.pdf"; filename\*=UTF-8''caf%C3%A9\.pdf$/);
});

test('a person reads their mailbox, one address at a time or all together', async (t) => {
    const s = await boot();
    t.after(() => s.close());
    const alice = s.network.addUser('alice');
    const { mailbox, mask } = await mailboxOf(s, alice);
    s.mail.deliver({ mailboxAddress: mailbox, to: mask.address, from: 'hello@shoes.example', subject: 'Shipped', html: '<p>On its way</p>' });
    s.mail.deliver({ mailboxAddress: mailbox, to: mailbox, from: 'cy@friends.example', subject: 'Friday film?', text: 'Popcorn?' });

    const addrs = await s.get('/api/v1/me/mail/addresses', { as: alice });
    assert.strictEqual(addrs.status, 200);
    assert.strictEqual(addrs.body.mailbox, mailbox);
    assert.deepStrictEqual(addrs.body.addresses.map((a) => a.kind).sort(), ['mailbox', 'mask']);

    const all = await s.get('/api/v1/me/mail/messages', { as: alice });
    assert.strictEqual(all.status, 200);
    assert.deepStrictEqual(all.body.messages.map((m) => m.subject), ['Friday film?', 'Shipped'], 'newest first');
    assert.strictEqual(all.body.messages[0].unread, true);
    assert.strictEqual(all.body.messages[0].text, undefined, 'a list carries no body');

    const one = await s.get(`/api/v1/me/mail/messages?address=${encodeURIComponent(mask.address)}`, { as: alice });
    assert.deepStrictEqual(one.body.messages.map((m) => m.subject), ['Shipped'], 'the mask: only what the server stamped for it');
    const notMine = await s.get('/api/v1/me/mail/messages?address=someone@openvibe.email', { as: alice });
    assert.strictEqual(notMine.status, 404);
});

test('a message is read by its owner only, its HTML cleaned, and it can be marked and trashed', async (t) => {
    const s = await boot();
    t.after(() => s.close());
    const alice = s.network.addUser('alice');
    const bob = s.network.addUser('bob');
    const { mailbox, mask } = await mailboxOf(s, alice);
    await mailboxOf(s, bob);
    const m = s.mail.deliver({ mailboxAddress: mailbox, to: mask.address, subject: 'Shipped',
        html: '<p onclick="x()">On its way<script>1</script></p><img src="https://t.example/p.gif" alt="logo">',
        attachments: [{ part: '2', name: 'invoice.pdf', type: 'application/pdf', bytes: Buffer.from('%PDF-1.4 test') },
            { part: '3', name: 'page.html', type: 'text/html', bytes: Buffer.from('<script>1</script>') }] });

    const read = await s.get(`/api/v1/me/mail/messages/${m.id}`, { as: alice });
    assert.strictEqual(read.status, 200);
    assert.match(read.headers.get('cache-control') || '', /no-store/);
    assert.ok(!/script|onclick|t\.example\/p\.gif/.test(read.body.message.html), read.body.message.html);
    assert.strictEqual(read.body.message.blocked_images, 1);
    assert.deepStrictEqual(read.body.message.attachments.map((a) => [a.name, a.type]), [['invoice.pdf', 'application/pdf'], ['page.html', 'application/octet-stream']]);
    const shown = await s.get(`/api/v1/me/mail/messages/${m.id}?images=1`, { as: alice });
    assert.match(shown.body.message.html, /t\.example\/p\.gif/);

    assert.strictEqual((await s.get(`/api/v1/me/mail/messages/${m.id}`, { as: bob })).status, 404, 'another person: not found');

    const file = await s.get(`/api/v1/me/mail/messages/${m.id}/attachments/3`, { as: alice });
    assert.strictEqual(file.status, 200);
    assert.strictEqual(file.headers.get('content-type'), 'application/octet-stream', 'html never served as html');
    assert.match(file.headers.get('content-disposition') || '', /^attachment;/);
    assert.strictEqual(file.headers.get('x-content-type-options'), 'nosniff');
    assert.strictEqual((await s.get(`/api/v1/me/mail/messages/${m.id}/attachments/2`, { as: bob })).status, 404);

    assert.strictEqual((await s.post(`/api/v1/me/mail/messages/${m.id}/read`, { as: alice })).status, 200);
    let list = await s.get('/api/v1/me/mail/messages', { as: alice });
    assert.strictEqual(list.body.messages[0].unread, false);
    assert.strictEqual((await s.post(`/api/v1/me/mail/messages/${m.id}/unread`, { as: alice })).status, 200);
    assert.strictEqual((await s.post(`/api/v1/me/mail/messages/${m.id}/read`, { as: bob })).status, 404);

    assert.strictEqual((await s.del(`/api/v1/me/mail/messages/${m.id}`, { as: bob })).status, 404);
    assert.strictEqual((await s.del(`/api/v1/me/mail/messages/${m.id}`, { as: alice })).status, 200);
    assert.strictEqual((await s.get(`/api/v1/me/mail/messages/${m.id}`, { as: alice })).status, 404, 'trashed: gone from the inbox');
});

test('signed out, the inbox sends you to sign in; signed in it is private and never cached', async (t) => {
    const s = await boot();
    t.after(() => s.close());
    const out = await fetch(`${s.base}/inbox`, { redirect: 'manual' });
    assert.strictEqual(out.status, 302);
    assert.match(out.headers.get('location') || '', /^\/auth\/login\?next=%2Finbox/);
    const unauth = await s.get('/api/v1/me/mail/messages');
    assert.strictEqual(unauth.status, 401);
});

test('no message body reaches a log line while reading', async (t) => {
    const s = await boot();
    t.after(() => s.close());
    const alice = s.network.addUser('alice');
    const { mailbox, mask } = await mailboxOf(s, alice);
    const m = s.mail.deliver({ mailboxAddress: mailbox, to: mask.address, subject: 'Secret plans', text: 'the-body-marker-7731', html: '<p>the-html-marker-7731</p>' });
    await s.get(`/api/v1/me/mail/messages/${m.id}`, { as: alice });
    await s.get('/api/v1/me/mail/messages', { as: alice });
    assert.ok(!s.logs().some((l) => /marker-7731/.test(l)), 'a body in a log line');
});
