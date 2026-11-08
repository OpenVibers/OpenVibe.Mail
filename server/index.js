'use strict';

/**
 * OpenVibe.Mail — the process.
 *
 * The order is the order of the dependencies: the database first (the schema is applied at boot), then the mail
 * server (the domains have to be known before the first message arrives), then the events relay and the purge job,
 * and only then the door. There is no pool mailbox: every burner is its own directory account.
 */
const configLib = require('./config');
const { openStore } = require('./db');
const { createApp } = require('./app');
const { createEvents } = require('./events');
const { createStalwartClient } = require('./stalwart/client');
const { startPurgeJob } = require('./jobs/purge');
const { startAgentMailJob } = require('./jobs/agent-mail');

async function main() {
    const config = configLib.load();
    const log = console;

    const store = await openStore(config, { log });
    const db = store.db;

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

    // An agent answers the mail sent to its own address (track HO6): the due poll that announces a letter once,
    // for an inbox whose switch the person turned on. Its own lease, so a long purge never blocks it.
    const agentMail = startAgentMailJob({ db, stalwart, events, config, log });

    const { app } = await createApp({ config, store, stalwart, events, log });

    const server = app.listen(config.port, config.host, () => {
        log.info(`[OpenVibe.Mail] listening on ${config.host}:${config.port}`);
    });

    const shutdown = async (signal) => {
        log.info(`[OpenVibe.Mail] ${signal}: stopping`);
        purge.stop();
        agentMail.stop();
        events.stop();
        server.close(() => {
            store.close().finally(() => process.exit(0));
        });
        setTimeout(() => process.exit(0), 10_000).unref();
    };
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));

    return { server, store, stalwart, events, purge, agentMail };
}

if (require.main === module) {
    main().catch((err) => {
        console.error('[OpenVibe.Mail] the service did not start:', err && err.message ? err.message : err);
        process.exit(1);
    });
}

module.exports = { main };
