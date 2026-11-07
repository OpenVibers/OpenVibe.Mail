'use strict';

/**
 * The messages of one of our addresses, and the moment the service first saw them.
 *
 * A message is announced once. The service writes down that it has seen a message for an address, and the first
 * time it sees one it publishes mail.received — the address, the time, the sender, the message id. Nothing else:
 * no subject, no body, no code.
 *
 * The body is read in exactly one place, the code extractor, and it is not kept.
 */
const { sql } = require('openvibe-sdk/db');

/** A message as the API gives it: who wrote it, what it is about, when it came, and its id. */
function summary(message) {
    return {
        id: message.id,
        from: message.from || [],
        subject: message.subject || null,
        received_at: message.receivedAt || null,
    };
}

/**
 * Write down the messages that are new to us and announce them.
 *
 * The write is the test: the row is only returned when the message was not seen for this address before, so two
 * readers at the same time announce it once between them.
 */
async function observe({ db, events, owner = null, address, messages = [] }) {
    for (const message of messages) {
        if (!message || !message.id) continue;
        // The "I have seen this" row and the event are one transaction: an event cannot exist for a row that did
        // not commit, and a row cannot commit without its event. On a conflict the row is not new, so no event.
        await db.tx(async (t) => {
            const row = await t.maybe(sql`
                INSERT INTO mail_observed_messages (address, message_id, received_at)
                VALUES (${address}, ${message.id}, ${message.receivedAt || null})
                ON CONFLICT (address, message_id) DO NOTHING
                RETURNING message_id`);
            if (row && events) await events.outbox.emitIn(t, events.messageReceived({ owner, address, message }));
        });
    }
}

/**
 * The messages sent to one of our addresses, newest first, read from the mail server over loopback.
 *
 * `mailbox` is where the mail landed. A burner passes `recipient: null` because the mailbox is the burner; a mask
 * or agent inbox passes its address, and the Stalwart client matches it only against the envelope recipient the
 * server stamped, never a sender-written To, Cc or Delivered-To.
 */
async function listForAddress({ db, stalwart, events, owner = null, address, mailbox, recipient = null, limit = 20 }) {
    if (!mailbox) return [];
    const messages = await stalwart.listMessages({ mailboxAddress: mailbox, recipient, limit });
    await observe({ db, events, owner, address, messages });
    return messages.map(summary);
}

/** The messages of one address the service has already seen (used by the purge job to know what to delete). */
async function observedIds({ db, address }) {
    const rows = await db.many(sql`SELECT message_id FROM mail_observed_messages WHERE address = ${address}`);
    return rows.map((r) => r.message_id);
}

module.exports = { summary, observe, listForAddress, observedIds };
