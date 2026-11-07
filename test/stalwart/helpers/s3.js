'use strict';

/**
 * The S3-compatible target of the integration test (MinIO in CI). AWS Signature V4 is left to curl, which every
 * runner and workstation here has; the test only needs to create the bucket and count the objects Stalwart wrote.
 */
const { execFileSync } = require('child_process');

function curl(args) {
    return execFileSync('curl', ['-sS', '--max-time', '20', '--aws-sigv4', `aws:amz:${process.env.STALWART_BLOB_REGION || 'us-east-1'}:s3`, '--user', `${process.env.STALWART_BLOB_ACCESS_KEY_ID}:${process.env.STALWART_BLOB_SECRET_KEY}`, ...args], { encoding: 'utf8' });
}

function endpoint() {
    return String(process.env.STALWART_BLOB_ENDPOINT || '').replace(/\/+$/, '');
}

function bucket() {
    return process.env.STALWART_BLOB_BUCKET;
}

function ensureBucket() {
    if (!endpoint() || !bucket()) throw new Error('STALWART_BLOB_ENDPOINT and STALWART_BLOB_BUCKET are needed');
    const status = execFileSync('curl', ['-sS', '-o', '/dev/null', '-w', '%{http_code}', '--max-time', '20', '--aws-sigv4', `aws:amz:${process.env.STALWART_BLOB_REGION || 'us-east-1'}:s3`, '--user', `${process.env.STALWART_BLOB_ACCESS_KEY_ID}:${process.env.STALWART_BLOB_SECRET_KEY}`, '-X', 'PUT', `${endpoint()}/${bucket()}`], { encoding: 'utf8' });
    // 200 created, 409 already there. Anything else is the environment, not the code, but it must be loud.
    if (!['200', '409'].includes(String(status).trim())) throw new Error(`could not create the test bucket (HTTP ${status})`);
}

function listKeys() {
    if (!endpoint() || !bucket()) return [];
    const xml = curl([`${endpoint()}/${bucket()}?list-type=2`]);
    const keys = [];
    for (const m of String(xml).matchAll(/<Key>([^<]+)<\/Key>/g)) keys.push(m[1]);
    return keys;
}

module.exports = { ensureBucket, listKeys };
