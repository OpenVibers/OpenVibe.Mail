'use strict';

const crypto = require('crypto');
const { sql } = require('openvibe-sdk/db');
const adapters = require('./provider-adapters');

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
        has_credential: Boolean(row.credential_ciphertext), has_webhook_secret: Boolean(row.webhook_secret_ciphertext), secure: row.secure, starttls: row.starttls,
        enabled: row.enabled, priority: row.priority, free_monthly: row.free_monthly,
        price_per_thousand: Number(row.price_per_thousand), monthly_budget: Number(row.monthly_budget),
        free_daily: Number(row.free_daily || 0), rate_limit_per_minute: Number(row.rate_limit_per_minute || 60),
        enabled_kinds: row.enabled_kinds || ['system','person'], sent_today: Number(row.sent_today || 0),
        sent_this_month: Number(row.sent_this_month || 0), attempts_this_month: Number(row.attempts_this_month || 0),
        free_left_today: Number(row.free_daily || 0) ? Math.max(0, Number(row.free_daily) - Number(row.sent_today || 0)) : null,
        free_left_this_month: Math.max(0, Number(row.free_monthly || 0) - Number(row.sent_this_month || 0)),
        spend_this_month: Number(row.spend_this_month || 0), bounce_rate: Number(row.bounce_rate || 0), complaint_rate: Number(row.complaint_rate || 0),
        health: row.health_open_until && new Date(row.health_open_until) > new Date() ? 'open' : row.last_health === 'degraded' ? 'degraded' : 'healthy',
    };
}

function validate(input) {
    const value = input || {};
    const adapter = String(value.adapter || 'smtp');
    const allowedAdapters = ['smtp','ses','cloudflare','brevo','mailjet','mailersend','resend','smtp2go','zeptomail','postmark'];
    if (!allowedAdapters.includes(adapter)) throw new Error('Select a supported mail provider.');
    let host = String(value.host || '').trim();
    if (adapter === 'smtp' && (!/^[a-z0-9.-]{1,253}$/i.test(host) || host.startsWith('.') || host.endsWith('.'))) throw new Error('Enter a valid SMTP host.');
    if (adapter !== 'smtp' && !host) host = `${adapter}.api.invalid`;
    const settings = value.settings && typeof value.settings === 'object' && !Array.isArray(value.settings) ? value.settings : {};
    const containsCredentialKey = (value) => value && typeof value === 'object' && Object.entries(value).some(([key, item]) => /(?:token|secret|password|credential|api.?key)/i.test(key) || containsCredentialKey(item));
    if (containsCredentialKey(settings)) throw new Error('Keep credentials in the encrypted credential field.');
    if (adapter === 'cloudflare' && !/^[a-z0-9-]{3,64}$/i.test(String(settings.account_id || ''))) throw new Error('Cloudflare needs its account_id in provider settings.');
    if (adapter === 'ses' && !/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/i.test(String(settings.region || ''))) throw new Error('Amazon SES needs a valid AWS region in provider settings.');
    const port = Number(value.port || 587);
    const priority = Number(value.priority ?? 100);
    const free = Number(value.free_monthly ?? 0);
    const price = Number(value.price_per_thousand ?? 0);
    const budget = Number(value.monthly_budget ?? 0);
    const freeDaily = Number(value.free_daily ?? 0);
    const rateLimit = Number(value.rate_limit_per_minute ?? 60);
    const kinds = Array.isArray(value.enabled_kinds) ? value.enabled_kinds : ['system','person'];
    if (!Number.isInteger(port) || port < 1 || port > 65535 || !Number.isInteger(priority) || !Number.isInteger(free)
        || free < 0 || !Number.isInteger(freeDaily) || freeDaily < 0 || !Number.isInteger(rateLimit) || rateLimit < 1
        || !kinds.length || kinds.some((kind) => !['system','person'].includes(kind))
        || !Number.isFinite(price) || price < 0 || !Number.isFinite(budget) || budget < 0) throw new Error('Provider limits and prices must be non-negative numbers, and the port must be valid.');
    if ((price > 0 || value.enabled) && budget <= 0) throw new Error('Set a monthly budget cap before enabling paid outbound mail.');
    return {
        adapter,
        settings,
        id: String(value.id || `smtp_${crypto.randomUUID()}`).slice(0, 80),
        name: String(value.name || host).trim().slice(0, 100), host, port, priority, free, price, budget,
        username: value.username ? String(value.username).slice(0, 200) : null, freeDaily, rateLimit, kinds,
        secure: value.secure === true, starttls: value.starttls !== false, enabled: value.enabled === true,
    };
}

