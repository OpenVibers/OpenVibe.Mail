'use strict';

/**
 * An agent's reply: the message it sends FROM its own address, in the thread it answers (track HO6).
 *
 * Two rules shape this file, and both are about who may write as whom.
 *
 *   * The From is the agent's inbox address and nothing else. A caller cannot name a different sender, and the
 *     person's own mailbox address is never written from here: an agent answers for a person, it does not become
 *     them.
 *   * The recipient is the sender of the message being answered (or that same address named explicitly). An agent's
 *     answer cannot be sent to a stranger the letter did not come from, so a compromised or confused run cannot use
 *     this path to write to somebody new.
 *
 * The reply is plain text — no HTML, no attachment — and carries In-Reply-To and References so it stays one thread
 * in the reader that receives it. Delivery is local when the recipient is on one of our own domains (the mail
 * server takes it over loopback), and through the outbound relay when one is configured. Until the owner buys a
 * relay, a reply to the outside world is refused in plain words, never pretended.
 */
const crypto = require('crypto');

const LOCAL_TIMEOUT_MS = 20_000;
const MAX_BODY = 10000;
const MAX_SUBJECT = 2000;

/**
 * A header value safe to put on a line: no CR, no LF, no NUL. A subject with a newline in it is how a header is
 * injected into another one, so a value that carries one is refused rather than stripped silently.
 */
function headerValue(value, { max = MAX_SUBJECT } = {}) {
    const text = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
    if (/[\r\n\u0000]/.test(String(value == null ? '' : value))) return null;
    return text.slice(0, max);
}

/** The Message-ID of a reply: random, in our own domain, so it cannot collide with a sender's. */
function newMessageId(domain) {
    return `${crypto.randomUUID()}@${domain}`;
}

/** `Re: …`, once: a subject that already answers does not grow another Re: on every turn. */
function replySubject(subject) {
    const clean = headerValue(subject, { max: MAX_SUBJECT - 4 });
    if (!clean) return 'Re: your message';
    return /^re\s*:/i.test(clean) ? clean : `Re: ${clean}`;
}

/** Angle-bracket a Message-ID exactly once. */
const bracketed = (id) => `<${String(id).replace(/^</, '').replace(/>$/, '')}>`;
const bare = (id) => String(id || '').replace(/^</, '').replace(/>$/, '').trim();

/** A Date header in RFC 5322 form. */
function rfcDate(at) {
    return new Date(at).toUTCString().replace(/GMT$/, '+0000');
}

/**
 * The RFC 5322 text of a reply. `inReplyTo` and `references` are bare Message-IDs; each is bracketed. The body is
 * quoted-printable-free plain UTF-8 (8bit), which every mail server this service talks to accepts.
 */
function buildReply({ from, to, subject, body, messageId, inReplyTo = null, references = [], at = Date.now(), agentName = null }) {
    const text = String(body || '');
    if (!text.trim()) throw new Error('a reply needs a body');
    if (text.length > MAX_BODY) throw new Error(`a reply is at most ${MAX_BODY} characters`);
    const refs = [...new Set((references || []).map(bare).filter(Boolean))];
    const lines = [
        `From: ${headerValue(agentName, { max: 120 }) ? `${quoteName(headerValue(agentName, { max: 120 }))} <${from}>` : from}`,
        `To: ${to}`,
        `Subject: ${replySubject(subject)}`,
        `Date: ${rfcDate(at)}`,
        `Message-ID: ${bracketed(messageId)}`,
    ];
    if (inReplyTo) lines.push(`In-Reply-To: ${bracketed(inReplyTo)}`);
    if (refs.length) lines.push(`References: ${refs.map(bracketed).join(' ')}`);
    lines.push('MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: 8bit', 'Auto-Submitted: auto-replied');
    // The body on CRLF lines; a leading dot is handled by the SMTP client (dot-stuffing).
    const bodyText = text.replace(/\r\n/g, '\n').split('\n').join('\r\n');
    return `${lines.join('\r\n')}\r\n\r\n${bodyText}`;
}

/** "Name" with any quote or backslash escaped (RFC 5322 quoted-string). */
function quoteName(name) {
    return `"${String(name).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** Is this address on one of our own domains? Then delivery is local and no relay is needed. */
function isLocalAddress(address, { base, mask, burners = [] }) {
    const at = String(address || '').lastIndexOf('@');
    if (at < 0) return false;
    const domain = String(address).slice(at + 1).toLowerCase();
    return [base, mask, ...burners].filter(Boolean).some((d) => String(d).toLowerCase() === domain);
}

module.exports = {
    MAX_BODY,
    headerValue,
    newMessageId,
    replySubject,
    rfcDate,
    buildReply,
    isLocalAddress,
    bracket: bracketed,
    bare,
    quoteName,
    LOCAL_TIMEOUT_MS,
};
