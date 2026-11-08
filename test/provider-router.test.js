'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { boot } = require('./helpers/boot');
const providers = require('../server/domain/outbound-providers');

test('outbound provider settings are hidden from non-owners and secrets are write-only', async (t) => {
    const s = await boot({ env: { MAIL_PROVIDER_KEK: 'test-only-key', MAIL_OUTBOUND: 'on' } });
    t.after(() => s.close());
    const user = s.network.addUser('reader');
    const owner = s.network.addUser('owner', { role: 'owner' });
    assert.equal((await s.get('/api/v1/admin/mail/providers', { as: user })).status, 404);
    assert.equal((await s.get('/api/v1/admin/mail/domains?domain=example.com', { as: user })).status, 404);
    const saved = await s.put('/api/v1/admin/mail/providers/smtp_primary', { as: owner, json: {
        name: 'Primary SMTP', host: 'smtp.example.net', port: 587, username: 'mailer', password: 'never-return-this',
        enabled: true, free_monthly: 1000, price_per_thousand: 0.1, monthly_budget: 5,
    } });
    assert.equal(saved.status, 200, saved.text);
    assert.equal(saved.body.provider.has_credential, true);
    assert.doesNotMatch(saved.text, /never-return-this/);
    const row = (await s.db.many('SELECT * FROM mail_outbound_providers'))[0];
    assert.doesNotMatch(row.credential_ciphertext, /never-return-this/);
    assert.equal(providers.open(row, providers.keyFrom(s.config)), 'never-return-this');
    assert.equal((await s.get('/api/v1/admin/mail/providers', { as: owner })).body.providers[0].has_credential, true);
    assert.equal((await s.del('/api/v1/admin/mail/providers/smtp_primary', { as: owner })).status, 204);
});

test('router spreads free sends across providers and respects monthly budget', async (t) => {
    const s = await boot({ env: { MAIL_PROVIDER_KEK: 'test-only-key', MAIL_OUTBOUND: 'on' } });
    t.after(() => s.close());
    for (const id of ['smtp_a', 'smtp_b']) await providers.save({ db: s.db, config: s.config, input: {
        id, name: id, host: id.replace('_', '-') + '.example.net', username: 'u', password: 'p', enabled: true,
        free_monthly: 1, price_per_thousand: 1, monthly_budget: 0.001, priority: 10,
    } });
    const first = await providers.choose({ db: s.db, config: s.config });
    const second = await providers.choose({ db: s.db, config: s.config });
    assert.deepEqual([first.providerId, second.providerId].sort(), ['smtp_a', 'smtp_b']);
    assert.ok(await providers.choose({ db: s.db, config: s.config }));
    assert.ok(await providers.choose({ db: s.db, config: s.config }));
    assert.equal(await providers.choose({ db: s.db, config: s.config }), null);
});

test('router verifies From DKIM, fails over only after transient refusal, and honors shared suppression', async (t) => {
    const s = await boot({ env: { MAIL_PROVIDER_KEK: 'test-only-key', MAIL_OUTBOUND: 'on' } });
    t.after(() => s.close());
    for (const id of ['smtp_a', 'smtp_b']) await providers.save({ db: s.db, config: s.config, input: {
        id, name: id, host: id.replace('_', '-') + '.example.net', password: 'p', enabled: true,
        free_monthly: 10, monthly_budget: 1, settings: { dkim_hosts: ['selector._domainkey.{domain}'] }, priority: id === 'smtp_a' ? 1 : 2,
    } });
    const attempted = [];
    const smtp = { async sendMessage(route) { attempted.push(route.providerId); return attempted.length === 1 ? { ok: false, code: 451, transient: true, reason: 'Try again' } : { ok: true, code: 250 }; } };
    const sent = await providers.sendWithFailover({ db: s.db, config: s.config, from: 'sender@openvibe.email', to: 'person@gmail.com', message: 'From: sender@openvibe.email\r\n\r\nhello', smtp,
        lookupTxt: async () => [['v=DKIM1; p=example']], lookupMx: async () => [{ exchange: 'mx.example.net' }] });
    assert.equal(sent.ok, true);
    assert.deepEqual(attempted, ['smtp_a','smtp_b']);
    const permanent = await providers.sendWithFailover({ db: s.db, config: s.config, from: 'sender@openvibe.email', to: 'hard-bounce@gmail.com', message: 'hello', smtp: { async sendMessage(route) { attempted.push(route.providerId); return { ok: false, code: 550, reason: 'Mailbox does not exist' }; } },
        lookupTxt: async () => [['v=DKIM1; p=example']], lookupMx: async () => [{ exchange: 'mx.example.net' }] });
    assert.equal(permanent.ok, false);
    assert.equal(attempted.length, 3, 'a permanent recipient failure must not be sent through another provider');
    await s.db.exec("INSERT INTO mail_outbound_suppressions(address,reason) VALUES ('blocked@gmail.com','hard_bounce')");
    const blocked = await providers.sendWithFailover({ db: s.db, config: s.config, from: 'sender@openvibe.email', to: 'blocked@gmail.com', message: 'hello', smtp });
    assert.equal(blocked.suppressed, true);
    assert.equal(attempted.length, 3);
});

