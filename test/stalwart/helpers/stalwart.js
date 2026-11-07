'use strict';

/**
 * Start the pinned Stalwart binary against the test PostgreSQL and MinIO, render and apply the repository's own
 * configuration, and wait until it answers.
 *
 * The binary is downloaded and checksum-verified by CI (`.github/workflows/ci.yml`); locally set STALWART_BIN to
 * the binary you fetched. Nothing here writes a secret to disk: the rendered config.json names an environment
 * variable for the database password, and apply.js reads the S3 keys from the environment.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { createClient, apply } = require('../../../deploy/stalwart/apply');
const { settings } = require('./pg');

const ROOT = path.join(__dirname, '..', '..', '..');

function testEnv(overrides = {}) {
    const pg = settings();
    return {
        ...process.env,
        NODE_ENV: 'test',
        MAIL_BASE_DOMAIN: 'openvibe.test',
        MAIL_MASK_DOMAIN: 'mask.openvibe.test',
        BURNER_DOMAINS: 'burn1.openvibe.test,burn2.openvibe.test',
        STALWART_DEFAULT_HOSTNAME: 'mail.openvibe.test',
        STALWART_DB_HOST: pg.host,
        STALWART_DB_PORT: String(pg.port),
        STALWART_DB_NAME: pg.database,
        STALWART_DB_USER: pg.user,
        STALWART_DB_PASSWORD: pg.password,
        STALWART_SMTP_BIND: '127.0.0.1',
        STALWART_SMTP_PORT: '2525',
        STALWART_HTTP_BIND: '127.0.0.1',
        STALWART_HTTP_PORT: '18080',
        STALWART_IMAP_BIND: '127.0.0.1',
        STALWART_IMAP_PORT: '1143',
        STALWART_URL: 'http://127.0.0.1:18080',
        STALWART_ADMIN_USER: 'admin',
        STALWART_ADMIN_PASSWORD: 'ov-test-admin-password',
        ...overrides,
    };
}

function binaryPath(env = process.env) {
    return env.STALWART_BIN || path.join(ROOT, '.cache', 'stalwart', 'stalwart');
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function waitFor(check, { timeoutMs = 40_000, everyMs = 250, what = 'the mail server' } = {}) {
    const deadline = Date.now() + timeoutMs;
    let last = null;
    while (Date.now() < deadline) {
        try {
            const value = await check();
            if (value) return value;
        } catch (err) { last = err; }
        await sleep(everyMs);
    }
    throw new Error(`${what} did not answer in ${timeoutMs}ms${last ? `: ${last.message}` : ''}`);
}

async function start({ env = testEnv(), binary = null } = {}) {
    const bin = binary || binaryPath(env);
    if (!fs.existsSync(bin)) throw new Error(`STALWART_BIN not found: ${bin} (download the pinned release first)`);
    for (const name of ['STALWART_BLOB_ENDPOINT', 'STALWART_BLOB_BUCKET', 'STALWART_BLOB_ACCESS_KEY_ID', 'STALWART_BLOB_SECRET_KEY']) {
        if (!env[name]) throw new Error(`${name} is not set: the integration test needs the S3/MinIO target`);
    }

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-mail-stalwart-'));
    execFileSync(process.execPath, [path.join(ROOT, 'deploy', 'stalwart', 'render.js'), '--out', dir], { env, stdio: 'pipe' });
    const plan = JSON.parse(fs.readFileSync(path.join(dir, 'plan.json'), 'utf8'));

    const logs = [];
    const url = env.STALWART_URL;
    const auth = 'Basic ' + Buffer.from(`${env.STALWART_ADMIN_USER}:${env.STALWART_ADMIN_PASSWORD}`).toString('base64');
    const adminEnv = {
        ...env,
        STALWART_RECOVERY_ADMIN: `${env.STALWART_ADMIN_USER}:${env.STALWART_ADMIN_PASSWORD}`,
    };

    function launch(extra) {
        const state = { child: null, exited: null };
        state.child = spawn(bin, ['--config', path.join(dir, 'config.json')], {
            env: { ...adminEnv, ...extra },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        const keep = (chunk) => {
            logs.push(chunk.toString('utf8'));
            if (logs.length > 400) logs.splice(0, logs.length - 400);
        };
        state.child.stdout.on('data', keep);
        state.child.stderr.on('data', keep);
        state.child.on('exit', (code, signal) => { state.exited = { code, signal }; });
        return state;
    }

    async function waitReady(state, what) {
        await waitFor(async () => {
            if (state.exited) throw new Error(`Stalwart exited (${state.exited.code || state.exited.signal})`);
            const res = await fetch(`${url}/jmap`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: auth },
                body: JSON.stringify({ using: ['urn:ietf:params:jmap:core'], methodCalls: [['Core/echo', {}, '0']] }),
                signal: AbortSignal.timeout(3000),
            });
            return res.ok;
        }, { timeoutMs: 60_000, what });
    }

    async function stopState(state) {
        if (state.exited) return;
        state.child.kill('SIGTERM');
        await Promise.race([
            new Promise((resolve) => state.child.once('exit', resolve)),
            sleep(8000).then(() => { try { state.child.kill('SIGKILL'); } catch { /* gone */ } }),
        ]);
    }

    // First start is recovery mode: Stalwart has just created its schema and would otherwise try to bind the
    // default listeners (25, 443, 8080, …) before the plan replaces them — which fails on a workstation where
    // another process owns one of those ports, and is wrong in CI too. Recovery mode binds one HTTP port, the
    // plan is applied, then the real listeners start.
    const recovery = launch({
        STALWART_RECOVERY_MODE: '1',
        STALWART_RECOVERY_MODE_PORT: String(env.STALWART_HTTP_PORT),
    });
    try {
        await waitReady(recovery, 'Stalwart JMAP (recovery)');
        await apply(plan, createClient({
            url,
            user: env.STALWART_ADMIN_USER,
            password: env.STALWART_ADMIN_PASSWORD,
        }), env);
    } catch (err) {
        await stopState(recovery);
        throw new Error(`${err.message}\n--- stalwart log ---\n${logs.join('').slice(-6000)}`);
    }
    await stopState(recovery);

    const childState = launch({});
    try {
        await waitReady(childState, 'Stalwart JMAP');
        // The normal start has now written the built-in roles, so the Authentication defaults can be set. This is
        // the harness's second pass; an installed server runs apply once against an already-started Stalwart.
        await apply(plan, createClient({
            url,
            user: env.STALWART_ADMIN_USER,
            password: env.STALWART_ADMIN_PASSWORD,
        }), env);
    } catch (err) {
        await stopState(childState);
        throw new Error(`${err.message}\n--- stalwart log ---\n${logs.join('').slice(-6000)}`);
    }

    return {
        child: childState.child,
        dir,
        logs,
        url,
        smtpPort: Number(env.STALWART_SMTP_PORT),
        httpPort: Number(env.STALWART_HTTP_PORT),
        imapPort: Number(env.STALWART_IMAP_PORT),
        env,
        async stop() {
            await stopState(childState);
            fs.rmSync(dir, { recursive: true, force: true });
        },
    };
}

module.exports = { start, testEnv, waitFor, binaryPath, sleep };
