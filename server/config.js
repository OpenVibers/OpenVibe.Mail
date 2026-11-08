'use strict';

/**
 * OpenVibe.Mail's configuration: names only, values from the environment.
 *
 * Two things are worth reading twice. The mail server (Stalwart) is reached over loopback only, and the addresses
 * are split by domain: masks live on MAIL_MASK_DOMAIN, burners rotate over BURNER_DOMAINS (a new burner domain is
 * a configuration change, never a code change), and an agent's inbox is <agent>.<user>@MAIL_BASE_DOMAIN.
 */
const path = require('path');

require('dotenv').config({ path: process.env.DOTENV_PATH || path.join(__dirname, '..', '.env'), quiet: true });

/** The environment: the process's own, with whatever the caller overrides (the tests pass their own). */
let env = process.env;

function int(name, fallback) {
    const v = env[name];
    if (v === undefined || v === '') return fallback;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a whole number`);
    return n;
}

function list(name) {
    return String(env[name] || '')
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);
}

function domain(name, fallback) {
    const v = String(env[name] || fallback || '').trim().toLowerCase();
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(v)) {
        throw new Error(`${name} must be a domain name`);
    }
    return v;
}

function load(overrides = null) {
    if (overrides) env = { ...process.env, ...overrides };
    const nodeEnv = env.NODE_ENV || 'development';
    const isProduction = nodeEnv === 'production';
    const baseDomain = domain('MAIL_BASE_DOMAIN', 'openvibe.email');
    const maskDomain = domain('MAIL_MASK_DOMAIN', `mask.${baseDomain}`);
    const burnerDomains = list('BURNER_DOMAINS');
    const baseUrl = String(env.BASE_URL || `https://${baseDomain}`).replace(/\/+$/, '');

    if (isProduction && !env.DATABASE_URL) {
        throw new Error('DATABASE_URL is not set: production serves from PostgreSQL (OpenVibe.Host roles/data/add-service.sh today)');
    }
    if (isProduction && !env.STALWART_ADMIN_PASSWORD) {
        throw new Error('STALWART_ADMIN_PASSWORD is not set: the service reads and invalidates mail with it');
    }
    if (!burnerDomains.length) {
        throw new Error('BURNER_DOMAINS is empty: a burner needs a domain to live on');
    }
    for (const d of burnerDomains) {
        if (d === maskDomain || d === baseDomain) throw new Error(`BURNER_DOMAINS must not contain ${d}`);
    }

    return {
        nodeEnv,
        isProduction,
        service: 'mail',
        port: int('PORT', 5250),
        host: env.HOST || '127.0.0.1',
        baseUrl,
        trustProxy: int('TRUST_PROXY', 0),

        db: {
            url: env.DATABASE_URL || null,
            directUrl: env.DATABASE_DIRECT_URL || null,
            pgliteDir: env.MAIL_PGLITE_DIR || path.join(__dirname, '..', 'data', 'pglite'),
        },

        valkey: {
            url: env.VALKEY_URL || null,
            prefix: env.VALKEY_PREFIX || 'ov:mail:',
        },

        network: {
            url: env.OV_NETWORK_URL || 'https://openvibe.network',
            internalUrl: env.OV_NETWORK_INTERNAL_URL || 'http://127.0.0.1:4000',
            issuer: env.OV_NETWORK_ISSUER || env.OV_NETWORK_URL || 'https://openvibe.network',
            audience: env.MAIL_AUDIENCE || 'openvibe.mail',
            sessionAudience: env.OV_SESSION_AUDIENCE || 'openvibe.network',
        },

        oauth: {
            clientId: env.OV_OAUTH_CLIENT_ID || 'mail',
            clientSecret: env.OV_OAUTH_CLIENT_SECRET || '',
            redirectUri: env.OV_OAUTH_REDIRECT_URI || `${baseUrl}/auth/callback`,
            scope: env.OV_OAUTH_SCOPE || 'profile',
        },
        ai: {
            url: String(env.OV_AI_URL || 'https://ai.openvibe.services').replace(/\/+$/, ''),
            clientId: env.OV_OAUTH_CLIENT_ID || 'mail',
            clientSecret: env.OV_OAUTH_CLIENT_SECRET || '',
            timeoutMs: int('MAIL_AI_TIMEOUT_MS', 180_000),
            waitMs: int('MAIL_AI_WAIT_MS', 120_000),
        },
        cookies: {
            secure: env.COOKIE_SECURE ? env.COOKIE_SECURE === 'true' : isProduction,
        },

        addresses: {
            base: baseDomain,
            mask: maskDomain,
            burners: burnerDomains,
        },

        stalwart: {
            url: (env.STALWART_URL || 'http://127.0.0.1:8080').replace(/\/+$/, ''),
            adminUser: env.STALWART_ADMIN_USER || 'admin',
            adminPassword: env.STALWART_ADMIN_PASSWORD || '',
            requestTimeoutMs: int('STALWART_TIMEOUT_MS', 20_000),
        },

        // Where the mail server takes mail over SMTP. Our own domains (the base, the mask domain and the burner
        // domains) are delivered here, over loopback: that is how an agent's reply to one of them is sent with no
        // relay. The default is the mail server's own listener.
        localSubmission: {
            host: env.MAIL_SMTP_HOST || '127.0.0.1',
            port: int('MAIL_SMTP_PORT', 25),
        },

        // Outbound mail is not ours to send yet (plan M2: it waits on the owner for a separate mail IPv4, its PTR
        // record, and Workers Paid for the relay). MAIL_OUTBOUND=on is the only way on, and OFF is the default: with
        // it off Mail sends only to its own domains over loopback, and a reply to anyone else never opens a socket.
        outbound: {
            enabled: /^(1|true|on|yes)$/i.test(String(env.MAIL_OUTBOUND || '').trim()),
            encryptionKey: env.MAIL_PROVIDER_KEK || '',
        },

        // The outbound relay, read only when outbound is switched on. Until it exists, a reply to an address outside
        // our own domains is refused in plain words. Nothing here is printed or logged.
        relay: {
            host: env.MAIL_RELAY_HOST || '',
            port: int('MAIL_RELAY_PORT', 587),
            user: env.MAIL_RELAY_USER || '',
            password: env.MAIL_RELAY_PASSWORD || '',
            secure: env.MAIL_RELAY_SECURE === 'true',
            starttls: env.MAIL_RELAY_STARTTLS !== 'false',
        },

        // Answering (track HO6): a message at an agent's address whose switch is on is announced once. The poll is
        // due-based; `batch` is how many inboxes one run looks at, and `scan` how many recent messages of one
        // mailbox it reads (a shared mailbox holds a person's other mail too).
        agentMail: {
            intervalMs: int('MAIL_AGENT_MAIL_INTERVAL_MS', 30_000),
            batch: int('MAIL_AGENT_MAIL_BATCH', 50),
            scan: int('MAIL_AGENT_MAIL_SCAN', 100),
            leaseMs: 60_000,
        },

        events: {
            url: env.MAIL_EVENTS_URL || null,
            clientId: env.MAIL_EVENTS_CLIENT_ID || 'mail',
            clientSecret: env.MAIL_EVENTS_CLIENT_SECRET || null,
            intervalMs: int('MAIL_EVENTS_INTERVAL_MS', 5000),
        },

        limits: {
            maxMasks: int('MAIL_MAX_MASKS', 20),
            maxLiveBurners: int('MAIL_MAX_LIVE_BURNERS', 5),
            maxLiveAnonBurners: int('MAIL_MAX_LIVE_ANON_BURNERS', 2000),
            burnersPerIpHour: int('MAIL_BURNERS_PER_IP_HOUR', 10),
            anonBurnerTtlMinutes: int('MAIL_ANON_BURNER_TTL_MINUTES', 10),
            apiPerMinute: int('MAIL_API_RATE_LIMIT_PER_MIN', 240),
        },

        jobs: {
            purgeIntervalMs: int('MAIL_PURGE_INTERVAL_MS', 60_000),
            inboxAiIntervalMs: int('MAIL_INBOX_AI_INTERVAL_MS', 60_000),
        },
    };
}

module.exports = { load };