async function list(db) {
    return db.many(sql`SELECT p.*, COALESCE(u.attempts, 0) AS attempts_this_month, COALESCE(u.sent, 0) AS sent_this_month,
        COALESCE(d.attempts, 0) AS attempts_today, COALESCE(d.sent, 0) AS sent_today, COALESCE(p.health_failures,0) AS current_health_failures,
        COALESCE(u.spend,0)::numeric(12,6) AS spend_this_month,
        COALESCE(ds.bounced,0)::numeric / GREATEST(1,COALESCE(ds.delivered,0)+COALESCE(ds.bounced,0)) AS bounce_rate,
        COALESCE(ds.complaints,0)::numeric / GREATEST(1,COALESCE(ds.delivered,0)+COALESCE(ds.bounced,0)) AS complaint_rate
        FROM mail_outbound_providers p LEFT JOIN mail_outbound_usage u ON u.provider_id = p.id AND u.month = date_trunc('month', now())::date
        LEFT JOIN mail_outbound_daily_usage d ON d.provider_id = p.id AND d.day = now()::date
        LEFT JOIN (SELECT provider_id,SUM(delivered) delivered,SUM(bounced) bounced,SUM(complaints) complaints FROM mail_outbound_deliverability GROUP BY provider_id) ds ON ds.provider_id=p.id
        ORDER BY p.priority, p.id`);
}

async function save({ db, config, input }) {
    const p = validate(input);
    const secret = input && typeof input.password === 'string' ? input.password : null;
    const webhookSecret = input && typeof input.webhook_secret === 'string' ? input.webhook_secret : null;
    const existing = await db.maybe(sql`SELECT credential_ciphertext FROM mail_outbound_providers WHERE id=${p.id}`);
    if (p.adapter !== 'smtp' && p.enabled && !secret && !existing?.credential_ciphertext) throw new Error('Add the provider API credential before enabling it.');
    const key = keyFrom(config);
    if (secret !== null && secret && !key) throw new Error('MAIL_PROVIDER_KEK must be configured before adding provider credentials.');
    const encrypted = secret ? seal(secret, key) : null;
    const encryptedWebhook = webhookSecret ? seal(webhookSecret, key) : null;
    return db.exec(sql`INSERT INTO mail_outbound_providers
        (id,adapter,settings,name,host,port,username,credential_ciphertext,credential_nonce,credential_tag,webhook_secret_ciphertext,webhook_secret_nonce,webhook_secret_tag,secure,starttls,enabled,priority,free_daily,free_monthly,price_per_thousand,monthly_budget,rate_limit_per_minute,enabled_kinds)
        VALUES (${p.id},${p.adapter},${JSON.stringify(p.settings)}::jsonb,${p.name},${p.host},${p.port},${p.username},${encrypted && encrypted.ciphertext},${encrypted && encrypted.nonce},${encrypted && encrypted.tag},${encryptedWebhook && encryptedWebhook.ciphertext},${encryptedWebhook && encryptedWebhook.nonce},${encryptedWebhook && encryptedWebhook.tag},${p.secure},${p.starttls},${p.enabled},${p.priority},${p.freeDaily},${p.free},${p.price},${p.budget},${p.rateLimit},${JSON.stringify(p.kinds)}::jsonb)
        ON CONFLICT (id) DO UPDATE SET adapter=excluded.adapter,settings=excluded.settings,name=excluded.name,host=excluded.host,port=excluded.port,username=excluded.username,
        credential_ciphertext=COALESCE(excluded.credential_ciphertext,mail_outbound_providers.credential_ciphertext),
        credential_nonce=COALESCE(excluded.credential_nonce,mail_outbound_providers.credential_nonce),
        credential_tag=COALESCE(excluded.credential_tag,mail_outbound_providers.credential_tag),
        webhook_secret_ciphertext=COALESCE(excluded.webhook_secret_ciphertext,mail_outbound_providers.webhook_secret_ciphertext),
        webhook_secret_nonce=COALESCE(excluded.webhook_secret_nonce,mail_outbound_providers.webhook_secret_nonce),
        webhook_secret_tag=COALESCE(excluded.webhook_secret_tag,mail_outbound_providers.webhook_secret_tag), secure=excluded.secure,starttls=excluded.starttls,
        enabled=excluded.enabled,priority=excluded.priority,free_daily=excluded.free_daily,free_monthly=excluded.free_monthly,
        price_per_thousand=excluded.price_per_thousand,monthly_budget=excluded.monthly_budget,
        rate_limit_per_minute=excluded.rate_limit_per_minute,enabled_kinds=excluded.enabled_kinds,updated_at=now()`);
}

