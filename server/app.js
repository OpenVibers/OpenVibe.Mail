'use strict';

/**
 * OpenVibe.Mail — the Express app. server/index.js listens; the tests build their own instance with a temporary
 * database and a stand-in for the mail server.
 *
 *   /api/health, /api/ready            the machine answers
 *   /api/v1/masks, /burners, …         the API (http/api.js)
 *
 * There are no pages: M1 has no site, only an API for the apps and the agents of the house.
 *
 * Nothing here logs a request body. A request body of this service may carry a person's label for a mask; a
 * message body never reaches this process at all, and the one place a body is read (the code extractor) throws it
 * away as soon as it has read it.
 */
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const contracts = require('openvibe-contracts');

const configLib = require('./config');
const { openStore } = require('./db');
const { createKeyStore } = require('./auth/keys');
const { createPrincipal } = require('./http/principal');
const { createApi } = require('./http/api');
const { createServiceReadiness } = require('./observability');
const { createStalwartClient } = require('./stalwart/client');
const { createEvents } = require('./events');

const VERSION = require('../package.json').version;

/**
 * opts: config, store, stalwart, events, now (clock), fetchImpl (Network), log.
 */
async function createApp(opts = {}) {
    const config = opts.config || configLib.load();
    const log = opts.log || console;
    const fetchImpl = opts.fetchImpl || globalThis.fetch;
    const store = opts.store || await openStore(config, { now: opts.now, log });

    const keys = createKeyStore({ config, fetchImpl, log });
    const stalwart = opts.stalwart || createStalwartClient({ config, fetchImpl, log });
    const events = opts.events || createEvents({ db: store.db, config, now: opts.now, log });
    const principal = createPrincipal({ config, keys });

    const app = express();
    app.disable('x-powered-by');
    app.set('trust proxy', config.trustProxy);

    app.use(contracts.http.middleware());
    app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
    app.use(express.json({ limit: '16kb' }));

    app.get('/api/health', (_req, res) => res.json({ status: 'ok', service: 'openvibe-mail', name: 'OpenVibe.Mail', version: VERSION }));

    const readiness = createServiceReadiness({ db: store.db, config, stalwart, version: VERSION });
    app.get('/api/ready', readiness.handler);

    app.use('/api/v1', rateLimit({
        windowMs: 60_000,
        limit: config.limits.apiPerMinute,
        standardHeaders: true,
        legacyHeaders: false,
        handler: (req, res) => contracts.http.sendProblem(res, 429, 'rate_limited', {
            detail: 'Too many requests from this address; retry shortly.',
            ctx: req.ov,
        }),
    }));

    app.use('/api/v1', principal.middleware);
    app.use(createApi({ db: store.db, config, stalwart, events, principal, log }));

    app.use('/api', (req, res) => contracts.http.sendProblem(res, 404, 'route.not_found', {
        detail: 'No such API route.',
        ctx: req.ov,
    }));

    // eslint-disable-next-line no-unused-vars
    app.use((err, req, res, _next) => {
        // The message is the error, never the request: a body of a request is not written down.
        log.error('[OpenVibe.Mail]', err && err.message ? String(err.message).slice(0, 300) : err);
        if (res.headersSent) return;
        if (err && err.type === 'entity.parse.failed') {
            return contracts.http.sendProblem(res, 400, 'request.malformed_json', { ctx: req.ov });
        }
        if (err && err.type === 'entity.too.large') {
            return contracts.http.sendProblem(res, 413, 'request.too_large', { ctx: req.ov });
        }
        return contracts.http.sendProblem(res, 500, 'internal.error', { detail: 'Internal error.', ctx: req.ov });
    });

    return { app, ctx: { config, store, keys, stalwart, events, principal, log } };
}

module.exports = { createApp, VERSION };
