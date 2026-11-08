'use strict';

/**
 * Sending an agent's reply: build it (server/domain/agent-reply.js), then hand it to the mail server.
 *
 * There are two paths, and the second one is CLOSED until the owner says otherwise.
 *
 *   * LOCAL — always available. The recipient is on one of our own domains (openvibe.email, a mask domain, a burner
 *     domain). The mail server already takes mail for these over loopback, so Mail submits it there on port 25 with
 *     no relay and no credentials, and no packet leaves the host.
 *   * OUTBOUND — OFF by default. Sending to anyone else is not ours yet: the plan puts it in M2, and it waits on the
 *     owner (a separate mail IPv4, its PTR record, and Workers Paid for the relay). MAIL_OUTBOUND=on is what turns
 *     it on; only then is the outbound relay (MAIL_RELAY_HOST) even considered. With the switch off, routeFor
 *     answers null before any connection is made, so a reply to a stranger never opens a socket outward — the caller
 *     turns it into the person's approval instead.
 *
 * Every send is written to mail_sent_mail in the same commit as its outcome, so an agent's page can show what it
 * answered and a person can see what left their address in their name.
 */
const { sql } = require('openvibe-sdk/db');
const reply = require('./agent-reply');

/** The words a person reads when a reply cannot go outside OpenVibe yet. */
const OUTBOUND_CLOSED = 'OpenVibe Mail cannot send outside OpenVibe yet: the reply waits here.';

/**
 * Where a reply for this recipient goes: 'local' (the mail server on loopback) or 'relay' (the outbound relay, only
 * with MAIL_OUTBOUND on), and the SMTP settings for it. `null` when a reply may not be sent there at all — which is
 * every address outside our own domains until outbound is switched on.
 */
function routeFor(recipient, config) {
    if (reply.isLocalAddress(recipient, config.addresses)) {
        const local = config.localSubmission;
        return { kind: 'local', host: local.host, port: local.port, starttls: false, user: null, password: null, timeoutMs: reply.LOCAL_TIMEOUT_MS };
    }
    // Outbound mail is not ours to send yet (plan M2, waiting on the owner). A switch, off by default, is the only
    // way on; with it off nothing here reads the relay's settings and no connection is ever opened.
    const outbound = config.outbound;
    if (!outbound || !outbound.enabled) return null;
    const relay = config.relay;
    if (!relay || !relay.host) return null;
    return {
        kind: 'relay', host: relay.host, port: relay.port, secure: relay.secure,
        starttls: relay.starttls, user: relay.user, password: relay.password, timeoutMs: reply.TIMEOUT_MS,
    };
}

/** Can a reply go to this address at all (locally, or outside once the owner turns outbound on)? */
const canSendTo = (recipient, config) => Boolean(routeFor(recipient, config));

/** Is this address on one of our own domains? Then a reply to it never leaves the host. */
const isLocal = (recipient, config) => reply.isLocalAddress(recipient, config.addresses);

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
        outcome = { ok: false, code: 0, reason: OUTBOUND_CLOSED };
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

module.exports = { sendReply, routeFor, canSendTo, isLocal, OUTBOUND_CLOSED };
