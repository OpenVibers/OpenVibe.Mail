'use strict';

/**
 * Masks: an address that is the person's own, on a domain of ours, and that nobody outside can guess.
 *
 * A mask never forwards anywhere. It delivers into the owner's mailbox in OpenVibe and stops there, and turning it
 * off makes it bounce: the address leaves the directory view, and the mail server is told to forget what it cached
 * about it.
 */
const { sql } = require('openvibe-sdk/db');
const { ids } = require('openvibe-contracts');
const { maskAddress, maskWords } = require('./addresses');
const { ensureOwnerMailbox } = require('./mailboxes');
const { countMasks } = require('./limits');

const WORDS_FOR_LABEL = 1;

function shape(row) {
    if (!row) return null;
    return {
        id: row.id,
        address: row.address,
        label: row.label || null,
        purpose: row.purpose || null,
        enabled: row.enabled !== false,
        created_at: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    };
}

/**
 * Make a mask for a person.
 *
 * The address is <words>.<four characters>@<mask domain>: the words are what the person asked for, the four
 * characters are what keeps the address unguessable. A collision is retried with new characters — the words stay
 * the person's.
 */
async function createMask({ db, config, events, owner, label = null, purpose = null, now = () => Date.now() }) {
    const words = maskWords(label || purpose || '');
    const limit = config.limits.maxMasks;

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
                INSERT INTO mail_masks (id, owner_subject, address, label, purpose, enabled)
                VALUES (${`msk_${ids.ulid(now())}`}, ${owner}, ${address}, ${label || null}, ${purpose || null}, true)
                ON CONFLICT (address) DO NOTHING
                RETURNING id, address, label, purpose, enabled, created_at`);
            if (!row) continue;
            const mask = shape(row);
            if (events) await events.outbox.emit(events.maskCreated({ owner, mask }));
            return mask;
        }
        const err = new Error('the address is taken; try again');
        err.code = 'mail.address_taken';
        err.status = 503;
        throw err;
    });
}

/** The person's masks, newest first. */
async function listMasks({ db, owner }) {
    const rows = await db.many(sql`
        SELECT id, address, label, purpose, enabled, created_at
          FROM mail_masks WHERE owner_subject = ${owner}
         ORDER BY created_at DESC`);
    return rows.map(shape);
}

/** One mask of this person, or null. Somebody else's mask is not found, not forbidden. */
async function findMask({ db, owner, id }) {
    const row = await db.maybe(sql`
        SELECT id, address, label, purpose, enabled, created_at
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
            RETURNING id, address, label, purpose, enabled, created_at`);
        return shape(row);
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
    return mask;
}

module.exports = { createMask, listMasks, findMask, disableMask, shape, WORDS_FOR_LABEL };
