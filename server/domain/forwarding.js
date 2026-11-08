'use strict';

const crypto = require('node:crypto');
const { sql } = require('openvibe-sdk/db');
const { cleanAddress, senderAllowed, buildMessage } = require('./person-mail');
const { mailboxAddressFor } = require('./mailboxes');
const providers = require('./outbound-providers');

async function add({ db, owner, source, target, policy }) {
    const to = cleanAddress(target);
    if (!to) throw new Error('Enter a valid forwarding address.');
    const address = source === 'all' || !source ? null : cleanAddress(source);
    if (source && source !== 'all' && !address) throw new Error('Choose one of your addresses or all mail.');
    if (address && !await senderAllowed(db, owner, address)
        && !await db.maybe(sql`SELECT 1 AS ok FROM mail_masks WHERE owner_subject=${owner} AND address=${address} AND enabled=true`)
        && !await db.maybe(sql`SELECT 1 AS ok FROM mail_agent_inboxes WHERE owner_subject=${owner} AND address=${address}`)) throw new Error('Choose one of your active addresses.');
    if (!await policy.verifiedEmail(owner, to)) throw new Error('Verify this address on your Network account before forwarding to it.');
    const mailbox = await mailboxAddressFor(db, owner);
    if (!mailbox) throw new Error('Create your mailbox before adding a forwarding rule.');
    if (to === mailbox || to === address) throw new Error('A forwarding rule cannot send mail back to itself.');
    const existing = await db.maybe(sql`SELECT id FROM mail_forward_rules WHERE owner_subject=${owner} AND source_address IS NOT DISTINCT FROM ${address} AND target_address=${to}`);
    if (existing) return existing.id;
    const id = crypto.randomUUID();
    await db.exec(sql`INSERT INTO mail_forward_rules(id,owner_subject,source_address,target_address) VALUES(${id},${owner},${address},${to})`);
    return id;
}

async function run({ db, stalwart, config, policy, smtp, fetchImpl = globalThis.fetch, limit = 100 }) {
    if (!config.outbound?.enabled) return { sent: 0 };
    const rules = await db.many(sql`SELECT r.id,r.owner_subject,r.source_address,r.target_address,m.address AS mailbox FROM mail_forward_rules r
        JOIN mail_mailboxes m ON m.owner_subject=r.owner_subject WHERE r.enabled=true ORDER BY r.created_at LIMIT ${limit}`);
    const groups = new Map();
    for (const rule of rules) {
        if (!groups.has(rule.mailbox)) groups.set(rule.mailbox, []);
        groups.get(rule.mailbox).push(rule);
    }
    let sent = 0;
    for (const [mailbox, group] of groups) {
        let page;
        try { page = await stalwart.readMessages({ mailboxAddress: mailbox, limit: 100 }); } catch { continue; }
        for (const row of page.messages || []) {
            if (row.spam) continue;
            const matching = group.filter((rule) => !rule.source_address || rule.source_address === row.to?.[0]);
            if (!matching.length) continue;
            let message;
            try { message = await stalwart.readMessage({ mailboxAddress: mailbox, id: row.id }); } catch { continue; }
            if (!message || message.spam || !message.deliveredTo || (message.attachments || []).length) continue;
            for (const rule of matching) {
                if (rule.source_address && rule.source_address !== message.deliveredTo) continue;
                if (rule.target_address === message.deliveredTo || (message.from || []).some((from) => String(from).toLowerCase().includes(rule.target_address))) continue;
                let verified = false;
                try { verified = await policy.verifiedEmail(rule.owner_subject, rule.target_address); } catch { continue; }
                if (!verified) { await db.exec(sql`UPDATE mail_forward_rules SET enabled=false WHERE id=${rule.id}`); continue; }
                const claimed = await db.maybe(sql`INSERT INTO mail_forward_deliveries(rule_id,message_id,state) VALUES(${rule.id},${message.id},'sending')
                    ON CONFLICT(rule_id,message_id) DO UPDATE SET state='sending',updated_at=now()
                    WHERE mail_forward_deliveries.state='failed' AND mail_forward_deliveries.updated_at < now()-interval '5 minutes' RETURNING rule_id`);
                if (!claimed) continue;
                const day = new Date().toISOString().slice(0,10);
                const allowance = await db.tx(async (t) => {
                    await t.exec(sql`INSERT INTO mail_forward_daily(owner_subject,day) VALUES(${rule.owner_subject},${day}) ON CONFLICT DO NOTHING`);
                    const used = await t.maybe(sql`SELECT attempts FROM mail_forward_daily WHERE owner_subject=${rule.owner_subject} AND day=${day} FOR UPDATE`);
                    if (Number(used.attempts) >= 100) return false;
                    await t.exec(sql`UPDATE mail_forward_daily SET attempts=attempts+1 WHERE owner_subject=${rule.owner_subject} AND day=${day}`);
                    return true;
                });
                if (!allowance) { await db.exec(sql`UPDATE mail_forward_deliveries SET state='failed',updated_at=now() WHERE rule_id=${rule.id} AND message_id=${message.id}`); continue; }
                const body = `Forwarded from ${String(message.from?.[0] || 'unknown sender').slice(0,180)}\n\n${String(message.text || '').slice(0,9000)}`;
                const id = crypto.randomUUID();
                let raw;
                try { raw = buildMessage({ from: mailbox, to: rule.target_address, subject: `Fwd: ${message.subject || '(no subject)'}`.slice(0,200), body, id, reportBase: config.baseUrl, now: new Date() }); }
                catch { await db.exec(sql`UPDATE mail_forward_deliveries SET state='failed',updated_at=now() WHERE rule_id=${rule.id} AND message_id=${message.id}`); continue; }
                raw = raw.replace('\r\nMIME-Version:', '\r\nAuto-Submitted: auto-forwarded\r\nMIME-Version:');
                let result;
                try { result = await providers.sendWithFailover({ db, config, from: mailbox, to: rule.target_address, message: raw, kind: 'person', smtp, fetchImpl }); }
                catch { continue; }
                if (result.ok) { await db.exec(sql`UPDATE mail_forward_deliveries SET state='sent',updated_at=now() WHERE rule_id=${rule.id} AND message_id=${message.id}`); sent++; }
                else if (!result.uncertain) await db.exec(sql`UPDATE mail_forward_deliveries SET state='failed',updated_at=now() WHERE rule_id=${rule.id} AND message_id=${message.id}`);
            }
        }
    }
    return { sent };
}

module.exports = { add, run };
