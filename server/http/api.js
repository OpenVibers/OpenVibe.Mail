'use strict';

/**
 * The API of OpenVibe.Mail, v1.
 *
 *   GET    /api/v1/me/mail                   the person's masks, burners and agent inboxes, with state and counts
 *
 *   POST   /api/v1/masks                     a mask for the person
 *   GET    /api/v1/masks                     the person's masks
 *   GET    /api/v1/masks/:id                 one mask of the person
 *   POST   /api/v1/masks/:id/disable         turn a mask off (it bounces from then on)
 *   DELETE /api/v1/masks/:id                 the same, for a DELETE-shaped client
 *
 *   POST   /api/v1/burners                   a burner (with an account, or the ten-minute one without)
 *   GET    /api/v1/burners                   the person's burners
 *   GET    /api/v1/burners/:id/messages      the messages sent to a burner
 *   GET    /api/v1/burners/:id/code          the newest verification code in a burner
 *
 *   POST   /api/v1/agent-inboxes             an inbox for one of the person's agents
 *   GET    /api/v1/agent-inboxes             the person's agent inboxes
 *   GET    /api/v1/agent-inboxes/:id/messages  the messages sent to an agent's inbox
 *
 * Two rules run through all of it:
 *
 *   * what belongs to somebody else is not found. Another person's burner, mask or inbox answers 404, not 403:
 *     the answer must not say that it exists.
 *   * a message body is never in an answer and never in a log line. The list of messages gives the sender, the
 *     subject and the time; the code endpoint gives the code.
 */
const express = require('express');
const { http } = require('openvibe-contracts');

const masks = require('../domain/masks');
const burners = require('../domain/burners');
const agentInboxes = require('../domain/agent-inboxes');
const messages = require('../domain/messages');
const answering = require('../domain/agent-answering');
const outboundProviders = require('../domain/outbound-providers');
const providerWebhooks = require('../domain/provider-webhooks');
const providerDomains = require('../domain/provider-domains');

/** Whether this inbox answers mail (track HO6): off unless the person turned it on. */
const agentInboxesAnswering = (db, owner, inbox) => answering.getAnswering({ db, owner, inbox });

