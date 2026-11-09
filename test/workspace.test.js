'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot } = require('./helpers/boot');
const { sql } = require('openvibe-sdk/db');
const { parseSearch, searchFilter } = require('../server/domain/mail-search');
const compose = require('../server/domain/compose');
const { wakeSnoozes } = require('../server/jobs/workspace');
const { simpleParser } = require('mailparser');
const B = '/api/v1/me/mail/workspace';
async function setup() {
    const sent = [];
    const smtp = { sendMessage:async (_route,message) => { sent.push(message); return { ok:true,code:250 }; } };
    const s = await boot({ env:{ OV_OAUTH_CLIENT_SECRET:'test-secret' },smtp });
    const alice = s.network.addUser('alice'), bob = s.network.addUser('bob');
    await s.post('/api/v1/masks',{ as:alice,json:{ label:'first' } });
    const mailbox = await s.db.value(sql`SELECT address FROM mail_mailboxes WHERE owner_subject=${alice.subject}`);
    const payload = { request_id:'request-12345',from:mailbox,to:['friend@openvibe.email'],subject:'A subject',text:'A letter',html:'<p>A <b>letter</b></p>',attachments:[] };
    return { s,alice,bob,mailbox,payload,sent,smtp };
}
test('search parsing supports quotes, fields, attachment and strict UTC dates', () => {
    assert.deepEqual(parseSearch('from:alice to:bob subject:"a subject" "two words" has:attachment after:2026-01-01 before:2026-02-01'),[
        { from:'alice' },{ to:'bob' },{ subject:'a subject' },{ text:'two words' },{ hasAttachment:true },{ after:'2026-01-01T00:00:00.000Z' },{ before:'2026-02-01T00:00:00.000Z' },
    ]);
    for (const query of ['after:2026-02-30','before:nope','"open','has:video','subject:""']) assert.throws(() => parseSearch(query));
    assert.equal(searchFilter({ folder:'starred' }).conditions[0].hasKeyword,'$flagged');
});
test('attachment limits apply to decoded bytes, per file, total, count and encoding', () => {
    const file = (size) => ({ name:'notes.txt',type:'text/plain',content:Buffer.alloc(size).toString('base64') });
    assert.equal(compose.attachments([file(compose.MAX_FILE),file(compose.MAX_FILE)]).length,2);
    assert.throws(() => compose.attachments([file(compose.MAX_FILE+1)]));
    assert.throws(() => compose.attachments([file(compose.MAX_FILE),file(compose.MAX_FILE),file(1)]));
    assert.throws(() => compose.attachments(Array.from({ length:11 },() => file(1))));
    assert.throws(() => compose.attachments([{ content:'!!!!' }]));
});
test('undo cancels persistently, owner isolation and idempotency survive a repeated request', async () => {
    const { s,alice,bob,payload,sent,smtp } = await setup();
    try {
        const response = await s.post(B+'/send',{ as:alice,json:payload });
        assert.equal(response.status,202,JSON.stringify(response.body));
        const { id,undo_until } = response.body;
        assert.equal((await s.post(B+'/send',{ as:alice,json:payload })).body.id,id);
        assert.equal((await s.get(B+'/outbox/'+id,{ as:bob })).status,404);
        assert.equal((await s.post(B+'/outbox/'+id+'/cancel',{ as:bob })).status,409);
        await compose.runOutbox({ db:s.db,config:s.config,smtp,stalwart:s.mail,now:Date.parse(undo_until)-1 });
        assert.equal(sent.length,0);
        assert.equal((await s.post(B+'/outbox/'+id+'/cancel',{ as:alice })).status,200);
        await compose.runOutbox({ db:s.db,config:s.config,smtp,stalwart:s.mail,now:Date.parse(undo_until)+1000 });
        assert.equal(sent.length,0);
        assert.equal((await s.get(B+'/outbox',{ as:alice })).body.messages[0].state,'cancelled');
    } finally { await s.close(); }
});
test('scheduled send waits, delivers rich MIME and claims once across concurrent workers', async () => {
    const { s,alice,payload,sent,smtp } = await setup();
    try {
        const at = Date.now()+3600000;
        const response = await s.post(B+'/send',{ as:alice,json:{ ...payload,send_at:new Date(at).toISOString(),cc:['cc@openvibe.email'],bcc:['bcc@openvibe.email'],attachments:[{ name:'hello.txt',type:'text/plain',content:Buffer.from('attachment bytes').toString('base64') }] } });
        assert.equal(response.status,202,JSON.stringify(response.body));
        await compose.runOutbox({ db:s.db,config:s.config,smtp,stalwart:s.mail,now:at-1 }); assert.equal(sent.length,0);
        await Promise.all([compose.runOutbox({ db:s.db,config:s.config,smtp,stalwart:s.mail,now:at+1 }),compose.runOutbox({ db:s.db,config:s.config,smtp,stalwart:s.mail,now:at+1 })]);
        assert.equal(sent.length,3);
        const parsed = await simpleParser(sent[0].message);
        assert.equal(parsed.subject,'A subject'); assert.match(parsed.html,/<b>letter<\/b>/);
        assert.equal(parsed.attachments[0].content.toString(),'attachment bytes'); assert.equal(parsed.bcc,undefined);
        assert.match(parsed.text,/Report unwanted mail:/);
        const out = await s.get(B+'/outbox/'+response.body.id,{ as:alice }); assert.equal(out.body.state,'sent');
        assert.equal((await s.post(B+'/outbox/'+response.body.id+'/cancel',{ as:alice })).status,409);
        assert.equal((await s.post(B+'/send',{ as:alice,json:{ ...payload,request_id:'request-past',send_at:'2020-01-01' } })).status,422);
    } finally { await s.close(); }
});
test('sender, account trust and outbound controls are checked before queueing and again on delivery', async () => {
    const { s,alice,bob,payload,sent,smtp } = await setup();
    try {
        assert.equal((await s.post(B+'/send',{ as:alice,json:{ ...payload,from:'someone@openvibe.email' } })).status,422);
        assert.equal((await s.post(B+'/send',{ as:alice,json:{ ...payload,to:['external@example.net'] } })).status,422);
        const young = s.network.addUser('young',{ ageDays:0 });
        await s.post('/api/v1/masks',{ as:young,json:{} });
        const address = await s.db.value(sql`SELECT address FROM mail_mailboxes WHERE owner_subject=${young.subject}`);
        assert.equal((await s.post(B+'/send',{ as:young,json:{ ...payload,from:address } })).status,422);
        const r = await s.post(B+'/send',{ as:alice,json:payload }); assert.equal(r.status,202);
        const policy = { trust:async () => { throw new Error('offline'); } };
        await compose.runOutbox({ db:s.db,config:s.config,smtp,stalwart:s.mail,policy,now:Date.parse(r.body.undo_until)+1 });
        assert.equal(sent.length,0); assert.equal((await s.get(B+'/outbox/'+r.body.id,{ as:alice })).body.state,'failed');
    } finally { await s.close(); }
});
test('snooze, archive, labels and stars filter before paging and cannot change another mailbox', async () => {
    const { s,alice,bob,mailbox } = await setup();
    try {
        const m = s.mail.deliver({ mailboxAddress:mailbox,to:mailbox,subject:'Invoice',text:'blue receipt',attachments:[{ part:'1',name:'a.txt',type:'text/plain',bytes:Buffer.from('a') }] });
        const url = B+'/messages/'+m.id;
        assert.equal((await s.put(url,{ as:bob,json:{ starred:true } })).status,404);
        assert.equal((await s.put(url,{ as:alice,json:{ starred:true,label:'Travel',archived:true } })).status,200);
        assert.equal((await s.get(B+'/messages',{ as:alice })).body.messages.length,0);
        assert.equal((await s.get(B+'/messages?folder=starred&q=has:attachment%20subject:Invoice',{ as:alice })).body.messages.length,1);
        const wake = Date.now()+60000;
        assert.equal((await s.put(url,{ as:alice,json:{ archived:false,snooze_until:new Date(wake).toISOString() } })).status,200);
        assert.equal((await s.get(B+'/messages',{ as:alice })).body.messages.length,0);
        await wakeSnoozes({ db:s.db,stalwart:s.mail,now:wake-1 });
        assert.equal((await s.get(B+'/messages?folder=snoozed',{ as:alice })).body.messages.length,1);
        await wakeSnoozes({ db:s.db,stalwart:s.mail,now:wake+1 });
        assert.equal((await s.get(B+'/messages',{ as:alice })).body.messages.length,1);
        assert.equal(await s.db.value(sql`SELECT count(*) FROM mail_message_snoozes`),0);
        assert.equal((await s.put(url,{ as:alice,json:{ snooze_until:'nonsense' } })).status,422);
        assert.equal((await s.get(B+'/messages?q=after:invalid',{ as:alice })).status,422);
    } finally { await s.close(); }
});
test('signatures are scoped to owned addresses and outgoing HTML is cleaned', async () => {
    const { s,alice,bob,mailbox,payload } = await setup();
    try {
        assert.equal((await s.put(B+'/signature',{ as:bob,json:{ address:mailbox,signature:'stolen' } })).status,422);
        assert.equal((await s.put(B+'/signature',{ as:alice,json:{ address:mailbox,signature:'Regards' } })).status,200);
        assert.equal((await s.get(B+'/settings',{ as:alice })).body.addresses.find((a) => a.address===mailbox).signature,'Regards');
        const r = await s.post(B+'/send',{ as:alice,json:{ ...payload,html:'<script>bad()</script><p onclick="bad()">hello</p><a href="javascript:bad()">x</a>' } });
        const saved = await s.get(B+'/outbox/'+r.body.id,{ as:alice }); assert.doesNotMatch(saved.body.payload.html,/script|onclick|javascript/);
    } finally { await s.close(); }
});

test('outbox filters before pagination so cancelled sends cannot hide scheduled mail', async () => {
    const { s,alice,payload } = await setup();
    try {
        for (let i=0;i<52;i++) await s.db.exec(sql`INSERT INTO mail_compose_outbox(id,owner_subject,request_id,payload,state,send_at,undo_until)
            VALUES(${require('crypto').randomUUID()},${alice.subject},${'page-'+i},${JSON.stringify(payload)}::jsonb,${i===51 ? 'cancelled' : 'queued'},now(),now())`);
        const first = await s.get(B+'/outbox?folder=scheduled',{ as:alice }); assert.equal(first.status,200,JSON.stringify(first.body));
        assert.equal(first.body.messages.length,50); assert.ok(first.body.next_cursor);
        const second = await s.get(B+'/outbox?folder=scheduled&cursor='+first.body.next_cursor,{ as:alice });
        assert.equal(second.body.messages.length,1); assert.equal(second.body.next_cursor,null);
        assert.equal(new Set([...first.body.messages,...second.body.messages].map((m) => m.id)).size,51);
        assert.equal((await s.get(B+'/outbox?folder=sent',{ as:alice })).body.messages.length,0);
    } finally { await s.close(); }
});
