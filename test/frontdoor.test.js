'use strict';

/**
 * The front door: CORS, the same-site session cookie, and the one listing the page reads.
 *
 * These are the rules that decide who may reach the API from a browser, and they are easy to get subtly wrong:
 * a Bearer token is fine from any first-party origin, a cookie is not; a cookie write must come from
 * openvibe.email itself; and /me/mail carries no message content.
 */
const test = require('node:test');
const assert = require('node:assert');
const contracts = require('openvibe-contracts');
const { boot } = require('./helpers/boot');

const ALLOWED = 'https://openvibe.network';
const OTHER = 'https://example.invalid';

test('CORS lets a first-party origin read the API, and refuses another', async (t) => {
    const s = await boot();
    t.after(() => s.close());

    const allowed = await s.options('/api/v1/masks', {
        headers: {
            origin: ALLOWED,
            'access-control-request-method': 'POST',
            'access-control-request-headers': 'authorization, content-type',
        },
    });
    assert.strictEqual(allowed.status, 204);
    assert.strictEqual(allowed.headers.get('access-control-allow-origin'), ALLOWED);
    assert.match(allowed.headers.get('access-control-allow-headers'), /authorization/i);
    assert.strictEqual(allowed.headers.get('access-control-allow-credentials'), null,
        'a cross-origin caller is authenticated by a Bearer token, never by the cookie');

    const refused = await s.options('/api/v1/masks', { headers: { origin: OTHER } });
    assert.strictEqual(refused.status, 204);
    assert.strictEqual(refused.headers.get('access-control-allow-origin'), null);

    const read = await s.get('/api/v1/masks', { headers: { origin: OTHER } });
    assert.strictEqual(read.status, 401);
    assert.strictEqual(read.headers.get('access-control-allow-origin'), null);
});

test('a Bearer token is accepted together with a first-party Origin', async (t) => {
    const s = await boot();
    t.after(() => s.close());
    const alice = s.network.addUser('alice');

    const made = await s.post('/api/v1/masks', {
        as: alice,
        headers: { origin: ALLOWED },
        json: { purpose: 'shopping' },
    });
    assert.strictEqual(made.status, 201);
    assert.strictEqual(made.headers.get('access-control-allow-origin'), ALLOWED);
});

test('the session cookie reads the person\'s mail, and a write must come from openvibe.email', async (t) => {
    const s = await boot();
    t.after(() => s.close());
    const alice = s.network.addUser('alice');
    const cookie = s.network.userToken(alice);

    const session = await s.get('/api/v1/masks', { cookie });
    assert.strictEqual(session.status, 200, 'the cookie is a session on openvibe.email');

    const crossSite = await s.post('/api/v1/masks', {
        cookie,
        origin: OTHER,
        secFetchSite: 'cross-site',
        json: { purpose: 'stolen' },
    });
    assert.strictEqual(crossSite.status, 403);
    assert.strictEqual(crossSite.body.code, 'mail.cross_site');

    const sameSite = await s.post('/api/v1/masks', {
        cookie,
        origin: 'https://openvibe.email',
        secFetchSite: 'same-origin',
        json: { purpose: 'mine' },
    });
    assert.strictEqual(sameSite.status, 201);

    // The fetch metadata alone is enough, even when the Origin header is not sent (same-origin GET/POST in some
    // browsers); a cross-site one is still refused.
    const metadataOnly = await s.post('/api/v1/masks', {
        cookie,
        secFetchSite: 'same-origin',
        json: { purpose: 'mine too' },
    });
    assert.strictEqual(metadataOnly.status, 201);
});

test('a bad Bearer token is not downgraded to the session cookie', async (t) => {
    const s = await boot();
    t.after(() => s.close());
    const alice = s.network.addUser('alice');
    const cookie = s.network.userToken(alice);

    const res = await s.get('/api/v1/masks', { cookie, bearer: 'not.a.token' });
    assert.strictEqual(res.status, 401);
});

