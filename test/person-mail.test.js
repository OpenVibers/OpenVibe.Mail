'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { boot } = require('./helpers/boot');
const person = require('../server/domain/person-mail');
const domains = require('../server/domain/custom-domains');
const providers = require('../server/domain/outbound-providers');
const providerDomains = require('../server/domain/provider-domains');

test('daily allowance grows with trusted history and pauses on bounce or complaint rates', () => {
    const signals = { kind: 'account', email_verified: true, verified: true, account_age_hours: 90*24, account_age_days: 90 };
    assert.equal(person.dailyLimit({ ...signals, account_age_hours: 23 }, 100), 0);
    assert.equal(person.dailyLimit({ ...signals, email_verified: false }, 100), 0);
    assert.equal(person.dailyLimit({ ...signals, account_age_days: 3 }, 0), 20);
    assert.equal(person.dailyLimit({ ...signals, account_age_days: 30 }, 20), 50);
    assert.equal(person.dailyLimit(signals, 100), 100);
    assert.match(person.paused([{ status: 'complaint' }, ...Array(9).fill({ status: 'accepted' })]), /complaint/);
    assert.match(person.paused([{ status: 'bounced' }, ...Array(9).fill({ status: 'accepted' })]), /bounced/);
    assert.equal(person.paused(Array(9).fill({ status: 'accepted' })), null);
});

test('person send checks trust, recipient cap and concurrent daily allowance', async (t) => {
    const smtp = { sendMessage: async () => ({ ok: true, code: 250 }) };
    const s = await boot({ env: { OV_OAUTH_CLIENT_SECRET: 'test-secret' }, smtp });
    t.after(() => s.close());
    const alice = s.network.addUser('alice', { ageDays: 3 });
    const made = await s.post('/api/v1/me/mail/person-addresses', { as: alice, json: { name: 'alice', kind: 'name' } });
    assert.equal(made.status, 201, made.text);
    const appToken = s.network.signJwt({ iss: s.network.url, sub: 'svc:mail-test', actor_type: 'service',
        aud: ['openvibe.mail'], cap: ['mail.addresses.write'], on_behalf_of: alice.subject,
        iat: Math.floor(Date.now()/1000), exp: Math.floor(Date.now()/1000)+300, jti: 'person-mail-app-1' });
    assert.equal((await s.post('/api/v1/me/mail/send', { bearer: appToken, json: { from: made.body.address, to: ['friend@openvibe.email'], subject: 'Hello', body: 'Hi' } })).status, 403);
    const send = (to) => s.post('/api/v1/me/mail/send', { as: alice, json: { from: made.body.address, to, subject: 'Hello', body: 'One message.' } });
    assert.equal((await send(Array.from({ length: 11 }, (_, i) => `r${i}@openvibe.email`))).status, 422);
    assert.equal((await send(Array.from({ length: 10 }, (_, i) => `a${i}@openvibe.email`))).status, 200);
    assert.equal((await send(Array.from({ length: 10 }, (_, i) => `b${i}@openvibe.email`))).status, 200);
    const over = await send(['last@openvibe.email']);
    assert.equal(over.status, 429, over.text);
    assert.match(over.body.detail, /20/);
});

test('forwarding refuses unverified targets and accepts only Network verified account emails', async (t) => {
    const s = await boot({ env: { OV_OAUTH_CLIENT_SECRET: 'test-secret' } });
    t.after(() => s.close());
    const alice = s.network.addUser('alice');
    const mask = await s.post('/api/v1/masks', { as: alice, json: { label: 'shop' } });
    assert.equal(mask.status, 201);
    const unverified = await s.post('/api/v1/me/mail/forwards', { as: alice, json: { source: mask.body.mask.address, target: 'alice@gmail.com' } });
    assert.equal(unverified.status, 422);
    s.network.state.verifiedEmails.get(alice.subject).add('alice@gmail.com');
    const verified = await s.post('/api/v1/me/mail/forwards', { as: alice, json: { source: mask.body.mask.address, target: 'alice@gmail.com' } });
    assert.equal(verified.status, 201, verified.text);
    const rows = await s.get('/api/v1/me/mail/forwards', { as: alice });
    assert.equal(rows.body.forwards.length, 1);
});

test('custom domain advances only after ownership, MX and DKIM are verified', async (t) => {
    const s = await boot({ env: { MAIL_CUSTOM_DOMAIN_MX: 'mail.openvibe.email', MAIL_PROVIDER_KEK: Buffer.alloc(32, 3).toString('base64') } });
    t.after(() => s.close());
    const alice = s.network.addUser('alice');
    await s.post('/api/v1/masks', { as: alice, json: { label: 'shop' } });
    const added = await domains.add({ db: s.db, config: s.config, owner: alice.subject, domain: 'alice.example' });
    assert.equal(added.status, 'pending_ownership');
    const token = added.dns.ownership.value;
    const lookupTxt = async (host) => host === '_openvibe-mail.alice.example' ? [[token]] : host === 's1._domainkey.alice.example' ? [['v=DKIM1; p=test']] : [];
    const lookupMx = async () => [{ exchange: 'mail.openvibe.email', priority: 10 }];
    let checked = await domains.verify({ db: s.db, config: s.config, owner: alice.subject, domain: 'alice.example', lookupTxt: async () => [], lookupMx });
    assert.equal(checked.status, 'pending_ownership');
    checked = await domains.verify({ db: s.db, config: s.config, owner: alice.subject, domain: 'alice.example', lookupTxt, lookupMx: async () => [] });
    assert.equal(checked.status, 'pending_mx');
    await providers.save({ db: s.db, config: s.config, input: { id: 'smtp_domain', name: 'SMTP', host: 'smtp.example', enabled: true, free_monthly: 100, monthly_budget: 1, password: 'secret' } });
    await providerDomains.save({ db: s.db, providerId: 'smtp_domain', input: { domain: 'alice.example', dkim_records: [{ type: 'TXT', name: 's1._domainkey.alice.example', value: 'v=DKIM1; p=test' }] } });
    checked = await domains.verify({ db: s.db, config: s.config, stalwart: { ensureDomain: async () => true }, owner: alice.subject, domain: 'alice.example', lookupTxt, lookupMx });
    assert.equal(checked.status, 'active', JSON.stringify(checked));
});
