'use strict';

/**
 * The limits that keep M1 from being an open relay for spam.
 *
 *   * a person has twenty masks and five live burners at a time;
 *   * an address on the internet may make ten burners an hour, and the ten-minute burner is the one that is
 *     allowed without an account.
 *
 * The counters live in the database, not in memory: a restart must not hand everybody a fresh allowance, and two
 * processes of the service must agree.
 */
const { sql } = require('openvibe-sdk/db');

const HOUR_MS = 60 * 60 * 1000;

async function countMasks(t, ownerSubject) {
    const row = await t.maybe(sql`SELECT count(*)::int AS n FROM mail_masks WHERE owner_subject = ${ownerSubject}`);
    return row ? row.n : 0;
}

async function countLiveBurners(t, ownerSubject) {
    const row = await t.maybe(sql`
        SELECT count(*)::int AS n FROM mail_burners
         WHERE owner_subject = ${ownerSubject}
           AND expires_at > now()
           AND (NOT first_message_only OR first_message_at IS NULL)`);
    return row ? row.n : 0;
}

/**
 * Serialize the anonymous-burner cap. A count alone is a soft cap: two requests can both read 1999 and both insert.
 * This row lock is held until the transaction commits, so the count and the insert that follows it are one decision.
 */
async function lockAnonBurners(t) {
    await t.exec(sql`
        INSERT INTO mail_settings (key, value, updated_at)
        VALUES ('anon_burner_lock', '0', now())
        ON CONFLICT (key) DO NOTHING`);
    await t.one(sql`SELECT value FROM mail_settings WHERE key = 'anon_burner_lock' FOR UPDATE`);
}

/** The anonymous burners alive right now: the global ceiling in front of the per-IP limit. */
async function countLiveAnonBurners(t) {
    const row = await t.maybe(sql`
        SELECT count(*)::int AS n FROM mail_burners
         WHERE owner_subject IS NULL
           AND expires_at > now()
           AND (NOT first_message_only OR first_message_at IS NULL)`);
    return row ? row.n : 0;
}

/**
 * Count one thing in a window, and say whether the caller may have one more.
 *
 * The counter is one row: when the window is over the row starts again at one. The count is read back in the same
 * statement that writes it, so two people racing for the last burner do not both get it — the second one sees the
 * count the first one wrote.
 */
async function bump(t, { key, windowMs = HOUR_MS }) {
    const row = await t.one(sql`
        INSERT INTO mail_rate_limits (key, window_started_at, count, updated_at)
        VALUES (${key}, now(), 1, now())
        ON CONFLICT (key) DO UPDATE SET
            count = CASE
                WHEN mail_rate_limits.window_started_at < now() - (${windowMs} * interval '1 millisecond')
                THEN 1 ELSE mail_rate_limits.count + 1 END,
            window_started_at = CASE
                WHEN mail_rate_limits.window_started_at < now() - (${windowMs} * interval '1 millisecond')
                THEN now() ELSE mail_rate_limits.window_started_at END,
            updated_at = now()
        RETURNING count, window_started_at`);
    return { count: row.count, windowStartedAt: row.window_started_at };
}

/** The number of burners this address may still make in this hour. */
async function burnersLeft(t, { ip, limit, windowMs = HOUR_MS }) {
    if (!ip) return { count: 0, left: limit };
    const row = await t.maybe(sql`
        SELECT count FROM mail_rate_limits
         WHERE key = ${`burner:ip:${ip}`}
           AND window_started_at >= now() - (${windowMs} * interval '1 millisecond')`);
    const count = row ? row.count : 0;
    return { count, left: Math.max(0, limit - count) };
}

/** The counters nobody is counting any more. */
async function staleCounters(t, { windowMs = HOUR_MS } = {}) {
    return t.exec(sql`
        DELETE FROM mail_rate_limits
         WHERE window_started_at < now() - (${windowMs} * interval '1 millisecond')`);
}

module.exports = { HOUR_MS, countMasks, countLiveBurners, countLiveAnonBurners, lockAnonBurners, bump, burnersLeft, staleCounters };
