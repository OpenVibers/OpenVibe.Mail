'use strict';

/**
 * Who is calling /api/v1 — req.principal:
 *
 *   { kind: 'user', subject: 'usr_…', role, username, viaSession }
 *       a person, with their Network session token as a Bearer, or the openvibe.email session cookie set by
 *       openvibe-sdk/sso after sign-in. A cookie-authenticated write must come from openvibe.email itself
 *       (Sec-Fetch-Site same-origin, or an Origin equal to ours): another site cannot make a signed-in visitor
 *       create a mask, turn one off or spend their burner allowance.
 *   { kind: 'app', requester: 'app:…' | 'agent:…' | 'service:…', subject: 'usr_…' | null, capabilities, claims }
 *       a Network app, agent or service token for audience openvibe.mail. When the token names the person it acts
 *       for (`on_behalf_of`), the app acts for that person and is held to that person's limits. When it does not,
 *       it acts for itself and may read nothing of theirs.
 *   { kind: 'anonymous' }
 *       nobody. The only thing an anonymous caller may do is ask for a burner, and only within the limits that are
 *       counted by the address the request came from.
 *
 * A request that presents a token is judged on that token alone: a bad one is refused, never downgraded to the
 * session or to anonymous. A typed token (Network's `typ` or `purpose` claim) is not a session and is refused here
 * as it is everywhere else in the house (openvibe-sdk's verifyUserToken enforces it).
 */
const { serviceAuth, http, ids } = require('openvibe-contracts');

const PRINCIPAL_SUB = /^(svc|app|mod|agent):/;
// The scope the browser extension holds, and the only one Mail gives it: its own masks.
const MAIL_MASK_SCOPE = 'mail.mask.manage';
const USER_SUB = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// The capabilities Network may grant to an app that acts for a person. A person with their own token needs none.
const CAPABILITIES = {
    write: 'mail.addresses.write',
    read: 'mail.messages.read',
    // masks is what the browser extension holds: the Companion's own scoped token may manage the
    // person's masks and nothing else (it never reads a message, never makes a burner).
    masks: 'mail.mask.manage',
};

/** Same-origin for a signed-in write: the browser's fetch metadata, else the Origin header. */
function sameOrigin(req, baseUrl) {
    const site = String(req.get('sec-fetch-site') || '');
    if (site) return site === 'same-origin';
    const origin = req.get('origin');
    if (!origin) return false;
    return origin === baseUrl || origin === `${req.protocol}://${req.get('host')}`;
}