async function remove(db, id) {
    return db.exec(sql`DELETE FROM mail_outbound_providers WHERE id = ${String(id || '').slice(0,80)}`);
}

const monthDay = (date) => new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)).toISOString().slice(0,10);
const dayKey = (date) => new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())).toISOString().slice(0,10);

async function isSuppressed(db, address) {
    return Boolean(await db.maybe(sql`SELECT address FROM mail_outbound_suppressions WHERE address = ${String(address || '').trim().toLowerCase()}`));
}

async function deliverability(db, providerId, recipientDomain) {
    if (!recipientDomain) return { delivered: 0, bounced: 0, complaints: 0 };
    return await db.maybe(sql`SELECT delivered,bounced,complaints FROM mail_outbound_deliverability WHERE provider_id = ${providerId} AND recipient_domain = ${recipientDomain}`)
        || { delivered: 0, bounced: 0, complaints: 0 };
}

async function reserve({ db, provider, now }) {
    return db.tx(async (t) => {
        const locked = await t.maybe(sql`SELECT * FROM mail_outbound_providers WHERE id = ${provider.id} AND enabled = true FOR UPDATE`);
        if (!locked) return null;
        const halfOpen = locked.health_open_until && new Date(locked.health_open_until) <= now;
        if (locked.health_open_until && new Date(locked.health_open_until) <= now) {
            if (locked.health_probe_until && new Date(locked.health_probe_until) > now) return null;
        }
        const month = monthDay(now), day = dayKey(now), minute = new Date(Math.floor(now.getTime()/60000)*60000).toISOString();
        await t.exec(sql`INSERT INTO mail_outbound_usage (provider_id,month) VALUES (${provider.id},${month}) ON CONFLICT DO NOTHING`);
        await t.exec(sql`INSERT INTO mail_outbound_daily_usage (provider_id,day) VALUES (${provider.id},${day}) ON CONFLICT DO NOTHING`);
        await t.exec(sql`INSERT INTO mail_outbound_rate_usage (provider_id,minute_bucket) VALUES (${provider.id},${minute}) ON CONFLICT DO NOTHING`);
        await t.exec(sql`DELETE FROM mail_outbound_rate_usage WHERE provider_id=${provider.id} AND minute_bucket < ${new Date(now.getTime()-5*60_000).toISOString()}`);
        const monthly = await t.maybe(sql`SELECT attempts FROM mail_outbound_usage WHERE provider_id=${provider.id} AND month=${month}`);
        const daily = await t.maybe(sql`SELECT attempts FROM mail_outbound_daily_usage WHERE provider_id=${provider.id} AND day=${day}`);
        const rate = await t.maybe(sql`SELECT attempts FROM mail_outbound_rate_usage WHERE provider_id=${provider.id} AND minute_bucket=${minute}`);
        const monthlyAttempts = Number(monthly && monthly.attempts || 0), dailyAttempts = Number(daily && daily.attempts || 0);
        const useFree = monthlyAttempts < Number(locked.free_monthly) && (!Number(locked.free_daily) || dailyAttempts < Number(locked.free_daily));
        const paidBefore = Math.max(0, monthlyAttempts - Number(locked.free_monthly));
        const paidAfter = Math.max(0, monthlyAttempts + 1 - Number(locked.free_monthly));
        const spendAfter = paidAfter * Number(locked.price_per_thousand) / 1000;
        if (!useFree && (Number(locked.monthly_budget) <= 0 || spendAfter > Number(locked.monthly_budget))) return null;
        if (Number(rate && rate.attempts || 0) >= Number(locked.rate_limit_per_minute)) return null;
        if (halfOpen) await t.exec(sql`UPDATE mail_outbound_providers SET health_probe_until=${new Date(now.getTime()+30_000).toISOString()} WHERE id=${provider.id}`);
        await t.exec(sql`UPDATE mail_outbound_usage SET attempts=attempts+1 WHERE provider_id=${provider.id} AND month=${month}`);
        await t.exec(sql`UPDATE mail_outbound_daily_usage SET attempts=attempts+1 WHERE provider_id=${provider.id} AND day=${day}`);
        await t.exec(sql`UPDATE mail_outbound_rate_usage SET attempts=attempts+1 WHERE provider_id=${provider.id} AND minute_bucket=${minute}`);
        return { free: useFree, monthlyAttempts, dailyAttempts, paidBefore };
    });
}

