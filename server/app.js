'use strict';

/**
 * OpenVibe.Mail — the Express app. server/index.js listens; the tests build their own instance with a temporary
 * database and a stand-in for the mail server.
 *
 *   /api/health, /api/ready            the machine answers
 *   /auth/*                            Network SSO with PKCE (openvibe-sdk/sso)
 *   /api/v1/masks, /burners, …         the API (http/api.js)
 *
 * There are no pages: M1 has no site, only an API for the apps and the agents of the house. nginx answers `/` with
 * a placeholder until the page lands.
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
const { createCors } = require('./http/cors');
const { createApi } = require('./http/api');
const { createServiceReadiness } = require('./observability');
const { createStalwartClient } = require('./stalwart/client');
const { createEvents } = require('./events');
const { createSsoClient } = require('openvibe-sdk/sso');

const VERSION = require('../package.json').version;
const ROOT = require('path').join(__dirname, '..');

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
    const sso = opts.sso || createSsoClient({
        site: 'mail',
        siteName: 'OpenVibe.Mail',
        baseUrl: config.baseUrl,
        clientId: config.oauth.clientId,
        clientSecret: config.oauth.clientSecret,
        redirectUri: config.oauth.redirectUri,
        scope: config.oauth.scope,
        networkUrl: config.network.url,
        networkInternalUrl: config.network.internalUrl,
        issuer: config.network.issuer,
        audience: [config.network.sessionAudience],
        secureCookies: config.cookies.secure,
        fetch: fetchImpl,
        log,
    });

    const app = express();
    app.disable('x-powered-by');
    app.set('trust proxy', config.trustProxy);

    app.use(contracts.http.middleware());
    app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
    app.use('/api/v1/mail/provider-webhooks', express.json({ limit: '256kb', verify: (req, _res, buffer) => { req.rawBody = Buffer.from(buffer); } }));
    app.use(express.json({ limit: '16kb' }));
    // Nothing here is cacheable: a person's addresses and sign-in are private, and a machine answer is live.
    app.use(['/api', '/auth'], (_req, res, next) => {
        res.set('Cache-Control', 'no-store');
        next();
    });

    app.get('/api/health', (_req, res) => res.json({ status: 'ok', service: 'openvibe-mail', name: 'OpenVibe.Mail', version: VERSION }));

    const readiness = createServiceReadiness({ db: store.db, config, stalwart, version: VERSION });
    app.get('/api/ready', readiness.handler);

    // GET /release.json (registry.release-manifest@1): the deployed commit, read at boot. Open tabs poll it through
    // the shared navbar's release-watch and pick up a new release without a hard refresh, as on every other site.
    require('openvibe-shared/release').createRelease({ service: 'mail', root: ROOT }).mount(app);

    // Sign-in with OpenVibe.Network (openvibe-sdk/sso): /auth/login, /auth/callback, /auth/me, /auth/logout. The
    // session lives in the SDK's host-only ov_token cookie on openvibe.email. A request that already carries a
    // Bearer token is judged by that token alone, so the cookie is not even read for it.
    app.use((req, res, next) => (req.headers.authorization ? next() : sso.optionalAuth()(req, res, next)));
    app.use('/auth', rateLimit({
        windowMs: 15 * 60_000,
        limit: 60,
        standardHeaders: true,
        legacyHeaders: false,
        handler: (req, res) => contracts.http.sendProblem(res, 429, 'rate_limited', {
            detail: 'Too many sign-in requests from this address; retry shortly.',
            ctx: req.ov,
        }),
    }));
    app.use('/auth', sso.router(express));

    // CORS: a Bearer token may be sent from any first-party origin in the manifests; a cookie may not cross sites.
    app.use('/api/v1', createCors({ baseUrl: config.baseUrl }));

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
    app.use(createApi({ db: store.db, config, stalwart, events, principal, log, smtp: opts.smtp || null, fetchImpl, imap: opts.imap || null }));

    // The agent's own system (track HO6): one letter in full text and the reply to it, loopback only under a
    // first-party service token; and the person's own answering switch and block list.
    require('./http/agent-mail').mountAgentMail(app, { db: store.db, config, stalwart, principal, keys, smtp: opts.smtp || null, now: opts.now, log });

    // openvibe.email's page, its files and Shared's (server/http/pages.js).
    require('./http/pages').mountPages(app, { config });

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

    return { app, ctx: { config, store, keys, stalwart, events, principal, sso, log } };
}

module.exports = { createApp, VERSION };
