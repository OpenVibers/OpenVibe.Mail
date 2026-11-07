'use strict';

/**
 * The PostgreSQL the integration test owns.
 *
 * Stalwart keeps its own tables in the same database as the service (the directory view is how they meet), so the
 * test uses a database of its own — `ov_mail_test` by default — and drops its public schema before it starts. It
 * never touches the database named by DATABASE_URL in a shell that points at a real service.
 */
const { Client } = require('pg');

function settings(env = process.env) {
    return {
        host: env.STALWART_DB_HOST || '127.0.0.1',
        port: Number(env.STALWART_DB_PORT || 5432),
        user: env.STALWART_DB_USER || 'ov',
        password: env.STALWART_DB_PASSWORD || '',
        database: env.STALWART_TEST_DB || 'ov_mail_test',
        ssl: /^(1|true|yes)$/i.test(env.STALWART_DB_SSL || '') ? { rejectUnauthorized: false } : false,
    };
}

function urlFor(db, env = process.env) {
    const s = settings(env);
    const auth = `${encodeURIComponent(s.user)}:${encodeURIComponent(s.password)}`;
    return `postgres://${auth}@${s.host}:${s.port}/${encodeURIComponent(db)}`;
}

async function withClient(db, fn, env = process.env) {
    const s = settings(env);
    const client = new Client({ ...s, database: db });
    await client.connect();
    try { return await fn(client); } finally { await client.end(); }
}

async function ensureDatabase(env = process.env) {
    const s = settings(env);
    if (!/^[a-z_][a-z0-9_]*$/.test(s.database)) throw new Error('STALWART_TEST_DB must be a plain database name');
    await withClient('postgres', async (client) => {
        const found = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [s.database]);
        if (found.rowCount) return;
        await client.query(`CREATE DATABASE "${s.database}"`);
    }, env);
    return s.database;
}

async function resetSchema(env = process.env) {
    const s = settings(env);
    await withClient(s.database, async (client) => {
        await client.query('DROP SCHEMA IF EXISTS public CASCADE');
        await client.query('CREATE SCHEMA public');
        await client.query('GRANT ALL ON SCHEMA public TO current_user');
    }, env);
}

module.exports = { settings, urlFor, ensureDatabase, resetSchema, withClient };
