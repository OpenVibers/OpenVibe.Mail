'use strict';

const crypto = require('node:crypto');
const { sql } = require('openvibe-sdk/db');
const reply = require('./agent-reply');
const sending = require('./sending');
const providers = require('./outbound-providers');
const { ensureOwnerMailbox, mailboxAddressFor } = require('./mailboxes');

const ADDRESS = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}$/;
const NAME = /^[a-z][a-z0-9-]{2,31}$/;
const BLOCKED = /^(?:admin|abuse|billing|contact|help|info|mail|mailer-daemon|moderator|noreply|postmaster|root|security|support|webmaster|fuck|shit|nazi|hitler)(?:-|$)/i;

function cleanAddress(value) {
    const address = String(value || '').trim().toLowerCase();
    return address.length <= 254 && ADDRESS.test(address) ? address : null;
}
function validateName(value) {
    const name = String(value || '').trim().toLowerCase();
    if (!NAME.test(name) || BLOCKED.test(name) || name.endsWith('-') || name.includes('--')) throw new Error('Choose a name of 3–32 letters, numbers or hyphens that is not reserved.');
    return name;
}
function dailyLimit(signals, history) {
    if (!signals || signals.kind !== 'account' || !signals.email_verified || Number(signals.account_age_hours) < 24) return 0;
    if (Number(signals.account_age_days) >= 90 && signals.verified && history >= 100) return 100;
    if (Number(signals.account_age_days) >= 30 && signals.verified && history >= 20) return 50;
    return 20;
}
function paused(history) {
    const accepted = history.filter((row) => ['accepted','bounced','complaint'].includes(row.status));
    if (accepted.length < 10) return null;
    const bounced = accepted.filter((row) => row.status === 'bounced').length;
    const complaints = accepted.filter((row) => row.status === 'complaint').length;
    if (complaints / accepted.length >= 0.01) return 'Sending is paused after a complaint. Contact Mail support to review it.';
    if (bounced / accepted.length >= 0.1) return 'Sending is paused after too many bounced messages. Check your recipients and contact Mail support.';
    return null;
}
async function recentHistory(db, owner) {
    return db.many(sql`SELECT status FROM mail_person_sends WHERE owner_subject=${owner} AND created_at > now()-interval '30 days' ORDER BY created_at DESC LIMIT 100`);
}
async function createAddress({ db, config, stalwart, owner, local, domain, kind = 'alias' }) {
    const name = validateName(local);
    const host = String(domain || config.addresses.base).toLowerCase();
    if (!['name','alias','custom'].includes(kind) || (kind === 'custom') !== (host !== config.addresses.base)) throw new Error('Choose an address type that matches its domain.');
    if (host !== config.addresses.base) {
        const ready = await db.maybe(sql`SELECT 1 AS ok FROM mail_custom_domains WHERE domain=${host} AND owner_subject=${owner} AND ownership_verified_at IS NOT NULL AND mx_verified_at IS NOT NULL`);
        if (!ready) throw new Error('Verify domain ownership and MX before creating its address.');
    }
    const address = `${name}@${host}`;
    await db.tx(async (t) => {
        await ensureOwnerMailbox(t, { ownerSubject: owner, baseDomain: config.addresses.base });
        if (kind === 'name' && await t.maybe(sql`SELECT 1 AS found FROM mail_person_addresses WHERE owner_subject=${owner} AND kind='name'`)) throw new Error('You already have a named address; use an alias.');
        const count = await t.maybe(sql`SELECT count(*) AS n FROM mail_person_addresses WHERE owner_subject=${owner}`);
        if (Number(count.n) >= 20) throw new Error('You can have up to 20 personal addresses.');
        const existing = await t.maybe(sql`SELECT owner_subject FROM mail_person_addresses WHERE address=${address}`);
        if (existing) { if (existing.owner_subject !== owner) throw new Error('That address is taken.'); return; }
        for (const table of ['mail_mailboxes','mail_masks','mail_burners','mail_agent_inboxes']) {
            const other = await t.maybe(sql`SELECT 1 AS taken FROM ${sql.raw(table)} WHERE address=${address}`);
            if (other) throw new Error('That address is taken.');
        }
        await t.exec(sql`INSERT INTO mail_person_addresses(address,owner_subject,kind) VALUES(${address},${owner},${kind})`);
    });
    if (stalwart && stalwart.invalidateCaches) await stalwart.invalidateCaches();
    return address;
}

async function senderAllowed(db, owner, address) {
    const mailbox = await mailboxAddressFor(db, owner);
    if (address === mailbox) return true;
    return Boolean(await db.maybe(sql`SELECT 1 AS ok FROM mail_person_addresses p LEFT JOIN mail_custom_domains d ON d.domain=split_part(p.address,'@',2)
        AND d.owner_subject=p.owner_subject AND d.ownership_verified_at IS NOT NULL
        WHERE p.owner_subject=${owner} AND p.address=${address} AND p.enabled=true AND (p.kind<>'custom' OR d.dkim_verified_at IS NOT NULL)`));
}

