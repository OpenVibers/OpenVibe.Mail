'use strict';

/**
 * The API's CORS rule, the house one: the browser may read a response from any first-party origin the service
 * manifests declare (openvibe.network, openvibe.blog, …), and from this site itself. Nothing else — no wildcard, no
 * tenant subdomain, no `http://` origin. Every service repeats this small helper rather than adding a dependency;
 * the allow-list is the part that matters.
 *
 * The API authenticates a cross-origin caller with a Bearer token, never with a cookie. A browser does not send
 * `Access-Control-Allow-Credentials`, so a cross-origin `fetch` cannot carry the person's openvibe.email session
 * cookie; a cookie-authenticated write is checked for same-origin in http/principal.js.
 */
const contracts = require('openvibe-contracts');

const HOST_RE = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
let cached = null;

/** The https origins of every first-party domain the installed Contracts manifest names. */
function manifestOrigins() {
    if (cached) return cached;
    const out = new Set();
    for (const manifest of (contracts.services && contracts.services.manifests) || []) {
        for (const domainName of manifest.domains || []) {
            const host = String(domainName || '').trim().toLowerCase();
            if (HOST_RE.test(host)) out.add(`https://${host}`);
        }
    }
    cached = out;
    return out;
}

/** An origin-only form of a configured URL, or null. */
function originOf(url) {
    try {
        const u = new URL(String(url || ''));
        return u.origin === 'null' ? null : u.origin;
    } catch {
        return null;
    }
}

/**
 * opts.extraOrigins  additional exact origins (tests and an operator's override; still no wildcard)
 * opts.baseUrl       this site's origin, always allowed (the same-origin API calls need no CORS, but a page that
 *                    names its own origin explicitly is still first-party)
 */
function createCors({ extraOrigins = [], baseUrl = null } = {}) {
    const allowed = new Set(manifestOrigins());
    const own = originOf(baseUrl);
    if (own) allowed.add(own);
    for (const value of extraOrigins || []) {
        const origin = originOf(value);
        if (origin) allowed.add(origin);
    }

    return function cors(req, res, next) {
        const origin = req.get('origin');
        if (origin && allowed.has(origin)) {
            res.set('Access-Control-Allow-Origin', origin);
            res.vary('Origin');
            res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type, traceparent, X-OpenVibe-Request-Id');
            res.set('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
            res.set('Access-Control-Expose-Headers', 'X-OpenVibe-Request-Id, Retry-After');
            res.set('Access-Control-Max-Age', '600');
        }
        if (req.method === 'OPTIONS') return res.status(204).end();
        return next();
    };
}

module.exports = { createCors, manifestOrigins, originOf };
