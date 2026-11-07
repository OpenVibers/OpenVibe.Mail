'use strict';

/**
 * Burners: an address that is thrown away.
 *
 * A burner exists to receive one thing — a verification code, a newsletter, a receipt — and to be gone afterwards.
 * It has an expiry, and when it expires its mail is deleted: not archived, not hidden, deleted.
 *
 * A burner may be made without an account. That is the ten-minute burner, and it is the reason for the limits in
 * front of it: ten an hour from one address, a global cap on live anonymous burners, and five alive at once for a
 * person who has an account.
 *
 * Every burner is its own Stalwart directory account, anonymous or owned. The mail server isolates it; the service
 * reads that account's mailbox with no recipient matching at all, so no sender-written header can move a message
 * from one burner to another.
 */
const crypto = require('crypto');
const { sql } = require('openvibe-sdk/db');
const { ids } = require('openvibe-contracts');
const { burnerAddress } = require('./addresses');
const { ensureOwnerMailbox } = require('./mailboxes');
const { countLiveBurners, countLiveAnonBurners, lockAnonBurners, bump } = require('./limits');
const { listForAddress, observe } = require('./messages');
const { extractCode } = require('../stalwart/code');

const EXPIRIES = {
    '10m': 10 * 60 * 1000,
    '1h': 60 * 60 * 1000,
    '1d': 24 * 60 * 60 * 1000,
    '7d': 7 * 24 * 60 * 60 * 1000,
};
const ANON_EXPIRY = '10m';
const TOKEN_PREFIX = 'mbt_';

function shape(row) {
    if (!row) return null;
    return {
        id: row.id,
        address: row.address,
        owner: row.owner_subject || row.owner || null,
        expires_at: row.expires_at instanceof Date ? row.expires_at.toISOString() : row.expires_at,
        first_message_only: Boolean(row.first_message_only),
        created_at: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    };
}

