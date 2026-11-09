'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createStalwartClient } = require('../server/stalwart/client');

test('Stalwart ClassifySpam receives the raw message in a non-delivering management action', async () => {
    let request;
    const client = createStalwartClient({
        config: { stalwart: { url: 'http://127.0.0.1:8080', adminUser: 'admin', adminPassword: 'fixture' } },
        fetchImpl: async (url, options) => {
            request = { url, options, body: JSON.parse(options.body) };
            return new Response(JSON.stringify({ methodResponses: [['x:Action/set', { created: { classify: { score: 6.5, result: 'spam' } } }, 'spam']] }), { status: 200 });
        },
    });
    const message = 'From: sender@example.net\r\nTo: recipient@example.net\r\nSubject: fixture\r\n\r\nMessage content';
    assert.deepEqual(await client.classifySpam({ message, from: 'sender@example.net', to: 'recipient@example.net' }), { score: 6.5, result: 'spam' });
    assert.equal(request.url, 'http://127.0.0.1:8080/jmap');
    const action = request.body.methodCalls[0][1].create.classify;
    assert.equal(action['@type'], 'ClassifySpam');
    assert.equal(action.message, message);
    assert.deepEqual(action.rcptTo, { 'recipient@example.net': true });
    assert.equal(action.remoteIp, '127.0.0.1');
});
