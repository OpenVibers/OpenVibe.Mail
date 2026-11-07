'use strict';

/**
 * Where a person's mail lands, and where the mail of a burner made without an account lands.
 *
 * Every person who owns an address has one mailbox: an account in the mail server, addressed
 * <local>@<base domain>. The row is written the first time the person asks for a mask, a burner or an agent
 * inbox, and it never changes afterwards — the address is the address.
 *
 * A burner may be made without an account (the ten-minute burner). Its mail then goes to the service's own pool
 * mailbox, and the service separates the messages by the address they were sent to. The pool address is a setting
 * because the directory view has to read it.
 */
const { sql } = require('openvibe-sdk/db');
const { localOf, mailboxAddress, mailboxLocalFor } = require('./addresses');

const POOL_KEY = 'burner_pool';
const POOL_SUBJECT = 'service:burner-pool';

function wireMailbox(t, { ownerSubject, address }) {
    return t.maybe(sql`
        INSERT INTO mail_mailboxes (owner_subject, address)
        VALUES (${ownerSubject}, ${address})
        ON CONFLICT (owner_subject) DO NOTHING
        RETURNING address`);
}

async function mailboxAddressFor(t, ownerSubject) {
    const row = await t.maybe(sql`SELECT address FROM mail_mailboxes WHERE owner_subject = ${ownerSubject}`);
    return row ? row.address : null;
}

/** The person's own mailbox, written once and never changed. */
async function ensureMailbox(t, { ownerSubject, address }) {
    const existing = await mailboxAddressFor(t, ownerSubject);
    if (existing) return existing;
    const inserted = await wireMailbox(t, { ownerSubject, address });
    if (inserted) return inserted.address;
    const again = await mailboxAddressFor(t, ownerSubject);
    if (again) return again;
    // Another address is already taken by somebody else: add a short suffix and try once more.
    const taken = await t.maybe(sql`SELECT 1 AS taken FROM mail_mailboxes WHERE address = ${address}`);
    if (!taken) throw new Error('the mailbox address is taken');
    const alternative = `${localOf(address)}-${String(ownerSubject).slice(-4).toLowerCase()}@${address.slice(address.lastIndexOf('@') + 1)}`;
    const second = await wireMailbox(t, { ownerSubject, address: alternative });
    return second ? second.address : alternative;
}

/** The mailbox of a person, named after their Network subject id. */
async function ensureOwnerMailbox(t, { ownerSubject, baseDomain }) {
    return ensureMailbox(t, {
        ownerSubject,
        address: mailboxAddress(mailboxLocalFor(ownerSubject), baseDomain),
    });
}

/** The pool mailbox: where the mail of a burner made without an account goes. */
async function ensurePoolMailbox(t, { baseDomain }) {
    const existing = await mailboxAddressFor(t, POOL_SUBJECT);
    if (existing) return existing;
    const address = mailboxAddress('burner-pool', baseDomain);
    const inserted = await wireMailbox(t, { ownerSubject: POOL_SUBJECT, address });
    if (inserted) return inserted.address;
    const again = await mailboxAddressFor(t, POOL_SUBJECT);
    if (again) return again;
    const alternative = mailboxAddress(`burner-pool-${String(Date.now()).slice(-6)}`, baseDomain);
    const second = await wireMailbox(t, { ownerSubject: POOL_SUBJECT, address: alternative });
    return second ? second.address : alternative;
}

async function poolAddress(t) {
    const row = await t.maybe(sql`SELECT value FROM mail_settings WHERE key = ${POOL_KEY}`);
    return row ? row.value : null;
}

async function setPoolAddress(t, address) {
    await t.exec(sql`
        INSERT INTO mail_settings (key, value, updated_at)
        VALUES (${POOL_KEY}, ${address}, now())
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`);
    return address;
}

module.exports = {
    POOL_KEY,
    POOL_SUBJECT,
    wireMailbox,
    mailboxAddressFor,
    ensureMailbox,
    ensureOwnerMailbox,
    ensurePoolMailbox,
    poolAddress,
    setPoolAddress,
};
