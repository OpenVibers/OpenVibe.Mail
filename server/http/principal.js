'use strict';

/**
 * Who is calling /api/v1 — req.principal:
 *
 *   { kind: 'user', subject: 'usr_…', role, username }
 *       a person, with their Network session token as a Bearer.
 *   { kind: 'app', requester: 'app:…' | 'agent:…' | 'service:…', subject: 'usr_…' | null, capabilities, claims }
 *       a Network app, agent or service token for audience openvibe.mail. When the token names the person it acts
 *       for (`on_behalf_of`), the app acts for that person and is held to that person's limits. When it does not,
 *       it acts for itself and may read nothing of theirs.
 *   { kind: 'anonymous' }
 *       nobody. The only thing an anonymous caller may do is ask for a burner, and only within the limits that are
 *       counted by the address the request came from.
 *
 * A request that presents a token is judged on that token alone: a bad one is refused, never downgraded to
 * anonymous. A typed token (Network's `typ` or `purpose` claim) is not a session and is refused here as it is
 * everywhere else in the house.
 */
const { serviceAuth, http, ids } = require('openvibe-contracts');

const PRINCIPAL_SUB = /^(svc|app|mod|agent):/;
const USER_SUB = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;

// The capabilities Network may grant to an app that acts for a person. A person with their own token needs none.
const CAPABILITIES = {
    write: 'mail.addresses.write',
    read: 'mail.messages.read',
};

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

function capabilitiesOf(claims) {
    const cap = claims && claims.cap;
    if (Array.isArray(cap)) return cap.filter((c) => typeof c === 'string');
    if (typeof cap === 'string') return cap.split(/[\s,]+/).filter(Boolean);
    return [];
}

function createPrincipal({ config, keys }) {
    async function resolve(req) {
        const header = String(req.headers.authorization || '');
        if (!header.startsWith('Bearer ')) return { principal: { kind: 'anonymous' } };
        const token = header.slice(7).trim();
        if (!token) return { error: [401, 'token.invalid', 'the Bearer token is empty'] };

        const payload = decodePayload(token);
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
            },
        };
    }

    async function middleware(req, res, next) {
        const r = await resolve(req);
        if (r.error) return http.sendProblem(res, r.error[0], r.error[1], { detail: r.error[2], ctx: req.ov });
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

    /** A route for a person: their token, or an app acting for them with the right capability. */
    function requirePerson(capability) {
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
                if (capability && !(principal.capabilities || []).includes(capability)) {
                    return http.sendProblem(res, 403, 'mail.capability_missing', {
                        detail: `The app needs the ${capability} capability for this route.`,
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

module.exports = { createPrincipal, CAPABILITIES, decodePayload };
