'use strict';
/**
 * The machine-readable front door: /.well-known/agent.json, /openapi.json, /llms.txt and /llms-full.txt.
 *
 * Only public data goes out. The site has one public page (`/`); `/inbox` and `/admin/mail/providers` are one
 * person's or the owner's and never appear here. The OpenAPI document is the one openvibe-contracts publishes for
 * this service, without the operations marked internal-only and without the loopback `/internal/` routes.
 */
const express = require('express');
const contracts = require('openvibe-contracts');
const seo = require('openvibe-shared/seo');

const SITE_NAME = 'OpenVibe.Mail';
const { mailCopy } = require('./mail-copy');

/** The words the agent files use: the home page's own (server/http/mail-copy.js), so both follow MAIL_OUTBOUND. */
function words(config) {
    const c = mailCopy(config);
    return {
        summary: c.summary,
        details: `OpenVibe.Mail (openvibe.email) is the mail service of the OpenVibe network. Its public page is /, and its JSON API at /api/v1 needs a person's Network token. ${c.sendRule}`,
        page: `An address for every sign-up. ${c.summary} A ten-minute address shows the code a site sends and then deletes itself; it needs no account. `
            + 'Your address: a name at openvibe.email, aliases and your own domain, all into one inbox with trackers off until you say, '
            + `and another mailbox brought in over IMAP, read only. ${c.sendLine} Masks give a different address per site and deliver `
            + 'to your inbox, so a leak never learns your real one. Inboxes let an agent have its own address for sign-ups and codes. '
            + 'Inbox AI is off until you turn it on, and a draft is never sent until you press Send. A message body stays in its '
            + 'mailbox: never in a log, an event or a page.',
    };
}

const METHODS = new Set(['get', 'put', 'post', 'delete', 'patch', 'head', 'options']);

/** The public API document: contracts' mail document minus internal-only operations and the loopback routes. */
function publicDocument() {
    const doc = contracts.openapi.document('mail');
    if (!doc) return null;
    const paths = {};
    for (const [p, item] of Object.entries(doc.paths || {})) {
        // /internal/... are loopback-only routes; some contracts call them first-party rather than internal,
        // but they are not part of the public API this document describes.
        if (p === '/internal' || p.startsWith('/internal/')) continue;
        const kept = {};
        for (const [method, op] of Object.entries(item || {})) {
            if (!METHODS.has(method)) { kept[method] = op; continue; }
            const visibility = [].concat((op && op['x-openvibe-visibility']) || []);
            if (visibility.length && visibility.every((v) => v === 'internal')) continue;
            kept[method] = op;
        }
        if (Object.keys(kept).some((method) => METHODS.has(method))) paths[p] = kept;
    }
    return { ...doc, paths };
}

function createDiscoveryRoutes({ config }) {
    const base = String(config.baseUrl || 'https://openvibe.email').replace(/\/+$/, '');
    const said = words(config);
    const r = express.Router();
    const CACHE = 'public, max-age=3600';

    const manifest = {
        network: 'OpenVibe',
        site: 'openvibe.email',
        id: 'mail',
        name: SITE_NAME,
        purpose: said.summary,
        home: base,
        api: `${base}/api/v1`,
        openapi: `${base}/openapi.json`,
        docs: `${base}/openapi.json`,
        llms: `${base}/llms.txt`,
        llmsFull: `${base}/llms-full.txt`,
        policy: {
            robots: 'https://openvibe.network/bot.json',
            auth: ['none', 'Network OIDC'],
            rateLimit: 'The API is rate limited per address; a ten-minute address needs no account.',
        },
    };

    r.get('/.well-known/agent.json', (_req, res) => res.set('Cache-Control', CACHE).json(manifest));

    // GET /openapi.json (SEO-3): the service's own API as OpenAPI 3.1.
    r.get('/openapi.json', (_req, res) => {
        const doc = publicDocument();
        if (!doc) return res.status(404).type('text/plain').send('No API document.');
        res.set('Cache-Control', CACHE).set('Access-Control-Allow-Origin', '*').json(doc);
    });

    // /llms.txt (llmstxt.org): the public page, the API document and the machine-readable files. The markdown mode
    // is off: this site has no Markdown twins.
    r.get('/llms.txt', (_req, res) => res.type('text/plain').set('Cache-Control', CACHE).send(seo.llmsTxt({
        name: SITE_NAME,
        summary: said.summary,
        details: said.details,
        sections: [
            { title: 'Start here', links: [
                { title: SITE_NAME, url: `${base}/`, note: 'your address, masks, ten-minute addresses and agent inboxes' },
                { title: 'OpenAPI 3.1 document', url: `${base}/openapi.json`, note: 'every public API route, with its fields' },
                { title: 'Agent descriptor', url: `${base}/.well-known/agent.json` },
                { title: 'Health', url: `${base}/api/health` },
                { title: 'Release metadata', url: `${base}/release.json` },
            ] },
        ],
        optional: [
            { title: 'Full text for language models', url: `${base}/llms-full.txt` },
        ],
    })));

    // /llms-full.txt (SEO-33): the same, with the public page's text.
    r.get('/llms-full.txt', (_req, res) => res.type('text/plain').set('Cache-Control', CACHE).send(seo.llmsFull({
        site: SITE_NAME,
        summary: said.summary,
        base,
        maxBytes: 512 * 1024,
        sections: [{ title: 'Pages', pages: [
            { title: SITE_NAME, url: '/', text: said.page },
            { title: 'The API', url: '/openapi.json', text: 'The JSON API is at /api/v1 and needs a person\'s OpenVibe Network token: masks, burners, agent inboxes, their messages and the verification code. The OpenAPI document lists every public route and its fields. Uploads and the local mail server are not HTTP.' },
        ] }],
    })));

    return r;
}

module.exports = { createDiscoveryRoutes, publicDocument, SITE_NAME };
