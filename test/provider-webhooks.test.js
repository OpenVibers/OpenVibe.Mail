'use strict';
const fs = require('fs');

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { boot } = require('./helpers/boot');
const providers = require('../server/domain/outbound-providers');
const webhooks = require('../server/domain/provider-webhooks');
const domains = require('../server/domain/provider-domains');

test('Resend webhook signatures are timestamped and checked against the raw body', () => {
    const secret = `whsec_${Buffer.from('test-hook-secret').toString('base64')}`;
    const raw = JSON.stringify({ type: 'email.bounced' });
    const id = 'msg-hook-1', timestamp = String(Math.floor(Date.now() / 1000));
    const signature = crypto.createHmac('sha256', Buffer.from(secret.slice(6), 'base64')).update(`${id}.${timestamp}.${raw}`).digest('base64');
    const headers = { 'svix-id': id, 'svix-timestamp': timestamp, 'svix-signature': `v1,${signature}` };
    assert.equal(webhooks.verifyResend(secret, raw, headers), true);
    assert.equal(webhooks.verifyResend(secret, raw + ' ', headers), false);
    assert.equal(webhooks.verifyResend(secret, raw, { ...headers, 'svix-timestamp': '1' }), false);
});

test('SES SNS signatures require the configured topic and a trusted SNS certificate URL', async () => {
    const pair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const payload = { Type: 'Notification', Message: 'example', MessageId: 'm-1', Timestamp: '2026-11-08T12:00:00Z', TopicArn: 'arn:aws:sns:us-east-1:123456789012:mail', SignatureVersion: '2', SigningCertURL: 'https://sns.us-east-1.amazonaws.com/SimpleNotificationService-abcd.pem' };
    payload.Signature = crypto.sign('RSA-SHA256', Buffer.from(webhooks.snsCanonical(payload)), pair.privateKey).toString('base64');
    const fetchImpl = async () => ({ ok: true, text: async () => pair.publicKey.export({ type: 'spki', format: 'pem' }) });
    assert.equal(await webhooks.verifySes('', payload, fetchImpl, payload.TopicArn), true);
    assert.equal(await webhooks.verifySes('', payload, fetchImpl, 'arn:aws:sns:elsewhere'), false);
    assert.equal(await webhooks.verifySes('', { ...payload, SigningCertURL: 'https://example.net/cert.pem' }, fetchImpl, payload.TopicArn), false);
});

test('provider webhook authentication uses documented signatures or shared credentials', async () => {
    const rawBody = Buffer.from('{"event":"bounce"}');
    const signature = crypto.createHmac('sha256', 'mailersend-hook').update(rawBody).digest('hex');
    assert.equal(await webhooks.verify({ adapter: 'mailersend', secret: 'mailersend-hook', payload: {}, rawBody, headers: { signature } }), true);
    assert.equal(await webhooks.verify({ adapter: 'mailjet', secret: 'user:pass', payload: {}, rawBody, headers: { authorization: `Basic ${Buffer.from('user:pass').toString('base64')}` } }), true);
    assert.equal(await webhooks.verify({ adapter: 'brevo', secret: 'owner-shared-secret', payload: {}, rawBody, headers: { 'x-mail-webhook-secret': 'owner-shared-secret' } }), true);
    assert.equal(await webhooks.verify({ adapter: 'brevo', secret: 'owner-shared-secret', payload: {}, rawBody, headers: {} }), false);
});

test('verified provider webhook events are idempotent, update domain health and suppress shared hard bounces', async (t) => {
    const s = await boot({ env: { MAIL_PROVIDER_KEK: 'test-only-key', MAIL_OUTBOUND: 'on' } });
    t.after(() => s.close());
    const secret = `whsec_${Buffer.from('test-hook-secret').toString('base64')}`;
    await providers.save({ db: s.db, config: s.config, input: { id: 'resend_test', adapter: 'resend', name: 'Resend test', host: 'api.resend.com', password: 'send-token', webhook_secret: secret, enabled: true, free_monthly: 100, monthly_budget: 1 } });
    const payload = { id: 'event-1', type: 'email.bounced', data: { to: ['blocked@gmail.com'] } };
    const rawBody = Buffer.from(JSON.stringify(payload));
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = crypto.createHmac('sha256', Buffer.from(secret.slice(6), 'base64')).update(`evt_1.${timestamp}.${rawBody}`).digest('base64');
    const args = { db: s.db, config: s.config, providerId: 'resend_test', payload, rawBody, headers: { 'svix-id': 'evt_1', 'svix-timestamp': timestamp, 'svix-signature': `v1,${signature}` } };
    const stored = (await providers.list(s.db))[0];
    assert.equal(providers.open({ ...stored, credential_ciphertext: stored.webhook_secret_ciphertext, credential_nonce: stored.webhook_secret_nonce, credential_tag: stored.webhook_secret_tag }, providers.keyFrom(s.config)), secret);
    assert.equal(await webhooks.verify({ adapter: 'resend', secret, payload, rawBody, headers: args.headers }), true);
    assert.equal((await webhooks.handle(args)).status, 200);
    assert.equal(await providers.isSuppressed(s.db, 'blocked@gmail.com'), true);
    assert.equal((await webhooks.handle(args)).body.duplicates, 1);
    const row = await s.db.maybe("SELECT bounced FROM mail_outbound_deliverability WHERE provider_id='resend_test' AND recipient_domain='gmail.com'");
    assert.equal(Number(row.bounced), 1);
    assert.equal((await webhooks.handle({ ...args, headers: { ...args.headers, 'svix-signature': 'v1,wrong' } })).status, 401);
});