test('transient failures open the provider circuit and allow one half-open probe after cooldown', async (t) => {
    const s = await boot({ env: { MAIL_PROVIDER_KEK: 'test-only-key', MAIL_OUTBOUND: 'on' } });
    t.after(() => s.close());
    await providers.save({ db: s.db, config: s.config, input: { id: 'smtp_breaker', name: 'Breaker', host: 'smtp.example.net', password: 'p', enabled: true, free_monthly: 10, monthly_budget: 1 } });
    const start = new Date();
    for (let index = 0; index < 3; index += 1) await providers.recordOutcome({ db: s.db, providerId: 'smtp_breaker', to: 'person@gmail.com', ok: false, transient: true, now: start });
    assert.equal(await providers.choose({ db: s.db, config: s.config, now: start }), null);
    const reopened = new Date(start.getTime() + 5 * 60_000 + 1);
    assert.ok(await providers.choose({ db: s.db, config: s.config, now: reopened }));
    assert.equal(await providers.choose({ db: s.db, config: s.config, now: reopened }), null, 'only one half-open probe may run at once');
});

test('owner provider metrics report successful sends, remaining free volume and actual spend', async (t) => {
    const s = await boot({ env: { MAIL_PROVIDER_KEK: 'test-only-key', MAIL_OUTBOUND: 'on' } });
    t.after(() => s.close());
    await providers.save({ db: s.db, config: s.config, input: { id: 'smtp_metrics', name: 'Metrics', host: 'smtp.example.net', password: 'p', enabled: true, free_daily: 2, free_monthly: 1, price_per_thousand: 10, monthly_budget: 1 } });
    for (let index = 0; index < 2; index += 1) {
        const route = await providers.choose({ db: s.db, config: s.config });
        const cost = route.reservation.free ? 0 : Number(route.price_per_thousand) / 1000;
        await providers.recordOutcome({ db: s.db, providerId: route.providerId, to: 'person@gmail.com', ok: true, spend: cost });
    }
    await s.db.exec("INSERT INTO mail_outbound_deliverability(provider_id,recipient_domain,delivered,bounced,complaints) VALUES ('smtp_metrics','gmail.com',9,1,0)");
    const provider = providers.publicProvider((await providers.list(s.db))[0]);
    assert.equal(provider.sent_today, 2);
    assert.equal(provider.sent_this_month, 2);
    assert.equal(provider.free_left_today, 0);
    assert.equal(provider.free_left_this_month, 0);
    assert.equal(provider.spend_this_month, 0.01);
    assert.equal(provider.bounce_rate, 0.1);
});

test('paid provider cannot be enabled without a monthly budget cap', () => {
    assert.throws(() => providers.validate({ host: 'smtp.example.net', enabled: true, price_per_thousand: 1 }), /monthly budget cap/);
    assert.throws(() => providers.validate({ host: 'smtp.example.net', port: 70000 }), /port must be valid/);
});
