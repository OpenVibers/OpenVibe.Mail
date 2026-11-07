#!/usr/bin/env node
'use strict';

/**
 * Render deploy/stalwart/config.toml into the two files Stalwart v1.0.3 actually consumes:
 *
 *   config.json   the data store the binary reads at boot (one small file; UPGRADING/v0_16.md)
 *   plan.json     the settings apply.js reconciles over loopback JMAP
 *
 * Nothing secret is written: the data-store password stays an EnvironmentVariable reference, and the S3 keys are
 * the *names* of environment variables that apply.js resolves in memory. M1's default blob store is the local
 * filesystem (STALWART_BLOB_STORE=fs); STALWART_BLOB_STORE=s3 keeps the B2/MinIO path available for a host that
 * wants blobs off the mail server's disk.
 *
 *   node deploy/stalwart/render.js [--config PATH] [--out DIR]
 */
const fs = require('fs');
const path = require('path');
const { parse } = require('./toml');

const ROOT = path.join(__dirname, '..', '..');

function arg(name, fallback) {
    const i = process.argv.indexOf(name);
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function required(value, what) {
    if (!value) throw new Error(`${what} is empty (see .env.example)`);
    return value;
}

function render(config, env = process.env) {
    const getEnv = (name, fallback) => {
        const v = env[name];
        return v === undefined || v === '' ? fallback : v;
    };
    const getString = (name, fallback) => String(getEnv(name, fallback)).trim();
    const getInt = (name, fallback) => {
        const v = getEnv(name, fallback);
        if (v === undefined || v === '') return fallback;
        const n = Number(v);
        if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a whole number`);
        return n;
    };
    const getBool = (name, fallback) => {
        const v = getEnv(name, fallback);
        if (v === undefined || v === '') return fallback;
        return /^(1|true|yes|on)$/i.test(String(v).trim());
    };
    const getList = (name, fallback) => {
        const v = getEnv(name, fallback);
        if (v === undefined || v === '') return fallback;
        return String(v).split(',').map((item) => item.trim().toLowerCase()).filter(Boolean);
    };
    const db = config.data_store || {};
    if (String(db.kind || '').toLowerCase() !== 'postgresql') {
        throw new Error('config.toml: data_store.kind must be "postgresql" (M1 stores mail in PostgreSQL)');
    }
    const host = getString('STALWART_DB_HOST', db.host);
    const port = getInt('STALWART_DB_PORT', db.port);
    const database = getString('STALWART_DB_NAME', db.database);
    const user = getString('STALWART_DB_USER', db.user);
    const passwordEnv = getString('STALWART_DB_PASSWORD_ENV', db.password_env || 'STALWART_DB_PASSWORD');
    required(host, 'STALWART_DB_HOST');
    required(database, 'STALWART_DB_NAME');
    required(user, 'STALWART_DB_USER');

    const dataStore = {
        '@type': 'PostgreSql',
        host,
        port,
        database,
        authUsername: user,
        authSecret: { '@type': 'EnvironmentVariable', variableName: passwordEnv },
        useTls: getBool('STALWART_DB_SSL', Boolean(db.ssl)),
        allowInvalidCerts: false,
        poolMaxConnections: getInt('STALWART_DB_POOL_MAX', db.pool_max_connections || 20),
    };

    const blob = config.blob_store || {};
    const domains = config.domains || {};
    const base = getString('MAIL_BASE_DOMAIN', domains.base);
    const mask = getString('MAIL_MASK_DOMAIN', domains.mask);
    const burners = getList('BURNER_DOMAINS', domains.burners || []);
    if (!burners.length) throw new Error('BURNER_DOMAINS is empty: a burner needs a domain to live on');

    const smtpBind = getString('STALWART_SMTP_BIND', config.listeners.smtp_bind);
    const smtpPort = getInt('STALWART_SMTP_PORT', config.listeners.smtp_port);
    const httpBind = getString('STALWART_HTTP_BIND', config.listeners.http_bind);
    const httpPort = getInt('STALWART_HTTP_PORT', config.listeners.http_port);
    const imapBind = getString('STALWART_IMAP_BIND', config.listeners.imap_bind);
    const imapPort = getInt('STALWART_IMAP_PORT', config.listeners.imap_port);

    // M1 defaults to blobs on the mail server's own disk. fs is the new default; s3 stays available (B2 in
    // production, MinIO in CI) with the existing variables.
    const blobKind = String(getString('STALWART_BLOB_STORE', blob.kind || 'fs')).toLowerCase();
    if (blobKind !== 'fs' && blobKind !== 's3') {
        throw new Error('config.toml: blob_store.kind / STALWART_BLOB_STORE must be "fs" or "s3"');
    }
    let blobStore;
    if (blobKind === 'fs') {
        blobStore = {
            kind: 'fs',
            path: getString('STALWART_BLOB_PATH', blob.path || '/var/lib/openvibe-stalwart/blobs'),
            depth: getInt('STALWART_BLOB_DEPTH', blob.depth || 2),
        };
        required(blobStore.path, 'STALWART_BLOB_PATH');
        if (blobStore.depth < 0 || blobStore.depth > 5) throw new Error('STALWART_BLOB_DEPTH must be from 0 to 5');
    } else {
        const s3 = {
            kind: 's3',
            endpoint: getString('STALWART_BLOB_ENDPOINT', blob.endpoint),
            bucket: getString('STALWART_BLOB_BUCKET', blob.bucket),
            region: getString('STALWART_BLOB_REGION', blob.region),
            accessKeyIdEnv: getString('STALWART_BLOB_ACCESS_KEY_ID_ENV', blob.access_key_id_env || 'STALWART_BLOB_ACCESS_KEY_ID'),
            secretKeyEnv: getString('STALWART_BLOB_SECRET_KEY_ENV', blob.secret_key_env || 'STALWART_BLOB_SECRET_KEY'),
            allowInvalidCerts: getBool('STALWART_BLOB_ALLOW_INVALID_CERTS', Boolean(blob.allow_invalid_certs)),
            verifyAfterWrite: getBool('STALWART_BLOB_VERIFY_AFTER_WRITE', blob.verify_after_write !== false),
            timeoutMs: getInt('STALWART_BLOB_TIMEOUT_MS', blob.timeout_ms || 30000),
            maxRetries: getInt('STALWART_BLOB_MAX_RETRIES', blob.max_retries || 3),
            keyPrefix: getString('STALWART_BLOB_KEY_PREFIX', blob.key_prefix || '') || null,
        };
        required(s3.endpoint, 'STALWART_BLOB_ENDPOINT');
        required(s3.bucket, 'STALWART_BLOB_BUCKET');
        blobStore = s3;
    }

    const directory = config.directory || {};
    const spam = config.spam || {};

    return {
        dataStore,
        plan: {
            generated_by: 'deploy/stalwart/render.js',
            version: 1,
            server: {
                default_hostname: getString('STALWART_DEFAULT_HOSTNAME', config.server.default_hostname),
            },
            domains: {
                base,
                mask,
                burners,
                all: [base, mask, ...burners],
            },
            directory: {
                description: directory.description || 'OpenVibe mail directory',
                query_recipient: directory.query_recipient,
                query_login: directory.query_login,
                query_member_of: directory.query_member_of,
                query_email_aliases: directory.query_email_aliases,
            },
            blob_store: blobStore,
            spam: {
                enabled: getBool('STALWART_SPAM_ENABLED', spam.enabled !== false),
                score_spam: Number(getString('STALWART_SPAM_SCORE', spam.score_spam || 5.0)),
            },
            listeners: [
                { name: 'smtp', protocol: 'smtp', bind: [`${smtpBind}:${smtpPort}`], use_tls: true, implicit_tls: false },
                { name: 'http', protocol: 'http', bind: [`${httpBind}:${httpPort}`], use_tls: false, implicit_tls: false },
                { name: 'imap', protocol: 'imap', bind: [`${imapBind}:${imapPort}`], use_tls: false, implicit_tls: false },
            ],
        },
    };
}

function main() {
    const configPath = path.resolve(arg('--config', path.join(__dirname, 'config.toml')));
    const outDir = path.resolve(arg('--out', process.env.STALWART_RENDER_DIR || path.join(__dirname, 'rendered')));
    const config = parse(fs.readFileSync(configPath, 'utf8'));
    const rendered = render(config);
    fs.mkdirSync(outDir, { recursive: true });
    const configOut = path.join(outDir, 'config.json');
    const planOut = path.join(outDir, 'plan.json');
    fs.writeFileSync(configOut, `${JSON.stringify(rendered.dataStore, null, 2)}\n`, { mode: 0o600 });
    fs.writeFileSync(planOut, `${JSON.stringify(rendered.plan, null, 2)}\n`, { mode: 0o600 });
    process.stdout.write(`rendered ${path.relative(ROOT, configOut)} and ${path.relative(ROOT, planOut)}\n`);
}

if (require.main === module) {
    try { main(); } catch (err) {
        process.stderr.write(`render failed: ${err && err.message ? err.message : err}\n`);
        process.exit(1);
    }
}

module.exports = { render };
