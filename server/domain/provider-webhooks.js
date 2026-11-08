'use strict';

const crypto = require('node:crypto');
const { sql } = require('openvibe-sdk/db');
const adapters = require('./provider-adapters');
const providers = require('./outbound-providers');

const equal = (left, right) => {
    const a = Buffer.from(String(left || ''));
    const b = Buffer.from(String(right || ''));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
};

function verifyHmac(secret, raw, supplied) {
    const expected = crypto.createHmac('sha256', secret).update(raw).digest('hex');
    return (String(supplied || '').split(/\s+/).some((part) => equal(part.replace(/^sha256=/i, ''), expected)) ||
        equal(String(supplied || '').replace(/^sha256=/i, ''), crypto.createHmac('sha256', secret).update(raw).digest('base64')));
}

function verifyResend(secret, raw, headers, now = Date.now()) {
    const id = headers['svix-id'], timestamp = headers['svix-timestamp'], signatures = headers['svix-signature'];
    const seconds = Number(timestamp);
    if (!id || !Number.isFinite(seconds) || Math.abs(now / 1000 - seconds) > 300) return false;
    const key = String(secret).replace(/^whsec_/, '');
    let decoded;
    try { decoded = Buffer.from(key, 'base64'); } catch { return false; }
    const signed = `${id}.${timestamp}.${raw}`;
    const expected = crypto.createHmac('sha256', decoded).update(signed).digest('base64');
    return String(signatures || '').split(/\s+/).some((item) => {
        const [version, value] = item.split(',', 2);
        return version === 'v1' && equal(value, expected);
    });
}

function snsCanonical(message) {
    const order = message.Type === 'Notification'
        ? ['Message','MessageId','Subject','Timestamp','TopicArn','Type']
        : ['Message','MessageId','SubscribeURL','Timestamp','Token','TopicArn','Type'];
    return order.filter((key) => message[key] !== undefined).map((key) => `${key}\n${message[key]}\n`).join('');
}

async function verifySes(secret, payload, fetchImpl, expectedTopicArn) {
    // Validate SNS messages with the signed TopicArn and Amazon SNS certificate URL:
    // https://docs.aws.amazon.com/sns/latest/dg/sns-verify-signature-of-message.html
    if (!expectedTopicArn || payload.TopicArn !== expectedTopicArn) return false;
    const url = String(payload.SigningCertURL || '');
    let parsed;
    try { parsed = new URL(url); } catch { return false; }
    if (parsed.protocol !== 'https:' || !/^sns(?:\.[a-z0-9-]+)?\.amazonaws\.com$/i.test(parsed.hostname) || !/^\/SimpleNotificationService-[a-f0-9-]+\.pem$/i.test(parsed.pathname)) return false;
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) return false;
    const cert = await response.text();
    const signature = Buffer.from(String(payload.Signature || ''), 'base64');
    const algorithm = payload.SignatureVersion === '2' ? 'RSA-SHA256' : payload.SignatureVersion === '1' ? 'RSA-SHA1' : null;
    if (!algorithm) return false;
    return crypto.verify(algorithm, Buffer.from(snsCanonical(payload)), cert, signature);
}

/** A verified SNS SubscriptionConfirmation is confirmed by fetching its SubscribeURL, only when that URL is Amazon's SNS
 *  endpoint confirming this very topic (https://docs.aws.amazon.com/sns/latest/dg/SendMessageToHttp.confirm.html). */
function snsConfirmUrl(payload) {
    if (!payload || payload.Type !== 'SubscriptionConfirmation') return null;
    let url;
    try { url = new URL(String(payload.SubscribeURL || '')); } catch { return null; }
    if (url.protocol !== 'https:' || !/^sns\.[a-z0-9-]+\.amazonaws\.com$/i.test(url.hostname) || url.port) return null;
    if (url.searchParams.get('Action') !== 'ConfirmSubscription' || url.searchParams.get('TopicArn') !== payload.TopicArn) return null;
    return url.toString();
}

async function confirmSnsSubscription(payload, fetchImpl = globalThis.fetch) {
    const url = snsConfirmUrl(payload);
    if (!url) return false;
    const response = await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(5000) });
    return Boolean(response && response.ok);
}

async function verify({ adapter, secret, payload, rawBody, headers = {}, fetchImpl = globalThis.fetch, now = Date.now(), expectedTopicArn }) {
    const raw = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody || ''));
    if (adapter === 'ses') return verifySes(secret, payload, fetchImpl, expectedTopicArn);
    if (!secret) return false;
    // Resend uses Svix's raw-body signature and timestamp headers: https://resend.com/docs/webhooks/signature-verification
    if (adapter === 'resend') return verifyResend(secret, raw, headers, now);
    // Postmark Basic Auth: https://postmarkapp.com/developer/webhooks/webhooks-overview
    // Mailjet recommends HTTPS plus URL Basic Auth: https://dev.mailjet.com/docs/email-api/webhooks/webhooks-overview/
    if (adapter === 'postmark' || adapter === 'mailjet') {
        const auth = String(headers.authorization || '');
        const expected = `Basic ${Buffer.from(String(secret)).toString('base64')}`;
        return equal(auth, expected) || equal(headers['x-postmark-webhook-token'], secret);
    }
    // MailerSend v2 HMAC: https://developers.mailersend.com/api/v1/account/webhooks#security
    if (adapter === 'mailersend') return verifyHmac(secret, raw, headers.signature);
    const auth = String(headers.authorization || '');
    if (auth.startsWith('Basic ') && equal(auth, `Basic ${Buffer.from(String(secret)).toString('base64')}`)) return true;
    // Brevo's transactional webhook docs describe unsigned JSON notifications, so require owner-configured shared
    // authentication for it and providers without a documented payload signature. https://developers.brevo.com/docs/transactional-webhooks
    return equal(headers['x-mail-webhook-secret'], secret);
}

