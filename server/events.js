'use strict';

/**
 * The events OpenVibe.Mail publishes.
 *
 * Three:
 *
 *   mail.mask.created          a person made a mask;
 *   mail.received              a message arrived for one of our addresses;
 *   mail.agent_inbox.received  a message arrived for an agent's address whose answering is on.
 *
 * None of them carries an attachment or an HTML body. mail.received says that mail arrived, for which address,
 * when, and from whom — that is what an agent needs to decide whether to look. mail.agent_inbox.received goes
 * further because the person said their agent may answer: it carries the subject and a plain-text excerpt of at
 * most 4000 characters, never the whole body, and never the HTML. The agent's system reads the full text through
 * mail.agent.read, on the owner's behalf, once it has decided to answer.
 */
const { ids } = require('openvibe-contracts');
const { createServiceOutbox } = require('openvibe-sdk/events');

const SOURCE = 'mail';
const AGENT_EVENT_TYPES = ['mail.mask.created', 'mail.received', 'mail.agent_inbox.received'];

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
        eventTypes: AGENT_EVENT_TYPES,
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

    /**
     * mail.agent_inbox.received — a message arrived at an agent's address and the person's switch for it is on, so
     * their agent may answer it. The subject and a plain-text excerpt (at most 4000 characters) are here because
     * the agent's system decides from them whether to read the whole letter; the whole body, the HTML and the
     * attachments are not, and never reach an event.
     */
    function agentInboxReceived({ inbox, owner, message }) {
        return envelope({
            type: 'mail.agent_inbox.received',
            actor: { type: 'user', id: owner },
            subject: { type: 'mail.agent-inbox', id: inbox.id },
            payload: {
                inbox_id: inbox.id,
                inbox: inbox.address,
                agent_id: inbox.agent_id,
                owner,
                message_id: message.id,
                from: Array.isArray(message.from) ? message.from[0] : message.from,
                subject: message.subject || null,
                excerpt: message.excerpt || '',
                received_at: message.receivedAt || null,
            },
        });
    }

    return {
        outbox,
        envelope,
        maskCreated,
        messageReceived,
        agentInboxReceived,
        start: () => outbox.start(),
        stop: () => outbox.stop(),
    };
}

module.exports = { createEvents, SOURCE };
