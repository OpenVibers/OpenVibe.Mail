'use strict';

/**
 * An agent answers the mail sent to its own address (track HO6, channels, step 1).
 *
 * Three things live here and nowhere else:
 *
 *   * the switch. An address that exists is not an invitation to answer: a person turns answering ON for one agent,
 *     and no row means off. Reading it for an address is a single lookup and never a write.
 *   * the block list. A person may say a sender must never reach their agent. Mail's block list is per owner and
 *     its own (the mail server's spam filter is the other half); a blocked sender starts nothing.
 *   * what has been announced. A row per (inbox, message) is written in the transaction that queues the event, so a
 *     poll that overlaps another poll, or a service that restarted mid-run, never announces the same letter twice.
 *
 * The poll itself is server/jobs/agent-mail.js; this module is what it reads and writes, and what the API asks.
 */
const { sql } = require('openvibe-sdk/db');

const INBOX_ID = /^agi_[0-9A-HJKMNP-TV-Z]{26}$/;
const EXCERPT_MAX = 4000;

const iso = (v) => (v instanceof Date ? v.toISOString() : v || null);

/** The switch as mail.inbox-answering@1: off unless a row says otherwise. */
function answeringShape(inbox, row) {
    return {
        agent_id: inbox.agent_id,
        address: inbox.address,
        owner: inbox.owner || inbox.owner_subject || null,
        enabled: Boolean(row && row.enabled),
        changed_at: row ? iso(row.changed_at) : null,
    };
}

/** The switch of one inbox of this owner. Off when there is no row, which is how an address starts. */
async function getAnswering({ db, owner, inbox }) {
    const row = await db.maybe(sql`
        SELECT enabled, changed_at FROM mail_inbox_answering
         WHERE inbox_id = ${inbox.id} AND owner_subject = ${owner}`);
    return answeringShape(inbox, row);
}

/**
 * Turn answering on or off for one inbox. The row is the person's decision, so `changed_at` moves with it;
 * turning it off keeps the row (with enabled = false) rather than deleting it, so the page can say when.
 */
async function setAnswering({ db, owner, inbox, enabled, now = () => Date.now() }) {
    const at = new Date(now()).toISOString();
    const row = await db.maybe(sql`
        INSERT INTO mail_inbox_answering (inbox_id, owner_subject, enabled, changed_at)
        VALUES (${inbox.id}, ${owner}, ${Boolean(enabled)}, ${at})
        ON CONFLICT (inbox_id) DO UPDATE
            SET enabled = EXCLUDED.enabled, changed_at = EXCLUDED.changed_at
        RETURNING enabled, changed_at`);
    return answeringShape(inbox, row);
}

/** Every inbox of this owner whose answering is on: what the poll walks. */
async function answeringInboxes({ db }) {
    return db.many(sql`
        SELECT a.id, a.owner_subject, a.agent_id, a.address
          FROM mail_agent_inboxes a
          JOIN mail_inbox_answering s ON s.inbox_id = a.id AND s.enabled
         ORDER BY a.created_at`);
}

// ---- the block list ---------------------------------------------------------------------------

const ADDRESS_RE = /^[^\s@<>,;:"]+@[^\s@<>,;:"]+$/;

/** A sender address as the block list stores it: lowercased, trimmed, and only if it is an address. */
function cleanAddress(value) {
    const address = String(value || '').trim().toLowerCase();
    return ADDRESS_RE.test(address) && address.length <= 254 ? address : null;
}

/** Is this sender blocked for this owner? A blocked sender starts nothing at all. */
async function isBlocked({ db, owner, from }) {
    const address = cleanAddress(from);
    if (!address) return false;
    const row = await db.maybe(sql`
        SELECT 1 AS blocked FROM mail_blocked_senders
         WHERE owner_subject = ${owner} AND address = ${address}`);
    return Boolean(row);
}

/** The person's block list, newest first. */
async function listBlocked({ db, owner }) {
    const rows = await db.many(sql`
        SELECT address, created_at FROM mail_blocked_senders
         WHERE owner_subject = ${owner} ORDER BY created_at DESC`);
    return rows.map((r) => ({ address: r.address, created_at: iso(r.created_at) }));
}

/** Block a sender for this owner; asking twice is not an error. */
async function blockSender({ db, owner, address }) {
    const clean = cleanAddress(address);
    if (!clean) {
        const err = new Error('a block needs an email address');
        err.code = 'mail.bad_address';
        err.status = 422;
        throw err;
    }
    await db.exec(sql`
        INSERT INTO mail_blocked_senders (owner_subject, address)
        VALUES (${owner}, ${clean}) ON CONFLICT (owner_subject, address) DO NOTHING`);
    return { address: clean };
}

/** Take a sender off the block list; false when it was not on it. */
async function unblockSender({ db, owner, address }) {
    const clean = cleanAddress(address);
    if (!clean) return false;
    const rows = await db.many(sql`
        DELETE FROM mail_blocked_senders
         WHERE owner_subject = ${owner} AND address = ${clean}
        RETURNING address`);
    return rows.length > 0;
}

// ---- what has been announced -------------------------------------------------------------------

/**
 * Write down that this letter is the agent's, and whether it was announced. The insert and the event share one
 * transaction in the poll, so a row without an announced_at is a letter still waiting to be told about.
 */
async function claim({ t, inbox, messageId, from }) {
    return t.maybe(sql`
        INSERT INTO mail_agent_mail (inbox_id, message_id, owner_subject, from_address)
        VALUES (${inbox.id}, ${messageId}, ${inbox.owner_subject}, ${cleanAddress(from)})
        ON CONFLICT (inbox_id, message_id) DO NOTHING
        RETURNING message_id`);
}

/** The message ids of this inbox the poll has already handled, so a walk skips them. */
async function known({ db, inboxId, messageIds = [] }) {
    const list = [...new Set((messageIds || []).filter(Boolean))];
    if (!list.length) return new Set();
    const rows = await db.many(sql`
        SELECT message_id FROM mail_agent_mail
         WHERE inbox_id = ${inboxId} AND message_id = ANY(${list})`);
    return new Set(rows.map((r) => r.message_id));
}

/** Mark a claimed letter as announced (its event is in the outbox in the same commit). */
async function announced({ t, inboxId, messageId, now = () => Date.now() }) {
    await t.exec(sql`
        UPDATE mail_agent_mail SET announced_at = ${new Date(now()).toISOString()}
         WHERE inbox_id = ${inboxId} AND message_id = ${messageId} AND announced_at IS NULL`);
}

/** The last `limit` letters the agent answered, newest first: what its page lists, with the thread's run. */
async function answered({ db, inboxId, limit = 10 }) {
    const rows = await db.many(sql`
        SELECT message_id, from_address, created_at FROM mail_agent_mail
         WHERE inbox_id = ${inboxId} AND announced_at IS NOT NULL
         ORDER BY created_at DESC LIMIT ${limit}`);
    return rows.map((r) => ({ message_id: r.message_id, from: r.from_address || null, announced_at: iso(r.announced_at || r.created_at) }));
}

/** The excerpt a mail.agent_inbox.received carries: the text part, cut, never the html or an attachment. */
function excerptOf(text) {
    const value = String(text || '');
    return value.length > EXCERPT_MAX ? value.slice(0, EXCERPT_MAX) : value;
}

module.exports = {
    INBOX_ID,
    EXCERPT_MAX,
    answeringShape,
    getAnswering,
    setAnswering,
    answeringInboxes,
    cleanAddress,
    isBlocked,
    listBlocked,
    blockSender,
    unblockSender,
    claim,
    known,
    announced,
    answered,
    excerptOf,
};
