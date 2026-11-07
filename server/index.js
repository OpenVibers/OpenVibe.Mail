'use strict';

/**
 * OpenVibe.Mail — the process.
 *
 * The order is the order of the dependencies: the database first (the schema is applied at boot), then the pool
 * mailbox (the directory view reads it), then the mail server (the domains have to be known before the first
 * message arrives), then the events relay and the purge job, and only then the door.
 */
const configLib = require('./config');
const { openStore } = require('./db');
const { createApp } = require('./app');
const { createEvents } = require('./events');
const { createStalwartClient } = require('./stalwart/client');
const { ensurePoolMailbox, setPoolAddress } = require('./domain/mailboxes');
const { startPurgeJob } = require('./jobs/purge');

async function main() {
    const config = configLib.load();
    const log = console;

    const store = await openStore(config, { log });
    const db = store.db;

    // The pool mailbox: where the mail of a burner made without an account goes.
    const pool = await db.tx(async (t) => {
        const address = await ensurePoolMailbox(t, { baseDomain: config.addresses.base });
        await setPoolAddress(t, address);
        return address;
    });

    const stalwart = createStalwartClient({ config, log });

    // The domains: the base domain, the mask domain and every burner domain. A burner domain that the mail server
    // does not know would bounce, so it is added here — a new domain is a configuration change, not a code change.
    const domains = [config.addresses.base, config.addresses.mask, ...config.addresses.burners];
    for (const domain of domains) {
        try {
            const added = await stalwart.ensureDomain(domain);
            if (added) log.info(`[OpenVibe.Mail] the mail server now knows ${domain}`);
        } catch (err) {
            log.warn(`[OpenVibe.Mail] the mail server did not take ${domain}: ${err && err.message}`);
        }
    }

    const events = createEvents({ db, config, log });
    events.start();

    const purge = startPurgeJob({
        db,
        stalwart,
        events,
        intervalMs: config.jobs.purgeIntervalMs,
        log,
    });

    const { app } = await createApp({ config, store, stalwart, events, log });

    const server = app.listen(config.port, config.host, () => {
        log.info(`[OpenVibe.Mail] listening on ${config.host}:${config.port} (pool mailbox ${pool})`);
    });

    const shutdown = async (signal) => {
        log.info(`[OpenVibe.Mail] ${signal}: stopping`);
        purge.stop();
        events.stop();
        server.close(() => {
            store.close().finally(() => process.exit(0));
        });
        setTimeout(() => process.exit(0), 10_000).unref();
    };
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));

    return { server, store, stalwart, events, purge };
}

if (require.main === module) {
    main().catch((err) => {
        console.error('[OpenVibe.Mail] the service did not start:', err && err.message ? err.message : err);
        process.exit(1);
    });
}

module.exports = { main };
