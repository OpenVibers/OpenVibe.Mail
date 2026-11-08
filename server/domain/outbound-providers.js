'use strict';

const crypto = require('crypto');
const { sql } = require('openvibe-sdk/db');

function keyFrom(config) {
    const key = config.outbound && config.outbound.encryptionKey;
    return key ? crypto.createHash('sha256').update(key).digest() : null;
}

function seal(secret, key) {
    if (!key) throw new Error('MAIL_PROVIDER_KEK must be set before storing provider credentials.');
    const nonce = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
    const ciphertext = Buffer.concat([cipher.update(String(secret), 'utf8'), cipher.final()]);
    return { ciphertext: ciphertext.toString('base64'), nonce: nonce.toString('base64'), tag: cipher.getAuthTag().toString('base64') };
}

function open(row, key) {
    if (!row.credential_ciphertext) return '';
    if (!key) throw new Error('MAIL_PROVIDER_KEK is not configured.');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(row.credential_nonce, 'base64'));
    decipher.setAuthTag(Buffer.from(row.credential_tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(row.credential_ciphertext, 'base64')), decipher.final()]).toString('utf8');
}

function publicProvider(row) {
    return {
        id: row.id, adapter: row.adapter || 'smtp', settings: row.settings || {}, name: row.name, host: row.host, port: row.port, username: row.username || null,
        has_credential: Boolean(row.credential_ciphertext), secure: row.secure, starttls: row.starttls,
        enabled: row.enabled, priority: row.priority, free_monthly: row.free_monthly,
        price_per_thousand: Number(row.price_per_thousand), monthly_budget: Number(row.monthly_budget),
        attempts_this_month: Number(row.attempts_this_month || 0),
    };
}

function validate(input) {
    const value = input || {};
    const host = String(value.host || '').trim();
    if (!/^[a-z0-9.-]{1,253}$/i.test(host) || host.startsWith('.') || host.endsWith('.')) throw new Error('Enter a valid SMTP host.');
    const adapter = String(value.adapter || 'smtp');
    const allowedAdapters = ['smtp','ses','cloudflare','brevo','mailjet','mailersend','resend','smtp2go','zeptomail','postmark'];
    if (!allowedAdapters.includes(adapter)) throw new Error('Select a supported mail provider.');
    const settings = value.settings && typeof value.settings === 'object' && !Array.isArray(value.settings) ? value.settings : {};
    if (/(?:token|secret|password|credential|api.?key)/i.test(JSON.stringify(Object.keys(settings)))) throw new Error('Keep credentials in the encrypted credential field.');
    if (adapter === 'cloudflare' && !/^[a-z0-9-]{3,64}$/i.test(String(settings.account_id || ''))) throw new Error('Cloudflare needs its account_id in provider settings.');
    if (adapter === 'ses' && !/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/i.test(String(settings.region || ''))) throw new Error('Amazon SES needs a valid AWS region in provider settings.');
    const port = Number(value.port || 587);
    const priority = Number(value.priority ?? 100);
    const free = Number(value.free_monthly ?? 0);
    const price = Number(value.price_per_thousand ?? 0);
    const budget = Number(value.monthly_budget ?? 0);
    if (!Number.isInteger(port) || port < 1 || port > 65535 || !Number.isInteger(priority) || !Number.isInteger(free)
        || free < 0 || !Number.isFinite(price) || price < 0 || !Number.isFinite(budget) || budget < 0) throw new Error('Provider limits and prices must be non-negative numbers, and the port must be valid.');
    if ((price > 0 || value.enabled) && budget <= 0) throw new Error('Set a monthly budget cap before enabling paid outbound mail.');
    return {
        adapter,
        settings,
        id: String(value.id || `smtp_${crypto.randomUUID()}`).slice(0, 80),
        name: String(value.name || host).trim().slice(0, 100), host, port, priority, free, price, budget,
        username: value.username ? String(value.username).slice(0, 200) : null,
        secure: value.secure === true, starttls: value.starttls !== false, enabled: value.enabled === true,
    };
}

