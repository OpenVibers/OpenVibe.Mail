'use strict';

const crypto = require('crypto');
const smtp = require('../stalwart/smtp');

class ProviderError extends Error {
    constructor(message, { status = 0, transient = false, uncertain = false, code = 'provider.error' } = {}) {
        super(message);
        this.status = status;
        this.transient = transient;
        this.uncertain = uncertain;
        this.code = code;
    }
}

function parseMessage(raw) {
    const [head, ...bodyParts] = String(raw || '').split(/\r?\n\r?\n/);
    const headers = Object.create(null);
    let last = '';
    for (const line of String(head || '').split(/\r?\n/)) {
        if (/^[ \t]/.test(line) && last) headers[last] += ` ${line.trim()}`;
        else {
            const at = line.indexOf(':');
            if (at < 1) continue;
            last = line.slice(0, at).trim().toLowerCase();
            headers[last] = line.slice(at + 1).trim();
        }
    }
    const address = (value) => {
        const found = /<([^<>\s]+@[^<>\s]+)>/.exec(String(value || ''));
        return (found ? found[1] : String(value || '')).trim();
    };
    return { from: address(headers.from), to: address(headers.to), subject: headers.subject || '', text: bodyParts.join('\n\n').replace(/\r\n/g, '\n').trim(), headers };
}

async function responseJson(response) {
    let body = {};
    try { body = await response.json(); } catch { /* provider may return an empty accepted response */ }
    if (!response.ok) {
        const status = Number(response.status) || 0;
        const detail = String(body.message || body.error || body.errors?.[0]?.message || `Provider refused the message (${status || 'no status'}).`).slice(0, 240);
        throw new ProviderError(detail, { status, transient: status === 408 || status === 425 || status === 429 || status >= 500, code: status >= 500 || status === 429 ? 'provider.transient' : 'provider.rejected' });
    }
    return body;
}

async function post(fetchImpl, url, headers, body) {
    try {
        const response = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) });
        const data = await responseJson(response);
        const messageId = response.headers && response.headers.get ? response.headers.get('x-message-id') : null;
        return messageId ? { ...data, _messageId: messageId } : data;
    } catch (err) {
        if (err instanceof ProviderError) throw err;
        throw new ProviderError('The provider connection ended before its response was confirmed.', { transient: true, uncertain: true, code: 'provider.uncertain' });
    }
}

function hmac(key, value, encoding) { return crypto.createHmac('sha256', key).update(value, 'utf8').digest(encoding); }
function sesAuthorization({ accessKeyId, secretAccessKey, region }, body, now = new Date()) {
    const host = `email.${region}.amazonaws.com`;
    const date = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
    const day = date.slice(0, 8);
    const hashed = crypto.createHash('sha256').update(body).digest('hex');
    const canonical = `POST\n/v2/email/outbound-emails\n\ncontent-type:application/json\nhost:${host}\nx-amz-date:${date}\n\ncontent-type;host;x-amz-date\n${hashed}`;
    const scope = `${day}/${region}/ses/aws4_request`;
    const stringToSign = `AWS4-HMAC-SHA256\n${date}\n${scope}\n${crypto.createHash('sha256').update(canonical).digest('hex')}`;
    const dateKey = hmac(`AWS4${secretAccessKey}`, day);
    const regionKey = crypto.createHmac('sha256', dateKey).update(region).digest();
    const serviceKey = crypto.createHmac('sha256', regionKey).update('ses').digest();
    const signingKey = crypto.createHmac('sha256', serviceKey).update('aws4_request').digest();
    const signature = crypto.createHmac('sha256', signingKey).update(stringToSign).digest('hex');
    return { host, date, authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=content-type;host;x-amz-date, Signature=${signature}` };
}

function sesGetAuthorization({ accessKeyId, secretAccessKey, region }, path, now = new Date()) {
    const host = `email.${region}.amazonaws.com`;
    const date = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
    const day = date.slice(0, 8);
    const canonical = `GET\n${path}\n\nhost:${host}\nx-amz-date:${date}\n\nhost;x-amz-date\n${crypto.createHash('sha256').update('').digest('hex')}`;
    const scope = `${day}/${region}/ses/aws4_request`;
    const stringToSign = `AWS4-HMAC-SHA256\n${date}\n${scope}\n${crypto.createHash('sha256').update(canonical).digest('hex')}`;
    const dateKey = hmac(`AWS4${secretAccessKey}`, day);
    const regionKey = crypto.createHmac('sha256', dateKey).update(region).digest();
    const serviceKey = crypto.createHmac('sha256', regionKey).update('ses').digest();
    const signingKey = crypto.createHmac('sha256', serviceKey).update('aws4_request').digest();
    const signature = crypto.createHmac('sha256', signingKey).update(stringToSign).digest('hex');
    return { host, date, authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=host;x-amz-date, Signature=${signature}` };
}

