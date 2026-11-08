'use strict';
const crypto = require('crypto');
const { sql } = require('openvibe-sdk/db');
const MailComposer = require('nodemailer/lib/mail-composer');
const sanitize = require('sanitize-html');
const { mailboxAddressFor } = require('./mailboxes');
const sending = require('./sending');
const person = require('./person-mail');
const { createNetworkPolicy } = require('./network-policy');
const MAX_FILE = 5 * 1024 * 1024, MAX_TOTAL = 10 * 1024 * 1024, MAX_FILES = 10, UNDO_MS = 15000;
const ADDRESS = /^[a-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,63}$/i;
function address(value) {
    if (typeof value !== 'string' || value.length > 254 || !ADDRESS.test(value)) throw new Error('Enter a valid email address.');
    return value.toLowerCase();
}
async function identities(db, owner) {
    const rows = await db.many(sql`SELECT address, description AS kind FROM mail_directory_accounts
        WHERE owner = ${owner} AND description <> 'burner' ORDER BY address`);
    const signatures = await db.many(sql`SELECT address, signature FROM mail_address_signatures WHERE owner_subject=${owner}`);
    const allowed = [];
    for (const row of rows) if (await person.senderAllowed(db,owner,row.address)) allowed.push(row);
    return allowed.map((r) => ({ ...r, signature: signatures.find((s) => s.address === r.address)?.signature || '' }));
}
function attachments(input = []) {
    if (!Array.isArray(input) || input.length > MAX_FILES) throw new Error('Attach at most 10 files.');
    let total = 0;
    return input.map((a) => {
        if (!a || typeof a.content !== 'string' || a.content.length > Math.ceil(MAX_FILE / 3) * 4 || /[^A-Za-z0-9+/=]/.test(a.content) || a.content.length % 4 !== 0) throw new Error('Each attachment must be valid base64, at most 5 MB.');
        const bytes = Buffer.from(a.content, 'base64');
        if (bytes.toString('base64') !== a.content) throw new Error('Invalid attachment encoding.');
        total += bytes.length;
        if (bytes.length > MAX_FILE || total > MAX_TOTAL) throw new Error('Attachments are limited to 5 MB each and 10 MB total.');
        const name = String(a.name || 'attachment').replace(/[\x00-\x1f"\\/]/g, '_').slice(0, 180);
        const type = /^[\w.+-]+\/[\w.+-]+$/.test(a.type || '') ? a.type : 'application/octet-stream';
        return { name, type, content: a.content, size: bytes.length };
    });
}
function future(value, now, maxDays = 365) {
    const time = typeof value === 'string' ? Date.parse(value) : NaN;
    if (!Number.isFinite(time) || time <= now || time > now + maxDays * 86400000) throw new Error('Choose a future time within one year.');
    return new Date(time).toISOString();
}
async function enqueue({ db, stalwart, config, owner, input, now = Date.now(), policy = createNetworkPolicy(config) }) {
    if (!input || typeof input.request_id !== 'string' || !/^[a-zA-Z0-9_-]{8,100}$/.test(input.request_id)) throw new Error('A send request needs a unique request_id.');
    const previous = await db.maybe(sql`SELECT id, state, send_at, undo_until FROM mail_compose_outbox WHERE owner_subject=${owner} AND request_id=${input.request_id}`);
    if (previous) return previous;
    const checked = await person.checkPolicy({ db,owner,policy });
    if (checked.code) throw new Error(checked.detail);
    const from = address(input.from);
    if (!(await identities(db, owner)).some((a) => a.address === from)) throw new Error('Choose one of your active sending addresses.');
    const recipients = (value) => {
        if (!Array.isArray(value) || value.length > 10) throw new Error('Use up to 10 recipients.');
        return [...new Set(value.map(address))];
    };
    const to = recipients(input.to), cc = recipients(input.cc || []), bcc = recipients(input.bcc || []);
    const all = [...new Set([...to, ...cc, ...bcc])];
    if (!all.length || all.length > 10) throw new Error('Use 1–10 recipients.');
    if (all.some((recipient) => !sending.canSendTo(recipient, config))) throw new Error(sending.OUTBOUND_CLOSED);
    const subject = input.subject || '', text = input.text || '', html = input.html || '';
    if (typeof subject !== 'string' || subject.length > 500 || /[\r\n\x00]/.test(subject) || typeof text !== 'string' || text.length > 100000 || typeof html !== 'string' || html.length > 100000 || !text.trim()) throw new Error('Add a message; keep the subject under 500 and body under 100,000 characters.');
    const files = attachments(input.attachments);
    let inReplyTo, references, threadId;
    if (input.reply_to) {
        const mailbox = await mailboxAddressFor(db, owner);
        const original = await stalwart.readMessage({ mailboxAddress: mailbox, id: String(input.reply_to) });
        if (!original) throw new Error('The original message is not available.');
        threadId = original.threadId || original.id;
        inReplyTo = original.threadHeaders?.messageId;
        references = [...(original.threadHeaders?.references || []), inReplyTo].filter(Boolean);
    }
    const undoUntil = new Date(now + UNDO_MS).toISOString();
    const sendAt = input.send_at ? future(input.send_at, now) : undoUntil;
    const payload = { from, to, cc, bcc, subject, text, html: sanitize(html, { allowedTags: ['p','br','div','b','strong','i','em','u','a','ul','ol','li','blockquote'], allowedAttributes: { a: ['href'] }, allowedSchemes: ['https','http','mailto'], allowProtocolRelative: false }), attachments: files, inReplyTo, references, thread_id:threadId };
    // Lock the owner's mailbox to serialize quota checks, including concurrent HTTP requests.
    return db.tx(async (t) => {
        await t.maybe(sql`SELECT owner_subject FROM mail_mailboxes WHERE owner_subject=${owner} FOR UPDATE`);
        const count = await t.value(sql`SELECT count(*) FROM mail_compose_outbox WHERE owner_subject=${owner} AND created_at > now() - interval '1 day'`);
        if (Number(count) >= 100) throw new Error('The daily limit is 100 messages. Try again tomorrow.');
        return t.maybe(sql`INSERT INTO mail_compose_outbox(id,owner_subject,request_id,payload,state,send_at,undo_until)
            VALUES(${crypto.randomUUID()},${owner},${input.request_id},${JSON.stringify(payload)}::jsonb,'queued',${sendAt},${undoUntil})
            ON CONFLICT(owner_subject,request_id) DO UPDATE SET request_id=EXCLUDED.request_id
            RETURNING id,state,send_at,undo_until`);
    });
}
async function cancel(db, owner, id) {
    return db.maybe(sql`UPDATE mail_compose_outbox SET state='cancelled',updated_at=now() WHERE id=${id} AND owner_subject=${owner} AND state='queued' RETURNING id,state,payload`);
}
async function mime(payload, id, now, reportUrl = null) {
    return new MailComposer({ from: payload.from, to: payload.to, cc: payload.cc, subject: payload.subject,
        text: payload.text + (reportUrl ? '\n\nReport unwanted mail: ' + reportUrl : ''), html: payload.html ? payload.html + (reportUrl ? '<p>Report unwanted mail: ' + reportUrl + '</p>' : '') : undefined,
        headers: reportUrl ? { 'X-OpenVibe-Report-Abuse':reportUrl } : {}, messageId: `<${id}@${payload.from.split('@')[1]}>`, date: new Date(now),
        inReplyTo: payload.inReplyTo, references: payload.references,
        disableFileAccess: true, disableUrlAccess: true,
        attachments: payload.attachments.map((a) => ({ filename: a.name, content: Buffer.from(a.content,'base64'), contentType: a.type })) }).compile().build();
}
async function runOutbox({ db, config, smtp, now = Date.now(), policy = createNetworkPolicy(config) }) {
    // A lost acknowledgement cannot safely be retried. Show it for review instead of duplicating mail.
    await db.exec(sql`UPDATE mail_compose_outbox SET state='uncertain',updated_at=now() WHERE state='sending' AND updated_at < now() - interval '15 minutes'`);
    const due = await db.many(sql`SELECT id FROM mail_compose_outbox WHERE state='queued' AND send_at <= ${new Date(now).toISOString()} AND undo_until <= ${new Date(now).toISOString()} ORDER BY send_at LIMIT 20`);
    for (const { id } of due) {
        const row = await db.maybe(sql`UPDATE mail_compose_outbox SET state='sending',updated_at=now() WHERE id=${id} AND state='queued' RETURNING *`);
        if (!row) continue;
        let outcomes = [], state = 'uncertain';
        try {
            const p = row.payload;
            const result = await person.send({ db,config,owner:row.owner_subject,from:p.from,
                recipients:[...new Set([...p.to,...p.cc,...p.bcc])],subject:p.subject,body:p.text,policy,smtp,now:new Date(now),
                makeMessage:async ({ id:deliveryId }) => (await mime(p,id,now,`${config.baseUrl}/report/${deliveryId}`)).toString('utf8') });
            outcomes = result.results || [{ state:'failed', reason:result.detail || 'Sending unavailable.' }];
            state = result.status === 200 ? 'sent' : outcomes.some((o) => o.status === 'uncertain') ? 'uncertain' : 'failed';
        } catch { state = 'uncertain'; }
        await db.exec(sql`UPDATE mail_compose_outbox SET state=${state},outcomes=${JSON.stringify(outcomes)}::jsonb,updated_at=now() WHERE id=${id}`);
    }
}
module.exports = { identities, attachments, address, future, enqueue, cancel, mime, runOutbox, MAX_FILE, MAX_TOTAL, MAX_FILES, UNDO_MS };
