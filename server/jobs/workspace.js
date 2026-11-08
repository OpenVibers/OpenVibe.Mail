'use strict';
const { sql } = require('openvibe-sdk/db');
const { runOutbox } = require('../domain/compose');
async function wakeSnoozes({ db, stalwart, now = Date.now() }) {
    const due = await db.many(sql`SELECT owner_subject,message_id FROM mail_message_snoozes WHERE wake_at <= ${new Date(now).toISOString()} ORDER BY wake_at LIMIT 100`);
    for (const row of due) await db.tx(async (t) => {
        const mailbox = await t.maybe(sql`SELECT address FROM mail_mailboxes WHERE owner_subject=${row.owner_subject} FOR UPDATE`);
        const snooze = await t.maybe(sql`SELECT wake_at FROM mail_message_snoozes WHERE owner_subject=${row.owner_subject} AND message_id=${row.message_id} AND wake_at <= ${new Date(now).toISOString()}`);
        if (!mailbox || !snooze) return;
        const ok = await stalwart.setKeywords({ mailboxAddress:mailbox.address,id:row.message_id,keywords:{ 'ov-snoozed':false, 'ov-archived':false } });
        if (ok || !await stalwart.readMessage({ mailboxAddress:mailbox.address,id:row.message_id })) await t.exec(sql`DELETE FROM mail_message_snoozes WHERE owner_subject=${row.owner_subject} AND message_id=${row.message_id}`);
    });
}
function startWorkspaceJob(options) {
    let busy = false;
    const tick = async () => {
        if (busy) return;
        busy = true;
        try { await runOutbox(options); await wakeSnoozes(options); }
        catch { (options.log || console).warn('[mail] workspace tick failed'); }
        finally { busy = false; }
    };
    const timer = setInterval(tick,1000); timer.unref(); void tick();
    return { tick, stop:() => clearInterval(timer) };
}
module.exports = { startWorkspaceJob, wakeSnoozes };
