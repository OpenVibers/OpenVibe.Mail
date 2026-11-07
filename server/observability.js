'use strict';

/**
 * What the service tells the outside about itself: is it alive, is it ready, and what is it doing.
 *
 * The health answer says nothing about mail and nothing about anybody. The readiness answer asks two questions —
 * can the database answer, and can the mail server answer — and refuses when either cannot, so a half-up service
 * does not take traffic.
 */
function createServiceReadiness({ db, config, stalwart, version = null }) {
    async function handler(req, res) {
        const detail = { service: 'mail', version };
        let ok = true;

        try {
            const ready = await db.ready();
            detail.database = ready.ok ? ready.detail : { error: ready.error };
            if (!ready.ok) ok = false;
        } catch (err) {
            detail.database = { error: err && err.message };
            ok = false;
        }

        if (stalwart) {
            try {
                const domains = await stalwart.listDomains();
                detail.mail_server = { ok: true, domains: domains.length };
            } catch (err) {
                detail.mail_server = { ok: false, error: err && err.message ? String(err.message).slice(0, 120) : 'unreachable' };
                ok = false;
            }
        }

        if (config && config.events) detail.events = config.events.url ? 'configured' : 'off';

        res.status(ok ? 200 : 503).json({ status: ok ? 'ok' : 'not_ready', ...detail });
        return null;
    }

    return { handler };
}

module.exports = { createServiceReadiness };
