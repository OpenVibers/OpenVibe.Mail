'use strict';

/**
 * An agent's inbox: an address an agent can read, on the person's own domain.
 *
 * The address is <agent>.<user>@<base domain> — helper.alice@openvibe.email — so it is obvious whose it is and
 * whose mail it carries. The mail lands in the person's mailbox, like every other address we hand out; what makes
 * it an agent's inbox is that the service will read it back for that agent.
 *
 * One agent has one inbox: asking twice gives the same address.
 */
const { sql } = require('openvibe-sdk/db');
const { ids } = require('openvibe-contracts');
const { agentInboxAddress, mailboxLocalFor } = require('./addresses');
const { ensureOwnerMailbox, mailboxAddressFor } = require('./mailboxes');
const { listForAddress } = require('./messages');

function shape(row) {
    if (!row) return null;
    return {
        id: row.id,
        agent_id: row.agent_id,
        address: row.address,
        owner: row.owner_subject || null,
        created_at: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    };
}

function cleanAgentId(value) {
    const agent = String(value || '')
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 32);
    if (!agent) {
        const err = new Error('an agent inbox needs an agent id');
        err.code = 'mail.bad_agent';
        err.status = 400;
        throw err;
    }
    return agent;
}

/** The person's name as an address label: their Network username when they have one, else their mailbox local. */
function cleanUserLocal(value) {
    return String(value || '')
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 32);
}

/**
 * The inbox of an agent, made if it is not there yet.
 *
 * The same agent asked twice gets the same address: the person may call the agent by a different name, but the
 * address stays.
 */
async function createAgentInbox({ db, config, owner, agentId, userLocal = null, now = () => Date.now() }) {
    const agent = cleanAgentId(agentId);
    return db.tx(async (t) => {
        const existing = await t.maybe(sql`
            SELECT id, owner_subject, agent_id, address, created_at
              FROM mail_agent_inboxes WHERE owner_subject = ${owner} AND agent_id = ${agent}`);
        if (existing) return shape(existing);
        await ensureOwnerMailbox(t, { ownerSubject: owner, baseDomain: config.addresses.base });

        // <agent>.<user>@<base>: the person's username when they have one, and the mailbox local (their subject
        // id) when they do not. If the readable address is taken by another person, the stable mailbox local is
        // tried before giving up, so an inbox never silently becomes somebody else's.
        const mailboxLocal = mailboxLocalFor(owner);
        const preferred = cleanUserLocal(userLocal) || mailboxLocal;
        const candidates = preferred === mailboxLocal
            ? [agentInboxAddress(agent, preferred, config.addresses.base)]
            : [agentInboxAddress(agent, preferred, config.addresses.base), agentInboxAddress(agent, mailboxLocal, config.addresses.base)];

        for (const address of candidates) {
            const row = await t.maybe(sql`
                INSERT INTO mail_agent_inboxes (id, owner_subject, agent_id, address)
                VALUES (${`agi_${ids.ulid(now())}`}, ${owner}, ${agent}, ${address})
                ON CONFLICT DO NOTHING
                RETURNING id, owner_subject, agent_id, address, created_at`);
            if (row) return shape(row);
            const again = await t.maybe(sql`
                SELECT id, owner_subject, agent_id, address, created_at
                  FROM mail_agent_inboxes WHERE owner_subject = ${owner} AND agent_id = ${agent}`);
            if (again) return shape(again);
        }
        const err = new Error('the agent address is taken; try another agent name');
        err.code = 'mail.address_taken';
        err.status = 503;
        throw err;
    });
}

/** The person's agent inboxes, newest first. */
async function listAgentInboxes({ db, owner }) {
    const rows = await db.many(sql`
        SELECT id, owner_subject, agent_id, address, created_at
          FROM mail_agent_inboxes WHERE owner_subject = ${owner}
         ORDER BY created_at DESC`);
    return rows.map(shape);
}

/** One inbox of this person, or null. Somebody else's inbox is not found. */
async function findAgentInbox({ db, owner, id = null, agentId = null }) {
    if (id) {
        const row = await db.maybe(sql`
            SELECT id, owner_subject, agent_id, address, created_at
              FROM mail_agent_inboxes WHERE id = ${id} AND owner_subject = ${owner}`);
        return row ? shape(row) : null;
    }
    if (agentId) {
        const row = await db.maybe(sql`
            SELECT id, owner_subject, agent_id, address, created_at
              FROM mail_agent_inboxes WHERE agent_id = ${String(agentId).toLowerCase()} AND owner_subject = ${owner}`);
        return row ? shape(row) : null;
    }
    return null;
}

/** The messages sent to an agent's inbox, newest first. */
async function agentInboxMessages({ db, stalwart, events, inbox, limit = 20 }) {
    // findAgentInbox gives the API `owner`; the row itself names `owner_subject`. Read either, so the
    // internal caller cannot lose the mailbox by passing the shape the API returns.
    const owner = inbox.owner_subject || inbox.owner;
    const mailbox = await mailboxAddressFor(db, owner);
    return listForAddress({
        db,
        stalwart,
        events,
        owner,
        address: inbox.address,
        mailbox,
        recipient: inbox.address,
        limit,
    });
}

module.exports = { createAgentInbox, listAgentInboxes, findAgentInbox, agentInboxMessages, shape, cleanAgentId, cleanUserLocal };