test('/me/mail lists all three kinds with state and counts, and the resources are the Contracts shapes', async (t) => {
    const s = await boot();
    t.after(() => s.close());
    const alice = s.network.addUser('alice');

    const mask = (await s.post('/api/v1/masks', { as: alice, json: { purpose: 'shopping' } })).body.mask;
    const burner = (await s.post('/api/v1/burners', { as: alice, json: { expires: '1h' } })).body.burner;
    const inbox = (await s.post('/api/v1/agent-inboxes', { as: alice, json: { agent_id: 'weather' } })).body.agent_inbox;

    s.mail.deliver({ mailboxAddress: burner.address, to: burner.address, subject: 'code', text: 'Your code is 123456' });
    assert.strictEqual((await s.get(`/api/v1/burners/${burner.id}/code`, { as: alice })).status, 200,
        'reading the code observes the message for the count');

    const mine = await s.get('/api/v1/me/mail', { as: alice });
    assert.strictEqual(mine.status, 200);
    assert.strictEqual(mine.body.masks.length, 1);
    assert.strictEqual(mine.body.burners.length, 1);
    assert.strictEqual(mine.body.agent_inboxes.length, 1);
    assert.strictEqual(mine.body.counts.masks.total, 1);
    assert.strictEqual(mine.body.counts.burners.live, 1);
    assert.strictEqual(mine.body.counts.agent_inboxes.total, 1);
    assert.strictEqual(mine.body.burners[0].counts.messages, 1);

    assert.ok(contracts.validate('mail.mask@1', mine.body.masks[0].mask).valid, 'mask is mail.mask@1');
    assert.ok(contracts.validate('mail.burner@1', mine.body.burners[0].burner).valid, 'burner is mail.burner@1');
    assert.ok(contracts.validate('mail.agent-inbox@1', mine.body.agent_inboxes[0].agent_inbox).valid, 'inbox is mail.agent-inbox@1');
    assert.strictEqual(mine.body.masks[0].mask.owner, alice.subject);

    assert.strictEqual(mine.body.masks[0].state, 'active');
    assert.strictEqual(mine.body.burners[0].state, 'live');
    assert.strictEqual(mine.body.agent_inboxes[0].state, 'active');
    assert.strictEqual(mine.body.masks[0].address, mine.body.masks[0].mask.address);
    assert.strictEqual(mine.body.masks[0].purpose, 'shopping');
    assert.strictEqual(mine.body.agent_inboxes[0].purpose, null);
    assert.ok(mine.body.masks[0].mask.id && mine.body.masks[0].mask.address);
    assert.strictEqual(mask.id, mine.body.masks[0].mask.id);
    assert.strictEqual(burner.id, mine.body.burners[0].burner.id);
    assert.strictEqual(inbox.id, mine.body.agent_inboxes[0].agent_inbox.id);

    const text = JSON.stringify(mine.body);
    assert.ok(!text.includes('123456'), 'no code in the listing');
    assert.ok(!text.includes('Your code is'), 'no body in the listing');
});

test('/me/mail needs a person', async (t) => {
    const s = await boot();
    t.after(() => s.close());
    const res = await s.get('/api/v1/me/mail');
    assert.strictEqual(res.status, 401);
});

test('a mask can be given a life, and POST /masks/:id/disable turns it off', async (t) => {
    const s = await boot();
    t.after(() => s.close());
    const alice = s.network.addUser('alice');

    const made = await s.post('/api/v1/masks', { as: alice, json: { purpose: 'shop', expires_days: 7 } });
    assert.strictEqual(made.status, 201);
    assert.ok(contracts.validate('mail.mask@1', made.body.mask).valid, 'the create answer is still mail.mask@1');

    const listed = await s.get('/api/v1/me/mail', { as: alice });
    const item = listed.body.masks[0];
    assert.ok(item.expires_at, 'the listing carries the expiry');
    const days = (new Date(item.expires_at).getTime() - Date.now()) / 86400000;
    assert.ok(days > 6.9 && days <= 7, 'the expiry is seven days away');

    const off = await s.post(`/api/v1/masks/${made.body.mask.id}/disable`, { as: alice });
    assert.strictEqual(off.status, 200);
    assert.strictEqual(off.body.mask.enabled, false);
    assert.ok(s.mail.calls.invalidateCaches >= 1);

    const crossed = await s.post(`/api/v1/masks/${made.body.mask.id}/disable`, { as: alice });
    assert.strictEqual(crossed.status, 404);
});

test('expires_days is a whole number from 1 to 3650', async (t) => {
    const s = await boot();
    t.after(() => s.close());
    const alice = s.network.addUser('alice');
    for (const value of [0, -1, 1.5, 'soon', 3651]) {
        const res = await s.post('/api/v1/masks', { as: alice, json: { purpose: 'x', expires_days: value } });
        assert.strictEqual(res.status, 400, `expires_days ${value} is refused`);
        assert.strictEqual(res.body.code, 'mail.bad_expiry');
    }
});
