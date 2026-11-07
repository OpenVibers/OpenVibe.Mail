'use strict';

/**
 * The job that keeps M1 honest: a burner's mail is deleted when the burner expires.
 *
 * The work is due-based, not a sweep. Every run asks the database what is due — the burners whose expiry has
 * passed — and does that, and nothing else. There is no weekly round over the whole table, and a service that was
 * down for an hour deletes what expired in that hour the minute it starts, not a week later.
 *
 * The job also watches the burners that were made for one message only: as soon as one of them has taken its
 * message, it stops accepting, and the mail server is told to forget what it cached.
 */
const { sql } = require('openvibe-sdk/db');
const { mailboxAddressFor, poolAddress } = require('../domain/mailboxes');
const { staleCounters } = require('../domain/limits');
const { observe } = require('../domain/messages');

const LEASE_KEY = 'purge_lease';
const LEASE_MS = 30_000;

/** Take the lease, so two instances of the service do not do the same work twice. */
async function takeLease(t, { now = Date.now(), leaseMs = LEASE_MS } = {}) {
    const row = await t.maybe(sql`
        INSERT INTO mail_settings (key, value, updated_at)
        VALUES (${LEASE_KEY}, ${new Date(now).toISOString()}, now())
        ON CONFLICT (key) DO UPDATE
            SET value = EXCLUDED.value, updated_at = now()
            WHERE mail_settings.updated_at < now() - (${leaseMs} * interval '1 millisecond')
        RETURNING value`);
    return Boolean(row);
}

/** The burners whose time is up. */
async function dueBurners(t, { now = Date.now(), limit = 200 } = {}) {
    return t.many(sql`
        SELECT id, owner_subject, address, expires_at, first_message_only, first_message_at
          FROM mail_burners
         WHERE expires_at <= ${new Date(now).toISOString()}
         ORDER BY expires_at
         LIMIT ${limit}`);
}

/** The burners that were made for one message and have not taken it yet. */
async function waitingBurners(t, { limit = 50 } = {}) {
    return t.many(sql`
        SELECT id, owner_subject, address, expires_at, first_message_only, first_message_at
          FROM mail_burners
         WHERE first_message_only
           AND first_message_at IS NULL
           AND expires_at > now()
         ORDER BY created_at
         LIMIT ${limit}`);
}

/**
 * Delete one burner's mail and the burner.
 *
 * The messages are found by the address they were sent to, so a person's other mail is never touched — not even
 * when the burner shared the pool mailbox with a dozen other burners.
 */
async function purgeBurner({ db, stalwart, burner }) {
    const mailbox = burner.owner_subject ? await mailboxAddressFor(db, burner.owner_subject) : await poolAddress(db);
    let deleted = 0;
    if (mailbox && stalwart) {
        // A failure here keeps the row (and with it the next run's work): the mail must not outlive the address
        // because the mail server was down for one minute. Once the mail is gone, the row and its bookkeeping go
        // in one transaction.
        const messages = await stalwart.listMessages({ mailboxAddress: mailbox, recipient: burner.address, limit: 100 });
        if (messages.length) deleted = await stalwart.deleteMessages({ mailboxAddress: mailbox, ids: messages.map((m) => m.id) });
    }
    await db.tx(async (t) => {
        await t.exec(sql`DELETE FROM mail_observed_messages WHERE address = ${burner.address}`);
        await t.exec(sql`DELETE FROM mail_burners WHERE id = ${burner.id}`);
    });
    return deleted;
}

/**
 * One run of the job: what is due, and only that.
 *
 * Returns what it did, so the run can be logged without saying anything about the mail itself.
 */
async function runDue({ db, stalwart, events, now = () => Date.now(), log = console } = {}) {
    const report = { expired: 0, messagesDeleted: 0, consumed: 0, counters: 0, skipped: false };
    const held = await db.tx(async (t) => takeLease(t, { now: now() }));
    if (!held) {
        report.skipped = true;
        return report;
    }

    const expired = await db.tx(async (t) => dueBurners(t, { now: now() }));
    for (const burner of expired) {
        try {
            report.messagesDeleted += await purgeBurner({ db, stalwart, burner });
            report.expired += 1;
        } catch (err) {
            (log.warn || log.log).call(log, `[mail] the burner ${burner.id} was not purged: ${err && err.message}`);
        }
    }
    // The directory no longer resolves the expired addresses, but the mail server's account cache still holds
    // the aliases it learned: without this, a just-expired burner would keep receiving until its cache aged out.
    if (report.expired && stalwart) {
        try {
            await stalwart.invalidateCaches();
        } catch (err) {
            (log.warn || log.log).call(log, `[mail] the mail server did not take the expiry cache notice: ${err && err.message}`);
        }
    }

    const waiting = await db.tx(async (t) => waitingBurners(t));
    for (const burner of waiting) {
        const mailbox = burner.owner_subject ? await mailboxAddressFor(db, burner.owner_subject) : await poolAddress(db);
        if (!mailbox || !stalwart) continue;
        try {
            const messages = await stalwart.listMessages({ mailboxAddress: mailbox, recipient: burner.address, limit: 5 });
            if (!messages.length) continue;
            await observe({ db, events, owner: burner.owner_subject || null, address: burner.address, messages });
            await db.exec(sql`
                UPDATE mail_burners SET first_message_at = now()
                 WHERE id = ${burner.id} AND first_message_at IS NULL`);
            await stalwart.invalidateCaches();
            report.consumed += 1;
        } catch (err) {
            (log.warn || log.log).call(log, `[mail] the burner ${burner.id} was not checked: ${err && err.message}`);
        }
    }

    report.counters = await db.tx(async (t) => staleCounters(t));
    return report;
}

/**
 * The scheduler.
 *
 * A chain of timeouts, not an interval: the next run is planned after the last one finished, so a slow mail
 * server cannot pile runs on top of each other.
 */
function startPurgeJob({ db, stalwart, events, intervalMs = 60_000, now = () => Date.now(), log = console } = {}) {
    let stopped = false;
    let timer = null;

    async function tick() {
        if (stopped) return;
        try {
            const report = await runDue({ db, stalwart, events, now, log });
            if (!report.skipped && (report.expired || report.consumed)) {
                (log.info || log.log).call(log, `[mail] purge: ${report.expired} burners expired, ${report.messagesDeleted} messages deleted`);
            }
        } catch (err) {
            (log.warn || log.log).call(log, `[mail] the purge job failed: ${err && err.message}`);
        }
        if (!stopped) {
            timer = setTimeout(tick, intervalMs);
            if (timer.unref) timer.unref();
        }
    }

    timer = setTimeout(tick, intervalMs);
    if (timer.unref) timer.unref();

    return {
        stop() {
            stopped = true;
            if (timer) clearTimeout(timer);
        },
        runNow: () => runDue({ db, stalwart, events, now, log }),
    };
}

module.exports = { runDue, startPurgeJob, takeLease, dueBurners, waitingBurners, purgeBurner, LEASE_KEY };
