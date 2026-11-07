#!/usr/bin/env node
'use strict';

/**
 * Download the pinned Stalwart Community binary and verify the sha256 in deploy/stalwart/VERSION.
 *
 *   node scripts/fetch-stalwart.js [--force]
 *
 * CI runs this before `npm run test:stalwart`; a workstation can run it once and then keep it in .cache/stalwart.
 */
const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const CACHE = path.join(ROOT, '.cache', 'stalwart');

function readVersion() {
    const text = fs.readFileSync(path.join(ROOT, 'deploy', 'stalwart', 'VERSION'), 'utf8');
    const out = {};
    for (const line of text.split(/\r?\n/)) {
        const m = /^([a-z0-9_]+)=(.*)$/.exec(line.trim());
        if (m) out[m[1]] = m[2];
    }
    for (const key of ['version', 'asset', 'sha256', 'url']) {
        if (!out[key]) throw new Error(`deploy/stalwart/VERSION has no ${key}`);
    }
    if (!/^[0-9a-f]{64}$/.test(out.sha256)) throw new Error('deploy/stalwart/VERSION sha256 is not 64 hex characters');
    return out;
}

function download(url, to, redirects = 0) {
    return new Promise((resolve, reject) => {
        https.get(url, { headers: { 'user-agent': 'openvibe-mail-ci' } }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                res.resume();
                if (redirects > 5) return reject(new Error('too many redirects'));
                return download(res.headers.location, to, redirects + 1).then(resolve, reject);
            }
            if (res.statusCode !== 200) {
                res.resume();
                return reject(new Error(`download failed: HTTP ${res.statusCode} ${url}`));
            }
            const file = fs.createWriteStream(to, { mode: 0o600 });
            res.pipe(file);
            file.on('finish', () => file.close(resolve));
            file.on('error', reject);
        }).on('error', reject);
    });
}

function sha256(file) {
    const hash = crypto.createHash('sha256');
    hash.update(fs.readFileSync(file));
    return hash.digest('hex');
}

async function main() {
    const version = readVersion();
    const binary = path.join(CACHE, 'stalwart');
    const archive = path.join(CACHE, version.asset);
    if (process.argv.includes('--force') === false && fs.existsSync(binary)) {
        process.stdout.write(`Stalwart ${version.version} already at ${path.relative(ROOT, binary)}\n`);
        return;
    }
    fs.mkdirSync(CACHE, { recursive: true });
    await download(version.url, archive);
    const actual = sha256(archive);
    if (actual !== version.sha256) {
        fs.rmSync(archive, { force: true });
        throw new Error(`sha256 mismatch: expected ${version.sha256}, got ${actual}`);
    }
    execFileSync('tar', ['-xzf', archive, '-C', CACHE]);
    fs.chmodSync(binary, 0o755);
    process.stdout.write(`Stalwart ${version.version} verified (${version.sha256}) at ${path.relative(ROOT, binary)}\n`);
}

if (require.main === module) {
    main().catch((err) => { process.stderr.write(`fetch-stalwart: ${err.message}\n`); process.exit(1); });
}

module.exports = { readVersion, sha256 };
