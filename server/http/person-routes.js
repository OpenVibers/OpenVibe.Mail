'use strict';

const { sql } = require('openvibe-sdk/db');
const addresses = require('../domain/person-mail');
const customDomains = require('../domain/custom-domains');
const forwarding = require('../domain/forwarding');
const { createNetworkPolicy } = require('../domain/network-policy');

function mountPersonMail(router, { db, config, stalwart, smtp, principal, wrap, fail, ownerOf, fetchImpl }) {
    const read = principal.requirePerson(principal.CAPABILITIES.read);
    const write = principal.requirePerson(principal.CAPABILITIES.write);
    const policy = createNetworkPolicy(config, fetchImpl);
    const noStore = (res) => res.set('Cache-Control', 'private, no-store');
    const humanOnly = (req, res, next) => req.principal?.kind === 'user' ? next()
        : fail(req, res, 403, 'mail.person_required', 'Sign in as the account owner to send or forward mail.');

    router.get('/api/v1/me/mail/person-addresses', read, wrap(async (req, res) => {
        const rows = await db.many(sql`SELECT address,kind,enabled,created_at FROM mail_person_addresses WHERE owner_subject=${ownerOf(req)} ORDER BY created_at`);
        return noStore(res).json({ addresses: rows });
    }));
    router.post('/api/v1/me/mail/person-addresses', write, wrap(async (req, res) => {
        const kind = req.body?.kind === 'name' ? 'name' : req.body?.kind === 'custom' ? 'custom' : 'alias';
        try {
            const address = await addresses.createAddress({ db, config, stalwart, owner: ownerOf(req), local: req.body?.name, domain: req.body?.domain, kind });
            return noStore(res).status(201).json({ address, kind });
        } catch (err) { return fail(req, res, 422, 'mail.address.invalid', err.message); }
    }));

    router.get('/api/v1/me/mail/custom-domains', read, wrap(async (req, res) => {
        const rows = await db.many(sql`SELECT domain FROM mail_custom_domains WHERE owner_subject=${ownerOf(req)} ORDER BY created_at`);
        return noStore(res).json({ domains: await Promise.all(rows.map((row) => customDomains.get({ db, config, owner: ownerOf(req), domain: row.domain }))) });
    }));
    router.post('/api/v1/me/mail/custom-domains', write, wrap(async (req, res) => {
        try { return noStore(res).status(201).json(await customDomains.add({ db, config, owner: ownerOf(req), domain: req.body?.domain })); }
        catch (err) { return fail(req, res, 422, 'mail.custom_domain.invalid', err.message); }
    }));
    router.post('/api/v1/me/mail/custom-domains/:domain/verify', write, wrap(async (req, res) => {
        try {
            const result = await customDomains.verify({ db, config, stalwart, owner: ownerOf(req), domain: req.params.domain, fetchImpl });
            if (!result) return fail(req, res, 404, 'mail.custom_domain.not_found', 'That domain is not yours.');
            return noStore(res).json(result);
        } catch (err) { return fail(req, res, 422, 'mail.custom_domain.invalid', err.message); }
    }));

    router.post('/api/v1/me/mail/send', write, humanOnly, wrap(async (req, res) => {
        const result = await addresses.send({ db, config, owner: ownerOf(req), from: req.body?.from,
            recipients: req.body?.to, subject: req.body?.subject, body: req.body?.body, policy, smtp, fetchImpl });
        if (result.code) return fail(req, res, result.status, result.code, result.detail);
        return noStore(res).status(result.status).json(result);
    }));

    router.get('/api/v1/me/mail/forwards', read, wrap(async (req, res) => {
        const rows = await db.many(sql`SELECT id,source_address,target_address,enabled,created_at FROM mail_forward_rules WHERE owner_subject=${ownerOf(req)} ORDER BY created_at`);
        return noStore(res).json({ forwards: rows });
    }));
    router.post('/api/v1/me/mail/forwards', write, humanOnly, wrap(async (req, res) => {
        try {
            const id = await forwarding.add({ db, owner: ownerOf(req), source: req.body?.source, target: req.body?.target, policy });
            return noStore(res).status(201).json({ id });
        } catch (err) { return fail(req, res, 422, 'mail.forward.invalid', err.message); }
    }));
    router.delete('/api/v1/me/mail/forwards/:id', write, humanOnly, wrap(async (req, res) => {
        const row = await db.maybe(sql`DELETE FROM mail_forward_rules WHERE id=${req.params.id} AND owner_subject=${ownerOf(req)} RETURNING id`);
        if (!row) return fail(req, res, 404, 'mail.forward.not_found', 'That forwarding rule is not yours.');
        return noStore(res).status(204).end();
    }));

    router.get('/report/:id', (req, res) => {
        if (!/^[0-9a-f-]{36}$/.test(req.params.id)) return res.status(404).end();
        res.set('Content-Type', 'text/html; charset=utf-8').set('Cache-Control', 'no-store');
        return res.end(`<!doctype html><html lang="en"><meta charset="utf-8"><title>Report a message</title><main><h1>Report an OpenVibe message</h1><p>Use this if this message was unwanted. Your report pauses sending when abuse is detected.</p><form method="post" action="/api/v1/mail/report/${req.params.id}"><button type="submit">Report message</button></form></main></html>`);
    });
    router.post('/api/v1/mail/report/:id', wrap(async (req, res) => {
        if (!/^[0-9a-f-]{36}$/.test(req.params.id)) return fail(req, res, 404, 'mail.report.not_found', 'The message was not found.');
        const row = await db.maybe(sql`INSERT INTO mail_person_reports(send_id) SELECT id FROM mail_person_sends WHERE id=${req.params.id} AND status IN ('accepted','complaint') ON CONFLICT DO NOTHING RETURNING send_id`);
        if (row) await db.exec(sql`UPDATE mail_person_sends SET status='complaint' WHERE id=${row.send_id}`);
        return noStore(res).json({ received: true });
    }));
}

module.exports = { mountPersonMail };
