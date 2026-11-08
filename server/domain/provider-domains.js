'use strict';

const dns = require('node:dns/promises');
const { sql } = require('openvibe-sdk/db');

function validDomain(value) {
    const domain = String(value || '').trim().toLowerCase().replace(/\.$/, '');
    if (domain.length > 253 || !domain.includes('.') || !domain.split('.').every((part) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(part))) throw new Error('Enter a valid mail domain.');
    return domain;
}

function validateRecords(records) {
    if (!Array.isArray(records) || records.length > 20) throw new Error('Add no more than 20 DNS records.');
    return records.map((record) => {
        const type = String(record.type || '').toUpperCase();
        const name = String(record.name || '').trim();
        const value = String(record.value || '').trim();
        const priority = record.priority === undefined || record.priority === '' ? null : Number(record.priority);
        if (!['TXT','CNAME','MX'].includes(type) || !name || name.length > 253 || !value || value.length > 2048 || (priority !== null && (!Number.isInteger(priority) || priority < 0 || priority > 65535))) throw new Error('Each DNS record needs a valid TXT, CNAME, or MX name and value.');
        return { type, name, value, priority };
    });
}

async function save({ db, providerId, input }) {
    const domain = validDomain(input.domain);
    const records = validateRecords(input.dkim_records || []);
    const returnPath = input.return_path ? validDomain(input.return_path) : null;
    const include = input.spf_include ? String(input.spf_include).trim().toLowerCase() : null;
    if (include && !/^[a-z0-9.-]+$/.test(include)) throw new Error('The SPF include must be a DNS hostname.');
    if (!await db.maybe(sql`SELECT id FROM mail_outbound_providers WHERE id=${providerId}`)) throw new Error('Select a configured provider.');
    await db.exec(sql`INSERT INTO mail_outbound_domains(provider_id,domain,dkim_records,return_path,spf_include)
        VALUES (${providerId},${domain},${JSON.stringify(records)}::jsonb,${returnPath},${include})
        ON CONFLICT(provider_id,domain) DO UPDATE SET dkim_records=excluded.dkim_records,return_path=excluded.return_path,spf_include=excluded.spf_include,updated_at=now()`);
    return domain;
}

async function lookupCount(domain, resolveTxt = (host) => dns.resolveTxt(host), includes = []) {
    const visited = new Set();
    let count = 0;
    let uncertain = false;
    async function visit(host) {
        if (visited.has(host) || visited.size > 30) return;
        visited.add(host);
        let records;
        try { records = await resolveTxt(host); } catch { uncertain = true; return; }
        const spf = records.map((parts) => Array.isArray(parts) ? parts.join('') : String(parts)).find((record) => /^v=spf1(?:\s|$)/i.test(record));
        if (!spf) { uncertain = true; return; }
        for (const mechanism of spf.split(/\s+/).slice(1)) {
            const bare = mechanism.replace(/^[+?~-]/, '');
            const include = /^include:(.+)$/i.exec(bare);
            if (include) { count += 1; await visit(include[1]); }
            else if (/^(?:a(?:$|[:/])|mx(?:$|[:/])|exists:|redirect=)/i.test(bare)) {
                count += 1;
                if (/^redirect=/i.test(bare)) await visit(bare.slice(9));
            }
        }
    }
    count = includes.length;
    for (const include of includes) await visit(include);
    return { count, uncertain };
}

async function list({ db, domain: inputDomain, resolveTxt }) {
    const domain = validDomain(inputDomain);
    const rows = await db.many(sql`SELECT d.provider_id,p.name,p.adapter,d.domain,d.dkim_records,d.return_path,d.spf_include
        FROM mail_outbound_domains d JOIN mail_outbound_providers p ON p.id=d.provider_id
        WHERE d.domain=${domain} AND p.enabled=true ORDER BY p.priority,p.id`);
    const includes = [...new Set(rows.map((row) => row.spf_include).filter(Boolean))];
    const spf = `v=spf1 ${includes.map((item) => `include:${item}`).join(' ')} -all`;
    const count = await lookupCount(domain, resolveTxt, includes);
    return { domain, records: rows, spf, lookup_count: count.count, lookup_count_uncertain: count.uncertain, warn_before_limit: count.uncertain || count.count >= 8, lookup_limit: 10 };
}

module.exports = { validDomain, validateRecords, save, list, lookupCount };
