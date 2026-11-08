'use strict';

const { sql } = require('openvibe-sdk/db');
const { mailboxAddressFor } = require('../domain/mailboxes');
const { createInboxAnalyzer } = require('../ai/inbox');
const { matchedRule } = require('../domain/inbox-ai-rules');
const { randomUUID } = require('node:crypto');

const LEASE_KEY = 'inbox_ai_lease';
const LEASE_MS = 60_000;

async function takeLease(db, now = Date.now()) {
    return db.maybe(sql`
        INSERT INTO mail_settings (key, value, updated_at)
        VALUES (${LEASE_KEY}, ${new Date(now).toISOString()}, now())
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
        WHERE mail_settings.updated_at < now() - (${LEASE_MS} * interval '1 millisecond')
        RETURNING value`);
}

async function runInboxAi({ db, stalwart, analyze, log = console, now = () => Date.now() }) {
    const stats = { mailboxes: 0, triaged: 0, skipped: false };
    const lease = await db.tx((t) => takeLease(t, now()));
    if (!lease) return { ...stats, skipped: true };
    const owners = await db.many(sql`SELECT owner_subject FROM mail_inbox_ai_consent WHERE enabled = true ORDER BY changed_at`);
    stats.mailboxes = owners.length;
    if (!analyze) return { ...stats, skipped: true };
    for (const { owner_subject: owner } of owners) {
        try {
            const mailbox = await mailboxAddressFor(db, owner);
            if (!mailbox) continue;
            const page = await stalwart.readMessages({ mailboxAddress: mailbox, limit: 100 });
            const messages = new Map();
            for (const message of page.messages) {
                const threadId = String(message.threadId || message.id);
                if (!messages.has(threadId) && !message.spam) messages.set(threadId, message);
            }
            for (const [threadId, message] of messages) {
                const exists = await db.maybe(sql`SELECT 1 AS found FROM mail_inbox_ai_threads WHERE owner_subject = ${owner} AND thread_id = ${threadId}`);
                if (exists) continue;
                const full = await stalwart.readMessage({ mailboxAddress: mailbox, id: message.id });
                if (!full) continue;
                const triage = await analyze({ owner, message: { ...message, text: full.text || '' } });
                if (!triage) continue;
                const rule = await matchedRule(db, owner, message);
                const previousCategory = triage.category;
                if (rule) triage.category = rule.category;
                const sender = (message.from || [])[0];
                const draft = triage.category === 'needs_reply' && sender
                    ? { to: sender, subject: /^re:/i.test(message.subject || '') ? message.subject : `Re: ${message.subject || ''}`, body: triage.draft }
                    : null;
                await db.tx(async (t) => {
                    await t.exec(sql`
                    INSERT INTO mail_inbox_ai_threads
                        (owner_subject, thread_id, message_id, sender, subject, category, summary, draft_to, draft_subject, draft_body, received_at)
                    VALUES (${owner}, ${threadId}, ${message.id}, ${sender}, ${message.subject || null}, ${triage.category}, ${triage.summary},
                        ${draft && draft.to}, ${draft && draft.subject}, ${draft && draft.body}, ${message.receivedAt})
                    ON CONFLICT (owner_subject, thread_id) DO NOTHING`);
                    if (rule) await t.exec(sql`INSERT INTO mail_inbox_ai_journal
                        (id, owner_subject, rule_id, rule_name, thread_id, previous_category, action_category)
                        VALUES (${`act_${randomUUID()}`}, ${owner}, ${rule.id}, ${rule.name}, ${threadId}, ${previousCategory}, ${rule.category})`);
                });
                stats.triaged++;
            }
        } catch (err) {
            // Never log a subject, sender or body: error text from a provider is not mail-safe.
            (log.warn || log.log).call(log, `[mail] Inbox AI skipped one mailbox: ${String(err && err.code || 'run failed').slice(0, 80)}`);
        }
    }
    return stats;
}

function startInboxAiJob({ db, stalwart, config, fetchImpl, intervalMs, log = console, now } = {}) {
    const analyze = createInboxAnalyzer({ config, fetchImpl });
    let busy = false;
    const tick = async () => {
        if (busy) return;
        busy = true;
        try { await runInboxAi({ db, stalwart, analyze, log, now }); }
        catch (err) { (log.warn || log.log).call(log, `[mail] Inbox AI poll failed: ${String(err && err.code || 'run failed').slice(0, 80)}`); }
        finally { busy = false; }
    };
    const timer = setInterval(tick, Math.max(5000, Number(intervalMs) || 60_000));
    timer.unref();
    void tick();
    return { stop: () => clearInterval(timer), tick };
}

module.exports = { runInboxAi, startInboxAiJob };