const apiAdapters = {
    // AWS SES v2 SendEmail API and SigV4: https://docs.aws.amazon.com/ses/latest/APIReference-V2/API_SendEmail.html
    ses: {
        async send(ctx) {
            const c = ctx.credentials, body = { FromEmailAddress: ctx.message.from, Destination: { ToAddresses: [ctx.message.to] }, Content: { Simple: { Subject: { Data: ctx.message.subject, Charset: 'UTF-8' }, Body: { Text: { Data: ctx.message.text, Charset: 'UTF-8' } } } } };
            const raw = JSON.stringify(body); const signed = sesAuthorization(c, raw);
            const result = await post(ctx.fetch, `https://${signed.host}/v2/email/outbound-emails`, { host: signed.host, 'x-amz-date': signed.date, authorization: signed.authorization }, body);
            return { messageId: result.MessageId || null };
        },
        async domainStatus(ctx, domain) { const c = ctx.credentials, path = `/v2/email/identities/${encodeURIComponent(domain)}`; const signed = sesGetAuthorization(c, path); const data = await getJson(ctx.fetch, `https://${signed.host}${path}`, { host: signed.host, 'x-amz-date': signed.date, authorization: signed.authorization }); return data.VerifiedForSendingStatus === true; },
    },
    // Cloudflare Email Sending REST API: https://developers.cloudflare.com/email-service/api/send-emails/rest-api/ . Email Sending domain verification is documented at https://developers.cloudflare.com/email-service/configuration/domains/; the service exposes it in the Cloudflare dashboard, so this API adapter deliberately fails closed until DNS-backed status is available.
    cloudflare: {
        async send(ctx) { const s = ctx.settings; const data = await post(ctx.fetch, `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(s.account_id)}/email/sending/send`, { authorization: `Bearer ${ctx.credentials}` }, { from: ctx.message.from, to: [ctx.message.to], subject: ctx.message.subject, text: ctx.message.text }); if (data.success !== true) throw new ProviderError('Cloudflare rejected the message.', { status: 400 }); return { messageId: data.result?.message_id || null }; },
        async domainStatus() { return false; },
    },
    // Brevo transactional send: https://developers.brevo.com/reference/send-transac-email
    brevo: {
        async send(ctx) { const data = await post(ctx.fetch, 'https://api.brevo.com/v3/smtp/email', { 'api-key': ctx.credentials }, { sender: { email: ctx.message.from }, to: [{ email: ctx.message.to }], subject: ctx.message.subject, textContent: ctx.message.text }); return { messageId: data.messageId || null }; },
        async domainStatus(ctx, domain) { const data = await getJson(ctx.fetch, 'https://api.brevo.com/v3/senders?limit=100', { 'api-key': ctx.credentials }); return (data.senders || []).some((s) => s.domain === domain && s.active === true); },
    },
    // Mailjet Send API v3.1: https://dev.mailjet.com/email/guides/send-api-v31/
    mailjet: {
        async send(ctx) { const c = ctx.credentials; const auth = Buffer.from(`${c.apiKey}:${c.secretKey}`).toString('base64'); const data = await post(ctx.fetch, 'https://api.mailjet.com/v3.1/send', { authorization: `Basic ${auth}` }, { Messages: [{ From: { Email: ctx.message.from }, To: [{ Email: ctx.message.to }], Subject: ctx.message.subject, TextPart: ctx.message.text }] }); const message = data.Messages?.[0]; if (message?.Status !== 'success') throw new ProviderError('Mailjet did not accept the message.', { status: 400 }); return { messageId: message.To?.[0]?.MessageID || null }; },
        async domainStatus(ctx, domain) { const c = ctx.credentials; const auth = Buffer.from(`${c.apiKey}:${c.secretKey}`).toString('base64'); const data = await getJson(ctx.fetch, 'https://api.mailjet.com/v3/REST/sender', { authorization: `Basic ${auth}` }); return (data.Data || []).some((s) => String(s.Email || '').toLowerCase().endsWith(`@${domain}`) && s.Status === 'Active'); },
    },
    // MailerSend Email API: https://developers.mailersend.com/api/v1/email
    mailersend: {
        async send(ctx) { const data = await post(ctx.fetch, 'https://api.mailersend.com/v1/email', { authorization: `Bearer ${ctx.credentials}` }, { from: { email: ctx.message.from }, to: [{ email: ctx.message.to }], subject: ctx.message.subject, text: ctx.message.text }); return { messageId: data.message_id || data._messageId || null }; },
        async domainStatus(ctx, domain) { const data = await getJson(ctx.fetch, 'https://api.mailersend.com/v1/domains', { authorization: `Bearer ${ctx.credentials}` }); return (data.data || []).some((d) => d.name === domain && d.is_verified === true); },
    },
    // Resend send email: https://resend.com/docs/api-reference/emails/send-email
    resend: {
        async send(ctx) { const data = await post(ctx.fetch, 'https://api.resend.com/emails', { authorization: `Bearer ${ctx.credentials}` }, { from: ctx.message.from, to: [ctx.message.to], subject: ctx.message.subject, text: ctx.message.text }); return { messageId: data.id || null }; },
        async domainStatus(ctx, domain) { const data = await getJson(ctx.fetch, 'https://api.resend.com/domains', { authorization: `Bearer ${ctx.credentials}` }); return (data.data || []).some((d) => d.name === domain && d.status === 'verified'); },
    },
    // SMTP2GO Send Email: https://developers.smtp2go.com/docs/send-an-email . Verified sender APIs: https://developers.smtp2go.com/docs/getting-started
    smtp2go: {
        async send(ctx) { const data = await post(ctx.fetch, 'https://api.smtp2go.com/v3/email/send', { 'X-Smtp2go-Api-Key': ctx.credentials }, { sender: ctx.message.from, to: [ctx.message.to], subject: ctx.message.subject, text_body: ctx.message.text }); if (Number(data.data?.failed || 0) > 0) throw new ProviderError('SMTP2GO rejected the message.', { status: 400 }); return { messageId: data.data?.email_id || null }; },
        async domainStatus(ctx, domain) { const data = await post(ctx.fetch, 'https://api.smtp2go.com/v3/domain/view', { 'X-Smtp2go-Api-Key': ctx.credentials }, { domain }); return (data.data?.domains || []).some((d) => d.domain === domain && d.verified === true); },
    },
    // Zoho ZeptoMail send API: https://www.zoho.com/zeptomail/help/api-home.html . Its domain management APIs require OAuth rather than the send-only agent key, so this send-key adapter does not claim API-verified DKIM status.
    zeptomail: {
        async send(ctx) { const data = await post(ctx.fetch, 'https://api.zeptomail.com/v1.1/email', { authorization: `Zoho-enczapikey ${ctx.credentials}` }, { from: { address: ctx.message.from }, to: [{ email_address: { address: ctx.message.to } }], subject: ctx.message.subject, textbody: ctx.message.text }); return { messageId: data.request_id || null }; },
        async domainStatus() { return false; },
    },
    // Postmark Email API: https://postmarkapp.com/developer/api/email-api
    postmark: {
        async send(ctx) { const data = await post(ctx.fetch, 'https://api.postmarkapp.com/email', { 'X-Postmark-Server-Token': ctx.credentials, accept: 'application/json' }, { From: ctx.message.from, To: ctx.message.to, Subject: ctx.message.subject, TextBody: ctx.message.text, MessageStream: ctx.settings.message_stream || 'outbound' }); if (Number(data.ErrorCode || 0) !== 0) throw new ProviderError(String(data.Message || 'Postmark rejected the message.'), { status: 400 }); return { messageId: data.MessageID || null }; },
        async domainStatus(ctx, domain) { const data = await getJson(ctx.fetch, 'https://api.postmarkapp.com/senders', { 'X-Postmark-Server-Token': ctx.credentials, accept: 'application/json' }); return (data.SenderSignatures || []).some((s) => String(s.FromEmail || '').toLowerCase().endsWith(`@${domain}`) && s.Confirmed === true); },
    },
};

