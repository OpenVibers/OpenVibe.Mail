'use strict';

/**
 * The job that tells an agent's system about the mail sent to its own address (track HO6, channels).
 *
 * Mail learns of mail when it looks: Stalwart has no push to this service, so the poll is the arrival, and it is
 * due-based. Each run walks the inboxes whose answering is ON (the switch, off unless the person turned it on),
 * reads the newest messages of the person's mailbox as that inbox, and for each letter not seen before:
 *
 *   * skips it when the mail server marked it junk — spam starts nothing;
 *   * skips it when the sender is on the person's block list — a blocked sender starts nothing;
 *   * skips it when the sender is the inbox itself — an agent's own reply is not a letter to answer;
 *   * otherwise reads the text once, and in ONE transaction writes the row that says "this letter is this agent's"
 *     and queues mail.agent_inbox.received. The row and the event commit together, so a redelivery, an overlapping
 *     poll or a restart mid-run never announces a letter twice.
 *
 * Nothing is announced for an inbox whose switch is off, and turning it off stops the next letter. The poll runs
 * under a lease in mail_settings (its own key, not the purge job's), so two instances do not do the work twice.
 */
const { sql } = require('openvibe-sdk/db');
const answering = require('../domain/agent-answering');
const { mailboxAddressFor } = require('../domain/mailboxes');

const LEASE_KEY = 'agent_mail_lease';
const LEASE_MS = 60_000;

/** Take the poll's lease, so two instances of the service do not announce the same letter twice. */
async function takeLease(t, { now = Date.now(), leaseMs = LEASE_MS } = {}) {
    const row = await t.maybe(sql`
        INSERT INTO mail_settings (key, value, updated_at)
        VALUES (${LEASE_KEY}, ${new Date(now).toISOString()}, now())
        ON CONFLICT (key) DO UPDATE
            SET value = EXCLUDED.value, updated_at = now()
            WHERE mail_settings.updated_at < now() - (${leaseMs} * interval '1 millisecond')
        RETURNING value`);
    return Boolean(row);
}

/**
 * One run of the job: what is due, and only that. Returns what it did (counts and inbox ids), never a subject or a
 * body, so the run can be logged without saying anything about the mail.
 */
async function runDue({ db, stalwart, events, config, now = () => Date.now(), log = console } = {}) {
    const report = { inboxes: 0, announced: 0, skippedSpam: 0, skippedBlocked: 0, skippedOwn: 0, skipped: false };
    if (!stalwart || !events) { report.skipped = true; return report; }
    const held = await db.tx(async (t) => takeLease(t, { now: now(), leaseMs: (config.agentMail && config.agentMail.leaseMs) || LEASE_MS }));
    if (!held) { report.skipped = true; return report; }

    const limit = Math.max(1, (config.agentMail && config.agentMail.batch) || 50);
    const scan = Math.max(1, Math.min(500, (config.agentMail && config.agentMail.scan) || 100));
    const inboxes = await answering.answeringInboxes({ db });

    for (const inbox of inboxes.slice(0, limit)) {
        report.inboxes += 1;
        try {
            report.announced += await runInbox({ db, stalwart, events, inbox, scan, now, report });
        } catch (err) {
            (log.warn || log.log).call(log, `[mail] the agent inbox ${inbox.id} was not checked: ${err && err.message}`);
        }
    }
    return report;
}

/** Every letter of one inbox that has not been handled yet. */
async function runInbox({ db, stalwart, events, inbox, scan, now, report }) {
    // The inbox is read as the owner's mailbox: the mail server stamped Delivered-To with the agent's address.
    const mailbox = await mailboxAddressFor(db, inbox.owner_subject);
    if (!mailbox) return 0;
    const messages = await stalwart.listMessages({
        mailboxAddress: mailbox,
        recipient: inbox.address,
        limit: scan,
    });
    if (!messages.length) return 0;
    const seen = await answering.known({ db, inboxId: inbox.id, messageIds: messages.map((m) => m.id) });
    let announced = 0;

    // Oldest first, so a thread's letters are announced in the order they arrived.
    for (const message of messages.slice().reverse()) {
        if (seen.has(message.id)) continue;
        const sender = (message.from || [])[0] || null;
        if (!sender) continue;
        if (message.spam) { report.skippedSpam += 1; continue; }
        if (String(sender).toLowerCase() === String(inbox.address).toLowerCase()) { report.skippedOwn += 1; continue; }
        if (await answering.isBlocked({ db, owner: inbox.owner_subject, from: sender })) { report.skippedBlocked += 1; continue; }

        // The text, read once and not kept beyond this run (it goes out in the event's excerpt and nowhere else).
        const body = await stalwart.messageBody({ mailboxAddress: mailbox, id: message.id }).catch(() => ({ text: '', html: '' }));
        const excerpt = answering.excerptOf(body && body.text);

        const claimed = await db.tx(async (t) => {
            const row = await answering.claim({ t, inbox, messageId: message.id, from: sender });
            if (!row) return false;
            await events.outbox.emitIn(t, events.agentInboxReceived({
                inbox,
                owner: inbox.owner_subject,
                message: {
                    id: message.id,
                    from: [sender],
                    subject: message.subject || null,
                    excerpt,
                    receivedAt: message.receivedAt || null,
                },
            }));
            await answering.announced({ t, inboxId: inbox.id, messageId: message.id, now });
            return true;
        });
        if (claimed) announced += 1;
    }
    return announced;
}

/**
 * The scheduler: a chain of timeouts, not an interval, so a slow mail server cannot pile runs on top of each other.
 */
function startAgentMailJob({ db, stalwart, events, config, intervalMs = null, now = () => Date.now(), log = console } = {}) {
    const every = Math.max(1000, intervalMs || (config.agentMail && config.agentMail.intervalMs) || 30_000);
    let stopped = false;
    let timer = null;

    async function tick() {
        if (stopped) return;
        try {
            const report = await runDue({ db, stalwart, events, config, now, log });
            if (!report.skipped && report.announced) {
                (log.info || log.log).call(log, `[mail] agent mail: ${report.announced} letter(s) announced from ${report.inboxes} inbox(es)`);
            }
        } catch (err) {
            (log.warn || log.log).call(log, `[mail] the agent mail job failed: ${err && err.message}`);
        }
        if (!stopped) {
            timer = setTimeout(tick, every);
            if (timer.unref) timer.unref();
        }
    }

    timer = setTimeout(tick, every);
    if (timer.unref) timer.unref();

    return {
        stop() {
            stopped = true;
            if (timer) clearTimeout(timer);
        },
        runNow: () => runDue({ db, stalwart, events, config, now, log }),
    };
}

module.exports = { runDue, runInbox, startAgentMailJob, takeLease, LEASE_KEY };
