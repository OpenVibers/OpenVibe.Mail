'use strict';

/**
 * A stand-in for the mail server, in memory.
 *
 * It does what the service asks of Stalwart: it keeps a mailbox per account, it hands back a mailbox's messages,
 * it gives the body of one message, and it forgets a burner's account when the burner expires. The bodies it keeps
 * are the bodies of the test — they are never written to a log.
 */
function createFakeStalwart() {
    const mailboxes = new Map(); // account address → messages
    const calls = { invalidateCaches: 0, listMessages: 0, deleteMessages: 0, destroyAccount: 0, messageBody: 0 };
    let counter = 0;

    function mailbox(address) {
        const key = String(address || '').toLowerCase();
        if (!mailboxes.has(key)) mailboxes.set(key, []);
        return mailboxes.get(key);
    }

    return {
        calls,
        mailboxes,

        /** Put a message in a mailbox, as if it had arrived; the first header is the server's own stamp. */
        deliver({ mailboxAddress, to, from = 'tester@example.net', subject = 'Hello', text = '', html = '', receivedAt = null, headers = [], attachments = [], spam = false }) {
            counter += 1;
            const message = {
                id: `m${counter}`,
                from: [{ email: from, name: null }],
                to: [{ email: String(to).toLowerCase(), name: null }],
                subject,
                receivedAt: receivedAt || new Date().toISOString(),
                text,
                html,
                spam: Boolean(spam),
                headers: [
                    { name: 'Delivered-To', value: ` ${String(to).toLowerCase()}` },
                    ...(headers.some((h) => String(h && h.name || '').toLowerCase() === 'message-id')
                        ? headers
                        : [{ name: 'Message-ID', value: `<fixture-${counter}@example.net>` }, ...headers]),
                ],
                attachments,
            };
            mailbox(mailboxAddress).push(message);
            return message;
        },

        async accountIdFor(address) {
            return String(address || '').toLowerCase();
        },

        async listMessages({ mailboxAddress, recipient = null, limit = 20 }) {
            calls.listMessages += 1;
            const all = mailboxes.get(String(mailboxAddress || '').toLowerCase()) || [];
            const wanted = recipient ? String(recipient).trim().toLowerCase() : null;
            const stamped = (message) => {
                const first = (message.headers || []).find((h) => String(h && h.name || '').toLowerCase() === 'delivered-to');
                return first ? String(first.value || '').trim().toLowerCase() : null;
            };
            // This fake stands in for the Stalwart client, so it applies the same rule as the real one: a shared
            // mailbox is filtered by the first (server-stamped) Delivered-To, never by sender-written headers.
            return all
                .filter((m) => !wanted || stamped(m) === wanted)
                .slice()
                .sort((a, b) => String(b.receivedAt).localeCompare(String(a.receivedAt)))
                .slice(0, limit)
                .map((m) => ({
                    id: m.id,
                    from: m.from.map((a) => a.email),
                    to: m.to.map((a) => a.email),
                    subject: m.subject,
                    receivedAt: m.receivedAt,
                    spam: Boolean(m.spam),
                    headers: m.headers,
                }));
        },

        /** One message, when the server stamped it for this recipient (the real client's readForRecipient). */
        async readForRecipient({ mailboxAddress, recipient, id }) {
            const all = mailboxes.get(String(mailboxAddress || '').toLowerCase()) || [];
            const message = all.find((m) => m.id === id);
            if (!message) return null;
            const stamp = (message.headers || []).find((h) => String(h && h.name || '').toLowerCase() === 'delivered-to');
            const deliveredTo = stamp ? String(stamp.value || '').trim().toLowerCase() : null;
            if (deliveredTo !== String(recipient || '').trim().toLowerCase()) return null;
            return this.readMessage({ mailboxAddress, id });
        },

        async messageBody({ mailboxAddress, id }) {
            calls.messageBody += 1;
            const all = mailboxes.get(String(mailboxAddress || '').toLowerCase()) || [];
            const message = all.find((m) => m.id === id);
            if (!message) return { text: '', html: '' };
            return { text: message.text, html: message.html };
        },

        // ---- reading (M1.5): the same rules as the real client (server/stalwart/client.js) ----
        async readMessages({ mailboxAddress, recipient = null, position = 0, limit = 50 }) {
            const all = [...(mailboxes.get(String(mailboxAddress || '').toLowerCase()) || [])].reverse();
            const wanted = recipient ? String(recipient).trim().toLowerCase() : null;
            const stamped = (m) => { const f = (m.headers || []).find((h) => String(h && h.name || '').toLowerCase() === 'delivered-to'); return f ? String(f.value || '').trim().toLowerCase() : null; };
            const picked = [];
            let used = 0;
            for (const m of all.slice(position)) {
                used += 1;
                if (wanted && stamped(m) !== wanted) continue;
                picked.push({ id: m.id, from: m.from.map((a) => a.email), to: [stamped(m)], subject: m.subject, receivedAt: m.receivedAt, unread: !m.seen, hasAttachment: Boolean((m.attachments || []).length), spam: false });
                if (picked.length >= limit) break;
            }
            return { messages: picked, next: position + used < all.length ? position + used : null };
        },
        async readMessage({ mailboxAddress, id }) {
            const m = (mailboxes.get(String(mailboxAddress || '').toLowerCase()) || []).find((x) => x.id === id && !x.trashed);
            if (!m) return null;
            const headers = m.headers || [];
            const valueOf = (name) => {
                const found = headers.find((h) => String(h && h.name || '').toLowerCase() === name);
                return found ? String(found.value || '') : '';
            };
            const idOf = (raw) => { const x = /<([^<>\s]{1,995})>/.exec(String(raw || '')); return x ? x[1] : null; };
            const refs = [...String(valueOf('references')).matchAll(/<([^<>\s]{1,995})>/g)].map((x) => x[1]).slice(0, 100);
            const stamp = headers.find((h) => String(h && h.name || '').toLowerCase() === 'delivered-to');
            return {
                id: m.id, threadId: m.threadId || m.id, from: m.from.map((a) => a.email), to: m.to.map((a) => a.email), cc: [], subject: m.subject, date: m.receivedAt, unread: !m.seen,
                spam: Boolean(m.spam),
                deliveredTo: stamp ? String(stamp.value || '').trim().toLowerCase() : null,
                threadHeaders: { messageId: idOf(valueOf('message-id')), inReplyTo: idOf(valueOf('in-reply-to')), references: refs },
                text: m.text || '', html: m.html || '',
                attachments: (m.attachments || []).map((a) => ({ part: a.part, blobId: `b-${a.part}`, name: a.name, type: a.type, size: a.bytes.length })),
            };
        },
        async readAttachment({ mailboxAddress, id, part }) {
            const m = (mailboxes.get(String(mailboxAddress || '').toLowerCase()) || []).find((x) => x.id === id && !x.trashed);
            const a = m && (m.attachments || []).find((x) => x.part === String(part));
            return a ? { name: a.name, type: a.type, bytes: a.bytes } : null;
        },
        async setSeen({ mailboxAddress, id, seen }) {
            const m = (mailboxes.get(String(mailboxAddress || '').toLowerCase()) || []).find((x) => x.id === id && !x.trashed);
            if (!m) return false;
            m.seen = Boolean(seen);
            return true;
        },
        async trashMessage({ mailboxAddress, id }) {
            const m = (mailboxes.get(String(mailboxAddress || '').toLowerCase()) || []).find((x) => x.id === id && !x.trashed);
            if (!m) return false;
            m.trashed = true;
            return true;
        },

        async deleteMessages({ mailboxAddress, ids }) {
            calls.deleteMessages += 1;
            const key = String(mailboxAddress || '').toLowerCase();
            const all = mailboxes.get(key) || [];
            const wanted = new Set(ids || []);
            const kept = all.filter((m) => !wanted.has(m.id));
            mailboxes.set(key, kept);
            return all.length - kept.length;
        },

        async destroyAccount({ mailboxAddress }) {
            calls.destroyAccount += 1;
            return mailboxes.delete(String(mailboxAddress || '').toLowerCase());
        },

        async invalidateCaches() {
            calls.invalidateCaches += 1;
        },

        async ensureDomain(name) {
            return false;
        },

        async listDomains() {
            return [];
        },

        forgetAccount() {},
    };
}

module.exports = { createFakeStalwart };
