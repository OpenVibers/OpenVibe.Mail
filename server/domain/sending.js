'use strict';

/**
 * Sending an agent's reply: build it (server/domain/agent-reply.js), then hand it to the mail server.
 *
 * The two paths, and why there are two:
 *
 *   * LOCAL. The recipient is on one of our own domains (openvibe.email, a mask domain, a burner domain). The mail
 *     server already takes mail for these over loopback, so Mail submits it there on port 25 with no relay and no
 *     credentials. That is the path a reply to the person's own addresses, and a reply to another OpenVibe address,
 *     take today.
 *   * RELAY. The recipient is anyone else. Mail has no outbound reputation and no port 25 path off the host (the
 *     DNS is SPF `-all` on purpose until sending exists), so this path needs the relay the plan names as M3. When
 *     MAIL_RELAY_HOST is set, the reply goes there with STARTTLS and AUTH; when it is not, the send is refused in
 *     plain words and the caller says so. Nothing is ever pretended to have left.
 *
 * Every send is written to mail_sent_mail in the same commit as its outcome, so an agent's page can show what it
 * answered and a person can see what left their address in their name.
 */
const { sql } = require('openvibe-sdk/db');
const reply = require('./agent-reply');

/**
 * Where a reply for this recipient goes: 'local' (the mail server on loopback) or 'relay' (the configured outbound
 * relay), and the SMTP settings for it. `null` when the recipient is not local and no relay is configured.
 */
function routeFor(recipient, config) {
    if (reply.isLocalAddress(recipient, config.addresses)) {
        const local = config.localSubmission;
        return { kind: 'local', host: local.host, port: local.port, starttls: false, user: null, password: null, timeoutMs: reply.LOCAL_TIMEOUT_MS };
    }
    const relay = config.relay;
    if (!relay || !relay.host) return null;
    return {
        kind: 'relay', host: relay.host, port: relay.port, secure: relay.secure,
        starttls: relay.starttls, user: relay.user, password: relay.password, timeoutMs: reply.TIMEOUT_MS,
    };
}

/**
 * Send one reply FROM an agent's inbox and record it. Answers mail.agent-reply-result@1:
 * { sent, message_id, rfc_message_id, reason }. `sent` is what the mail server answered — never "delivered".
 *
 *   { db, config, inbox, owner, to, body, subject, inReplyTo, references, messageId, agentName, now }
 */
async function sendReply({ db, config, inbox, owner, to, body, subject = null, inReplyTo = null, references = [], messageId = null, agentName = null, now = () => Date.now(), smtp = null }) {
    const mailer = smtp || require('../stalwart/smtp');
    const recipient = String(to || '').trim().toLowerCase();
    const from = inbox.address;
    if (!recipient) return { sent: false, message_id: null, rfc_message_id: null, reason: 'A reply needs someone to go to.' };
    if (recipient === from.toLowerCase()) return { sent: false, message_id: null, rfc_message_id: null, reason: 'An agent does not answer itself.' };

    const domain = String(from).slice(from.lastIndexOf('@') + 1);
    const rfcMessageId = messageId || reply.newMessageId(domain);
    const built = reply.buildReply({ from, to: recipient, subject, body, messageId: rfcMessageId, inReplyTo, references, at: now(), agentName });

    const route = routeFor(recipient, config);
    let outcome;
    if (!route) {
        outcome = { ok: false, code: 0, reason: `There is no way to send mail to ${recipient} from OpenVibe yet: the outbound relay is not configured.` };
    } else {
        outcome = await mailer.sendMessage(route, { from, to: recipient, message: built });
    }

    // Recorded whatever happened, in one transaction: the row and the answer cannot disagree.
    await db.tx(async (t) => {
        await t.exec(sql`
            INSERT INTO mail_sent_mail (inbox_id, owner_subject, rfc_message_id, to_address, subject, sent, reason, transport)
            VALUES (${inbox.id}, ${owner}, ${reply.bare(rfcMessageId)}, ${recipient}, ${reply.headerValue(subject) || null},
                    ${Boolean(outcome.ok)}, ${outcome.reason ? String(outcome.reason).slice(0, 300) : null}, ${route ? route.kind : 'none'})
            ON CONFLICT (inbox_id, rfc_message_id) DO NOTHING`);
    });

    return {
        sent: Boolean(outcome.ok),
        message_id: null,
        rfc_message_id: outcome.ok ? reply.bare(rfcMessageId) : null,
        reason: outcome.ok ? null : String(outcome.reason || 'The mail server refused the reply.').slice(0, 300),
    };
}

module.exports = { sendReply, routeFor };
