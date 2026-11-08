'use strict';

/**
 * The IMAP side of Inbox AI: connect to the host the person typed, read the INBOX, take the text of new messages.
 *
 * Three rules live here:
 *
 *   * TLS is required. The client only ever creates an implicit-TLS connection; there is no plaintext or
 *     opportunistic mode to configure.
 *   * the address is the person's choice, so it goes through openvibe-shared/egress: safeLookup is the resolver of
 *     the TLS socket, so a name that answers a private or loopback address is refused before the handshake.
 *   * the mailbox is read only. The mailbox is opened with EXAMINE and every body is fetched with BODY.PEEK, so a
 *     poll never sets \Seen and never deletes, moves or stores anything on the remote server.
 */
const { ImapFlow } = require('imapflow');
const { safeLookup, normalizeHost } = require('openvibe-shared/egress');
const sanitizeHtml = require('sanitize-html');

const MAX_TEXT_BYTES = 200_000;

function fail(code, message) {
    const err = new Error(message);
    err.code = code;
    return err;
}

/** Resolve the target once through the egress guard, so a private answer is refused with a clear error. */
function assertPublicTarget(host, { lookup = safeLookup } = {}) {
    return new Promise((resolve, reject) => {
        lookup(normalizeHost(host), { all: true }, (err, addresses) => (err ? reject(err) : resolve(addresses || [])));
    });
}

/** The client, or a refusal. Exported so a test can prove plaintext is not a mode. */
function createClient({ host, port = 993, username, password, lookup = safeLookup, secure = true }) {
    if (secure !== true) throw fail('IMAP_TLS_REQUIRED', 'IMAP connections must use TLS.');
    return new ImapFlow({
        host: normalizeHost(host),
        port: Number(port),
        secure: true,
        auth: { user: username, pass: password },
        // A log line from the client could carry the server's dialogue; the service's own job logs one sentence.
        logger: false,
        tls: { lookup },
        disableAutoIdle: true,
        // Bounded, so one unresponsive provider cannot hold the job or the test connection open.
        connectionTimeout: 30_000,
        greetingTimeout: 15_000,
        socketTimeout: 120_000,
    });
}

/** The first text part of a message, preferring plain text; attachments are never read. */
function textPart(node, type = 'text/plain') {
    if (!node || node.disposition === 'attachment') return null;
    if (node.type === type) return node.part || '1';
    for (const child of node.childNodes || []) {
        const found = textPart(child, type);
        if (found) return found;
    }
    return null;
}

function collect(stream, maxBytes) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        stream.on('data', (chunk) => {
            if (size >= maxBytes) return;
            const keep = chunk.slice(0, Math.max(0, maxBytes - size));
            chunks.push(keep);
            size += keep.length;
        });
        stream.on('error', reject);
        stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
}

function htmlToText(html) {
    return sanitizeHtml(String(html || ''), { allowedTags: [], allowedAttributes: {} });
}

/**
 * One connection to one remote INBOX, closed by `close`.
 *
 * `fetchNew({ afterUid, limit })` answers `{ messages, highestUid }`: messages are the new ones in UID order, and
 * highestUid is the largest UID the server returned — including a junk message the caller must skip — so the poll
 * advances past what it will not triage.
 */
async function createSession({ host, port = 993, username, password, lookup = safeLookup, maxBytes = MAX_TEXT_BYTES }) {
    await assertPublicTarget(host, { lookup });
    const client = createClient({ host, port, username, password, lookup, secure: true });
    let lock = null;
    try {
        await client.connect();
        lock = await client.getMailboxLock('INBOX', { readOnly: true });
        const mailbox = client.mailbox || {};
        const uidValidity = String(mailbox.uidValidity == null ? '' : mailbox.uidValidity);
        const uidNext = Number(mailbox.uidNext) || 1;
        const cap = Math.max(1024, Number(maxBytes) || MAX_TEXT_BYTES);

        return {
            uidValidity,
            uidNext,

            async fetchNew({ afterUid = 0, limit = 50 } = {}) {
                const start = Math.max(0, Number(afterUid) || 0) + 1;
                const end = uidNext - 1;
                if (end < start || limit <= 0) return { messages: [], highestUid: Number(afterUid) || 0 };
                const rows = [];
                let highestUid = Math.max(0, Number(afterUid) || 0);
                for await (const message of client.fetch(`${start}:${end}`, {
                    uid: true, envelope: true, internalDate: true, bodyStructure: true, size: true, flags: true,
                }, { uid: true })) {
                    highestUid = Math.max(highestUid, Number(message.uid) || 0);
                    const flags = message.flags || new Set();
                    if (flags.has('\\Junk') || flags.has('$Junk') || flags.has('\\Spam')) continue;
                    rows.push(message);
                    if (rows.length >= limit) break;
                }

                const messages = [];
                for (const message of rows) {
                    const plain = textPart(message.bodyStructure, 'text/plain');
                    const html = plain ? null : textPart(message.bodyStructure, 'text/html');
                    let text = '';
                    const part = plain || html;
                    if (part) {
                        const download = await client.download(message.uid, part, { uid: true, maxBytes: cap });
                        if (download && download.content) text = await collect(download.content, cap);
                        if (html) text = htmlToText(text);
                    }
                    const envelope = message.envelope || {};
                    const from = (envelope.from || []).map((entry) => entry && entry.address).filter(Boolean);
                    messages.push({
                        uid: Number(message.uid),
                        id: `imap:${message.uid}`,
                        subject: envelope.subject || '',
                        from,
                        receivedAt: message.internalDate ? new Date(message.internalDate).toISOString() : null,
                        text: String(text || '').slice(0, cap),
                    });
                }
                return { messages, highestUid };
            },

            async close() {
                try { if (lock) lock.release(); } catch { /* already released */ }
                try { await client.logout(); } catch { try { client.close(); } catch { /* socket already gone */ } }
                lock = null;
            },
        };
    } catch (err) {
        try { if (lock) lock.release(); } catch { /* nothing selected */ }
        try { await client.logout(); } catch { try { client.close(); } catch { /* nothing to close */ } }
        throw err;
    }
}

/** Open and close INBOX once: the answer is a working connection, or the error that stopped it. */
async function testConnection(options) {
    const session = await createSession({ ...options, maxBytes: 1024 });
    try {
        return { uid_validity: session.uidValidity, uid_next: session.uidNext };
    } finally {
        await session.close();
    }
}

module.exports = { createClient, createSession, testConnection, assertPublicTarget, textPart, MAX_TEXT_BYTES };