function buildMessage({ from, to, subject, body, id, reportBase, now }) {
    const title = reply.headerValue(subject);
    if (title === null || !title || title.length > 200) throw new Error('A subject of at most 200 characters is required.');
    const text = String(body || '');
    if (!text.trim() || text.length > reply.MAX_BODY) throw new Error('A message body of at most 10,000 characters is required.');
    const headers = [`From: ${from}`, `To: ${to}`, `Subject: ${title}`, `Date: ${reply.rfcDate(now)}`,
        `Message-ID: <${reply.newMessageId(from.split('@')[1])}>`, `X-OpenVibe-Report-Abuse: ${reportBase}/report/${id}`,
        'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: 8bit'];
    return `${headers.join('\r\n')}\r\n\r\n${text.replace(/\r\n/g,'\n').replace(/\n/g,'\r\n')}\r\n\r\nReport unwanted mail: ${reportBase}/report/${id}`;
}

async function send({ db, config, owner, from, recipients, subject, body, policy, smtp, now = new Date(), fetchImpl = globalThis.fetch }) {
    const sender = cleanAddress(from);
    const targets = Array.isArray(recipients) ? [...new Set(recipients.map(cleanAddress))] : [];
    if (!sender || !targets.length || targets.length > 10 || targets.includes(null)) return { status: 422, code: 'mail.send.recipients', detail: 'Use 1–10 valid recipients.' };
    try { buildMessage({ from: sender, to: targets[0], subject, body, id: crypto.randomUUID(), reportBase: config.baseUrl, now }); }
    catch (err) { return { status: 422, code: 'mail.send.invalid', detail: err.message }; }
    if (!await senderAllowed(db, owner, sender)) return { status: 403, code: 'mail.send.sender', detail: 'Choose an address you own with verified sending DNS.' };
    let signals;
    try { signals = await policy.trust(owner); } catch { return { status: 503, code: 'mail.send.trust_unavailable', detail: 'Network trust checks are unavailable; try again later.' }; }
    const history = await recentHistory(db, owner);
    const limit = dailyLimit(signals, history.filter((r) => r.status === 'accepted').length);
    if (!limit) return { status: 403, code: 'mail.send.trust', detail: 'Verify your account email and wait until your account is one day old before sending.' };
    const pause = paused(history);
    if (pause) return { status: 403, code: 'mail.send.paused', detail: pause };
    const day = now.toISOString().slice(0,10);
    const reserved = await db.tx(async (t) => {
        await t.maybe(sql`SELECT owner_subject FROM mail_mailboxes WHERE owner_subject=${owner} FOR UPDATE`);
        await t.exec(sql`INSERT INTO mail_person_daily(owner_subject,day) VALUES(${owner},${day}) ON CONFLICT DO NOTHING`);
        const row = await t.maybe(sql`SELECT attempts FROM mail_person_daily WHERE owner_subject=${owner} AND day=${day} FOR UPDATE`);
        if (Number(row.attempts) + targets.length > limit) return false;
        await t.exec(sql`UPDATE mail_person_daily SET attempts=attempts+${targets.length} WHERE owner_subject=${owner} AND day=${day}`);
        return true;
    });
    if (!reserved) return { status: 429, code: 'mail.send.daily_limit', detail: `Your daily allowance is ${limit} recipients. It grows with account history.` };
    const mailer = smtp || require('../stalwart/smtp');
    const results = [];
    for (const to of targets) {
        const id = crypto.randomUUID();
        await db.exec(sql`INSERT INTO mail_person_sends(id,owner_subject,sender,recipient,status) VALUES(${id},${owner},${sender},${to},'sending')`);
        let message;
        try { message = buildMessage({ from: sender, to, subject, body, id, reportBase: config.baseUrl, now }); }
        catch (err) { await db.exec(sql`UPDATE mail_person_sends SET status='failed' WHERE id=${id}`); return { status: 422, code: 'mail.send.invalid', detail: err.message }; }
        let result;
        const route = sending.routeFor(to, config);
        try {
            if (sending.isLocal(to, config)) result = await mailer.sendMessage(route, { from: sender, to, message });
            else if (!config.outbound.enabled) result = { ok: false, reason: sending.OUTBOUND_CLOSED };
            else result = await providers.sendWithFailover({ db, config, from: sender, to, message, kind: 'person', smtp: mailer, fetchImpl, now });
        } catch { result = { ok: false, uncertain: true, reason: 'The provider response was uncertain.' }; }
        const state = result.ok ? 'accepted' : result.uncertain ? 'uncertain' : 'failed';
        await db.exec(sql`UPDATE mail_person_sends SET status=${state},provider_id=${result.route?.providerId || null},provider_message_id=${result.messageId || null} WHERE id=${id}`);
        if (result.ok) await db.exec(sql`UPDATE mail_person_daily SET accepted=accepted+1 WHERE owner_subject=${owner} AND day=${day}`);
        results.push({ id, to, status: state, reason: result.ok ? null : String(result.reason || 'The provider refused this message.').slice(0,180) });
    }
    return { status: results.every((r) => r.status === 'accepted') ? 200 : 207, results, remaining: Math.max(0,limit-(await db.maybe(sql`SELECT attempts FROM mail_person_daily WHERE owner_subject=${owner} AND day=${day}`)).attempts) };
}

module.exports = { cleanAddress, validateName, dailyLimit, paused, createAddress, senderAllowed, buildMessage, send };
