'use strict';

/**
 * The API of OpenVibe.Mail, v1.
 *
 *   POST   /api/v1/masks                     a mask for the person
 *   GET    /api/v1/masks                     the person's masks
 *   GET    /api/v1/masks/:id                 one mask of the person
 *   DELETE /api/v1/masks/:id                 turn a mask off (it bounces from then on)
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

function createApi({ db, config, stalwart, events, principal, log = console }) {
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

    // ---- masks -------------------------------------------------------------------------------

    router.post('/api/v1/masks', requirePerson(principal.CAPABILITIES.write), wrap(async (req, res) => {
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
            });
            return res.status(201).json({ mask });
        } catch (err) {
            if (err && err.status) return fail(req, res, err.status, err.code || 'mail.error', err.message);
            throw err;
        }
    }));

    router.get('/api/v1/masks', requirePerson(principal.CAPABILITIES.read), wrap(async (req, res) => {
        const list = await masks.listMasks({ db, owner: ownerOf(req) });
        return res.json({ masks: list });
    }));

    router.get('/api/v1/masks/:id', requirePerson(principal.CAPABILITIES.read), wrap(async (req, res) => {
        const mask = await masks.findMask({ db, owner: ownerOf(req), id: req.params.id });
        if (!mask) return fail(req, res, 404, 'mail.not_found', 'That mask does not exist.');
        return res.json({ mask });
    }));

    router.delete('/api/v1/masks/:id', requirePerson(principal.CAPABILITIES.write), wrap(async (req, res) => {
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

    return router;
}

module.exports = { createApi };
