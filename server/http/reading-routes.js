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
const { sql } = require('openvibe-sdk/db');

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const PART_RE = /^[A-Za-z0-9._-]{1,64}$/;

function mountReading(router, { db, stalwart, config, smtp, principal, wrap, fail, ownerOf }) {
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

    // Inbox AI is a mailbox-level opt-in. No row is equivalent to off for old and new accounts.
    router.get('/api/v1/me/mail/ai-settings', read, wrap(async (req, res) => {
        const owner = ownerOf(req);
        const row = await db.maybe(sql`SELECT enabled, changed_at FROM mail_inbox_ai_consent WHERE owner_subject = ${owner}`);
        return noStore(res).json({ enabled: !!(row && row.enabled), changed_at: row ? row.changed_at : null });
    }));

    router.put('/api/v1/me/mail/ai-settings', write, wrap(async (req, res) => {
        if (!req.body || typeof req.body.enabled !== 'boolean') {
            return fail(req, res, 400, 'mail.ai_settings.invalid', 'enabled must be true or false.');
        }
        const owner = ownerOf(req);
        const mailbox = await mailboxAddressFor(db, owner);
        if (!mailbox) return fail(req, res, 404, 'mail.not_found', 'Create your mailbox before changing its Inbox AI setting.');
        const row = await db.maybe(sql`
            INSERT INTO mail_inbox_ai_consent (owner_subject, enabled)
            VALUES (${owner}, ${req.body.enabled})
            ON CONFLICT (owner_subject) DO UPDATE SET enabled = EXCLUDED.enabled, changed_at = now()
            RETURNING enabled, changed_at`);
        return noStore(res).json({ enabled: row.enabled, changed_at: row.changed_at });
    }));

    router.get('/api/v1/me/mail/triage', read, wrap(async (req, res) => {
        const owner = ownerOf(req);
        const items = await db.many(sql`SELECT thread_id, message_id, category, summary, draft_to, draft_subject,
            draft_body, draft_state, received_at FROM mail_inbox_ai_threads WHERE owner_subject = ${owner}
            ORDER BY received_at DESC NULLS LAST LIMIT 200`);
        const counts = Object.fromEntries(['needs_reply', 'to_read', 'receipts', 'newsletters', 'other'].map((category) =>
            [category, items.filter((item) => item.category === category).length]));
        return noStore(res).json({ counts, threads: items });
    }));

    // The read-only handoff for openvibe.my's Receipts card. `enabled` says whether Inbox AI is on for this mailbox:
    // with it off the card asks the person to turn it on instead of showing triage rows kept from when it was on.
    // The opt-in is checked here, as it is immediately before every model call.
    router.get('/api/v1/me/mail/receipts', read, wrap(async (req, res) => {
        const owner = ownerOf(req);
        const consent = await db.maybe(sql`SELECT enabled FROM mail_inbox_ai_consent WHERE owner_subject = ${owner}`);
        const enabled = !!(consent && consent.enabled);
        const receipts = enabled ? await db.many(sql`SELECT thread_id, message_id, sender AS merchant, subject, summary, received_at
            FROM mail_inbox_ai_threads WHERE owner_subject = ${owner} AND category = 'receipts'
            ORDER BY received_at DESC NULLS LAST LIMIT 200`) : [];
        return noStore(res).json({ enabled, receipts });
    }));

    const rules = require('../domain/inbox-ai-rules');
    router.get('/api/v1/me/mail/ai-rules', read, wrap(async (req, res) =>
        noStore(res).json({ rules: await rules.listRules(db, ownerOf(req)) })));
    router.post('/api/v1/me/mail/ai-rules', write, wrap(async (req, res) => {
        const rule = await rules.createRule(db, ownerOf(req), req.body);
        if (!rule) return fail(req, res, 422, 'mail.ai_rule.invalid', 'A name, sender or subject match, and category are required.');
        return noStore(res).status(201).json({ rule });
    }));
    router.put('/api/v1/me/mail/ai-rules/:id', write, wrap(async (req, res) => {
        const rule = await rules.updateRule(db, ownerOf(req), String(req.params.id), req.body);
        if (!rule) return fail(req, res, 404, 'mail.ai_rule.not_found', 'That rule is not available.');
        return noStore(res).json({ rule });
    }));
    router.delete('/api/v1/me/mail/ai-rules/:id', write, wrap(async (req, res) => {
        const rows = await db.many(sql`DELETE FROM mail_inbox_ai_rules WHERE owner_subject = ${ownerOf(req)} AND id = ${String(req.params.id)} RETURNING id`);
        if (!rows.length) return fail(req, res, 404, 'mail.ai_rule.not_found', 'That rule is not available.');
        return noStore(res).json({ id: rows[0].id, deleted: true });
    }));
    router.get('/api/v1/me/mail/ai-journal', read, wrap(async (req, res) => {
        const entries = await db.many(sql`SELECT id, rule_id, rule_name, thread_id, previous_category, action_category, created_at, undone_at
            FROM mail_inbox_ai_journal WHERE owner_subject = ${ownerOf(req)} ORDER BY created_at DESC LIMIT 200`);
        return noStore(res).json({ entries });
    }));
    router.post('/api/v1/me/mail/ai-journal/:id/undo', write, wrap(async (req, res) => {
        const result = await rules.undo(db, ownerOf(req), String(req.params.id));
        if (!result.ok) return fail(req, res, result.conflict ? 409 : 404, result.conflict ? 'mail.ai_journal.conflict' : 'mail.ai_journal.not_found',
            result.conflict ? 'This thread changed after the rule action, so it was not undone.' : 'That journal entry is not available.');
        return noStore(res).json(result);
    }));

    router.put('/api/v1/me/mail/triage/:threadId/draft', write, wrap(async (req, res) => {
        const threadId = String(req.params.threadId || '');
        const body = String(req.body && req.body.body || '');
        const subject = String(req.body && req.body.subject || '');
        if (!ID_RE.test(threadId) || !body.trim() || body.length > 10000 || subject.length > 2000 || /[\r\n\u0000]/.test(subject)) {
            return fail(req, res, 422, 'mail.ai_draft.invalid', 'The draft needs a valid thread, subject and body.');
        }
        const row = await db.maybe(sql`UPDATE mail_inbox_ai_threads SET draft_body = ${body}, draft_subject = ${subject}, updated_at = now()
            WHERE owner_subject = ${ownerOf(req)} AND thread_id = ${threadId} AND category = 'needs_reply' AND draft_state = 'draft'
            RETURNING thread_id, draft_to, draft_subject, draft_body, draft_state`);
        if (!row) return fail(req, res, 404, 'mail.ai_draft.not_found', 'That draft is not available.');
        return noStore(res).json({ draft: row });
    }));

    router.post('/api/v1/me/mail/triage/:threadId/send', write, wrap(async (req, res) => {
        const threadId = String(req.params.threadId || '');
        if (!ID_RE.test(threadId)) return fail(req, res, 404, 'mail.ai_draft.not_found', 'That draft is not available.');
        const { sendInboxDraft } = require('../domain/inbox-ai-send');
        const result = await sendInboxDraft({ db, config, stalwart, smtp, owner: ownerOf(req), threadId,
            body: req.body && req.body.body, subject: req.body && req.body.subject });
        if (result.status !== 200) return fail(req, res, result.status, result.code, result.detail || 'The draft was not sent.');
        return noStore(res).json(result);
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
