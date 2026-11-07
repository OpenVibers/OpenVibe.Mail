#!/usr/bin/env node
'use strict';

/**
 * Render deploy/stalwart/config.toml into the two files Stalwart v1.0.3 actually consumes:
 *
 *   config.json   the data store the binary reads at boot (one small file; UPGRADING/v0_16.md)
 *   plan.json     the settings apply.js reconciles over loopback JMAP
 *
 * Nothing secret is written: the data-store password stays an EnvironmentVariable reference, and the S3 keys are
 * the *names* of environment variables that apply.js resolves in memory.
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

function envString(name, fallback) {
    const v = process.env[name];
    return v === undefined || v === '' ? fallback : String(v).trim();
}

function envInt(name, fallback) {
    const v = process.env[name];
    if (v === undefined || v === '') return fallback;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a whole number`);
    return n;
}

function envBool(name, fallback) {
    const v = process.env[name];
    if (v === undefined || v === '') return fallback;
    return /^(1|true|yes|on)$/i.test(String(v).trim());
}

function envList(name, fallback) {
    const v = process.env[name];
    if (v === undefined || v === '') return fallback;
    return String(v).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}

function required(value, what) {
    if (!value) throw new Error(`${what} is empty (see .env.example)`);
    return value;
}

function render(config) {
    const db = config.data_store || {};
    if (String(db.kind || '').toLowerCase() !== 'postgresql') {
        throw new Error('config.toml: data_store.kind must be "postgresql" (M1 stores mail in PostgreSQL)');
    }
    const host = envString('STALWART_DB_HOST', db.host);
    const port = envInt('STALWART_DB_PORT', db.port);
    const database = envString('STALWART_DB_NAME', db.database);
    const user = envString('STALWART_DB_USER', db.user);
    const passwordEnv = envString('STALWART_DB_PASSWORD_ENV', db.password_env || 'STALWART_DB_PASSWORD');
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
        useTls: envBool('STALWART_DB_SSL', Boolean(db.ssl)),
        allowInvalidCerts: false,
        poolMaxConnections: envInt('STALWART_DB_POOL_MAX', db.pool_max_connections || 20),
    };

    const blob = config.blob_store || {};
    const domains = config.domains || {};
    const base = envString('MAIL_BASE_DOMAIN', domains.base);
    const mask = envString('MAIL_MASK_DOMAIN', domains.mask);
    const burners = envList('BURNER_DOMAINS', domains.burners || []);
    if (!burners.length) throw new Error('BURNER_DOMAINS is empty: a burner needs a domain to live on');

    const smtpBind = envString('STALWART_SMTP_BIND', config.listeners.smtp_bind);
    const smtpPort = envInt('STALWART_SMTP_PORT', config.listeners.smtp_port);
    const httpBind = envString('STALWART_HTTP_BIND', config.listeners.http_bind);
    const httpPort = envInt('STALWART_HTTP_PORT', config.listeners.http_port);
    const imapBind = envString('STALWART_IMAP_BIND', config.listeners.imap_bind);
    const imapPort = envInt('STALWART_IMAP_PORT', config.listeners.imap_port);

    const blobStore = {
        kind: String(blob.kind || '').toLowerCase(),
        endpoint: envString('STALWART_BLOB_ENDPOINT', blob.endpoint),
        bucket: envString('STALWART_BLOB_BUCKET', blob.bucket),
        region: envString('STALWART_BLOB_REGION', blob.region),
        accessKeyIdEnv: envString('STALWART_BLOB_ACCESS_KEY_ID_ENV', blob.access_key_id_env || 'STALWART_BLOB_ACCESS_KEY_ID'),
        secretKeyEnv: envString('STALWART_BLOB_SECRET_KEY_ENV', blob.secret_key_env || 'STALWART_BLOB_SECRET_KEY'),
        allowInvalidCerts: envBool('STALWART_BLOB_ALLOW_INVALID_CERTS', Boolean(blob.allow_invalid_certs)),
        verifyAfterWrite: envBool('STALWART_BLOB_VERIFY_AFTER_WRITE', blob.verify_after_write !== false),
        timeoutMs: envInt('STALWART_BLOB_TIMEOUT_MS', blob.timeout_ms || 30000),
        maxRetries: envInt('STALWART_BLOB_MAX_RETRIES', blob.max_retries || 3),
        keyPrefix: envString('STALWART_BLOB_KEY_PREFIX', blob.key_prefix || '') || null,
    };
    if (blobStore.kind !== 's3') throw new Error('config.toml: blob_store.kind must be "s3" (B2 in production)');
    required(blobStore.endpoint, 'STALWART_BLOB_ENDPOINT');
    required(blobStore.bucket, 'STALWART_BLOB_BUCKET');

    const directory = config.directory || {};
    const spam = config.spam || {};

    return {
        dataStore,
        plan: {
            generated_by: 'deploy/stalwart/render.js',
            version: 1,
            server: {
                default_hostname: envString('STALWART_DEFAULT_HOSTNAME', config.server.default_hostname),
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
                enabled: envBool('STALWART_SPAM_ENABLED', spam.enabled !== false),
                score_spam: Number(envString('STALWART_SPAM_SCORE', spam.score_spam || 5.0)),
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