async function choose({ db, config, now = new Date(), fromDomain = null, toDomain = null, toAddress = null, kind = 'person', exclude = [], fetchImpl = globalThis.fetch, lookupTxt, lookupMx }) {
    if (!config.outbound.enabled) return null;
    if (toAddress && await isSuppressed(db, toAddress)) return { suppressed: true };
    const excluded = new Set(exclude);
    const rows = await list(db);
    const candidates = [];
    for (const row of rows) {
        if (!row.enabled || excluded.has(row.id) || !(row.enabled_kinds || []).includes(kind)) continue;
        if (row.health_open_until && new Date(row.health_open_until) > now) continue;
        if (row.health_open_until && row.health_probe_until && new Date(row.health_probe_until) > now) continue;
        if (fromDomain) {
            let credential = open(row, keyFrom(config));
            try { credential = JSON.parse(credential); } catch { /* opaque provider token */ }
            const dnsConfig = await db.maybe(sql`SELECT dkim_records FROM mail_outbound_domains WHERE provider_id=${row.id} AND domain=${fromDomain}`);
            const dnsHosts = (dnsConfig && dnsConfig.dkim_records || []).filter((record) => record.type === 'TXT' && /_domainkey/i.test(record.name)).map((record) => record.name);
            const settings = { ...(row.settings || {}), ...(dnsHosts.length ? { dkim_hosts: dnsHosts } : {}) };
            const verified = await adapters.domainStatus({ route: { adapter: row.adapter, settings, password: credential }, domain: fromDomain, fetchImpl, lookupTxt, lookupMx });
            if (!verified) continue;
        }
        const metrics = await deliverability(db, row.id, toDomain);
        const deliveries = Number(metrics.delivered) + Number(metrics.bounced) + Number(metrics.complaints);
        if (deliveries >= 10 && (Number(metrics.bounced)/deliveries >= 0.1 || Number(metrics.complaints)/deliveries >= 0.01)) continue;
        candidates.push({ row, metrics, deliveries });
    }
    candidates.sort((a,b) => {
        const freeA = Number(a.row.attempts_this_month) < Number(a.row.free_monthly), freeB = Number(b.row.attempts_this_month) < Number(b.row.free_monthly);
        const dailyFreeA = !Number(a.row.free_daily) || Number(a.row.attempts_today) < Number(a.row.free_daily);
        const dailyFreeB = !Number(b.row.free_daily) || Number(b.row.attempts_today) < Number(b.row.free_daily);
        const useFreeA = freeA && dailyFreeA, useFreeB = freeB && dailyFreeB;
        if (useFreeA !== useFreeB) return useFreeA ? -1 : 1;
        if (useFreeA) return Number(a.row.attempts_this_month)/Math.max(1,Number(a.row.free_monthly)) - Number(b.row.attempts_this_month)/Math.max(1,Number(b.row.free_monthly)) || Number(a.row.priority)-Number(b.row.priority);
        return Number(a.row.price_per_thousand)-Number(b.row.price_per_thousand) || Number(a.row.priority)-Number(b.row.priority);
    });
    let selected = null;
    for (const candidate of candidates) {
        const reservation = await reserve({ db, provider: candidate.row, now });
        if (reservation) { selected = { ...candidate.row, reservation }; break; }
    }
    const row = selected;
    if (!row) return null;
    let credential = open(row, keyFrom(config));
    try { credential = JSON.parse(credential); } catch { /* token and SMTP credentials stay strings */ }
    return { kind: 'relay', adapter: row.adapter || 'smtp', settings: row.settings || {}, host: row.host, port: row.port, secure: row.secure, starttls: row.starttls,
        price_per_thousand: Number(row.price_per_thousand || 0),
        user: row.username, password: credential, timeoutMs: 20000, providerId: row.id, reservation: row.reservation };
}

