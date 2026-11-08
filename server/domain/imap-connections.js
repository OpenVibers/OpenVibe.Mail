'use strict';

/**
 * A person's IMAP connection: what they typed, validated, sealed and stored.
 *
 * The rules this module keeps:
 *
 *   * the host must be a public DNS name. An IP literal, `localhost` and a `.local` name are refused before any
 *     socket opens; the connection itself also resolves through openvibe-shared/egress (server/imap/client.js).
 *   * TLS is not a choice: the client only connects with implicit TLS, so a server that speaks plain IMAP is not
 *     reachable through here.
 *   * the password is sealed (server/domain/imap-secrets.js) before the INSERT, and no function in this module
 *     returns it. `shape` is the only thing an API answer is built from.
 *   * deleting a connection deletes the credential; the triage rows it pulled are deleted only when the person asks.
 */
const net = require('node:net');
const { randomUUID } = require('node:crypto');
const { sql } = require('openvibe-sdk/db');
const { isInternalName, normalizeHost } = require('openvibe-shared/egress');
const { sealSecret, openSecret } = require('./imap-secrets');

const HOST_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
const DEFAULT_PORT = 993;

function problem(code, detail, status = 422) {
    const err = new Error(detail);
    err.code = code;
    err.status = status;
    return err;
}

/** The fields of an API answer; never the username's password and never the sealed value. */
function shape(row) {
    return {
        id: row.id,
        host: row.host,
        port: row.port,
        username: row.username,
        last_sync_at: row.last_sync_at || null,
        last_error: row.last_error || null,
        created_at: row.created_at || null,
    };
}

/** What the person typed, or a plain problem. */
function validateInput(body) {
    const input = body && typeof body === 'object' ? body : {};
    const host = normalizeHost(input.host);
    if (!host || host.length > 255 || net.isIP(host) || isInternalName(host) || !HOST_RE.test(host)) {
        throw problem('mail.imap.host_invalid', 'Enter the mail server’s host name, for example imap.gmail.com.');
    }
    const port = input.port === undefined || input.port === null || input.port === '' ? DEFAULT_PORT : Number(input.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw problem('mail.imap.port_invalid', 'Enter the mail server’s IMAP port, usually 993.');
    }
    const username = String(input.username || '').trim();
    if (!username || username.length > 320 || /[\u0000-\u001f\u007f]/.test(username)) {
        throw problem('mail.imap.username_invalid', 'Enter the mailbox’s username, usually its full email address.');
    }
    const password = typeof input.password === 'string' ? input.password : '';
    if (!password || password.length > 1024 || password.includes('\u0000')) {
        throw problem('mail.imap.password_invalid', 'Enter the app password for this mailbox.');
    }
    return { host, port, username, password };
}

/** Errors become one plain sentence. The provider's own text is not repeated: it can echo the username. */
function plainError(err) {
    const code = String((err && err.code) || (err && err.cause && err.cause.code) || '');
    const name = String(err && err.name || '');
    if (err && err.authenticationFailed) return 'Could not sign in. Check the username and the app password.';
    if (code === 'EGRESS_DENIED') return 'That host name does not point to a public mail server.';
    if (/CERT|TLS|SSL/i.test(code) || /certificate/i.test(String(err && err.message || '')) || name === 'TLSSocket') {
        return 'The server’s TLS certificate could not be verified.';
    }
    if (/ENOTFOUND|EAI_AGAIN|EAI_FAIL/i.test(code)) return 'That host name could not be found.';
    if (/ETIMEDOUT|ESOCKETTIMEDOUT|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH/i.test(code)) {
        return 'The mail server did not answer on that host and port.';
    }
    if (code === 'IMAP_SECRET_UNREADABLE' || code === 'IMAP_NO_KEY') return 'The saved app password could not be read. Reconnect the mailbox.';
    return 'The mailbox could not be read. Check the host, port and app password.';
}

async function countForOwner(db, owner) {
    const rows = await db.many(sql`SELECT id FROM mail_imap_mailboxes WHERE owner_subject = ${owner}`);
    return rows.length;
}