function hashToken(token) {
    return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

function newToken() {
    return `${TOKEN_PREFIX}${crypto.randomBytes(24).toString('hex')}`;
}

/** The burner's expiry in milliseconds, or null when the name is not one we know. */
function expiryMs(name) {
    return EXPIRIES[String(name || '').trim().toLowerCase()] || null;
}

/**
 * Make a burner.
 *
 * `owner` is the person, or null for a burner made without an account. `ip` is the address the request came from;
 * it is what the anonymous limit counts. The token comes back once, in the answer, and only the hash of it is kept.
 */
async function createBurner({
    db, config, owner = null, expires = ANON_EXPIRY, firstMessageOnly = false, ip = null, now = () => Date.now(),
}) {
    const key = String(expires || '').trim().toLowerCase();
    const ttl = expiryMs(key);
    if (!ttl) {
        const err = new Error(`expires must be one of ${Object.keys(EXPIRIES).join(', ')}`);
        err.code = 'mail.bad_expiry';
        err.status = 400;
        throw err;
    }
    if (!owner && key !== ANON_EXPIRY) {
        const err = new Error('a burner without an account lives for ten minutes');
        err.code = 'mail.anon_expiry';
        err.status = 400;
        throw err;
    }
    const live = owner ? ttl : Math.min(ttl, config.limits.anonBurnerTtlMinutes * 60 * 1000);

    return db.tx(async (t) => {
        if (owner) {
            await ensureOwnerMailbox(t, { ownerSubject: owner, baseDomain: config.addresses.base });
            const used = await countLiveBurners(t, owner);
            if (used >= config.limits.maxLiveBurners) {
                const err = new Error(`a person may have ${config.limits.maxLiveBurners} burners alive at once`);
                err.code = 'mail.burner_limit';
                err.status = 409;
                throw err;
            }
        } else {
            // A global ceiling first, so one person or a botnet cannot fill the database with live anonymous rows;
            // then the per-IP creation limit.
            await lockAnonBurners(t);
            const liveAnon = await countLiveAnonBurners(t);
            if (liveAnon >= config.limits.maxLiveAnonBurners) {
                const err = new Error('the anonymous burner capacity is full; try again later');
                err.code = 'mail.burner_capacity';
                err.status = 503;
                throw err;
            }
            const { count } = await bump(t, { key: `burner:ip:${ip || 'unknown'}`, windowMs: 60 * 60 * 1000 });
            if (count > config.limits.burnersPerIpHour) {
                const err = new Error('too many burners from this address; try again later');
                err.code = 'mail.burner_rate';
                err.status = 429;
                throw err;
            }
        }

        const token = owner ? null : newToken();
        const guestId = owner ? null : `gst_${ids.ulid(now())}`;
        const domain = config.addresses.burners[Math.floor(Math.random() * config.addresses.burners.length)];
        for (let attempt = 0; attempt < 6; attempt++) {
            const address = burnerAddress(domain);
            const row = await t.maybe(sql`
                INSERT INTO mail_burners
                    (id, owner_subject, address, token_hash, guest_id, expires_at, first_message_only)
                VALUES
                    (${`bnr_${ids.ulid(now())}`}, ${owner}, ${address},
                     ${token ? hashToken(token) : null}, ${guestId},
                     ${new Date(now() + live).toISOString()}, ${Boolean(firstMessageOnly)})
                ON CONFLICT (address) DO NOTHING
                RETURNING id, owner_subject, address, expires_at, first_message_only, created_at`);
            if (!row) continue;
            return { burner: shape(row), token };
        }
        const err = new Error('the address is taken; try again');
        err.code = 'mail.address_taken';
        err.status = 503;
        throw err;
    });
}

/** The person's burners, newest first. */
async function listBurners({ db, owner }) {
    const rows = await listBurnerRows({ db, owner });
    return rows.map(shape);
}

/** The person's burners with the fields /me/mail needs beyond the contract (first message and expiry). */
async function listBurnerRows({ db, owner }) {
    const rows = await db.many(sql`
        SELECT id, owner_subject, address, expires_at, first_message_only, first_message_at, created_at
          FROM mail_burners WHERE owner_subject = ${owner}
         ORDER BY created_at DESC`);
    return rows.map((row) => ({
        ...shape(row),
        first_message_at: row.first_message_at instanceof Date
            ? row.first_message_at.toISOString()
            : (row.first_message_at || null),
    }));
}

/** live (accepting mail), consumed (first_message_only and it has taken one) or expired. */
function stateOf(row, now = () => Date.now()) {
    if (!row) return null;
    if (new Date(row.expires_at).getTime() <= now()) return 'expired';
    if (row.first_message_only && row.first_message_at) return 'consumed';
    return 'live';
}

/** One burner, whoever's it is. The caller decides what it may do with it. */
async function findBurner({ db, id }) {
    const row = await db.maybe(sql`
        SELECT id, owner_subject, address, token_hash, guest_id, expires_at, first_message_only, first_message_at, created_at
          FROM mail_burners WHERE id = ${id}`);
    return row || null;
}

/**
 * The burner, if the caller may see it.
 *
 * A person may see their own burners. The holder of the burner's token may see that burner and nothing else — the
 * token is what an account-less burner is read with. Anybody else gets nothing: there is no answer that says
 * "this exists but is not yours".
 */
async function authorizeBurner({ db, id, owner = null, token = null }) {
    const row = await findBurner({ db, id });
    if (!row) return null;
    if (owner && row.owner_subject && row.owner_subject === owner) return row;
    if (token && row.token_hash) {
        const given = Buffer.from(hashToken(token));
        const known = Buffer.from(row.token_hash);
        if (given.length === known.length && crypto.timingSafeEqual(given, known)) return row;
    }
    return null;
}

/** The mailbox of a burner: its own directory account, addressed by the burner address itself. */
async function mailboxOf({ burner }) {
    return burner.address;
}

/**
 * A burner made for one message stops accepting after it has taken one.
 *
 * The mail server decides what an address accepts, and it decides by reading the directory. Once the service has
 * seen the burner's one message it writes the time down, the address leaves the directory view, and the mail
 * server is told to forget what it cached: the next letter bounces.
 */
async function consumeIfFirstOnly({ db, stalwart, burner, messages = [] }) {
    if (!burner || !burner.first_message_only || burner.first_message_at) return false;
    if (!messages.length) return false;
    const row = await db.maybe(sql`
        UPDATE mail_burners SET first_message_at = now()
         WHERE id = ${burner.id} AND first_message_at IS NULL
        RETURNING id`);
    if (!row) return false;
    if (stalwart) {
        try {
            await stalwart.invalidateCaches();
        } catch (err) {
            (console.warn || console.log)(`[mail] the mail server did not take the cache notice: ${err && err.message}`);
        }
    }
    return true;
}

/** The messages sent to a burner, newest first. The whole account belongs to this one burner. */
async function burnerMessages({ db, stalwart, events, burner, limit = 20 }) {
    const mailbox = await mailboxOf({ burner });
    const messages = await listForAddress({
        db,
        stalwart,
        events,
        owner: burner.owner_subject || null,
        address: burner.address,
        mailbox,
        recipient: null,
        limit,
    });
    await consumeIfFirstOnly({ db, stalwart, burner, messages });
    return messages;
}

/**
 * The newest verification code in a burner's mail.
 *
 * The body is fetched, read by the extractor and dropped: it is never written down, never logged and never sent
 * anywhere. A message without a code gives no code.
 */
async function burnerCode({ db, stalwart, events, burner }) {
    const mailbox = await mailboxOf({ burner });
    if (!mailbox) return null;
    // No recipient filtering: the account is the burner. A sender's To/Cc/Delivered-To cannot choose another
    // burner's mailbox, and the account is never shared with another address.
    const messages = await stalwart.listMessages({ mailboxAddress: mailbox, limit: 5 });
    if (!messages.length) return null;
    await observe({ db, events, owner: burner.owner_subject || null, address: burner.address, messages });
    await consumeIfFirstOnly({ db, stalwart, burner, messages });
    for (const message of messages) {
        const body = await stalwart.messageBody({ mailboxAddress: mailbox, id: message.id });
        const found = extractCode({ subject: message.subject, text: body.text, html: body.html });
        if (found) {
            return {
                code: found.code,
                message_id: message.id,
                received_at: message.receivedAt || null,
                from: (message.from || [])[0] || null,
            };
        }
    }
    return null;
}

module.exports = {
    EXPIRIES,
    ANON_EXPIRY,
    createBurner,
    listBurners,
    listBurnerRows,
    stateOf,
    findBurner,
    authorizeBurner,
    mailboxOf,
    burnerMessages,
    burnerCode,
    consumeIfFirstOnly,
    expiryMs,
    shape,
    hashToken,
};
