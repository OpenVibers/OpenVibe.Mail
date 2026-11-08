'use strict';
const { sql } = require('openvibe-sdk/db');
const compose = require('../domain/compose');
const { searchFilter, labelKeyword } = require('../domain/mail-search');
const { mailboxAddressFor } = require('../domain/mailboxes');
const BASE = '/api/v1/me/mail/workspace';
function mountWorkspace(router, { db, stalwart, config, principal, wrap, fail, ownerOf }) {
    const read = principal.requirePerson(principal.CAPABILITIES.read);
    const write = principal.requirePerson(principal.CAPABILITIES.write);
    const invalid = (req, res, err) => fail(req,res,422,'mail.workspace.invalid',err.message);
    router.get(BASE + '/settings', read, wrap(async (req,res) => res.json({
        addresses: await compose.identities(db, ownerOf(req)),
        labels: await db.many(sql`SELECT name FROM mail_user_labels WHERE owner_subject=${ownerOf(req)} ORDER BY name`),
        limits: { file: compose.MAX_FILE, total: compose.MAX_TOTAL, count: compose.MAX_FILES, undo_ms: compose.UNDO_MS },
        outbound_enabled: !!config.outbound?.enabled,
    })));
    router.put(BASE + '/signature', write, wrap(async (req,res) => {
        const { address, signature } = req.body || {};
        if (typeof signature !== 'string' || signature.length > 4000 || !(await compose.identities(db,ownerOf(req))).some((a) => a.address === address)) return fail(req,res,422,'mail.signature.invalid','Choose your address and a signature under 4,000 characters.');
        await db.exec(sql`INSERT INTO mail_address_signatures(owner_subject,address,signature) VALUES(${ownerOf(req)},${address},${signature}) ON CONFLICT(owner_subject,address) DO UPDATE SET signature=EXCLUDED.signature`);
        res.json({ saved: true });
    }));
    router.post(BASE + '/send', write, wrap(async (req,res) => {
        try { res.status(202).json(await compose.enqueue({ db,stalwart,config,owner:ownerOf(req),input:req.body })); }
        catch (err) { invalid(req,res,err); }
    }));
    router.get(BASE + '/outbox', read, wrap(async (req,res) => res.json({ messages: await db.many(sql`
        SELECT id,state,send_at,undo_until,created_at,payload->>'subject' AS subject,payload->'to' AS recipients,outcomes
        FROM mail_compose_outbox WHERE owner_subject=${ownerOf(req)} ORDER BY created_at DESC LIMIT 100`) })));
    router.get(BASE + '/outbox/:id', read, wrap(async (req,res) => {
        const row = await db.maybe(sql`SELECT id,state,send_at,payload,outcomes FROM mail_compose_outbox WHERE owner_subject=${ownerOf(req)} AND id=${req.params.id}`);
        if (!row) return fail(req,res,404,'mail.not_found','That send is not here.');
        res.json(row);
    }));
    router.post(BASE + '/outbox/:id/cancel', write, wrap(async (req,res) => {
        const row = await compose.cancel(db,ownerOf(req),req.params.id);
        if (!row) return fail(req,res,409,'mail.send.started','This send has already started or is no longer queued.');
        res.json(row);
    }));
    router.get(BASE + '/messages', read, wrap(async (req,res) => {
        let filter;
        try { filter = searchFilter(req.query); } catch (err) { return invalid(req,res,err); }
        const mailbox = await mailboxAddressFor(db,ownerOf(req));
        if (!mailbox) return res.json({ messages:[],next_cursor:null });
        const recipient = req.query.address && req.query.address !== 'all' ? String(req.query.address) : null;
        if (recipient && !(await compose.identities(db,ownerOf(req))).some((a) => a.address === recipient)) return fail(req,res,404,'mail.not_found','That address is not here.');
        const page = await stalwart.readMessages({ mailboxAddress:mailbox,filter,recipient,position:/^\d{1,7}$/.test(req.query.cursor || '') ? Number(req.query.cursor) : 0,limit:50 });
        res.json({ messages:page.messages.map((m) => ({ id:m.id,thread_id:m.threadId || m.id,from:m.from,to:m.to,subject:m.subject,received_at:m.receivedAt,unread:m.unread,has_attachments:m.hasAttachment,starred:!!m.keywords?.$flagged,archived:!!m.keywords?.['ov-archived'],labels:Object.keys(m.keywords || {}).filter((k) => k.startsWith('ov-label-')).map((k) => Buffer.from(k.slice(9),'hex').toString()) })),next_cursor:page.next == null ? null : String(page.next) });
    }));
    router.get(BASE + '/threads/:id', read, wrap(async (req,res) => {
        const mailbox = await mailboxAddressFor(db,ownerOf(req));
        const ids = mailbox ? await stalwart.readThread({ mailboxAddress:mailbox,id:req.params.id }) : [];
        res.json({ ids });
    }));
    router.put(BASE + '/messages/:id', write, wrap(async (req,res) => {
        const owner = ownerOf(req), id = req.params.id;
        const mailbox = await mailboxAddressFor(db,owner);
        if (!mailbox || !await stalwart.readMessage({ mailboxAddress:mailbox,id })) return fail(req,res,404,'mail.not_found','That message is not here.');
        const input = req.body || {}, keywords = {};
        try {
            for (const [key,keyword] of [['starred','$flagged'],['archived','ov-archived']]) {
                if (key in input) {
                    if (typeof input[key] !== 'boolean') throw new Error(key + ' must be true or false.');
                    keywords[keyword] = input[key];
                }
            }
            if (input.label) {
                keywords[labelKeyword(input.label)] = input.remove !== true;
                if (input.remove !== true) await db.exec(sql`INSERT INTO mail_user_labels(owner_subject,name) VALUES(${owner},${input.label.trim()}) ON CONFLICT DO NOTHING`);
            }
            let wake = null;
            if ('snooze_until' in input && input.snooze_until !== null) wake = compose.future(input.snooze_until,Date.now());
            // The same row lock serializes wake-up with an extension or cancellation of a snooze.
            await db.tx(async (t) => {
                await t.maybe(sql`SELECT owner_subject FROM mail_mailboxes WHERE owner_subject=${owner} FOR UPDATE`);
                if ('snooze_until' in input) {
                    keywords['ov-snoozed'] = !!wake;
                    if (wake) await t.exec(sql`INSERT INTO mail_message_snoozes(owner_subject,message_id,wake_at) VALUES(${owner},${id},${wake}) ON CONFLICT(owner_subject,message_id) DO UPDATE SET wake_at=EXCLUDED.wake_at`);
                    else await t.exec(sql`DELETE FROM mail_message_snoozes WHERE owner_subject=${owner} AND message_id=${id}`);
                }
                if (!Object.keys(keywords).length) throw new Error('Choose a message action.');
                if (!await stalwart.setKeywords({ mailboxAddress:mailbox,id,keywords })) throw new Error('The mail server could not save this change.');
            });
        } catch (err) { return invalid(req,res,err); }
        res.json({ id,saved:true });
    }));
}
module.exports = { mountWorkspace };