function decodePayload(token) {
    const parts = String(token || '').split('.');
    if (parts.length !== 3) return null;
    try { return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')); } catch { return null; }
}

function roleClaim(claims) {
    return typeof claims.role === 'string' && claims.role ? claims.role.slice(0, 32) : 'user';
}

function usernameClaim(claims) {
    return typeof claims.username === 'string' ? claims.username.slice(0, 64) : null;
}

function requesterOfSub(sub) {
    if (String(sub).startsWith('svc:')) return `service:${String(sub).slice(4)}`;
    return String(sub);
}

/** The issuer the Network's Dock tokens carry: the network issuer with /dock behind it. */
function dockIssuer(config) {
    return String(config.network.issuer || '').replace(/\/+$/, '') + '/dock';
}

function capabilitiesOf(claims) {
    const cap = claims && claims.cap;
    if (Array.isArray(cap)) return cap.filter((c) => typeof c === 'string');
    if (typeof cap === 'string') return cap.split(/[\s,]+/).filter(Boolean);
    return [];
}

function createPrincipal({ config, keys }) {
    async function resolve(req) {
        const header = String(req.headers.authorization || '');
        if (header.startsWith('Bearer ')) {
            const token = header.slice(7).trim();
            if (!token) return { error: [401, 'token.invalid', 'the Bearer token is empty'] };

            const payload = decodePayload(token);

            // The Companion (the browser extension): the Network's Dock token for the public client
            // 'companion', scoped to 'mail.mask.manage'. It acts for the person who signed in, so it
            // gets that person's own masks and nothing else.
            if (payload && payload.client_id === 'companion') {
                const v = await keys.verifyDock(token, { issuer: dockIssuer(config), audience: config.network.sessionAudience });
                if (!v.ok) return { error: [401, v.expired ? 'token.expired' : 'token.invalid', v.reason] };
                const scope = String(v.claims.scope || '').split(/\s+/).filter(Boolean);
                if (!scope.includes(MAIL_MASK_SCOPE)) {
                    return { error: [403, 'mail.capability_missing', 'this token may not manage masks'] };
                }
                if (!ids.isSubjectId('user', v.claims.subject_id)) {
                    return { error: [403, 'identity.no_subject', 'this account has no canonical subject yet; sign in again'] };
                }
                return {
                    principal: {
                        kind: 'app',
                        requester: 'app:companion',
                        subject: v.claims.subject_id,
                        capabilities: [CAPABILITIES.masks],
                        claims: v.claims,
                    },
                };
            }

            if (payload && typeof payload.sub === 'string' && PRINCIPAL_SUB.test(payload.sub)) {
                const publicKey = await keys.pemForToken(token);
                if (!publicKey) return { error: [503, 'identity.unavailable', 'the Network signing key is not loaded yet'] };
                const r = serviceAuth.verifyServiceToken(token, { publicKey, issuer: config.network.issuer, audience: config.network.audience });
                if (!r.ok) return { error: [401, r.code || 'token.invalid', r.reason || 'the token does not verify'] };
                const claims = r.claims || {};
                const behalf = USER_SUB.test(String(claims.on_behalf_of || '')) ? claims.on_behalf_of : null;
                return {
                    principal: {
                        kind: 'app',
                        requester: requesterOfSub(claims.sub),
                        subject: behalf,
                        capabilities: capabilitiesOf(claims),
                        claims,
                    },
                };
            }

            const v = await keys.verifyUser(token, { issuer: config.network.issuer, audience: config.network.sessionAudience });
            if (!v.ok) return { error: [401, v.expired ? 'token.expired' : 'token.invalid', v.reason] };
            if (!ids.isSubjectId('user', v.claims.subject_id)) {
                return { error: [403, 'identity.no_subject', 'this account has no canonical subject yet; sign in again'] };
            }
            return {
                principal: {
                    kind: 'user',
                    subject: v.claims.subject_id,
                    requester: `user:${v.claims.subject_id}`,
                    capabilities: CAPABILITIES,
                    role: roleClaim(v.claims),
                    username: usernameClaim(v.claims),
                    token,
                    viaSession: false,
                },
            };
        }

        // No Authorization header: openvibe-sdk/sso's optionalAuth has verified the session cookie, if one was
        // presented. A cookie that does not verify is anonymous; a Bearer header, present but bad, is never
        // downgraded to the cookie (the branch above returns the error).
        const viewer = req.user;
        if (viewer && ids.isSubjectId('user', viewer.subject_id)) {
            return {
                principal: {
                    kind: 'user',
                    subject: viewer.subject_id,
                    requester: `user:${viewer.subject_id}`,
                    capabilities: CAPABILITIES,
                    role: roleClaim(viewer),
                    username: usernameClaim(viewer),
                    token: req.token,
                    viaSession: true,
                },
            };
        }
        return { principal: { kind: 'anonymous' } };
    }

    async function middleware(req, res, next) {
        const r = await resolve(req);
        if (r.error) return http.sendProblem(res, r.error[0], r.error[1], { detail: r.error[2], ctx: req.ov });
        // A write authenticated by the session cookie must come from this site. (A Bearer token has no such rule:
        // the token is the caller's, and a browser cannot read a cross-origin response without CORS approval.)
        if (r.principal.kind === 'user' && r.principal.viaSession && !SAFE_METHODS.has(req.method)
            && !sameOrigin(req, config.baseUrl)) {
            return http.sendProblem(res, 403, 'mail.cross_site', {
                detail: 'A signed-in request that changes something must come from openvibe.email itself.',
                ctx: req.ov,
            });
        }
        req.principal = r.principal;
        return next();
    }

    /**
     * The person the request acts for, or null.
     *
     * An app that names the person it acts for acts for them; an app that does not acts for itself and has no
     * person of its own to read.
     */
    function subjectOf(principal) {
        if (!principal) return null;
        if (principal.kind === 'user') return principal.subject;
        if (principal.kind === 'app' && principal.subject) return principal.subject;
        return null;
    }

    /**
     * A route for a person: their token, or an app acting for them with the right capability.
     *
     * 'capability' is the capability the route needs, or a list of them when more than one opens it
     * (the mask routes are open to the person's own token, to an app with the address capability, and
     * to the Companion, which holds the mask capability alone).
     */
    function requirePerson(capability) {
        const wanted = capability == null ? [] : (Array.isArray(capability) ? capability : [capability]);
        return function guard(req, res, next) {
            const principal = req.principal || { kind: 'anonymous' };
            if (principal.kind === 'anonymous') {
                return http.sendProblem(res, 401, 'token.required', {
                    detail: 'Send a person\'s Network token as a Bearer.',
                    ctx: req.ov,
                });
            }
            if (principal.kind === 'user') return next();
            if (principal.kind === 'app') {
                if (!principal.subject) {
                    return http.sendProblem(res, 403, 'mail.person_required', {
                        detail: 'This route is for a person. An app token that does not name a person has nothing here.',
                        ctx: req.ov,
                    });
                }
                const held = principal.capabilities || [];
                if (wanted.length && !wanted.some((c) => held.includes(c))) {
                    return http.sendProblem(res, 403, 'mail.capability_missing', {
                        detail: `The app needs the ${wanted.join(' or ')} capability for this route.`,
                        ctx: req.ov,
                    });
                }
                return next();
            }
            return http.sendProblem(res, 403, 'mail.person_required', { detail: 'This route is for a person.', ctx: req.ov });
        };
    }

    return { middleware, resolve, requirePerson, subjectOf, CAPABILITIES };
}

module.exports = { createPrincipal, CAPABILITIES, decodePayload, sameOrigin, dockIssuer };
