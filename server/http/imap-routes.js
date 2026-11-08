'use strict';

/**
 * Connecting another provider's mailbox to Inbox AI.
 *
 *   GET    /api/v1/me/mail/imap-mailboxes                     the person's connections, never a password
 *   POST   /api/v1/me/mail/imap-mailboxes                     test, then save (TLS only, public host, sealed secret)
 *   DELETE /api/v1/me/mail/imap-mailboxes/:id[?delete_triage=1]  disconnect; optionally delete the pulled summaries
 *
 * Connecting requires Inbox AI to be on for the mailbox, because that is what reads the connection. The test runs
 * before the INSERT, so a wrong host or app password never leaves a row behind. Every answer is no-store, and no
 * answer carries the password or the sealed value.
 */
const { sql } = require('openvibe-sdk/db');
const imapConnections = require('../domain/imap-connections');
const { mailboxAddressFor } = require('../domain/mailboxes');
const defaultImap = require('../imap/client');

const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;

function mountImap(router, { db, config, principal, wrap, fail, ownerOf, imap = defaultImap }) {
    const read = principal.requirePerson(principal.CAPABILITIES.read);
    const write = principal.requirePerson(principal.CAPABILITIES.write);
    const noStore = (res) => res.set('Cache-Control', 'no-store');

    const MAX_MAILBOXES = 5, MAX_ATTEMPTS = 10, ATTEMPT_WINDOW_MS = 60 * 60_000;
    const attempts = new Map();
    router.get('/api/v1/me/mail/imap-mailboxes', read, wrap(async (req, res) => {
        const mailboxes = await imapConnections.listConnections({ db, owner: ownerOf(req) });
        return noStore(res).json({ mailboxes });
    }));

    router.post('/api/v1/me/mail/imap-mailboxes', write, wrap(async (req, res) => {
        const owner = ownerOf(req);
        // Each attempt opens a TLS connection to a host the person chose: a few per hour, and a few mailboxes each.
        const now = Date.now();
        const recent = (attempts.get(owner) || []).filter((at) => now - at < ATTEMPT_WINDOW_MS);
        if (recent.length >= MAX_ATTEMPTS) {
            return fail(req, res, 429, 'mail.imap.too_many_attempts', 'Too many connection attempts. Try again in an hour.');
        }
        recent.push(now); attempts.set(owner, recent);
        const connected = await imapConnections.listConnections({ db, owner });
        if (connected.length >= MAX_MAILBOXES) {
            return fail(req, res, 409, 'mail.imap.too_many', `You can connect up to ${MAX_MAILBOXES} other mailboxes. Disconnect one first.`);
        }
        let input;
        try {
            input = imapConnections.validateInput(req.body);
        } catch (err) {
            return fail(req, res, err.status || 422, err.code || 'mail.imap.invalid', err.message);
        }
        if (!config.secrets || !config.secrets.key) {
            return fail(req, res, 503, 'mail.imap.unavailable', 'Connecting a mailbox is not configured on this server.');
        }
        const mailbox = await mailboxAddressFor(db, owner);
        if (!mailbox) return fail(req, res, 404, 'mail.not_found', 'Create your mailbox before connecting another one.');
        const consent = await db.maybe(sql`SELECT enabled FROM mail_inbox_ai_consent WHERE owner_subject = ${owner}`);
        if (!consent || !consent.enabled) {
            return fail(req, res, 409, 'mail.imap.ai_off', 'Turn on Inbox AI before connecting a mailbox.');
        }

        // The test is the first outbound connection: TLS only, through the egress guard, and read only. Its
        // uid_validity/uid_next anchor the first poll at mail that arrives after this moment.
        let testResult = null;
        try {
            testResult = await imap.testConnection({
                host: input.host,
                port: input.port,
                username: input.username,
                password: input.password,
                maxBytes: 1024,
            });
        } catch (err) {
            return fail(req, res, 422, 'mail.imap.connect_failed', imapConnections.plainError(err));
        }

        try {
            const connection = await imapConnections.createConnection({ db, config, owner, input, testResult });
            return noStore(res).status(201).json({ mailbox: connection });
        } catch (err) {
            if (err && err.status) return fail(req, res, err.status, err.code || 'mail.imap.error', err.message);
            throw err;
        }
    }));

    router.delete('/api/v1/me/mail/imap-mailboxes/:id', write, wrap(async (req, res) => {
        const id = String(req.params.id || '');
        if (!ID_RE.test(id)) return fail(req, res, 404, 'mail.not_found', 'That mailbox is not connected.');
        const deleteTriage = /^(1|true|yes)$/i.test(String(req.query.delete_triage || ''));
        const result = await imapConnections.deleteConnection({ db, owner: ownerOf(req), id, deleteTriage });
        if (!result) return fail(req, res, 404, 'mail.not_found', 'That mailbox is not connected.');
        return noStore(res).json(result);
    }));
}

module.exports = { mountImap };
