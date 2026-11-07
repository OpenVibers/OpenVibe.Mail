#!/usr/bin/env node
'use strict';

/**
 * Apply migrations/NNNN_*.sql to the database named by DATABASE_DIRECT_URL, then exit. The service also migrates at
 * boot; this is the install step that makes a failure visible before systemd starts the unit.
 */
const config = require('../server/config').load();
const { openDb } = require('../server/db');

async function main() {
    if (!config.db.directUrl) throw new Error('DATABASE_DIRECT_URL is not set');
    const db = await openDb(config);
    try {
        process.stdout.write('migrations applied\n');
    } finally {
        await db.close();
    }
}

main().catch((err) => {
    process.stderr.write(`init-db failed: ${err && err.message ? err.message : err}\n`);
    process.exit(1);
});