function createApi({ db, config, stalwart, events, principal, log = console, smtp = null, fetchImpl = globalThis.fetch, imap = null }) {
    const router = express.Router();
    const requirePerson = principal.requirePerson;

    /** The person the request acts for, or null. */
    function ownerOf(req) {
        return principal.subjectOf(req.principal);
    }

    /** The burner's secret, when the caller brought one. */
    function burnerTokenOf(req) {
        const header = req.get('x-mail-burner-token');
        return header ? String(header).trim() : null;
    }

    /** An async route that answers even when it throws: Express 4 does not catch a rejected promise. */
    const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

    /** The house's problem answer: RFC 9457, with the request's trace ids. */
    function fail(req, res, status, code, detail) {
        return http.sendProblem(res, status, code, { detail, ctx: req.ov });
    }

    // Provider keys and spend limits belong to the Network owner. Hide this surface from every other rank and from
    // app tokens; a provider credential is only accepted over the service's encrypted-at-rest vault.
    const ownerOnly = (req, res, next) => {
        if (!req.principal || req.principal.kind !== 'user' || req.principal.role !== 'owner') {
            return fail(req, res, 404, 'route.not_found', 'No such API route.');
        }
        return next();
    };
    router.post('/api/v1/mail/provider-webhooks/:providerId', wrap(async (req, res) => {
        try {
            const result = await providerWebhooks.handle({ db, config, providerId: req.params.providerId, payload: req.body || {}, rawBody: req.rawBody, headers: req.headers, fetchImpl });
            return res.status(result.status).json(result.body);
        } catch (err) {
            log.warn({ providerId: req.params.providerId }, 'mail provider webhook rejected');
            return fail(req, res, 400, 'mail.webhook.invalid', 'The provider webhook could not be verified or processed.');
        }
    }));
    router.get('/api/v1/admin/mail/providers', ownerOnly, wrap(async (_req, res) => {
        const rows = await outboundProviders.list(db);
        return res.json({ outbound_enabled: Boolean(config.outbound.enabled), providers: rows.map(outboundProviders.publicProvider) });
    }));
    router.put('/api/v1/admin/mail/providers/:id', ownerOnly, wrap(async (req, res) => {
        const input = { ...(req.body || {}), id: req.params.id };
        try {
            await outboundProviders.save({ db, config, input });
            const row = (await outboundProviders.list(db)).find((item) => item.id === req.params.id);
            return res.json({ provider: outboundProviders.publicProvider(row) });
        } catch (err) {
            return fail(req, res, 422, 'mail.provider.invalid', err.message);
        }
    }));
    router.delete('/api/v1/admin/mail/providers/:id', ownerOnly, wrap(async (req, res) => {
        await outboundProviders.remove(db, req.params.id);
        return res.status(204).end();
    }));
    router.get('/api/v1/admin/mail/domains', ownerOnly, wrap(async (req, res) => {
        try { return res.json(await providerDomains.list({ db, domain: req.query.domain })); }
        catch (err) { return fail(req, res, 422, 'mail.domain.invalid', err.message); }
    }));
    router.put('/api/v1/admin/mail/domains/:providerId', ownerOnly, wrap(async (req, res) => {
        try {
            const domain = await providerDomains.save({ db, providerId: req.params.providerId, input: req.body || {} });
            return res.json(await providerDomains.list({ db, domain }));
        } catch (err) { return fail(req, res, 422, 'mail.domain.invalid', err.message); }
    }));

    // ---- the person's front door ---------------------------------------------------------------

    /**
     * Everything the page draws, in one read: the three kinds of address, each with its state and how many
     * messages the service has seen for it, plus the totals.
     *
     * Every `mask`, `burner` and `agent_inbox` object inside an item is exactly the Contracts resource
     * (mail.mask@1, mail.burner@1, mail.agent-inbox@1); `state`, `expires_at` (a mask) and `counts` sit beside it.
     * No message body, subject, sender or code is in this answer.
     */
    router.get('/api/v1/me/mail', requirePerson(principal.CAPABILITIES.read), wrap(async (req, res) => {
        const owner = ownerOf(req);
        const [maskRows, burnerRows, inboxes] = await Promise.all([
            masks.listMaskRows({ db, owner }),
            burners.listBurnerRows({ db, owner }),
            agentInboxes.listAgentInboxes({ db, owner }),
        ]);
        const addresses = [
            ...maskRows.map((m) => m.address),
            ...burnerRows.map((b) => b.address),
            ...inboxes.map((i) => i.address),
        ];
        const seen = await messages.countsByAddress({ db, addresses });
        const answeringByInbox = new Map(
            (await Promise.all(inboxes.map((inbox) => agentInboxesAnswering(db, owner, inbox))))
                .map((state) => [state.address, state.enabled]),
        );
        const countOf = (address) => seen.get(address) || 0;

        const now = () => Date.now();

        const maskItems = maskRows.map((row) => ({
            mask: masks.shape(row),
            address: row.address,
            purpose: row.purpose || null,
            state: masks.stateOf(row, now),
            expires_at: row.expires_at || null,
            counts: { messages: countOf(row.address) },
        }));
        const burnerItems = burnerRows.map((row) => ({
            burner: burners.shape(row),
            address: row.address,
            purpose: null,
            state: burners.stateOf(row, now),
            counts: { messages: countOf(row.address) },
        }));
        const inboxItems = inboxes.map((inbox) => ({
            agent_inbox: inbox,
            address: inbox.address,
            purpose: null,
            state: 'active',
            answering: answeringByInbox.get(inbox.address) || false,
            counts: { messages: countOf(inbox.address) },
        }));

        return res.json({
            masks: maskItems,
            burners: burnerItems,
            agent_inboxes: inboxItems,
            counts: {
                masks: {
                    total: maskItems.length,
                    active: maskItems.filter((m) => m.state === 'active').length,
                    messages: maskItems.reduce((n, m) => n + m.counts.messages, 0),
                },
                burners: {
                    total: burnerItems.length,
                    live: burnerItems.filter((b) => b.state === 'live').length,
                    messages: burnerItems.reduce((n, b) => n + b.counts.messages, 0),
                },
                agent_inboxes: {
                    total: inboxItems.length,
                    messages: inboxItems.reduce((n, i) => n + i.counts.messages, 0),
                },
            },
        });
    }));

    // ---- masks -------------------------------------------------------------------------------

    router.post('/api/v1/masks', requirePerson([principal.CAPABILITIES.write, principal.CAPABILITIES.masks]), wrap(async (req, res) => {
        const owner = ownerOf(req);
        const body = req.body || {};
        try {
            const mask = await masks.createMask({
                db,
                config,
                events,
                owner,
                label: typeof body.label === 'string' ? body.label.slice(0, 120) : null,
                purpose: typeof body.purpose === 'string' ? body.purpose.slice(0, 120) : null,
                expiresDays: body.expires_days,
            });
            return res.status(201).json({ mask });
        } catch (err) {
            if (err && err.status) return fail(req, res, err.status, err.code || 'mail.error', err.message);
            throw err;
        }
    }));

    router.get('/api/v1/masks', requirePerson([principal.CAPABILITIES.read, principal.CAPABILITIES.masks]), wrap(async (req, res) => {
        const list = await masks.listMasks({ db, owner: ownerOf(req) });
        return res.json({ masks: list });
    }));

    router.get('/api/v1/masks/:id', requirePerson([principal.CAPABILITIES.read, principal.CAPABILITIES.masks]), wrap(async (req, res) => {
        const mask = await masks.findMask({ db, owner: ownerOf(req), id: req.params.id });
        if (!mask) return fail(req, res, 404, 'mail.not_found', 'That mask does not exist.');
        return res.json({ mask });
    }));

    router.post('/api/v1/masks/:id/disable', requirePerson([principal.CAPABILITIES.write, principal.CAPABILITIES.masks]), wrap(async (req, res) => {
        const mask = await masks.disableMask({ db, stalwart, owner: ownerOf(req), id: req.params.id });
        if (!mask) return fail(req, res, 404, 'mail.not_found', 'That mask does not exist.');
        return res.json({ mask });
    }));

    router.delete('/api/v1/masks/:id', requirePerson([principal.CAPABILITIES.write, principal.CAPABILITIES.masks]), wrap(async (req, res) => {
        const mask = await masks.disableMask({ db, stalwart, owner: ownerOf(req), id: req.params.id });
        if (!mask) return fail(req, res, 404, 'mail.not_found', 'That mask does not exist.');
        return res.json({ mask });
    }));

    // ---- burners -----------------------------------------------------------------------------

    /**
     * A burner. With a token it belongs to the person; without one it is the ten-minute burner, limited by the
     * address the request came from.
     */
    router.post('/api/v1/burners', wrap(async (req, res) => {
        const owner = ownerOf(req);
        const body = req.body || {};
        const ip = req.ip || (req.socket && req.socket.remoteAddress) || null;
        try {
            const { burner, token } = await burners.createBurner({
                db,
                config,
                owner,
                expires: body.expires || burners.ANON_EXPIRY,
                firstMessageOnly: Boolean(body.first_message_only),
                ip,
            });
            return res.status(201).json({ burner, token });
        } catch (err) {
            if (err && err.status) return fail(req, res, err.status, err.code || 'mail.error', err.message);
            throw err;
        }
    }));

    router.get('/api/v1/burners', requirePerson(principal.CAPABILITIES.read), wrap(async (req, res) => {
        const list = await burners.listBurners({ db, owner: ownerOf(req) });
        return res.json({ burners: list });
    }));

    /** The messages of a burner: the person's own, or the one whose token was sent. */
    router.get('/api/v1/burners/:id/messages', wrap(async (req, res) => {
        const burner = await burners.authorizeBurner({
            db,
            id: req.params.id,
            owner: ownerOf(req),
            token: burnerTokenOf(req),
        });
        if (!burner) return fail(req, res, 404, 'mail.not_found', 'That burner does not exist.');
        const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100);
        const messages = await burners.burnerMessages({ db, stalwart, events, burner, limit });
        return res.json({ messages });
    }));

    /** The newest verification code in a burner. */
    router.get('/api/v1/burners/:id/code', wrap(async (req, res) => {
        const burner = await burners.authorizeBurner({
            db,
            id: req.params.id,
            owner: ownerOf(req),
            token: burnerTokenOf(req),
        });
        if (!burner) return fail(req, res, 404, 'mail.not_found', 'That burner does not exist.');
        const found = await burners.burnerCode({ db, stalwart, events, burner });
        if (!found) return fail(req, res, 404, 'mail.no_code', 'No verification code has arrived yet.');
        return res.json(found);
    }));

    // ---- agent inboxes -----------------------------------------------------------------------

    router.post('/api/v1/agent-inboxes', requirePerson(principal.CAPABILITIES.write), wrap(async (req, res) => {
        const owner = ownerOf(req);
        const body = req.body || {};
        try {
            const inbox = await agentInboxes.createAgentInbox({
                db,
                config,
                owner,
                agentId: body.agent_id,
                userLocal: req.principal ? req.principal.username : null,
            });
            return res.status(201).json({ agent_inbox: inbox });
        } catch (err) {
            if (err && err.status) return fail(req, res, err.status, err.code || 'mail.error', err.message);
            throw err;
        }
    }));

    router.get('/api/v1/agent-inboxes', requirePerson(principal.CAPABILITIES.read), wrap(async (req, res) => {
        const list = await agentInboxes.listAgentInboxes({ db, owner: ownerOf(req) });
        return res.json({ agent_inboxes: list });
    }));

    router.get('/api/v1/agent-inboxes/:id/messages', requirePerson(principal.CAPABILITIES.read), wrap(async (req, res) => {
        const inbox = await agentInboxes.findAgentInbox({ db, owner: ownerOf(req), id: req.params.id });
        if (!inbox) return fail(req, res, 404, 'mail.not_found', 'That inbox does not exist.');
        const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100);
        const messages = await agentInboxes.agentInboxMessages({ db, stalwart, events, inbox, limit });
        return res.json({ messages });
    }));

    // Reading your own mail (M1.5): server/http/reading-routes.js.
    require('./reading-routes').mountReading(router, { db, stalwart, config, smtp, principal, wrap, fail, ownerOf });
    require('./person-routes').mountPersonMail(router, { db, config, stalwart, smtp, principal, wrap, fail, ownerOf, fetchImpl });

    // Inbox AI pulling another provider's mailbox over IMAP: server/http/imap-routes.js.
    require('./imap-routes').mountImap(router, { db, config, principal, wrap, fail, ownerOf, ...(imap ? { imap } : {}) });

    return router;
}

module.exports = { createApi };
