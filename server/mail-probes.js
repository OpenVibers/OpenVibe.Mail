'use strict';

/**
 * The test of a mail provider: one cheap authenticated read that never sends a letter and never spends money
 * (plan §AB.16 and §AB.18: "each with a test (an authenticated read, never a send)").
 *
 *   Amazon SES        GET /v2/email/identities, signed with SigV4 like the sender itself
 *   Postmark          GET /senders, with the server token
 *   Resend            GET /domains, with the API key
 *   Mailgun           GET /v3/domains, with the private key over HTTP basic
 *   SendGrid          GET /v3/scopes, with the API key
 *   Brevo             GET /v3/account, with the API key
 *   SMTP relay        sign in over SMTP (EHLO, STARTTLS, AUTH) and stop: no MAIL FROM, no letter
 *   Cloudflare        GET the zone, then its email routing rules
 *
 * A probe answers { ok, detail } with one plain line and no key in it. A refusal throws: the caller turns it into
 * one line with the provider's own words, with every secret of that provider cut out.
 */
const { sesGetAuthorization } = require('./domain/provider-adapters');

/** The provider's answer as JSON, or a throw with the provider's own words. */
async function json(fetchImpl, url, headers) {
    let response;
    try {
        response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(15000) });
    } catch (err) {
        throw new Error('the connection to the provider ended before its answer came');
    }
    let body = {};
    try { body = await response.json(); } catch { /* an empty or non-JSON answer */ }
    if (!response.ok) {
        const detail = String(body.message || body.error || body.errors?.[0]?.message || body.detail || `the provider answered ${response.status}`).slice(0, 200);
        throw new Error(detail);
    }
    return body;
}

const basic = (user, password) => `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;

const plural = (count, one, many) => `${count} ${count === 1 ? one : many}`;

const PROBES = {
    /** Amazon SES: the identities the key may send from (the same signed request the sender makes). */
    async ses(creds, { fetchImpl }) {
        const path = '/v2/email/identities';
        const signed = sesGetAuthorization({ accessKeyId: creds.accessKeyId, secretAccessKey: creds.secretAccessKey, region: creds.region }, path);
        const data = await json(fetchImpl, `https://${signed.host}${path}`, { host: signed.host, 'x-amz-date': signed.date, authorization: signed.authorization });
        const list = Array.isArray(data.Identities) ? data.Identities : [];
        return { ok: true, detail: `Amazon SES answered: the key may send from ${plural(list.length, 'one identity', `${list.length} identities`)}.` };
    },

    /** Postmark: the sender signatures the server token belongs to. */
    async postmark(creds, { fetchImpl }) {
        const data = await json(fetchImpl, 'https://api.postmarkapp.com/senders', { 'X-Postmark-Server-Token': creds.serverToken, accept: 'application/json' });
        const list = Array.isArray(data.SenderSignatures) ? data.SenderSignatures : [];
        return { ok: true, detail: `Postmark answered: the token holds ${plural(list.length, 'one sender signature', `${list.length} sender signatures`)}.` };
    },

    /** Resend: the domains the key may send from. */
    async resend(creds, { fetchImpl }) {
        const data = await json(fetchImpl, 'https://api.resend.com/domains', { authorization: `Bearer ${creds.apiKey}` });
        const list = Array.isArray(data.data) ? data.data : [];
        return { ok: true, detail: `Resend answered: the key holds ${plural(list.length, 'one domain', `${list.length} domains`)}.` };
    },

    /** Mailgun: the sending domains of the account (the private key over HTTP basic, as Mailgun asks). */
    async mailgun(creds, { fetchImpl }) {
        const data = await json(fetchImpl, 'https://api.mailgun.net/v3/domains', { authorization: basic('api', creds.apiKey) });
        const list = Array.isArray(data.items) ? data.items : [];
        return { ok: true, detail: `Mailgun answered: the key holds ${plural(list.length, 'one domain', `${list.length} domains`)}.` };
    },

    /** SendGrid: the permissions the key holds (a key with Mail Send is enough). */
    async sendgrid(creds, { fetchImpl }) {
        const data = await json(fetchImpl, 'https://api.sendgrid.com/v3/scopes', { authorization: `Bearer ${creds.apiKey}` });
        const list = Array.isArray(data.scopes) ? data.scopes : [];
        const canSend = list.some((scope) => String(scope).startsWith('mail.send'));
        return { ok: true, detail: `SendGrid answered: the key holds ${plural(list.length, 'one permission', `${list.length} permissions`)}${canSend ? '' : ' (no mail.send permission yet)'}.` };
    },

    /** Brevo: the account the key belongs to. */
    async brevo(creds, { fetchImpl }) {
        const data = await json(fetchImpl, 'https://api.brevo.com/v3/account', { 'api-key': creds.apiKey });
        const plan = data && data.plan ? ` on the ${String(data.plan).slice(0, 40)} plan` : '';
        return { ok: true, detail: `Brevo answered: the key works${plan}.` };
    },

    /**
     * A plain SMTP relay: sign in and stop. No MAIL FROM, no RCPT TO, no letter: the test only proves that the
     * host, the port and the sign-in are right.
     */
    async smtp(creds) {
        const { session, command, upgrade, offersStartTls } = require('./stalwart/smtp');
        const host = String(creds.host || '').trim();
        const port = Number(creds.port || 587);
        const secure = port === 465;
        if (!host) throw new Error('the relay has no host yet');
        await session({ host, port, secure, timeoutMs: 15000 }, async (socket, state, features) => {
            let link = socket;
            let linkState = state;
            if (!secure && offersStartTls(features)) {
                state.stage = 'starttls';
                await command(socket, state, 'STARTTLS', { accept: [220] });
                link = await upgrade(socket);
                linkState = { stage: 'ehlo-tls', onData: null };
                await command(link, linkState, 'EHLO openvibe.email');
            }
            if (creds.user) {
                linkState.stage = 'auth';
                const token = Buffer.from(`\u0000${creds.user}\u0000${creds.password || ''}`, 'utf8').toString('base64');
                await command(link, linkState, `AUTH PLAIN ${token}`, { accept: [235] });
            } else {
                linkState.stage = 'auth';
                await command(link, linkState, 'RSET', { accept: [250] });
            }
            return true;
        });
        return { ok: true, detail: `the relay at ${host}:${port} accepted the sign-in (no letter was sent).` };
    },

    /** Cloudflare Email Routing: the zone, then the rules that forward the mail of the domain. */
    async 'cloudflare-routing'(creds, { fetchImpl }) {
        const domain = String(creds.domain || '').trim();
        const auth = { authorization: `Bearer ${creds.apiToken}` };
        if (!domain) throw new Error('the receiving domain is not set yet');
        const zones = await json(fetchImpl, `https://api.cloudflare.com/client/v4/zones?name=${encodeURIComponent(domain)}&per_page=1`, auth);
        const zone = Array.isArray(zones.result) ? zones.result[0] : null;
        if (!zone) throw new Error(`Cloudflare has no zone called ${domain}`);
        const rules = await json(fetchImpl, `https://api.cloudflare.com/client/v4/zones/${encodeURIComponent(zone.id)}/email/routing/rules`, auth);
        const list = Array.isArray(rules.result) ? rules.result : [];
        return { ok: true, detail: `Cloudflare answered: ${domain} has ${plural(list.length, 'one routing rule', `${list.length} routing rules`)}.` };
    },
};

module.exports = { PROBES, json, basic };