test('SPF calculation counts provider includes and nested DNS lookups', async () => {
    const result = await domains.lookupCount('example.com', async (host) => host === 'spf.one.test'
        ? [['v=spf1 include:spf.nested.test mx ~all']]
        : host === 'spf.nested.test' ? [['v=spf1 a -all']] : [['v=spf1 -all']], ['spf.one.test', 'spf.two.test']);
    assert.equal(result.count, 5);
    assert.equal(result.uncertain, false);
    assert.throws(() => domains.validDomain('bad domain'), /valid mail domain/);
});

test('owner domain records are saved with return-path and generated SPF inputs', async (t) => {
    const s = await boot({ env: { MAIL_PROVIDER_KEK: 'test-only-key', MAIL_OUTBOUND: 'on' } });
    t.after(() => s.close());
    await providers.save({ db: s.db, config: s.config, input: { id: 'ses_domain', adapter: 'ses', name: 'SES', host: '', password: JSON.stringify({ accessKeyId: 'key', secretAccessKey: 'secret', region: 'us-east-1' }), settings: { region: 'us-east-1' }, enabled: true, free_monthly: 100, monthly_budget: 1 } });
    await domains.save({ db: s.db, providerId: 'ses_domain', input: { domain: 'example.com', dkim_records: [{ type: 'TXT', name: 'selector._domainkey.example.com', value: 'v=DKIM1; p=public' }], return_path: 'bounce.example.com', spf_include: 'spf.provider.test' } });
    const data = await domains.list({ db: s.db, domain: 'example.com', resolveTxt: async (host) => host === 'spf.provider.test' ? [['v=spf1 a -all']] : [] });
    assert.equal(data.spf, 'v=spf1 include:spf.provider.test -all');
    assert.equal(data.lookup_count, 2);
    assert.equal(data.lookup_count_uncertain, false);
    assert.equal(data.records[0].return_path, 'bounce.example.com');
    assert.equal(data.records[0].dkim_records[0].name, 'selector._domainkey.example.com');
});

test('SNS posts text/plain, and a subscription is confirmed only at Amazon SNS for the same topic', async () => {
    const app = fs.readFileSync(require('path').join(__dirname, '..', 'server', 'app.js'), 'utf8');
    assert.match(app, /provider-webhooks', express\.json\(\{ type: \['application\/json', 'text\/plain'\]/);
    const topic = 'arn:aws:sns:us-east-1:123456789012:mail';
    const good = { Type: 'SubscriptionConfirmation', TopicArn: topic, SubscribeURL: `https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription&TopicArn=${encodeURIComponent(topic)}&Token=abc` };
    assert.ok(webhooks.snsConfirmUrl(good));
    assert.equal(webhooks.snsConfirmUrl({ ...good, SubscribeURL: 'https://sns.us-east-1.amazonaws.com.evil.example/?Action=ConfirmSubscription' }), null);
    assert.equal(webhooks.snsConfirmUrl({ ...good, SubscribeURL: 'http://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription&TopicArn=' + encodeURIComponent(topic) }), null);
    assert.equal(webhooks.snsConfirmUrl({ ...good, SubscribeURL: good.SubscribeURL.replace('mail', 'other') }), null);
    assert.equal(webhooks.snsConfirmUrl({ ...good, Type: 'Notification' }), null);
    const asked = [];
    assert.equal(await webhooks.confirmSnsSubscription(good, async (url, opts) => { asked.push([url, opts.redirect]); return { ok: true }; }), true);
    assert.deepEqual(asked.map(([, r]) => r), ['error']);
    assert.equal(await webhooks.confirmSnsSubscription({ ...good, SubscribeURL: 'https://127.0.0.1/?Action=ConfirmSubscription' }, async () => { throw new Error('must not fetch'); }), false);
});
