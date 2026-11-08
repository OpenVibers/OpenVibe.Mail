'use strict';

/**
 * What an agent's own system asks Mail for (track HO6, channels, step 1): one letter in full text, and the reply to
 * it.
 *
 *   GET  /internal/mail/agents/:agentId/messages/:messageId    mail.agent.read
 *   POST /internal/mail/agents/:agentId/reply                   mail.agent.reply
 *
 * Loopback only (nginx answers 404 for /internal/), first-party service token (OpenVibe.Actor today), and the token
 * must name the person (on_behalf_of): the inbox must be one of THAT person's, and the letter must have been
 * delivered to that address. Another person's letter is the same 404 as one that does not exist, so an answer can
 * never confirm that it does.
 *
 * The body is plain text and nothing else: never the HTML, never an attachment. It is data from a stranger, and the
 * contract says so; nothing here makes it an instruction from the owner.
 *
 * The person's own routes are here too, because they are the same subject: the answering switch (off by default)
 * and the block list. The agent's system never turns its own answering on — only the person does.
 */
const { serviceAuth } = require('openvibe-contracts');
const answering = require('../domain/agent-answering');
const sending = require('../domain/sending');
const { createAgentInbox, findAgentInbox } = require('../domain/agent-inboxes');
const { mailboxAddressFor } = require('../domain/mailboxes');

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const AGENT_RE = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
const MAX_TEXT = 4000;
const MAX_REPLY = 10000;
const USER_ID = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;

/** The person a token names in on_behalf_of: a usr_ id, or a SubjectRef { type: 'user', id }. */
function claimPerson(claims) {
    const obo = claims && claims.on_behalf_of;
    if (typeof obo === 'string') return USER_ID.test(obo) ? obo : null;
    if (obo && typeof obo === 'object' && obo.type === 'user' && typeof obo.id === 'string' && USER_ID.test(obo.id)) return obo.id;
    return null;
}

/** The people a token may act for when it names nobody: on_behalf_of_any (one id or a list). */
function grantPeople(claims) {
    const any = claims && claims.on_behalf_of_any;
    const list = Array.isArray(any) ? any : (typeof any === 'string' ? [any] : []);
    return list.filter((x) => typeof x === 'string' && USER_ID.test(x));
}

/** An address list as bare lowercased addresses: "Name <a@b>" → "a@b". */
function splitAddresses(list) {
    return (Array.isArray(list) ? list : [])
        .map((entry) => {
            const raw = String(entry || '');
            const angle = /<([^<>\s]+)>/.exec(raw);
            return (angle ? angle[1] : raw).trim().toLowerCase();
        })
        .filter(Boolean);
}

