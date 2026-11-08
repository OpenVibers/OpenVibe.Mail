'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { send, domainStatus, normalizeWebhook, sesAuthorization } = require('../server/domain/provider-adapters');

const message = 'From: sender@openvibe.email\r\nTo: person@example.net\r\nSubject: Hello\r\nMessage-ID: <id@openvibe.email>\r\n\r\nPlain text body';
const response = (body, { status = 200, headers = {} } = {}) => ({ ok: status >= 200 && status < 300, status, headers: { get: (name) => headers[name.toLowerCase()] || null }, json: async () => body });

const cases = [
    ['ses', { adapter: 'ses', password: { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'unit-test-secret', region: 'us-east-1' }, settings: {} }, 'https://email.us-east-1.amazonaws.com/v2/email/outbound-emails', { MessageId: 'ses-id' }],
    ['cloudflare', { adapter: 'cloudflare', password: 'cf-token', settings: { account_id: 'account-123' } }, 'https://api.cloudflare.com/client/v4/accounts/account-123/email/sending/send', { success: true, result: { message_id: 'cf-id' } }],
    ['brevo', { adapter: 'brevo', password: 'brevo-token', settings: {} }, 'https://api.brevo.com/v3/smtp/email', { messageId: 'brevo-id' }],
    ['mailjet', { adapter: 'mailjet', password: { apiKey: 'public', secretKey: 'private' }, settings: {} }, 'https://api.mailjet.com/v3.1/send', { Messages: [{ Status: 'success', To: [{ MessageID: 4 }] }] }],
    ['mailersend', { adapter: 'mailersend', password: 'ms-token', settings: {} }, 'https://api.mailersend.com/v1/email', { message_id: 'ms-id' }],
    ['resend', { adapter: 'resend', password: 're-token', settings: {} }, 'https://api.resend.com/emails', { id: 're-id' }],
    ['smtp2go', { adapter: 'smtp2go', password: 's2g-token', settings: {} }, 'https://api.smtp2go.com/v3/email/send', { data: { succeeded: 1, failed: 0, email_id: 's2g-id' } }],
    ['zeptomail', { adapter: 'zeptomail', password: 'zepto-token', settings: {} }, 'https://api.zeptomail.com/v1.1/email', { request_id: 'zepto-id' }],
    ['postmark', { adapter: 'postmark', password: 'postmark-token', settings: {} }, 'https://api.postmarkapp.com/email', { ErrorCode: 0, MessageID: 'postmark-id' }],
];

