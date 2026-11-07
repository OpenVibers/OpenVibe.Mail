'use strict';

/**
 * The events OpenVibe.Mail publishes.
 *
 * Two, and only two:
 *
 *   mail.mask.created   a person made a mask;
 *   mail.received       a message arrived for one of our addresses.
 *
 * Neither carries a message body, a subject line or a code. mail.received says that mail arrived, for which
 * address, when, and from whom — that is what an agent needs to decide whether to look, and everything else is
 * the person's mail and stays where it is.
 */
const { ids } = require('openvibe-contracts');
const { createServiceOutbox } = require('openvibe-sdk/events');

const SOURCE = 'mail';

function createEvents({ db, config, now = () => Date.now(), log = console } = {}) {
    const outbox = createServiceOutbox({
        db,
        source: SOURCE,
        eventsUrl: config.events.url,
        networkInternalUrl: config.network.internalUrl,
        clientId: config.events.clientId,
        clientSecret: config.events.clientSecret,
        intervalMs: config.events.intervalMs,
        now,
        log,
        eventTypes: ['mail.mask.created', 'mail.received'],
    });

    function envelope({ type, actor, subject, payload, timestamp = new Date(now()).toISOString() }) {
        return {
            event_id: `evt_${ids.ulid(now())}`,
            event_type: type,
            version: 1,
            source: SOURCE,
            actor,
            timestamp,
            subject,
            payload,
        };
    }

    /** mail.mask.created — the mask exists; nothing about the person beyond the subject id. */
    function maskCreated({ owner, mask }) {
        return envelope({
            type: 'mail.mask.created',
            actor: { type: 'user', id: owner },
            subject: { type: 'mail.mask', id: mask.id },
            payload: {
                mask_id: mask.id,
                address: mask.address,
                label: mask.label || null,
                purpose: mask.purpose || null,
                enabled: mask.enabled !== false,
            },
        });
    }

    /**
     * mail.received — a message arrived. The payload is metadata: the address it was sent to, when it arrived, who
     * sent it and the id of the message. No subject, no preview, no body.
     */
    function messageReceived({ owner, address, message }) {
        return envelope({
            type: 'mail.received',
            actor: owner
                ? { type: 'user', id: owner }
                : { type: 'service', id: SOURCE },
            subject: { type: 'mail.address', id: address },
            payload: {
                address,
                owner: owner || null,
                message_id: message.id,
                received_at: message.receivedAt || null,
                from: message.from || [],
            },
        });
    }

    return { outbox, envelope, maskCreated, messageReceived, start: () => outbox.start(), stop: () => outbox.stop() };
}

module.exports = { createEvents, SOURCE };