function mountAgentMail(app, { db, config, stalwart, principal, keys, smtp = null, now = () => Date.now(), log = console } = {}) {
    const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

    /** The capability guard for a loopback route: a first-party service token that carries exactly this capability. */
    const guard = (capability) => async (req, res, next) => {
        const token = String(req.get('authorization') || '').replace(/^Bearer\s+/i, '');
        if (!token) return res.status(401).json({ status: 401, code: 'token.required', detail: 'Send a service token as a Bearer.' });
        const publicKey = await keys.pemForToken(token);
        if (!publicKey) return res.status(503).json({ status: 503, code: 'identity.unavailable', detail: 'the Network signing key is not loaded yet' });
        const r = serviceAuth.verifyServiceToken(token, { publicKey, issuer: config.network.issuer, audience: config.network.audience });
        if (!r.ok) return res.status(401).json({ status: 401, code: r.code || 'token.invalid', detail: r.reason || 'the token does not verify' });
        const cap = Array.isArray(r.claims.cap) ? r.claims.cap : [];
        if (!cap.includes(capability) && !cap.some((c) => c === `${capability.split('.').slice(0, -1).join('.')}.*`)) {
            (log.warn || log.log).call(log, `[mail] ${capability} refused for ${r.claims.sub}`);
            return res.status(403).json({ status: 403, code: 'capability.denied', detail: `the token does not carry ${capability}` });
        }
        req.mailService = { sub: r.claims.sub, claims: r.claims };
        return next();
    };

    /**
     * The person this call is for.
     *
     * The house's rule (Actor's server/http/subject.js, Space's X-OV-Subject): a token that NAMES a person may act
     * for that person only, and a header naming somebody else is refused; a first-party service token (svc:…,
     * actor_type service) may name the person it acts for in X-OV-Subject, which is exactly how Watch, Chat and
     * Work start a task for a person. An app token that names nobody and is not first-party reads nothing.
     */
    function personFor(req) {
        const claims = (req.mailService && req.mailService.claims) || {};
        const named = String(req.get('x-ov-subject') || '').trim();
        const claim = claimPerson(claims);
        if (claim) {
            if (named && named !== claim) return { error: 'subject.mismatch' };
            return { subject: claim };
        }
        if (!USER_ID.test(named)) return { error: 'subject.required' };
        const firstParty = String(claims.sub || '').startsWith('svc:') && claims.actor_type === 'service';
        if (firstParty) return { subject: named };
        if (grantPeople(claims).includes(named)) return { subject: named };
        return { error: 'subject.not_granted' };
    }

    /** The inbox this call is about, if it is one of the token's person's own; null otherwise. */
    async function inboxFor(req) {
        const who = personFor(req);
        const agentId = String(req.params.agentId || '');
        if (who.error || !AGENT_RE.test(agentId)) return null;
        return await findAgentInbox({ db, owner: who.subject, agentId }).catch(() => null);
    }

    app.get('/internal/mail/agents/:agentId/messages/:messageId', guard('mail.agent.read'), wrap(async (req, res) => {
        const inbox = await inboxFor(req);
        if (!inbox) return res.status(404).json({ status: 404, code: 'mail.not_found', detail: 'That inbox does not exist.' });
        if (!ID_RE.test(String(req.params.messageId || ''))) {
            return res.status(404).json({ status: 404, code: 'mail.not_found', detail: 'That message is not here.' });
        }
        const mailbox = await mailboxAddressFor(db, inbox.owner);
        if (!mailbox) return res.status(404).json({ status: 404, code: 'mail.not_found', detail: 'That message is not here.' });
        const message = await stalwart.readForRecipient({ mailboxAddress: mailbox, recipient: inbox.address, id: req.params.messageId });
        if (!message) return res.status(404).json({ status: 404, code: 'mail.not_found', detail: 'That message is not here.' });
        const headers = message.threadHeaders || {};
        return res.json({
            message_id: message.id,
            inbox: inbox.address,
            agent_id: inbox.agent_id,
            owner: inbox.owner,
            from: splitAddresses(message.from),
            to: splitAddresses(message.to),
            subject: message.subject || null,
            text: String(message.text || '').slice(0, MAX_TEXT),
            in_reply_to: headers.inReplyTo || null,
            references: (headers.references || []).slice(0, 100),
            received_at: message.date || null,
            spam: Boolean(message.spam),
        });
    }));

    app.post('/internal/mail/agents/:agentId/reply', guard('mail.agent.reply'), wrap(async (req, res) => {
        const inbox = await inboxFor(req);
        if (!inbox) return res.status(404).json({ status: 404, code: 'mail.not_found', detail: 'That inbox does not exist.' });
        const body = req.body && typeof req.body === 'object' ? req.body : {};
        const text = typeof body.body === 'string' ? body.body : '';
        if (!text.trim()) return res.status(422).json({ status: 422, code: 'mail.reply.empty', detail: 'A reply needs a body.' });
        if (text.length > MAX_REPLY) return res.status(422).json({ status: 422, code: 'mail.reply.too_long', detail: `A reply is at most ${MAX_REPLY} characters.` });

        const messageId = String(body.message_id || '');
        if (!ID_RE.test(messageId)) return res.status(422).json({ status: 422, code: 'mail.reply.no_message', detail: 'A reply answers a message: message_id is required.' });
        const mailbox = await mailboxAddressFor(db, inbox.owner);
        if (!mailbox) return res.status(404).json({ status: 404, code: 'mail.not_found', detail: 'That message is not here.' });
        const original = await stalwart.readForRecipient({ mailboxAddress: mailbox, recipient: inbox.address, id: messageId });
        if (!original) return res.status(404).json({ status: 404, code: 'mail.not_found', detail: 'That message is not here.' });
        if (original.spam) return res.status(422).json({ status: 422, code: 'mail.reply.spam', detail: 'That message was marked as spam, so nothing answers it.' });

        // The recipient is the sender of the letter being answered, or that same address named in `to`. Never a
        // stranger: this path answers mail, it does not start it.
        const senders = splitAddresses(original.from);
        const asked = typeof body.to === 'string' ? body.to.trim().toLowerCase() : null;
        if (asked && !senders.includes(asked)) {
            return res.status(422).json({ status: 422, code: 'mail.reply.recipient', detail: 'A reply goes to the sender of the message it answers.' });
        }
        const to = asked || senders[0];
        if (!to) return res.status(422).json({ status: 422, code: 'mail.reply.recipient', detail: 'That message has no sender to answer.' });

        // The thread is derived from the letter, never from the caller: In-Reply-To is the letter's own
        // Message-ID and References is its chain with that id appended, which is what RFC 5322 says a reply
        // carries. A caller cannot forge a thread it was not part of.
        const headers = original.threadHeaders || {};
        const rfcReferences = [...new Set([...(headers.references || []), headers.messageId].filter(Boolean))].slice(-100);
        const result = await sending.sendReply({
            db, config, inbox, owner: inbox.owner, to, body: text,
            subject: original.subject || null,
            inReplyTo: headers.messageId || null,
            references: rfcReferences,
            agentName: inbox.agent_id,
            now,
            smtp,
        });
        // "Outbound is closed" is not a failure of the agent's answer: the agent's system parks it for the person's
        // decision instead. A stable status and code say so, so no caller has to read English to know.
        if (!result.sent && result.reason === sending.OUTBOUND_CLOSED) {
            return res.status(409).json({ ...result, code: 'mail.outbound_closed' });
        }
        return res.status(result.sent ? 200 : 502).json(result);
    }));

    /**
     * Can Mail send outside OpenVibe at all? The agent's system asks this before it turns a reply to a stranger into
     * the person's approval, so the card can say plainly that the reply will wait. Loopback, first-party token.
     */
    app.get('/internal/mail/outbound', guard('mail.agent.reply'), (req, res) => {
        const enabled = Boolean(config.outbound && config.outbound.enabled);
        return res.json({
            enabled,
            reason: enabled ? null : sending.OUTBOUND_CLOSED,
        });
    });

    /**
     * The agent's switch, by the agent's name in the address, for the agent's own system to show on its page
     * (GET) and for the person to turn on through that page (PUT). Loopback under a first-party token with the person
     * in X-OV-Subject — exactly the read route above, so the page needs one credential, not the person's own token.
     *
     * The POST makes the address if it does not exist yet: an agent's page shows its address before any letter has
     * arrived, and an address Mail has not made is one no letter is ever checked against. Making it is idempotent, so
     * a page that asks on every load changes nothing after the first.
     */
    app.post('/internal/mail/agents/:agentId/inbox', guard('mail.agent.answering'), wrap(async (req, res) => {
        const who = personFor(req);
        const agentId = String(req.params.agentId || '');
        if (who.error || !AGENT_RE.test(agentId)) return res.status(404).json({ status: 404, code: 'mail.not_found', detail: 'That inbox does not exist.' });
        try {
            const inbox = await createAgentInbox({ db, config, owner: who.subject, agentId });
            return res.json({ agent_inbox: inbox });
        } catch (err) {
            if (err && err.status) return res.status(err.status).json({ status: err.status, code: err.code || 'mail.error', detail: err.message });
            throw err;
        }
    }));

    app.get('/internal/mail/agents/:agentId/answering', guard('mail.agent.read'), wrap(async (req, res) => {
        const inbox = await inboxFor(req);
        if (!inbox) return res.status(404).json({ status: 404, code: 'mail.not_found', detail: 'That inbox does not exist.' });
        return res.json(await answering.getAnswering({ db, owner: inbox.owner, inbox }));
    }));

    app.put('/internal/mail/agents/:agentId/answering', guard('mail.agent.answering'), wrap(async (req, res) => {
        const inbox = await inboxFor(req);
        if (!inbox) return res.status(404).json({ status: 404, code: 'mail.not_found', detail: 'That inbox does not exist.' });
        const asked = req.body && req.body.enabled;
        const enabled = asked === true || asked === 'true' || asked === 'on' || asked === 1;
        return res.json(await answering.setAnswering({ db, owner: inbox.owner, inbox, enabled, now }));
    }));

    // ---- the person's own switch and block list ---------------------------------------------------------------

    const requirePerson = principal.requirePerson;

    /** The inbox the request is about, if it is this person's; the same 404 as one that does not exist otherwise. */
    async function findInboxById(req, res) {
        const person = principal.subjectOf(req.principal);
        if (!person) {
            res.status(403).json({ status: 403, code: 'mail.person_required', detail: 'This route is for a person.' });
            return null;
        }
        const inbox = await findAgentInbox({ db, owner: person, id: req.params.id });
        if (!inbox) {
            res.status(404).json({ status: 404, code: 'mail.not_found', detail: 'That inbox does not exist.' });
            return null;
        }
        return inbox;
    }

    app.get('/api/v1/agent-inboxes/:id/answering', requirePerson(principal.CAPABILITIES.read), wrap(async (req, res) => {
        const inbox = await findInboxById(req, res);
        if (!inbox) return undefined;
        return res.json(await answering.getAnswering({ db, owner: inbox.owner, inbox }));
    }));

    app.put('/api/v1/agent-inboxes/:id/answering', requirePerson(principal.CAPABILITIES.write), wrap(async (req, res) => {
        const inbox = await findInboxById(req, res);
        if (!inbox) return undefined;
        const asked = req.body && req.body.enabled;
        const enabled = asked === true || asked === 'true' || asked === 'on' || asked === 1;
        return res.json(await answering.setAnswering({ db, owner: inbox.owner, inbox, enabled, now }));
    }));

    app.get('/api/v1/me/mail/blocks', requirePerson(principal.CAPABILITIES.read), wrap(async (req, res) => {
        return res.json({ blocked: await answering.listBlocked({ db, owner: principal.subjectOf(req.principal) }) });
    }));

    app.post('/api/v1/me/mail/blocks', requirePerson(principal.CAPABILITIES.write), wrap(async (req, res) => {
        try {
            const made = await answering.blockSender({ db, owner: principal.subjectOf(req.principal), address: req.body && req.body.address });
            return res.status(201).json({ blocked: made });
        } catch (err) {
            if (err && err.status) return res.status(err.status).json({ status: err.status, code: err.code || 'mail.error', detail: err.message });
            throw err;
        }
    }));

    app.delete('/api/v1/me/mail/blocks/:address', requirePerson(principal.CAPABILITIES.write), wrap(async (req, res) => {
        const removed = await answering.unblockSender({ db, owner: principal.subjectOf(req.principal), address: req.params.address });
        if (!removed) return res.status(404).json({ status: 404, code: 'mail.not_found', detail: 'That sender is not on your block list.' });
        return res.json({ address: String(req.params.address).toLowerCase(), blocked: false });
    }));
}

module.exports = { mountAgentMail, splitAddresses };
