'use strict';

/**
 * The Stalwart plan: fs is M1's default blob store, s3 stays available, and apply.js turns either plan into the
 * JMAP object Stalwart expects. These tests do not need the binary or a database.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { parse } = require('../deploy/stalwart/toml');
const { render } = require('../deploy/stalwart/render');
const { blobStoreFor } = require('../deploy/stalwart/apply');

const CONFIG = parse(fs.readFileSync(path.join(__dirname, '..', 'deploy', 'stalwart', 'config.toml'), 'utf8'));
const BASE_ENV = {
    STALWART_DB_HOST: '127.0.0.1',
    STALWART_DB_NAME: 'ov_mail',
    STALWART_DB_USER: 'ov_mail',
    MAIL_BASE_DOMAIN: 'openvibe.email',
    MAIL_MASK_DOMAIN: 'mask.openvibe.email',
    BURNER_DOMAINS: 'burn1.openvibe.email',
};

test('the shipped configuration defaults to local filesystem blobs under /var/lib/openvibe-stalwart/blobs', () => {
    assert.strictEqual(CONFIG.blob_store.kind, 'fs');
    assert.strictEqual(CONFIG.blob_store.path, '/var/lib/openvibe-stalwart/blobs');

    const { plan } = render(CONFIG, BASE_ENV);
    assert.deepStrictEqual(plan.blob_store, {
        kind: 'fs',
        path: '/var/lib/openvibe-stalwart/blobs',
        depth: 2,
    });
});

test('STALWART_BLOB_STORE=fs overrides a file that says s3, and STALWART_BLOB_PATH/DEPTH are read', () => {
    const config = { ...CONFIG, blob_store: { ...CONFIG.blob_store, kind: 's3' } };
    const { plan } = render(config, {
        ...BASE_ENV,
        STALWART_BLOB_STORE: 'fs',
        STALWART_BLOB_PATH: '/srv/mail/blobs',
        STALWART_BLOB_DEPTH: '3',
    });
    assert.deepStrictEqual(plan.blob_store, { kind: 'fs', path: '/srv/mail/blobs', depth: 3 });
});

test('STALWART_BLOB_STORE=s3 keeps the existing B2/MinIO path', () => {
    const { plan } = render(CONFIG, {
        ...BASE_ENV,
        STALWART_BLOB_STORE: 's3',
        STALWART_BLOB_ENDPOINT: 'http://127.0.0.1:9000',
        STALWART_BLOB_BUCKET: 'ov-mail',
        STALWART_BLOB_REGION: 'us-east-1',
    });
    assert.strictEqual(plan.blob_store.kind, 's3');
    assert.strictEqual(plan.blob_store.endpoint, 'http://127.0.0.1:9000');
    assert.strictEqual(plan.blob_store.bucket, 'ov-mail');
    assert.strictEqual(plan.blob_store.accessKeyIdEnv, 'STALWART_BLOB_ACCESS_KEY_ID');
});

test('an unknown blob store kind is refused at render time', () => {
    assert.throws(() => render(CONFIG, { ...BASE_ENV, STALWART_BLOB_STORE: 'ftp' }), /must be "fs" or "s3"/);
    assert.throws(() => render(CONFIG, { ...BASE_ENV, STALWART_BLOB_DEPTH: '9' }), /0 to 5/);
});

test('apply.js builds the FileSystem object without asking for S3 keys', () => {
    assert.deepStrictEqual(blobStoreFor({ kind: 'fs', path: '/var/lib/openvibe-stalwart/blobs', depth: 2 }, {}), {
        '@type': 'FileSystem',
        path: '/var/lib/openvibe-stalwart/blobs',
        depth: 2,
    });
});

test('apply.js builds the S3 object from the environment, and refuses a missing key', () => {
    const blob = {
        kind: 's3',
        endpoint: 'http://127.0.0.1:9000',
        bucket: 'ov-mail',
        region: 'us-east-1',
        accessKeyIdEnv: 'STALWART_BLOB_ACCESS_KEY_ID',
        secretKeyEnv: 'STALWART_BLOB_SECRET_KEY',
        timeoutMs: 30000,
        maxRetries: 3,
        verifyAfterWrite: true,
    };
    assert.throws(() => blobStoreFor(blob, {}), /STALWART_BLOB_ACCESS_KEY_ID/);
    const object = blobStoreFor(blob, { STALWART_BLOB_ACCESS_KEY_ID: 'key', STALWART_BLOB_SECRET_KEY: 'secret' });
    assert.strictEqual(object['@type'], 'S3');
    assert.strictEqual(object.accessKeyId.value, 'key');
    assert.strictEqual(object.secretKey.secret, 'secret');
    assert.strictEqual(object.bucket, 'ov-mail');
});
