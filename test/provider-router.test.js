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

test('paid provider cannot be enabled without a monthly budget cap', () => {
    assert.throws(() => providers.validate({ host: 'smtp.example.net', enabled: true, price_per_thousand: 1 }), /monthly budget cap/);
    assert.throws(() => providers.validate({ host: 'smtp.example.net', port: 70000 }), /port must be valid/);
});