function eventId(payload, normalized) {
    return String(payload.event_id || payload.id || payload.MessageID || payload.MessageId || payload.message_id || payload.sg_event_id ||
        crypto.createHash('sha256').update(JSON.stringify([normalized.adapter, normalized.event, normalized.recipient, payload.timestamp || payload.date || ''])).digest('hex')).slice(0, 250);
}

async function ingest({ db, provider, payload, now = new Date() }) {
    const normalized = adapters.adapterFor(provider.adapter).parseWebhook(payload);
    if (!normalized.recipient || normalized.kind === 'unknown') return { accepted: true, ignored: true };
    const address = normalized.recipient.toLowerCase();
    const recipientDomain = address.split('@').pop();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address) || recipientDomain.length > 253) return { accepted: true, ignored: true };
    const id = eventId(payload, normalized);
    return db.tx(async (t) => {
        const inserted = await t.maybe(sql`INSERT INTO mail_outbound_webhook_events(provider_id,event_id,recipient,recipient_domain,kind)
            VALUES (${provider.id},${id},${address},${recipientDomain},${normalized.kind}) ON CONFLICT DO NOTHING RETURNING event_id`);
        if (!inserted) return { accepted: true, duplicate: true };
        if (normalized.kind === 'hard_bounce' || normalized.kind === 'complaint') {
            await t.exec(sql`INSERT INTO mail_outbound_suppressions(address,reason,source_provider) VALUES (${address},${normalized.kind},${provider.id})
                ON CONFLICT(address) DO UPDATE SET reason=CASE WHEN mail_outbound_suppressions.reason='complaint' THEN 'complaint' ELSE excluded.reason END`);
        }
        const column = normalized.kind === 'delivered' ? 'delivered' : normalized.kind === 'complaint' ? 'complaints' : normalized.kind === 'hard_bounce' ? 'bounced' : null;
        if (column === 'delivered') await t.exec(sql`INSERT INTO mail_outbound_deliverability(provider_id,recipient_domain,delivered) VALUES (${provider.id},${recipientDomain},1)
            ON CONFLICT(provider_id,recipient_domain) DO UPDATE SET delivered=mail_outbound_deliverability.delivered+1,updated_at=now()`);
        else if (column === 'bounced') await t.exec(sql`INSERT INTO mail_outbound_deliverability(provider_id,recipient_domain,bounced) VALUES (${provider.id},${recipientDomain},1)
            ON CONFLICT(provider_id,recipient_domain) DO UPDATE SET bounced=mail_outbound_deliverability.bounced+1,updated_at=now()`);
        else if (column === 'complaints') await t.exec(sql`INSERT INTO mail_outbound_deliverability(provider_id,recipient_domain,complaints) VALUES (${provider.id},${recipientDomain},1)
            ON CONFLICT(provider_id,recipient_domain) DO UPDATE SET complaints=mail_outbound_deliverability.complaints+1,updated_at=now()`);
        return { accepted: true, kind: normalized.kind };
    });
}

async function handle({ db, config, providerId, payload, rawBody, headers, fetchImpl, now }) {
    const row = (await providers.list(db)).find((item) => item.id === providerId);
    if (!row || !row.enabled) return { status: 404, body: { error: 'not_found' } };
    const key = providers.keyFrom(config);
    const secret = providers.open({ ...row, credential_ciphertext: row.webhook_secret_ciphertext, credential_nonce: row.webhook_secret_nonce, credential_tag: row.webhook_secret_tag }, key);
    let parsed = payload;
    // SNS wraps the actual SES event in an escaped Message string.
    if (row.adapter === 'ses' && parsed.Type === 'Notification' && typeof parsed.Message === 'string') {
        try { parsed = JSON.parse(parsed.Message); } catch { return { status: 400, body: { error: 'invalid_payload' } }; }
    }
    const valid = await verify({ adapter: row.adapter, secret, payload, rawBody, headers, fetchImpl, now: now ? now.getTime() : Date.now(), expectedTopicArn: row.settings && row.settings.sns_topic_arn });
    if (!valid) return { status: 401, body: { error: 'invalid_signature' } };
    if (row.adapter === 'ses' && payload.Type === 'SubscriptionConfirmation') {
        const confirmed = await confirmSnsSubscription(payload, fetchImpl).catch(() => false);
        return { status: confirmed ? 200 : 502, body: { confirmed } };
    }
    if (row.adapter === 'ses' && payload.Type === 'UnsubscribeConfirmation') return { status: 200, body: { accepted: true, ignored: true } };
    const events = Array.isArray(parsed) ? parsed : [parsed];
    const results = await Promise.all(events.map((event) => ingest({ db, provider: row, payload: event, now })));
    return { status: 200, body: { accepted: true, events: results.length, duplicates: results.filter((result) => result.duplicate).length } };
}

module.exports = { verify, verifyResend, verifySes, snsCanonical, snsConfirmUrl, confirmSnsSubscription, ingest, handle, verifyHmac };
