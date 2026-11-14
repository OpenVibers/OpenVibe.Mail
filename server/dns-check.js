'use strict';

/**
 * The DNS check of a sending domain (plan §AB.18: "a DNS check row per sending domain that reads MX, SPF, DKIM,
 * DMARC (and BIMI if set) live and says which record is missing with the exact value to add").
 *
 * The check reads the live records with the resolver and never changes anything. For every record it answers one
 * line: it is there, it is missing (with the exact value to paste at the DNS host), or it is optional (BIMI).
 *
 * Where the exact value is known to the house it is given:
 *   - the MX records of a domain OpenVibe receives mail for (config.inbound.mx);
 *   - the SPF record of the sending providers a domain is configured with (the provider's own include);
 *   - the DKIM records stored for the domain (mail_outbound_domains.dkim_records);
 *   - the DMARC record OpenVibe asks for (v=DMARC1; p=none; rua=mailto:dmarc@<domain>).
 * Where it is not (a DKIM record only the provider can name), the line says where to get it instead of guessing.
 */
const dns = require('node:dns/promises');

const TXT = async (host, lookupTxt) => (await Promise.resolve(lookupTxt(host)).catch(() => [])).map((parts) => (Array.isArray(parts) ? parts.join('') : String(parts)));
const MX = async (host, lookupMx) => (await Promise.resolve(lookupMx(host)).catch(() => [])).map((record) => ({ exchange: String(record.exchange || '').toLowerCase().replace(/\.$/, ''), priority: Number(record.priority || 0) }));

/** The line of one record: it is there, it is missing, or it is optional. */
const line = (name, state, detail, add = null) => ({ name, state, detail, add });

/**
 * The check of one domain.
 *
 *   domain       the domain to read
 *   mxHosts      the MX hosts the domain should have (a domain OpenVibe receives mail for); empty: the MX is
 *                only reported, not asked for
 *   spfValue     the exact SPF record to add (null: only the provider knows it)
 *   spfIncludes  the includes the SPF record must name (the provider's own include)
 *   dkimRecords  the DKIM records stored for the domain: [{ type, name, value }]
 *   dmarcValue   the exact DMARC record to add
 */
