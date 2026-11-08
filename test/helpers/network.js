'use strict';

/**
 * An in-process stand-in for OpenVibe.Network with a real RS256 key pair: the JWKS document and the tokens of
 * the people who call the service. Nothing else of Network is needed by M1.
 */
const http = require('http');
const crypto = require('crypto');
const { ids } = require('openvibe-contracts');

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');

function signJwt(claims, privateKey) {
    const input = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64(claims)}`;
    return `${input}.${crypto.sign('RSA-SHA256', Buffer.from(input), privateKey).toString('base64url')}`;
}

async function startNetwork() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const publicPem = publicKey.export({ type: 'spki', format: 'pem' });
    const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' });
    const st = { users: new Map(), requests: [], down: false };
    let issuer = null;
    let nextUserId = 1;

    function addUser(username, { role = 'user' } = {}) {
        const u = { id: nextUserId++, subject: ids.newId('user'), username, role };
        st.users.set(u.id, u);
        return u;
    }

    function userToken(u, { ttl = 3600, typ, purpose, aud = 'openvibe.network' } = {}) {
        const now = Math.floor(Date.now() / 1000);
        const claims = {
            iss: issuer, sub: u.id, subject_id: u.subject, username: u.username, role: u.role,
            aud: [aud], iat: now, exp: now + ttl,
        };
        if (typ) claims.typ = typ;
        if (purpose) claims.purpose = purpose;
        return signJwt(claims, privatePem);
    }

    /** The Companion's own token: the Network's Dock token (issuer <issuer>/dock) for the public client 'companion'. */
    function dockToken(u, { scope = 'mail.mask.manage', ttl = 3600, clientId = 'companion' } = {}) {
        const now = Math.floor(Date.now() / 1000);
        const claims = {
            iss: `${issuer}/dock`, sub: u.id, subject_id: u.subject, username: u.username,
            client_id: clientId, scope, aud: ['openvibe.network', 'openvibe.chat'], iat: now, exp: now + ttl,
        };
        return signJwt(claims, privatePem);
    }

    const server = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
            const raw = Buffer.concat(chunks);
            st.requests.push({ method: req.method, path: req.url, body: raw.toString('utf8') });
            const json = (status, obj) => {
                res.writeHead(status, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(obj));
            };
            const url = new URL(req.url, 'http://x');
            if (url.pathname === '/api/.well-known/jwks') return json(200, { public_key: publicPem, algorithm: 'RS256' });
            if (st.down) return json(503, { error: 'network is restarting' });
            return json(404, { error: 'not found' });
        });
    });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${server.address().port}`;
    issuer = url;

    return {
        url,
        publicPem,
        state: st,
        addUser,
        userToken,
        dockToken,
        signJwt: (claims) => signJwt(claims, privatePem),
        setDown(v) { st.down = v; },
        close: () => new Promise((r) => server.close(r)),
    };
}

module.exports = { startNetwork, signJwt };
