'use strict';

/**
 * Masks: an address that is the person's own, on a domain of ours, and that nobody outside can guess.
 *
 * A mask never forwards anywhere. It delivers into the owner's mailbox in OpenVibe and stops there, and turning it
 * off makes it bounce: the address leaves the directory view, and the mail server is told to forget what it cached
 * about it.
 *
 * A mask may also be given a life: `expires_days` stores when it is due to turn itself off. The purge job disables
 * it then, so the expiry is a fact of the database, not a date the page has to remember. `expires_at` is listing
 * metadata; the mail.mask@1 resource stays exactly the Contract (it has no expiry field).
 */
const { sql } = require('openvibe-sdk/db');
const { ids } = require('openvibe-contracts');
const { maskAddress, maskWords } = require('./addresses');
const { ensureOwnerMailbox } = require('./mailboxes');
const { countMasks } = require('./limits');

const WORDS_FOR_LABEL = 1;
const MAX_EXPIRY_DAYS = 3650;
const DAY_MS = 24 * 60 * 60 * 1000;

function shape(row) {
    if (!row) return null;
    return {
        id: row.id,
        owner: row.owner_subject || row.owner || null,
        address: row.address,
        label: row.label || null,
        purpose: row.purpose || null,
        enabled: row.enabled !== false,
        created_at: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    };
}

/** A row of the person's list, with the fields /me/mail needs beyond the contract (expiry). */
function listShape(row) {
    const mask = shape(row);
    if (!mask) return null;
    return {
        ...mask,
        expires_at: row.expires_at instanceof Date ? row.expires_at.toISOString() : (row.expires_at || null),
    };
}

function stateOf(row, now = () => Date.now()) {
    if (row.expires_at && new Date(row.expires_at).getTime() <= now()) return 'expired';
    if (!row.enabled) return 'disabled';
    return 'active';
}

function expiryDays(value) {
    if (value === undefined || value === null || value === '') return null;
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1 || n > MAX_EXPIRY_DAYS) {
        const err = new Error(`expires_days must be a whole number from 1 to ${MAX_EXPIRY_DAYS}`);
        err.code = 'mail.bad_expiry';
        err.status = 400;
        throw err;
    }
    return n;
}

/**
 * Make a mask for a person.
 *
 * The address is <words>.<four characters>@<mask domain>: the words are what the person asked for, the four
 * characters are what keeps the address unguessable. A collision is retried with new characters — the words stay
 * the person's.
 */
async function createMask({
    db, config, events, owner, label = null, purpose = null, expiresDays = null, now = () => Date.now(),
}) {
    const words = maskWords(label || purpose || '');
    const limit = config.limits.maxMasks;
    const days = expiryDays(expiresDays);
    const expiresAt = days ? new Date(now() + days * DAY_MS) : null;

    return db.tx(async (t) => {
        const mailbox = await ensureOwnerMailbox(t, { ownerSubject: owner, baseDomain: config.addresses.base });
        const used = await countMasks(t, owner);
        if (used >= limit) {
            const err = new Error(`a person may have ${limit} masks`);
            err.code = 'mail.mask_limit';
            err.status = 409;
            throw err;
        }
        for (let attempt = 0; attempt < 6; attempt++) {
            const address = maskAddress(words, config.addresses.mask);
            const row = await t.maybe(sql`
                INSERT INTO mail_masks (id, owner_subject, address, label, purpose, enabled, expires_at)
                VALUES (${`msk_${ids.ulid(now())}`}, ${owner}, ${address}, ${label || null}, ${purpose || null}, true,
                        ${expiresAt ? expiresAt.toISOString() : null})
                ON CONFLICT (address) DO NOTHING
                RETURNING id, owner_subject, address, label, purpose, enabled, expires_at, created_at`);
            if (!row) continue;
            const mask = shape(row);
            if (events) await events.outbox.emit(events.maskCreated({ owner, mask }));
            return shape(row);
        }
        const err = new Error('the address is taken; try again');
        err.code = 'mail.address_taken';
        err.status = 503;
        throw err;
    });
}

/** The person's masks, newest first, in the mail.mask@1 shape. */
async function listMasks({ db, owner }) {
    const rows = await listMaskRows({ db, owner });
    return rows.map(shape);
}

/** The person's masks with the listing metadata (/me/mail): the contract fields and the expiry. */
async function listMaskRows({ db, owner }) {
    const rows = await db.many(sql`
        SELECT id, owner_subject, address, label, purpose, enabled, expires_at, created_at
          FROM mail_masks WHERE owner_subject = ${owner}
         ORDER BY created_at DESC`);
    return rows.map(listShape);
}

/** One mask of this person, or null. Somebody else's mask is not found, not forbidden. */
async function findMask({ db, owner, id }) {
    const row = await db.maybe(sql`
        SELECT id, owner_subject, address, label, purpose, enabled, expires_at, created_at
          FROM mail_masks WHERE id = ${id} AND owner_subject = ${owner}`);
    return shape(row);
}

/**
 * Turn a mask off. The address stops resolving at once — the mail server is told to forget its cache — so the next
 * message to it bounces instead of sitting in the person's mailbox.
 */
async function disableMask({ db, stalwart, owner, id, now = () => Date.now() }) {
    const mask = await db.tx(async (t) => {
        const row = await t.maybe(sql`
            UPDATE mail_masks SET enabled = false
             WHERE id = ${id} AND owner_subject = ${owner} AND enabled
            RETURNING id, owner_subject, address, label, purpose, enabled, expires_at, created_at`);
        return row || null;
    });
    if (!mask) return null;
    if (stalwart) {
        try {
            await stalwart.invalidateCaches();
        } catch (err) {
            // The address is already out of the view; the cache only decides how long the bounce is late.
            (console.warn || console.log)(`[mail] the mail server did not take the cache notice: ${err && err.message}`);
        }
    }
    return shape(mask);
}

/**
 * The masks whose life has run out: disable them and tell the mail server to forget them.
 *
 * Due-based like the burner purge: only rows whose expires_at has passed are touched, so a service that was down
 * for a day catches up on its first run. A failure leaves the row enabled; the next run tries again.
 */
async function disableDueMasks({ db, stalwart, now = () => Date.now() }) {
    const rows = await db.tx(async (t) => t.many(sql`
        UPDATE mail_masks SET enabled = false
         WHERE enabled
           AND expires_at IS NOT NULL
           AND expires_at <= ${new Date(now()).toISOString()}
        RETURNING id, address`));
    if (rows.length && stalwart) {
        try {
            await stalwart.invalidateCaches();
        } catch (err) {
            (console.warn || console.log)(`[mail] the mail server did not take the mask-expiry cache notice: ${err && err.message}`);
        }
    }
    return rows.length;
}

module.exports = {
    createMask,
    listMasks,
    listMaskRows,
    findMask,
    disableMask,
    disableDueMasks,
    shape,
    listShape,
    stateOf,
    expiryDays,
    WORDS_FOR_LABEL,
    MAX_EXPIRY_DAYS,
};
