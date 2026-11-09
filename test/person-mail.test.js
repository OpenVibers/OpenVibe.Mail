'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { boot } = require('./helpers/boot');
const person = require('../server/domain/person-mail');
const domains = require('../server/domain/custom-domains');
const providers = require('../server/domain/outbound-providers');
const providerDomains = require('../server/domain/provider-domains');
const { mountPersonMail } = require('../server/http/person-routes');
const { sql } = require('openvibe-sdk/db');

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

test('Stalwart score fixtures hold borderline mail, refuse spam, send clean mail, and fail closed', async (t) => {
    const submitted = [];
    const smtp = { sendMessage: async (_route, message) => { submitted.push(message); return { ok: true, code: 250 }; } };
    const s = await boot({ env: { OV_OAUTH_CLIENT_SECRET: 'test-secret' }, smtp });
    t.after(() => s.close());
    const alice = s.network.addUser('alice', { ageDays: 3 });
    const made = await s.post('/api/v1/me/mail/person-addresses', { as: alice, json: { name: 'alice', kind: 'name' } });
    const fixtures = [
        { score: 0.2, result: 'ham', status: 'accepted' },
        { score: 7, result: 'spam', status: 'held' },
        { score: 12, result: 'spam', status: 'refused' },
    ];
    let scoreFixture;
    s.mail.classifySpam = async ({ message }) => {
        assert.match(message, /Subject: Hello/);
        return scoreFixture;
    };
    const send = (to) => s.post('/api/v1/me/mail/send', { as: alice, json: { from: made.body.address, to: [to], subject: 'Hello', body: 'Fixture text.' } });
    for (const fixture of fixtures) {
        scoreFixture = fixture;
        const result = await send(`${fixture.status}@openvibe.email`);
        assert.equal(result.body.results[0].status, fixture.status, result.text);
    }
    assert.equal(submitted.length, 1, 'held and refused fixtures never reach the delivery transport');
    assert.equal(await s.db.value("SELECT count(*) FROM mail_person_sends WHERE spam_score IS NOT NULL"), 3);
    scoreFixture = null;
    s.mail.classifySpam = async () => { throw new Error('fixture scoring outage'); };
    const failed = await send('fail-closed@openvibe.email');
    assert.equal(failed.body.results[0].status, 'scoring_failed');
    assert.match(failed.body.results[0].reason, /could not be checked/);
    assert.equal(submitted.length, 1, 'a scoring failure never reaches the delivery transport');
    assert.equal(await s.db.value("SELECT count(*) FROM mail_person_sends WHERE spam_result='error' AND spam_outcome='failed'"), 1);
});

test('owner can tune spam cutoffs and repeated holds pause sending', async (t) => {
    assert.equal(typeof mountPersonMail, 'function');
    const s = await boot();
    t.after(() => s.close());
    const owner = s.network.addUser('owner', { role: 'owner' });
    const user = s.network.addUser('regular');
    assert.equal((await s.put('/api/v1/admin/mail/spam-settings', { as: user, json: { hold_score: 4, refuse_score: 9 } })).status, 404);
    const saved = await s.put('/api/v1/admin/mail/spam-settings', { as: owner, json: { hold_score: 4, refuse_score: 9 } });
    assert.deepEqual(saved.body.spam_thresholds, { hold_score: 4, refuse_score: 9 });
    assert.equal((await s.put('/api/v1/admin/mail/spam-settings', { as: owner, json: { hold_score: 9, refuse_score: 4 } })).status, 422);
    assert.match(person.paused([...Array(9).fill({ status: 'accepted' }), { status: 'held' }]), /held/);
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

test('pending custom domains cannot squat on another owner or receive their mail', async (t) => {
    const s = await boot({ env: { MAIL_CUSTOM_DOMAIN_MX: 'mail.openvibe.email' } });
    t.after(() => s.close());
    const alice = s.network.addUser('alice');
    const bob = s.network.addUser('bob');
    const claim = (owner, domain) => domains.add({ db: s.db, config: s.config, owner: owner.subject, domain });

    const squatter = await claim(alice, 'gmail.com');
    const other = await claim(bob, 'gmail.com');
    assert.equal(squatter.status, 'pending_ownership');
    assert.equal(other.status, 'pending_ownership');
    assert.notEqual(squatter.dns.ownership.value, other.dns.ownership.value);

    const first = await claim(alice, 'shared.example');
    const second = await claim(bob, 'shared.example');
    assert.notEqual(first.dns.ownership.value, second.dns.ownership.value);
    assert.equal((await claim(alice, 'shared.example')).dns.ownership.value, first.dns.ownership.value);
    assert.equal(await s.db.value('SELECT count(*)::int FROM mail_custom_domains WHERE domain=$1', ['shared.example']), 2);

    // A stale or forged pending address must not enter Stalwart's inbound directory.
    await s.db.exec(sql`INSERT INTO mail_person_addresses(address,owner_subject,kind) VALUES('bob@shared.example',${bob.subject},'custom')`);
    assert.equal(await s.db.value('SELECT count(*)::int FROM mail_directory_accounts WHERE address=$1', ['bob@shared.example']), 0);

    const dns = { lookupTxt: async () => [[first.dns.ownership.value], [second.dns.ownership.value]],
        lookupMx: async () => [{ exchange: 'mail.openvibe.email', priority: 10 }] };
    const verified = await domains.verify({ db: s.db, config: s.config, owner: alice.subject, domain: 'shared.example', ...dns });
    assert.equal(verified.status, 'pending_dkim');
    const address = await person.createAddress({ db: s.db, config: s.config, owner: alice.subject, local: 'alice', domain: 'shared.example', kind: 'custom' });
    assert.equal(await s.db.value('SELECT owner FROM mail_directory_accounts WHERE address=$1', [address]), alice.subject);
    assert.equal(await s.db.value('SELECT count(*)::int FROM mail_directory_accounts WHERE address=$1', ['bob@shared.example']), 0);

    await assert.rejects(domains.verify({ db: s.db, config: s.config, owner: bob.subject, domain: 'shared.example', ...dns }),
        { message: 'This domain is already in use on OpenVibe.' });
    await assert.rejects(claim(bob, 'shared.example'), { message: 'This domain is already in use on OpenVibe.' });
    await assert.rejects(s.db.exec(sql`UPDATE mail_custom_domains SET ownership_verified_at=now() WHERE domain='shared.example' AND owner_subject=${bob.subject}`),
        (err) => err.code === '23505' && err.constraint === 'mail_custom_domains_verified_domain');
    assert.equal(await s.db.value('SELECT owner_subject FROM mail_custom_domains WHERE domain=$1 AND ownership_verified_at IS NOT NULL', ['shared.example']), alice.subject);
    await s.db.exec(sql`UPDATE mail_custom_domains SET dkim_verified_at=now() WHERE domain='shared.example' AND owner_subject=${alice.subject}`);
    assert.equal(await person.senderAllowed(s.db, alice.subject, address), true);
    assert.equal(await person.senderAllowed(s.db, bob.subject, 'bob@shared.example'), false);
});
