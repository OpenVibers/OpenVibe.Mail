'use strict';

/**
 * The one place a triage result becomes a row, used by forwarded mail (server/jobs/inbox-ai.js) and by IMAP
 * (server/jobs/imap-pull.js). The category a rule assigns wins over the model's; the journal row and the thread row
 * commit together. `source` says which side the thread came from, so Disconnect can delete only the IMAP ones.
 */
const { sql } = require('openvibe-sdk/db');
const { randomUUID } = require('node:crypto');
const { senderAddress } = require('./inbox-ai-send');

async function storeTriage({ db, owner, threadId, message, triage, rule = null, source = 'forwarded', imapMailboxId = null }) {
    const previousCategory = triage.category;
    if (rule) triage.category = rule.category;
    const sender = (message.from || [])[0];
    const replyTo = senderAddress(sender);
    const draft = triage.category === 'needs_reply' && replyTo
        ? {
            to: replyTo,
            subject: /^re:/i.test(message.subject || '') ? message.subject : `Re: ${message.subject || ''}`,
            body: triage.draft,
        }
        : null;
    await db.tx(async (t) => {
        await t.exec(sql`
            INSERT INTO mail_inbox_ai_threads
                (owner_subject, thread_id, message_id, sender, subject, category, summary, draft_to, draft_subject,
                 draft_body, received_at, source, imap_mailbox_id)
            VALUES (${owner}, ${threadId}, ${message.id}, ${sender}, ${message.subject || null}, ${triage.category},
                ${triage.summary}, ${draft && draft.to}, ${draft && draft.subject}, ${draft && draft.body},
                ${message.receivedAt || null}, ${source}, ${imapMailboxId})
            ON CONFLICT (owner_subject, thread_id) DO NOTHING`);
        if (rule) await t.exec(sql`INSERT INTO mail_inbox_ai_journal
            (id, owner_subject, rule_id, rule_name, thread_id, previous_category, action_category)
            VALUES (${`act_${randomUUID()}`}, ${owner}, ${rule.id}, ${rule.name}, ${threadId}, ${previousCategory}, ${rule.category})`);
    });
}

module.exports = { storeTriage };
