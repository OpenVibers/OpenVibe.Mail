'use strict';

/**
 * Pulling another provider's mailbox into Inbox AI.
 *
 * The job is the arrival, and it is due-based: a connection runs when its own next_sync_at has passed (every
 * MAIL_IMAP_INTERVAL_MS), not on every tick of the timer. One run reads only UIDs above the stored last_uid, resets
 * when the server's UIDVALIDITY changes, and hands each new message's text to the same analyzer and the same
 * storeTriage path as forwarded mail (server/domain/inbox-ai-store.js).
 *
 * The remote mailbox is read only (server/imap/client.js opens it with EXAMINE and BODY.PEEK). A message that is
 * junk on the remote server is skipped but its UID is passed, so the next run does not read it again. A run that
 * throws does not advance last_uid; the next attempt re-reads, and the thread_id dedupe stops a double summary.
 *
 * Logs carry the connection id and one plain sentence. Never a host's error text, a subject, a sender or a password.
 */
const { sql } = require('openvibe-sdk/db');
const imapConnections = require('../domain/imap-connections');
const { storeTriage } = require('../domain/inbox-ai-store');
const { matchedRule } = require('../domain/inbox-ai-rules');
const { createInboxAnalyzer } = require('../ai/inbox');
const defaultImap = require('../imap/client');

const LEASE_KEY = 'imap_pull_lease';
const LEASE_MS = 120_000;

async function takeLease(db, now = Date.now(), leaseMs = LEASE_MS) {
    return db.maybe(sql`
        INSERT INTO mail_settings (key, value, updated_at)
        VALUES (${LEASE_KEY}, ${new Date(now).toISOString()}, now())
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
        WHERE mail_settings.updated_at < now() - (${leaseMs} * interval '1 millisecond')
        RETURNING value`);
}

/** One connection: read the new messages, triage them, and move last_uid only when the run finished cleanly. */
async function pullConnection({ db, config, imap, analyze, connection }) {
    // A key rotation leaves an old row unreadable; the error is reported in plain words and the row is kept so the
    // person can Disconnect it.
    const password = imapConnections.passwordFor(connection, config);
    const session = await imap.createSession({
        host: connection.host,
        port: connection.port,
        username: connection.username,
        password,
        maxBytes: config.imap.maxBytes,
    });
    try {
        const validity = String(session.uidValidity);
        const stored = connection.uid_validity == null ? null : String(connection.uid_validity);
        // A changed UIDVALIDITY means the old UID numbers mean nothing: start over and let thread_id dedupe.
        const afterUid = stored && stored === validity ? Number(connection.last_uid) || 0 : 0;
        const { messages, highestUid } = await session.fetchNew({ afterUid, limit: config.imap.maxMessages });
        let triaged = 0;
        let consented = true;
        for (const message of messages) {
            const still = await db.maybe(sql`SELECT 1 AS enabled FROM mail_inbox_ai_consent
                WHERE owner_subject = ${connection.owner_subject} AND enabled = true`);
            if (!still) { consented = false; break; }
            const threadId = `imap:${connection.id}:${validity}:${message.uid}`;
            const exists = await db.maybe(sql`SELECT 1 AS found FROM mail_inbox_ai_threads
                WHERE owner_subject = ${connection.owner_subject} AND thread_id = ${threadId}`);
            if (exists) continue;
            const triage = await analyze({ owner: connection.owner_subject, message });
            if (!triage) continue;
            const rule = await matchedRule(db, connection.owner_subject, message);
            await storeTriage({
                db,
                owner: connection.owner_subject,
                threadId,
                message,
                triage,
                rule,
                source: 'imap',
                imapMailboxId: connection.id,
            });
            triaged += 1;
        }
        if (consented) {
            await imapConnections.markSynced({ db, connection, uidValidity: validity, lastUid: highestUid, intervalMs: config.imap.intervalMs });
        }
        return triaged;
    } finally {
        try { await session.close(); } catch { /* the socket is already gone */ }
    }
}

async function runImapPull({ db, config, imap = defaultImap, analyze, now = () => Date.now(), log = console } = {}) {
    const report = { mailboxes: 0, pulled: 0, failed: 0, skipped: false };
    if (!config || !config.secrets || !config.secrets.key || !analyze) { report.skipped = true; return report; }
    const leaseMs = (config.imap && config.imap.leaseMs) || LEASE_MS;
    const held = await db.tx((t) => takeLease(t, now(), leaseMs));
    if (!held) { report.skipped = true; return report; }

    const due = await imapConnections.dueConnections({ db, limit: (config.imap && config.imap.batch) || 20 });
    for (const connection of due) {
        report.mailboxes += 1;
        // Claim it before the work: a second instance sees the new next_sync_at and leaves it alone.
        await imapConnections.reschedule({ db, id: connection.id, intervalMs: config.imap.intervalMs });
        try {
            report.pulled += await pullConnection({ db, config, imap, analyze, connection });
        } catch (err) {
            report.failed += 1;
            const sentence = imapConnections.plainError(err);
            await imapConnections.markFailed({ db, connection, error: sentence, intervalMs: config.imap.intervalMs });
            (log.warn || log.log).call(log, `[mail] IMAP mailbox ${connection.id} was not read: ${sentence}`);
        }
    }
    return report;
}

/** A chain of timeouts, not an interval: a slow provider cannot pile runs on top of each other. */
function startImapPullJob({ db, config, imap = defaultImap, fetchImpl, intervalMs = null, now = () => Date.now(), log = console } = {}) {
    const analyze = createInboxAnalyzer({ config, fetchImpl });
    const every = Math.max(1000, intervalMs || (config.imap && config.imap.tickMs) || 60_000);
    let stopped = false;
    let timer = null;

    async function tick() {
        if (stopped) return;
        try {
            const report = await runImapPull({ db, config, imap, analyze, now, log });
            if (!report.skipped && (report.pulled || report.failed)) {
                (log.info || log.log).call(log, `[mail] IMAP: ${report.pulled} message(s) triaged from ${report.mailboxes} mailbox(es), ${report.failed} failed`);
            }
        } catch (err) {
            (log.warn || log.log).call(log, `[mail] the IMAP pull job failed: ${String(err && err.code || 'run failed').slice(0, 80)}`);
        }
        if (!stopped) {
            timer = setTimeout(tick, every);
            if (timer.unref) timer.unref();
        }
    }

    timer = setTimeout(tick, every);
    if (timer.unref) timer.unref();

    return {
        stop() {
            stopped = true;
            if (timer) clearTimeout(timer);
        },
        runNow: () => runImapPull({ db, config, imap, analyze, now, log }),
    };
}

module.exports = { runImapPull, pullConnection, startImapPullJob, takeLease, LEASE_KEY };