test('provider adapters use the documented endpoints, credentials and body fields', async () => {
    for (const [adapter, route, expectedUrl, reply] of cases) {
        let request;
        const result = await send({ route, from: 'sender@openvibe.email', to: 'person@example.net', message, fetchImpl: async (url, init) => { request = { url, init }; return response(reply, { headers: { 'x-message-id': 'ms-header' } }); } });
        assert.equal(result.ok, true, adapter);
        assert.equal(request.url, expectedUrl, adapter);
        const body = JSON.parse(request.init.body);
        assert.ok(body.text || body.textContent || body.TextPart || body.TextBody || body.Content || body.text_body || body.textbody || body.Messages?.[0]?.TextPart, adapter);
        if (adapter === 'ses') assert.match(request.init.headers.authorization, /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\//);
        if (adapter === 'cloudflare') assert.equal(request.init.headers.authorization, 'Bearer cf-token');
        if (adapter === 'brevo') assert.equal(request.init.headers['api-key'], 'brevo-token');
        if (adapter === 'postmark') assert.equal(request.init.headers['X-Postmark-Server-Token'], 'postmark-token');
    }
});

test('provider error mapping separates permanent refusal, throttling and uncertain network outcomes', async () => {
    const route = { adapter: 'resend', password: 'token', settings: {} };
    const rejected = await send({ route, from: 'a@example.net', to: 'b@example.org', message, fetchImpl: async () => response({ message: 'invalid sender' }, { status: 422 }) });
    const throttled = await send({ route, from: 'a@example.net', to: 'b@example.org', message, fetchImpl: async () => response({ message: 'slow down' }, { status: 429 }) });
    const uncertain = await send({ route, from: 'a@example.net', to: 'b@example.org', message, fetchImpl: async () => { throw new Error('socket closed'); } });
    assert.equal(rejected.transient, false);
    assert.equal(throttled.transient, true);
    assert.equal(uncertain.uncertain, true);
    assert.equal(uncertain.transient, true);
});

test('domain status is normalized and SES signatures cover SigV4 canonical data', async () => {
    for (const [adapter, route] of cases) {
        let url = '';
        if (adapter === 'cloudflare') {
            assert.equal(await domainStatus({ route, domain: 'openvibe.email', fetchImpl: async () => { throw new Error('Cloudflare domain status uses DNS only'); },
                lookupTxt: async (host) => [[host.includes('_domainkey') ? 'v=DKIM1; p=test' : 'v=spf1 include:_spf.mx.cloudflare.net ~all']],
                lookupMx: async () => [{ exchange: 'route1.mx.cloudflare.net' }] }), true, adapter);
            continue;
        }
        if (adapter === 'zeptomail') {
            assert.equal(await domainStatus({ route, domain: 'openvibe.email', fetchImpl: async () => { throw new Error('send-only key cannot inspect domains'); } }), false, adapter);
            continue;
        }
        const statusReply = adapter === 'ses' ? { VerifiedForSendingStatus: true, DkimAttributes: { Status: 'SUCCESS' } }
            : adapter === 'brevo' ? { senders: [{ domain: 'openvibe.email', active: true }] }
                : adapter === 'mailjet' ? { Data: [{ DKIMStatus: 'verified', SPFStatus: 'verified' }] }
                    : adapter === 'mailersend' ? { data: [{ name: 'openvibe.email', is_verified: true }] }
                            : adapter === 'resend' ? { data: [{ name: 'openvibe.email', status: 'verified' }] }
                                : adapter === 'smtp2go' ? { data: { domains: [{ domain: 'openvibe.email', verified: true, dkim_verified: true }] } }
                                    : adapter === 'zeptomail' ? { data: [{ domain: 'openvibe.email', verified: true }] }
                                    : { SenderSignatures: [{ FromEmail: 'sender@openvibe.email', Confirmed: true, DKIMVerified: true }] };
        const verified = await domainStatus({ route, domain: 'openvibe.email', fetchImpl: async (target) => { url = target; return response(statusReply); } });
        assert.equal(verified, true, adapter);
        assert.match(url, /^https:\/\//);
    }
    const signed = sesAuthorization({ accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'test-only', region: 'us-east-1' }, '{}');
    assert.equal(signed.host, 'email.us-east-1.amazonaws.com');
    assert.match(signed.authorization, /SignedHeaders=content-type;host;x-amz-date/);
    assert.equal(normalizeWebhook('resend', { type: 'email.bounced', to: 'bad@example.net' }).kind, 'hard_bounce');
    assert.deepEqual(normalizeWebhook('ses', { notificationType: 'Bounce', Bounce: { bouncedRecipients: [{ emailAddress: 'bad@example.net' }] } }), {
        adapter: 'ses', event: 'bounce', recipient: 'bad@example.net', messageId: null, kind: 'hard_bounce',
    });
    assert.deepEqual(normalizeWebhook('mailersend', { type: 'activity.spam_complaint', data: { recipient: 'bad@example.net' } }), {
        adapter: 'mailersend', event: 'activity.spam_complaint', recipient: 'bad@example.net', messageId: null, kind: 'complaint',
    });
    assert.equal(normalizeWebhook('resend', { type: 'email.bounced', data: { to: 'bad@example.net', email_id: 'provider-message' } }).messageId, 'provider-message');
    assert.equal(normalizeWebhook('brevo', { event: 'softBounce', email: 'slow@example.net' }).kind, 'soft_bounce');
});
