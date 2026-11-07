'use strict';
/**
 * Reading your own mail (M1.5): the person's mailbox and the addresses that deliver into it (masks, agent inboxes),
 * for its owner only. Another person's message is the same 404 as a missing one. Bodies go to the owner and nowhere
 * else: no log line, event or row carries one (test/reading.test.js captures the logger to prove it).
 *
 *   GET    /api/v1/me/mail/addresses                       the mailbox and the addresses that deliver into it
 *   GET    /api/v1/me/mail/messages?address=&cursor=       a page, newest first (address: one of yours, or all)
 *   GET    /api/v1/me/mail/messages/:id[?images=1]         one message, its HTML cleaned (server/domain/reading.js)
 *   GET    /api/v1/me/mail/messages/:id/attachments/:part  the bytes, as a download
 *   POST   /api/v1/me/mail/messages/:id/read | /unread
 *   DELETE /api/v1/me/mail/messages/:id                    to the Trash
 */
const { cleanHtml, downloadType, dispositionFor } = require('../domain/reading');
const masks = require('../domain/masks');
const agentInboxes = require('../domain/agent-inboxes');
const { mailboxAddressFor } = require('../domain/mailboxes');

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const PART_RE = /^[A-Za-z0-9._-]{1,64}$/;

function mountReading(router, { db, stalwart, principal, wrap, fail, ownerOf }) {
    const requirePerson = principal.requirePerson;
    const read = requirePerson(principal.CAPABILITIES.read);
    const write = requirePerson(principal.CAPABILITIES.write);
    const noStore = (res) => res.set('Cache-Control', 'no-store');

    /** The person's mailbox address and every address that delivers into it. */
    async function addressesOf(owner) {
        const [mailbox, maskRows, inboxes] = await Promise.all([
            mailboxAddressFor(db, owner),
            masks.listMaskRows({ db, owner }),
            agentInboxes.listAgentInboxes({ db, owner }),
        ]);
        const list = [];
        if (mailbox) list.push({ address: mailbox, kind: 'mailbox', label: null });
        for (const m of maskRows) list.push({ address: m.address, kind: 'mask', label: m.label || null, enabled: m.enabled !== false });
        for (const i of inboxes) list.push({ address: i.address, kind: 'agent', label: i.agent_id || null });
        return { mailbox, list };
    }

    router.get('/api/v1/me/mail/addresses', read, wrap(async (req, res) => {
        const { mailbox, list } = await addressesOf(ownerOf(req));
        return noStore(res).json({ mailbox, addresses: list });
    }));

    router.get('/api/v1/me/mail/messages', read, wrap(async (req, res) => {
        const owner = ownerOf(req);
        const { mailbox, list } = await addressesOf(owner);
        if (!mailbox) return noStore(res).json({ messages: [], next_cursor: null, mailbox: null });
        const asked = String(req.query.address || 'all').trim().toLowerCase();
        let recipient = null;
        if (asked !== 'all' && asked !== mailbox.toLowerCase()) {
            if (!list.some((a) => a.address.toLowerCase() === asked)) return fail(req, res, 404, 'mail.not_found', 'That address is not one of yours.');
            recipient = asked;
        }
        const cursor = /^\d{1,7}$/.test(String(req.query.cursor || '')) ? Number(req.query.cursor) : 0;
        const page = await stalwart.readMessages({ mailboxAddress: mailbox, recipient, position: cursor, limit: 50 });
        return noStore(res).json({
            messages: page.messages.map((m) => ({
                id: m.id, from: m.from, to: m.to, subject: m.subject, received_at: m.receivedAt,
                unread: m.unread, has_attachments: m.hasAttachment, spam: m.spam,
            })),
            next_cursor: page.next == null ? null : String(page.next),
        });
    }));

    /** The person's mailbox, or an answer that says there is none. */
    async function mailboxOr404(req, res) {
        if (!ID_RE.test(String(req.params.id || ''))) { fail(req, res, 404, 'mail.not_found', 'That message is not here.'); return null; }
        const mailbox = await mailboxAddressFor(db, ownerOf(req));
        if (!mailbox) { fail(req, res, 404, 'mail.not_found', 'That message is not here.'); return null; }
        return mailbox;
    }

    router.get('/api/v1/me/mail/messages/:id', read, wrap(async (req, res) => {
        const mailbox = await mailboxOr404(req, res);
        if (!mailbox) return undefined;
        const m = await stalwart.readMessage({ mailboxAddress: mailbox, id: req.params.id });
        if (!m) return fail(req, res, 404, 'mail.not_found', 'That message is not here.');
        const images = String(req.query.images || '') === '1';
        const cleaned = m.html ? cleanHtml(m.html, { images }) : { html: '', blockedImages: 0 };
        return noStore(res).json({
            message: {
                id: m.id, from: m.from, to: m.to, cc: m.cc, subject: m.subject, date: m.date, unread: m.unread,
                text: m.text || '', html: cleaned.html || null, blocked_images: cleaned.blockedImages,
                attachments: m.attachments.map((a) => ({ part: a.part, name: a.name, type: downloadType(a.type), size: a.size })),
            },
        });
    }));

    router.get('/api/v1/me/mail/messages/:id/attachments/:part', read, wrap(async (req, res) => {
        const mailbox = await mailboxOr404(req, res);
        if (!mailbox) return undefined;
        if (!PART_RE.test(String(req.params.part || ''))) return fail(req, res, 404, 'mail.not_found', 'That attachment is not here.');
        let file;
        try {
            file = await stalwart.readAttachment({ mailboxAddress: mailbox, id: req.params.id, part: req.params.part });
        } catch (err) {
            if (err && err.status === 413) return fail(req, res, 413, 'mail.attachment_too_large', 'That attachment is too large to download here.');
            throw err;
        }
        if (!file) return fail(req, res, 404, 'mail.not_found', 'That attachment is not here.');
        noStore(res);
        res.set('Content-Type', downloadType(file.type));
        res.set('Content-Disposition', dispositionFor(file.name));
        res.set('X-Content-Type-Options', 'nosniff');
        res.set('Content-Security-Policy', "default-src 'none'; sandbox");
        return res.end(file.bytes);
    }));

    for (const [path, seen] of [['read', true], ['unread', false]]) {
        router.post(`/api/v1/me/mail/messages/:id/${path}`, write, wrap(async (req, res) => {
            const mailbox = await mailboxOr404(req, res);
            if (!mailbox) return undefined;
            const ok = await stalwart.setSeen({ mailboxAddress: mailbox, id: req.params.id, seen });
            if (!ok) return fail(req, res, 404, 'mail.not_found', 'That message is not here.');
            return noStore(res).json({ id: req.params.id, unread: !seen });
        }));
    }

    router.delete('/api/v1/me/mail/messages/:id', write, wrap(async (req, res) => {
        const mailbox = await mailboxOr404(req, res);
        if (!mailbox) return undefined;
        const ok = await stalwart.trashMessage({ mailboxAddress: mailbox, id: req.params.id });
        if (!ok) return fail(req, res, 404, 'mail.not_found', 'That message is not here.');
        return noStore(res).json({ id: req.params.id, trashed: true });
    }));
}

module.exports = { mountReading };
