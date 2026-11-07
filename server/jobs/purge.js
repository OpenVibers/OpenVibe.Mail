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
 * Delete one burner's mail, its Stalwart account and the burner row.
 *
 * The burner's account contains its mail and nothing else, so the delete cannot touch a person's other mail and
 * needs no recipient matching. A failure keeps the row (and with it the next run's work): the mail must not outlive
 * the address because the mail server was down for one minute.
 */
async function purgeBurner({ db, stalwart, burner }) {
    let deleted = 0;
    if (stalwart) {
        // A burner can have more than one page; delete every page before the account itself. The account destroy
        // removes anything left, so the address cannot keep a hidden copy after the row is gone.
        for (let page = 0; page < 200; page++) {
            const messages = await stalwart.listMessages({ mailboxAddress: burner.address, limit: 100 });
            if (!messages.length) break;
            deleted += await stalwart.deleteMessages({ mailboxAddress: burner.address, ids: messages.map((m) => m.id) });
            if (messages.length < 100) break;
        }
        await stalwart.destroyAccount({ mailboxAddress: burner.address });
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
    // The view no longer resolves the expired addresses (whether or not the delete succeeded), but the mail
    // server's account cache still holds what it learned: without this, a just-expired burner could keep receiving
    // until the cache aged out. Invalidate for every due address, not only the ones purged this run.
    if (expired.length && stalwart) {
        try {
            await stalwart.invalidateCaches();
        } catch (err) {
            (log.warn || log.log).call(log, `[mail] the mail server did not take the expiry cache notice: ${err && err.message}`);
        }
    }

    const waiting = await db.tx(async (t) => waitingBurners(t));
    for (const burner of waiting) {
        if (!stalwart) continue;
        try {
            const messages = await stalwart.listMessages({ mailboxAddress: burner.address, limit: 5 });
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