async function getJson(fetchImpl, url, headers) {
    try { return await responseJson(await fetchImpl(url, { headers, signal: AbortSignal.timeout(10000) })); }
    catch (err) { if (err instanceof ProviderError) throw err; throw new ProviderError('The provider status request failed.', { transient: true, uncertain: true }); }
}

function normalizeWebhook(adapter, payload) {
    const event = String(payload.event || payload.RecordType || payload.Type || payload.type || payload.EventType || '').toLowerCase();
    const recipient = String(payload.email || payload.Email || payload.recipient || payload.Recipient || payload.To || payload.to || '').trim().toLowerCase();
    const hard = /hard.?bounc(?:e|ed)|permanent.?bounc(?:e|ed)|bounc(?:e|ed)|undeliverable|spam.?complaint|complaint|blocked/.test(event);
    const soft = /soft.?bounce|deferred|temporary/.test(event);
    return { adapter, event, recipient, kind: hard ? (/(complaint|spam)/.test(event) ? 'complaint' : 'hard_bounce') : soft ? 'soft_bounce' : /delivered|delivery/.test(event) ? 'delivered' : 'unknown' };
}

function adapterFor(name) {
    if (name === 'smtp') return {
        async send(ctx) { const result = await smtp.sendMessage(ctx.route, { from: ctx.message.from, to: ctx.message.to, message: ctx.raw }); if (!result.ok) throw new ProviderError(result.reason || 'SMTP provider refused the message.', { status: result.code || 0, transient: Number(result.code) >= 400 && Number(result.code) < 500 }); return { messageId: result.messageId || null }; },
        async domainStatus() { return false; },
        parseWebhook(payload) { return normalizeWebhook('smtp', payload); },
    };
    const adapter = apiAdapters[name];
    if (!adapter) throw new ProviderError('The configured mail provider is not supported.', { code: 'provider.unsupported' });
    return { ...adapter, parseWebhook: (payload) => normalizeWebhook(name, payload) };
}

async function send({ route, from, to, message, fetchImpl = globalThis.fetch }) {
    const provider = adapterFor(route.adapter || 'smtp');
    const credentials = route.password;
    try {
        const result = await provider.send({ route, settings: route.settings || {}, credentials, message: { ...parseMessage(message), from, to }, raw: message, fetch: fetchImpl });
        return { ok: true, code: 250, reason: null, transient: false, messageId: result.messageId || null };
    } catch (err) {
        return { ok: false, code: err.status || 0, reason: err.message, transient: Boolean(err.transient), uncertain: Boolean(err.uncertain), errorCode: err.code || 'provider.error' };
    }
}

async function domainStatus({ route, domain, fetchImpl = globalThis.fetch }) {
    try { return await adapterFor(route.adapter || 'smtp').domainStatus({ settings: route.settings || {}, credentials: route.password, fetch: fetchImpl }, String(domain).toLowerCase()); }
    catch { return false; }
}

module.exports = { ProviderError, parseMessage, adapterFor, normalizeWebhook, send, domainStatus, sesAuthorization, sesGetAuthorization, apiAdapters };