async function recordOutcome({ db, providerId, to, ok, transient = false, spend = 0, now = new Date() }) {
    const month = monthDay(now), day = dayKey(now);
    await db.tx(async (t) => {
        if (ok) {
            await t.exec(sql`UPDATE mail_outbound_usage SET sent=sent+1,spend=spend+${Math.max(0,Number(spend)||0)} WHERE provider_id=${providerId} AND month=${month}`);
            await t.exec(sql`UPDATE mail_outbound_daily_usage SET sent=sent+1 WHERE provider_id=${providerId} AND day=${day}`);
            await t.exec(sql`UPDATE mail_outbound_providers SET health_failures=0,health_open_until=NULL,health_probe_until=NULL,last_health_at=${now.toISOString()},last_health='healthy' WHERE id=${providerId}`);
        } else if (transient) {
            await t.exec(sql`UPDATE mail_outbound_providers SET health_failures=health_failures+1,
                health_open_until=CASE WHEN health_failures+1 >= 3 THEN ${new Date(now.getTime()+5*60_000).toISOString()}::timestamptz ELSE health_open_until END,
                health_probe_until=NULL,last_health_at=${now.toISOString()},last_health='degraded' WHERE id=${providerId}`);
        }
    });
}

async function sendWithFailover({ db, config, from, to, message, kind = 'person', smtp, fetchImpl = globalThis.fetch, now = new Date(), lookupTxt, lookupMx }) {
    if (await isSuppressed(db, to)) return { ok: false, suppressed: true, code: 550, reason: 'This address is suppressed after a hard bounce or complaint.' };
    const domain = (value) => String(value || '').toLowerCase().split('@').pop();
    const excluded = [];
    const max = Math.min(10, (await list(db)).length);
    for (let attempt = 0; attempt < max; attempt += 1) {
        const route = await choose({ db, config, now, fromDomain: domain(from), toDomain: domain(to), toAddress: to, kind, exclude: excluded, fetchImpl, lookupTxt, lookupMx });
        if (route && route.suppressed) return { ok: false, suppressed: true, code: 550, reason: 'This address is suppressed after a hard bounce or complaint.' };
        if (!route) return { ok: false, code: 0, reason: 'No enabled provider can send from this verified domain within its free allowance, rate limit, and monthly budget.' };
        let result = route.adapter === 'smtp'
            ? await (smtp || require('../stalwart/smtp')).sendMessage(route, { from, to, message })
            : await adapters.send({ route, from, to, message, fetchImpl });
        if (route.adapter === 'smtp' && result && !result.ok) result = { ...result, transient: Number(result.code) >= 400 && Number(result.code) < 500, uncertain: !Number(result.code) };
        const spend = route.reservation && route.reservation.free ? 0 : Number(route.price_per_thousand || 0) / 1000;
        await recordOutcome({ db, providerId: route.providerId, to, ok: Boolean(result && result.ok), transient: Boolean(result && result.transient), spend, now });
        if (result && result.ok) return { ...result, route };
        if (!result || !result.transient || result.uncertain) return { ...(result || {}), ok: false, route };
        excluded.push(route.providerId);
    }
    return { ok: false, code: 0, reason: 'Every eligible provider temporarily refused this message.', transient: true };
}

module.exports = { validate, list, save, remove, choose, sendWithFailover, recordOutcome, isSuppressed, publicProvider, keyFrom, seal, open };
