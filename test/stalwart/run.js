#!/usr/bin/env node
'use strict';

/**
 * The Stalwart acceptance run. It is separate from `npm test` because it needs the pinned binary, PostgreSQL and
 * MinIO; CI starts all three, and a workstation can use `npm run test:stalwart` after fetching the binary and
 * pointing the STALWART_* variables at them.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');

function missing() {
    const out = [];
    const bin = process.env.STALWART_BIN || path.join(ROOT, '.cache', 'stalwart', 'stalwart');
    if (!fs.existsSync(bin)) out.push(`STALWART_BIN (run: node scripts/fetch-stalwart.js)`);
    if (!process.env.STALWART_DB_PASSWORD) out.push('STALWART_DB_PASSWORD');
    for (const name of ['STALWART_BLOB_ENDPOINT', 'STALWART_BLOB_BUCKET', 'STALWART_BLOB_ACCESS_KEY_ID', 'STALWART_BLOB_SECRET_KEY']) {
        if (!process.env[name]) out.push(name);
    }
    return out;
}

const gaps = missing();
if (gaps.length) {
    process.stderr.write(`test:stalwart needs: ${gaps.join(', ')}\n`);
    process.exit(2);
}

const r = spawnSync(process.execPath, ['--test', '--test-concurrency=1', path.join(__dirname, 'integration.test.js')], {
    stdio: 'inherit',
    env: process.env,
});
process.exit(r.status === null ? 1 : r.status);
