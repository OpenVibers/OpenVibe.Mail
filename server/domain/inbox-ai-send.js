'use strict';

const { sql } = require('openvibe-sdk/db');
const sending = require('./sending');
const reply = require('./agent-reply');
const providers = require('./outbound-providers');

function senderAddress(from) {
    const value = Array.isArray(from) ? String(from[0] || '') : String(from || '');
    const angle = /<([^<>\s]+@[^<>\s]+)>/.exec(value);
    const address = (angle ? angle[1] : value).trim().toLowerCase();
    return /^[^\s@<>]+@[^\s@<>]+$/.test(address) ? address : null;
}

async function sendInboxDraft({ db, config, stalwart, smtp, owner, threadId, body, subject, now = () => Date.now() }) {
    const draft = await db.maybe(sql`SELECT * FROM mail_inbox_ai_threads
        WHERE owner_subject = ${owner} AND thread_id = ${threadId} AND category = 'needs_reply'`);
    if (!draft || draft.draft_state !== 'draft') return { status: 404, code: 'mail.ai_draft.not_found' };
    const mailbox = await db.maybe(sql`SELECT address FROM mail_mailboxes WHERE owner_subject = ${owner}`);
    if (!mailbox) return { status: 404, code: 'mail.not_found' };
    const original = await stalwart.readMessage({ mailboxAddress: mailbox.address, id: draft.message_id });
    if (!original || original.spam) return { status: 404, code: 'mail.not_found' };
    const to = senderAddress(original.from);
    if (!to || to !== senderAddress(draft.draft_to)) return { status: 422, code: 'mail.ai_draft.recipient_changed' };
    const text = typeof body === 'string' ? body : draft.draft_body;
    const title = typeof subject === 'string' ? subject : draft.draft_subject;
    if (!String(text || '').trim() || String(text).length > 10000 || String(title || '').length > 2000 || /[\r\n\u0000]/.test(String(title || ''))) {
        return { status: 422, code: 'mail.ai_draft.invalid' };
    }
    let route = sending.routeFor(to, config);
    const managed = !sending.isLocal(to, config) && config.outbound && config.outbound.enabled ? await providers.list(db) : [];
    if (managed.length) route = { kind: 'relay', providerManaged: true };
    if (!route) return { status: 409, code: 'mail.outbound_closed', detail: sending.OUTBOUND_CLOSED };
    const claimed = await db.maybe(sql`UPDATE mail_inbox_ai_threads SET draft_state = 'sending',
        draft_body = ${String(text)}, draft_subject = ${String(title || '')}, updated_at = now()
        WHERE owner_subject = ${owner} AND thread_id = ${threadId} AND draft_state = 'draft' RETURNING thread_id`);
    if (!claimed) return { status: 409, code: 'mail.ai_draft.already_sending' };
    try {
        const headers = original.threadHeaders || {};
        const messageId = reply.newMessageId(config.addresses.base);
        const message = reply.buildReply({ from: mailbox.address, to, subject: title, body: text,
            messageId, inReplyTo: headers.messageId || null,
            references: [...(headers.references || []), headers.messageId].filter(Boolean), at: now() });
        const mailer = smtp || require('../stalwart/smtp');
        const result = route.providerManaged
            ? await providers.sendWithFailover({ db, config, from: mailbox.address, to, message, kind: 'person', smtp: mailer, now: new Date(now()) })
            : await mailer.sendMessage(route, { from: mailbox.address, to, message });
        if (!result || !result.ok) {
            // Do not retry automatically; a user may explicitly click send again after seeing the failure.
            await db.exec(sql`UPDATE mail_inbox_ai_threads SET draft_state = 'draft', updated_at = now()
                WHERE owner_subject = ${owner} AND thread_id = ${threadId} AND draft_state = 'sending'`);
            return { status: 502, code: 'mail.send.failed' };
        }
        await db.exec(sql`UPDATE mail_inbox_ai_threads SET draft_state = 'sent', updated_at = now()
            WHERE owner_subject = ${owner} AND thread_id = ${threadId} AND draft_state = 'sending'`);
        return { status: 200, thread_id: threadId, sent: true };
    } catch (err) {
        // An ambiguous transport error stays in 'sending' to prevent accidental duplicate delivery.
        return { status: 502, code: 'mail.send.uncertain' };
    }
}

module.exports = { sendInboxDraft, senderAddress };
