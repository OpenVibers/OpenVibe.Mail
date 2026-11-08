'use strict';

const crypto = require('node:crypto');
const dns = require('node:dns/promises');
const { sql } = require('openvibe-sdk/db');
const { validDomain } = require('./provider-domains');
const providers = require('./outbound-providers');
const adapters = require('./provider-adapters');
const { ensureOwnerMailbox } = require('./mailboxes');

const txtValues = async (host, lookupTxt) => (await lookupTxt(host).catch(() => [])).map((parts) => Array.isArray(parts) ? parts.join('') : String(parts));
const statusOf = (row) => !row.ownership_verified_at ? 'pending_ownership' : !row.mx_verified_at ? 'pending_mx' : !row.dkim_verified_at ? 'pending_dkim' : 'active';

async function add({ db, config, owner, domain: raw }) {
    const domain = validDomain(raw);
    if (domain === config.addresses.base || domain.endsWith(`.${config.addresses.base}`) || config.addresses.burners.includes(domain)) throw new Error('This domain belongs to OpenVibe.');
    const token = crypto.randomBytes(24).toString('hex');
    await db.tx((t) => ensureOwnerMailbox(t, { ownerSubject: owner, baseDomain: config.addresses.base }));
    const inserted = await db.maybe(sql`INSERT INTO mail_custom_domains(domain,owner_subject,ownership_token) VALUES(${domain},${owner},${token})
        ON CONFLICT DO NOTHING RETURNING domain`);
    if (!inserted) {
        const existing = await db.maybe(sql`SELECT owner_subject FROM mail_custom_domains WHERE domain=${domain}`);
        if (!existing || existing.owner_subject !== owner) throw new Error('This domain is already claimed.');
    }
    return get({ db, config, owner, domain });
}

async function get({ db, config, owner, domain }) {
    const row = await db.maybe(sql`SELECT domain,ownership_token,ownership_verified_at,mx_verified_at,dkim_verified_at FROM mail_custom_domains WHERE domain=${domain} AND owner_subject=${owner}`);
    if (!row) return null;
    const configured = await db.many(sql`SELECT d.provider_id,d.dkim_records,d.spf_include,p.name FROM mail_outbound_domains d JOIN mail_outbound_providers p ON p.id=d.provider_id AND p.enabled=true WHERE d.domain=${domain}`);
    return { domain, status: statusOf(row), ownership_verified: !!row.ownership_verified_at, mx_verified: !!row.mx_verified_at,
        dkim_verified: !!row.dkim_verified_at, dns: { ownership: { type: 'TXT', name: `_openvibe-mail.${domain}`, value: row.ownership_token },
            mx: (config.inbound?.mx || []).map((host, i) => ({ type: 'MX', name: domain, priority: (i+1)*10, value: host })),
            dkim: configured.flatMap((item) => item.dkim_records || []),
            spf: `v=spf1 ${[...new Set(configured.map((item) => item.spf_include).filter(Boolean))].map((host) => `include:${host}`).join(' ')} -all`.replace(/\s+/g,' ').trim() },
        providers: configured.map((item) => ({ id: item.provider_id, name: item.name })) };
}

async function verify({ db, config, stalwart, owner, domain: raw, lookupTxt = dns.resolveTxt, lookupMx = dns.resolveMx, fetchImpl = globalThis.fetch }) {
    const domain = validDomain(raw);
    const row = await db.maybe(sql`SELECT * FROM mail_custom_domains WHERE domain=${domain} AND owner_subject=${owner}`);
    if (!row) return null;
    const ownership = (await txtValues(`_openvibe-mail.${domain}`, lookupTxt)).includes(row.ownership_token);
    const expected = new Set(config.inbound?.mx || []);
    const actualMx = await lookupMx(domain).catch(() => []);
    const mx = expected.size > 0 && actualMx.length > 0 && actualMx.every((record) => expected.has(String(record.exchange || '').toLowerCase().replace(/\.$/,'')));
    let dkim = false;
    if (ownership && mx) {
        const configured = await db.many(sql`SELECT d.provider_id,d.dkim_records,p.* FROM mail_outbound_domains d JOIN mail_outbound_providers p ON p.id=d.provider_id WHERE d.domain=${domain} AND p.enabled=true`);
        for (const provider of configured) {
            const records = (provider.dkim_records || []).filter((r) => r.type === 'TXT' && /_domainkey/i.test(r.name));
            if (!records.length) continue;
            const matches = await Promise.all(records.map(async (record) => (await txtValues(record.name, lookupTxt)).includes(record.value)));
            if (!matches.every(Boolean)) continue;
            let credential = providers.open(provider, providers.keyFrom(config));
            try { credential = JSON.parse(credential); } catch { /* opaque provider token */ }
            const settings = { ...(provider.settings || {}), dkim_hosts: records.map((record) => record.name) };
            try { if (await adapters.domainStatus({ route: { adapter: provider.adapter, settings, password: credential }, domain, fetchImpl, lookupTxt, lookupMx })) { dkim = true; break; } }
            catch { /* provider status unavailable: do not enable sending */ }
        }
    }
    await db.exec(sql`UPDATE mail_custom_domains SET ownership_verified_at=CASE WHEN ${ownership} THEN COALESCE(ownership_verified_at,now()) ELSE NULL END,
        mx_verified_at=CASE WHEN ${ownership && mx} THEN COALESCE(mx_verified_at,now()) ELSE NULL END,
        dkim_verified_at=CASE WHEN ${ownership && mx && dkim} THEN COALESCE(dkim_verified_at,now()) ELSE NULL END WHERE domain=${domain} AND owner_subject=${owner}`);
    if (ownership && mx && stalwart?.ensureDomain) await stalwart.ensureDomain(domain);
    return get({ db, config, owner, domain });
}

module.exports = { add, get, verify, statusOf };
