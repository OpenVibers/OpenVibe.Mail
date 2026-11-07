'use strict';

/**
 * Where a person's mail lands.
 *
 * Every person who owns an address has one mailbox: an account in the mail server, addressed
 * <local>@<base domain>. The row is written the first time the person asks for a mask, a burner or an agent
 * inbox, and it never changes afterwards — the address is the address. Masks and agent inboxes are aliases of
 * this account, so their mail lands here.
 *
 * A burner does not use this table for delivery: the directory view makes the burner its own account, so one
 * burner's mail can never be seen in another's mailbox even when both have no owner.
 */
const { sql } = require('openvibe-sdk/db');
const { localOf, mailboxAddress, mailboxLocalFor } = require('./addresses');

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

module.exports = {
    wireMailbox,
    mailboxAddressFor,
    ensureMailbox,
    ensureOwnerMailbox,
};