async function list(db) {
    return db.many(sql`SELECT p.*, COALESCE(u.attempts, 0) AS attempts_this_month
        FROM mail_outbound_providers p LEFT JOIN mail_outbound_usage u ON u.provider_id = p.id AND u.month = date_trunc('month', now())::date
        ORDER BY p.priority, p.id`);
}

async function save({ db, config, input }) {
    const p = validate(input);
    const secret = input && typeof input.password === 'string' ? input.password : null;
    const key = keyFrom(config);
    if (secret !== null && secret && !key) throw new Error('MAIL_PROVIDER_KEK must be configured before adding provider credentials.');
    const encrypted = secret ? seal(secret, key) : null;
    return db.exec(sql`INSERT INTO mail_outbound_providers
        (id,adapter,settings,name,host,port,username,credential_ciphertext,credential_nonce,credential_tag,secure,starttls,enabled,priority,free_monthly,price_per_thousand,monthly_budget)
        VALUES (${p.id},${p.adapter},${JSON.stringify(p.settings)}::jsonb,${p.name},${p.host},${p.port},${p.username},${encrypted && encrypted.ciphertext},${encrypted && encrypted.nonce},${encrypted && encrypted.tag},${p.secure},${p.starttls},${p.enabled},${p.priority},${p.free},${p.price},${p.budget})
        ON CONFLICT (id) DO UPDATE SET adapter=excluded.adapter,settings=excluded.settings,name=excluded.name,host=excluded.host,port=excluded.port,username=excluded.username,
        credential_ciphertext=COALESCE(excluded.credential_ciphertext,mail_outbound_providers.credential_ciphertext),
        credential_nonce=COALESCE(excluded.credential_nonce,mail_outbound_providers.credential_nonce),
        credential_tag=COALESCE(excluded.credential_tag,mail_outbound_providers.credential_tag), secure=excluded.secure,starttls=excluded.starttls,
        enabled=excluded.enabled,priority=excluded.priority,free_monthly=excluded.free_monthly,
        price_per_thousand=excluded.price_per_thousand,monthly_budget=excluded.monthly_budget,updated_at=now()`);
}

async function remove(db, id) {
    return db.exec(sql`DELETE FROM mail_outbound_providers WHERE id = ${String(id || '').slice(0,80)}`);
}

async function choose({ db, config, now = new Date() }) {
    if (!config.outbound.enabled) return null;
    const rows = await list(db);
    const month = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString().slice(0,10);
    const eligible = rows.filter((p) => p.enabled && Number(p.attempts_this_month) < Number(p.free_monthly)
        || p.enabled && Number(p.monthly_budget) > 0
            && Math.max(0, Number(p.attempts_this_month) - Number(p.free_monthly)) * Number(p.price_per_thousand) / 1000 < Number(p.monthly_budget));
    eligible.sort((a,b) => {
        const af = Number(a.attempts_this_month) < Number(a.free_monthly), bf = Number(b.attempts_this_month) < Number(b.free_monthly);
        return Number(bf)-Number(af) || (af ? Number(a.attempts_this_month)-Number(b.attempts_this_month) || Number(a.priority)-Number(b.priority)
            : Number(a.price_per_thousand)-Number(b.price_per_thousand) || Number(a.priority)-Number(b.priority));
    });
    const row = eligible[0];
    if (!row) return null;
    await db.exec(sql`INSERT INTO mail_outbound_usage (provider_id, month, attempts) VALUES (${row.id}, ${month}, 1)
        ON CONFLICT (provider_id, month) DO UPDATE SET attempts = mail_outbound_usage.attempts + 1`);
    let credential = open(row, keyFrom(config));
    try { credential = JSON.parse(credential); } catch { /* token and SMTP credentials stay strings */ }
    return { kind: 'relay', adapter: row.adapter || 'smtp', settings: row.settings || {}, host: row.host, port: row.port, secure: row.secure, starttls: row.starttls,
        user: row.username, password: credential, timeoutMs: 20000, providerId: row.id };
}

module.exports = { validate, list, save, remove, choose, publicProvider, keyFrom, seal, open };
