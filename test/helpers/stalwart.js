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
        deliver({ mailboxAddress, to, from = 'tester@example.net', subject = 'Hello', text = '', html = '', receivedAt = null, headers = [] }) {
            counter += 1;
            const message = {
                id: `m${counter}`,
                from: [{ email: from, name: null }],
                to: [{ email: String(to).toLowerCase(), name: null }],
                subject,
                receivedAt: receivedAt || new Date().toISOString(),
                text,
                html,
                headers: [
                    { name: 'Delivered-To', value: ` ${String(to).toLowerCase()}` },
                    ...headers,
                ],
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
                    spam: false,
                    headers: m.headers,
                }));
        },

        async messageBody({ mailboxAddress, id }) {
            calls.messageBody += 1;
            const all = mailboxes.get(String(mailboxAddress || '').toLowerCase()) || [];
            const message = all.find((m) => m.id === id);
            if (!message) return { text: '', html: '' };
            return { text: message.text, html: message.html };
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