async function createConnection({ db, config, owner, input, testResult = null }) {
    const value = validateInput(input);
    if (!config.secrets || !config.secrets.key) {
        throw problem('mail.imap.unavailable', 'Connecting a mailbox is not configured on this server.', 503);
    }
    const max = Math.max(1, (config.imap && config.imap.maxPerOwner) || 5);
    if (await countForOwner(db, owner) >= max) {
        throw problem('mail.imap.limit', `You can connect up to ${max} mailboxes.`, 409);
    }
    const id = `imap_${randomUUID()}`;
    const secret = sealSecret({ key: config.secrets.key, owner, id, plaintext: value.password });
    // The test already told us where the remote INBOX is. Starting at its UIDNEXT - 1 means the first poll reads
    // mail that arrives after the person connected, not the provider's whole archive.
    const uidValidity = testResult && testResult.uid_validity != null ? String(testResult.uid_validity) : null;
    const lastUid = testResult && Number.isFinite(Number(testResult.uid_next))
        ? Math.max(0, Number(testResult.uid_next) - 1)
        : 0;
    const row = await db.maybe(sql`
        INSERT INTO mail_imap_mailboxes
            (id, owner_subject, host, port, username, secret, uid_validity, last_uid, created_at, updated_at)
        VALUES (${id}, ${owner}, ${value.host}, ${value.port}, ${value.username}, ${secret}, ${uidValidity}, ${lastUid}, now(), now())
        ON CONFLICT (owner_subject, host, port, username) DO NOTHING
        RETURNING id, host, port, username, last_sync_at, last_error, created_at`);
    if (!row) throw problem('mail.imap.duplicate', 'That mailbox is already connected.', 409);
    return shape(row);
}

async function listConnections({ db, owner }) {
    const rows = await db.many(sql`SELECT id, host, port, username, last_sync_at, last_error, created_at
        FROM mail_imap_mailboxes WHERE owner_subject = ${owner} ORDER BY created_at`);
    return rows.map(shape);
}

async function findConnection({ db, owner, id }) {
    const row = await db.maybe(sql`SELECT id, owner_subject, host, port, username, secret, uid_validity, last_uid,
        last_sync_at, last_error, next_sync_at FROM mail_imap_mailboxes
        WHERE owner_subject = ${owner} AND id = ${String(id || '')}`);
    return row || null;
}

/** The password, for one outbound connection. The caller must not keep or log it. */
function passwordFor(connection, config) {
    return openSecret({ key: config.secrets.key, owner: connection.owner_subject, id: connection.id, sealed: connection.secret });
}

async function deleteConnection({ db, owner, id, deleteTriage = false }) {
    const connection = await findConnection({ db, owner, id });
    if (!connection) return null;
    let summariesDeleted = 0;
    await db.tx(async (t) => {
        if (deleteTriage) {
            await t.exec(sql`DELETE FROM mail_inbox_ai_journal WHERE owner_subject = ${owner}
                AND thread_id IN (SELECT thread_id FROM mail_inbox_ai_threads
                    WHERE owner_subject = ${owner} AND imap_mailbox_id = ${connection.id})`);
            const gone = await t.many(sql`DELETE FROM mail_inbox_ai_threads
                WHERE owner_subject = ${owner} AND imap_mailbox_id = ${connection.id} RETURNING thread_id`);
            summariesDeleted = gone.length;
        }
        await t.exec(sql`DELETE FROM mail_imap_mailboxes WHERE owner_subject = ${owner} AND id = ${connection.id}`);
    });
    return { id: connection.id, deleted: true, summaries_deleted: summariesDeleted };
}

/** The connections whose person still has Inbox AI on and whose next_sync_at has passed. */
async function dueConnections({ db, limit = 20 }) {
    return db.many(sql`SELECT c.id, c.owner_subject, c.host, c.port, c.username, c.secret, c.uid_validity,
        c.last_uid, c.next_sync_at
        FROM mail_imap_mailboxes c
        JOIN mail_inbox_ai_consent s ON s.owner_subject = c.owner_subject AND s.enabled = true
        WHERE c.next_sync_at <= now()
        ORDER BY c.next_sync_at LIMIT ${Math.max(1, Number(limit) || 20)}`);
}

/** Move one connection's next run out, whether the run worked or not. */
async function reschedule({ db, id, intervalMs }) {
    await db.exec(sql`UPDATE mail_imap_mailboxes
        SET next_sync_at = now() + (${Math.max(1000, Number(intervalMs) || 60_000)} * interval '1 millisecond'),
            updated_at = now()
        WHERE id = ${id}`);
}

async function markSynced({ db, connection, uidValidity, lastUid, intervalMs }) {
    await db.exec(sql`UPDATE mail_imap_mailboxes
        SET uid_validity = ${String(uidValidity)}, last_uid = ${Number(lastUid) || 0}, last_sync_at = now(),
            last_error = NULL,
            next_sync_at = now() + (${Math.max(1000, Number(intervalMs) || 60_000)} * interval '1 millisecond'),
            updated_at = now()
        WHERE id = ${connection.id}`);
}

async function markFailed({ db, connection, error, intervalMs }) {
    // The sentence, never the provider's error text and never the password.
    await db.exec(sql`UPDATE mail_imap_mailboxes
        SET last_sync_at = now(), last_error = ${String(error).slice(0, 300)},
            next_sync_at = now() + (${Math.max(1000, Number(intervalMs) || 60_000)} * interval '1 millisecond'),
            updated_at = now()
        WHERE id = ${connection.id}`);
}

module.exports = {
    shape, validateInput, plainError, createConnection, listConnections, findConnection, passwordFor,
    deleteConnection, dueConnections, reschedule, markSynced, markFailed, DEFAULT_PORT,
};