async function checkDomain({ domain, mxHosts = [], spfValue = null, spfIncludes = [], dkimRecords = [], dmarcValue = null, lookupMx = (host) => dns.resolveMx(host), lookupTxt = (host) => dns.resolveTxt(host) } = {}) {
    const name = String(domain || '').trim().toLowerCase().replace(/\.$/, '');
    if (!name) return { ok: false, lines: [line('domain', 'missing', 'Name the domain to check first.')], message: 'Name the domain to check first.' };

    const lines = [];

    // MX: the hosts OpenVibe expects for a domain it receives mail for; otherwise the record is only reported.
    const actualMx = await MX(name, lookupMx);
    const expectedMx = (mxHosts || []).map((host) => String(host || '').toLowerCase().replace(/\.$/, '')).filter(Boolean);
    if (expectedMx.length) {
        const present = new Set(actualMx.map((record) => record.exchange));
        const missing = expectedMx.filter((host) => !present.has(host));
        if (!missing.length) lines.push(line('MX', 'ok', `MX ok: ${actualMx.map((record) => `${record.exchange} (${record.priority})`).join(', ') || expectedMx.join(', ')}`));
        else lines.push(line('MX', 'missing', `MX is missing ${missing.join(', ')}`, { type: 'MX', name, value: missing[0], priority: 10 }));
    } else {
        lines.push(line('MX', 'info', actualMx.length
            ? `MX: ${actualMx.map((record) => `${record.exchange} (${record.priority})`).join(', ')}`
            : 'MX: none (only needed if this domain should receive mail in OpenVibe)'));
    }

    // SPF: what the domain says about its sending servers.
    const txt = await TXT(name, lookupTxt);
    const spf = txt.find((value) => /^v=spf1(?:\s|$)/i.test(value));
    const wanted = (spfIncludes || []).filter(Boolean);
    const notNamed = wanted.filter((include) => !spf || !spf.includes(`include:${include}`));
    if (spf && !notNamed.length) lines.push(line('SPF', 'ok', `SPF ok: ${spf}`));
    else if (spf && notNamed.length) lines.push(line('SPF', 'missing', `SPF does not name ${notNamed.join(', ')}`, { type: 'TXT', name, value: spfValue || `v=spf1 ${wanted.map((include) => `include:${include}`).join(' ')} -all` }));
    else if (spfValue) lines.push(line('SPF', 'missing', 'SPF is missing', { type: 'TXT', name, value: spfValue }));
    else lines.push(line('SPF', 'missing', 'SPF is missing: your mail provider shows the exact record to add', { type: 'TXT', name, value: 'v=spf1 include:<your provider\'s include> -all' }));

    // DKIM: the records stored for this domain, else the provider's own record.
    const records = (dkimRecords || []).filter((record) => record && record.name && record.value);
    if (records.length) {
        for (const record of records) {
            const found = await TXT(record.name, lookupTxt);
            const there = found.some((value) => value.replace(/\s+/g, '') === String(record.value).replace(/\s+/g, ''))
                || found.some((value) => value.includes(String(record.value).split(' ')[0]));
            lines.push(there
                ? line('DKIM', 'ok', `DKIM ok: ${record.name}`)
                : line('DKIM', 'missing', `DKIM is missing for ${record.name}`, { type: record.type || 'TXT', name: record.name, value: record.value }));
        }
    } else {
        const bare = await TXT(`_domainkey.${name}`, lookupTxt);
        lines.push(bare.length
            ? line('DKIM', 'ok', 'DKIM ok: the domain key is published')
            : line('DKIM', 'missing', `DKIM is missing: ask your mail provider for its DKIM record and add it as CNAME <selector>._domainkey.${name}`, { type: 'CNAME', name: `<selector>._domainkey.${name}`, value: '<the value your provider shows>' }));
    }

    // DMARC: what to do with mail that fails SPF or DKIM, and where the reports go.
    const dmarc = await TXT(`_dmarc.${name}`, lookupTxt);
    const dmarcRecord = dmarc.find((value) => /^v=DMARC1/i.test(value));
    if (dmarcRecord) lines.push(line('DMARC', 'ok', `DMARC ok: ${dmarcRecord}`));
    else if (dmarcValue) lines.push(line('DMARC', 'missing', 'DMARC is missing', { type: 'TXT', name: `_dmarc.${name}`, value: dmarcValue }));
    else lines.push(line('DMARC', 'missing', 'DMARC is missing', { type: 'TXT', name: `_dmarc.${name}`, value: 'v=DMARC1; p=none; rua=mailto:dmarc@<your domain>' }));

    // BIMI: the logo in the inbox. Optional, so it never makes the check fail.
    const bimi = await TXT(`default._bimi.${name}`, lookupTxt);
    const bimiRecord = bimi.find((value) => /^v=BIMI1/i.test(value));
    lines.push(bimiRecord
        ? line('BIMI', 'ok', `BIMI ok: ${bimiRecord}`)
        : line('BIMI', 'optional', `BIMI is not set (optional): add TXT default._bimi.${name} → v=BIMI1; l=https://<your logo URL> to show a logo in the inbox`));

    const missing = lines.filter((item) => item.state === 'missing');
    return { ok: missing.length === 0, lines, missing, message: messageOf(lines) };
}

/**
 * The one line the guide shows: what is missing first, with the exact value to add, then what is worth knowing.
 * It stays inside the 300 characters the Setup tab keeps.
 */
function messageOf(lines) {
    const parts = [];
    for (const item of [...lines.filter((l) => l.state === 'missing'), ...lines.filter((l) => l.state !== 'missing')]) {
        const text = item.add
            ? `${item.name} missing: add ${item.add.type} ${item.add.name} → ${item.add.value}`
            : item.detail;
        if (parts.join('; ').length + text.length + 2 > 300) { parts.push('…'); break; }
        parts.push(text);
    }
    return parts.join('; ').slice(0, 300);
}

module.exports = { checkDomain, messageOf };
