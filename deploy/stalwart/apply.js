#!/usr/bin/env node
'use strict';

/**
 * Apply the rendered Stalwart plan over loopback JMAP.
 *
 * Stalwart v1.0.3 keeps its settings as JMAP objects (the v0.16 change), so "configuration" is a reconciliation:
 *   directory      the SQL views in migrations/0002_directory_views.sql
 *   authentication points at that directory
 *   domains        the base, mask and burner domains, none allowed to relay
 *   system         the SMTP hostname and the default domain
 *   blob store     S3-compatible (B2 in production); the keys are read from the environment here, never written
 *   spam           the built-in filter, on
 *   listeners      SMTP on 25; JMAP/management and IMAP on loopback; every submission/POP3/Sieve/HTTPS listener gone
 *
 *   STALWART_URL=http://127.0.0.1:8080 STALWART_ADMIN_PASSWORD=… \
 *     node deploy/stalwart/apply.js [--plan deploy/stalwart/rendered/plan.json]
 *
 * It is idempotent: run it on install and after a configuration change.
 */
const fs = require('fs');
const path = require('path');

const USING = ['urn:ietf:params:jmap:core', 'urn:stalwart:jmap'];

function arg(name, fallback) {
    const i = process.argv.indexOf(name);
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function basicAuth(user, password) {
    return 'Basic ' + Buffer.from(`${user}:${password}`, 'utf8').toString('base64');
}

function createClient({ url, user, password, timeoutMs = 20_000 }) {
    const base = String(url || '').replace(/\/+$/, '');
    const auth = basicAuth(user, password);

    async function jmap(methodCalls) {
        const res = await fetch(`${base}/jmap`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: auth },
            body: JSON.stringify({ using: USING, methodCalls }),
            signal: AbortSignal.timeout(timeoutMs),
        });
        const text = await res.text();
        let parsed = null;
        try { parsed = JSON.parse(text); } catch { /* the message below is the useful one */ }
        if (!res.ok || !parsed || !Array.isArray(parsed.methodResponses)) {
            throw new Error(`the mail server refused a JMAP request (HTTP ${res.status}): ${(parsed && parsed.detail) || text.slice(0, 200)}`);
        }
        return parsed.methodResponses;
    }

    async function one(name, args, id = '0') {
        const [[resultName, result]] = await jmap([[name, args, id]]);
        if (resultName === 'error') throw new Error(`${name}: ${result.description || result.type}`);
        return result;
    }

    return { jmap, one };
}

function setProblems(label, result) {
    const problems = [];
    for (const key of ['notCreated', 'notUpdated', 'notDestroyed']) {
        for (const [id, why] of Object.entries((result && result[key]) || {})) {
            problems.push(`${label} ${key} ${id}: ${why.description || why.type || 'refused'}`);
        }
    }
    return problems;
}

async function apply(plan, client, env = process.env) {
    const problems = [];

    // ---- directory -------------------------------------------------------------------------
    const dirQuery = await client.one('x:Directory/query', { filter: {}, limit: 50 }, 'dq');
    const dirIds = dirQuery.ids || [];
    const dirs = dirIds.length ? (await client.one('x:Directory/get', { ids: dirIds }, 'dg')).list || [] : [];
    const existingDir = dirs.find((d) => d.description === plan.directory.description);
    const directory = {
        '@type': 'Sql',
        description: plan.directory.description,
        store: { '@type': 'Default' },
        columnEmail: 'name',
        columnSecret: 'secret',
        columnDescription: 'description',
        queryRecipient: plan.directory.query_recipient,
        queryLogin: plan.directory.query_login,
        queryMemberOf: plan.directory.query_member_of,
        queryEmailAliases: plan.directory.query_email_aliases,
    };
    let directoryId = existingDir && existingDir.id;
    if (directoryId) {
        const r = await client.one('x:Directory/set', { update: { [directoryId]: directory } }, 'du');
        problems.push(...setProblems('directory', r));
    } else {
        const r = await client.one('x:Directory/set', { create: { openvibe: directory } }, 'dc');
        problems.push(...setProblems('directory', r));
        directoryId = r.created && r.created.openvibe && r.created.openvibe.id;
    }
    if (!directoryId) throw new Error('the mail server did not give the SQL directory an id');

    // Accounts created from the SQL directory inherit the Authentication defaults. A fresh Stalwart has the four
    // built-in roles but an empty default set; without the User role an account is created and then refuses its
    // own mail with "This account is not authorized to receive email." The ids are found by description because
    // they are generated per database.
    const roleQuery = await client.one('x:Role/query', { filter: {}, limit: 50 }, 'rq');
    const roleList = roleQuery.ids.length
        ? (await client.one('x:Role/get', { ids: roleQuery.ids, properties: ['id', 'description'] }, 'rg')).list || []
        : [];
    const role = (description) => {
        const found = roleList.find((r) => String(r.description || '').toLowerCase() === description.toLowerCase());
        return found ? found.id : null;
    };
    const userRole = role('User');
    const groupRole = role('Group');
    const tenantRole = role('Tenant Administrator');
    const adminRole = role('System Administrator');

    // The built-in roles are inserted with the safe defaults, which a recovery-mode first start has not written
    // yet. In that one case leave the default role ids alone; the acceptance harness runs apply once more after
    // the normal start, when they exist.
    const authUpdate = { directoryId };
    if (userRole && groupRole && tenantRole && adminRole) {
        authUpdate.defaultUserRoleIds = { [userRole]: true };
        authUpdate.defaultGroupRoleIds = { [groupRole]: true };
        authUpdate.defaultTenantRoleIds = { [tenantRole]: true, [userRole]: true };
        authUpdate.defaultAdminRoleIds = { [adminRole]: true, [userRole]: true };
    }
    const auth = await client.one('x:Authentication/set', { update: { singleton: authUpdate } }, 'a');
    problems.push(...setProblems('authentication', auth));
    if (authUpdate.defaultUserRoleIds) {
        // The running process parsed Authentication at startup; reload it so an account the directory creates on
        // the next delivery inherits the User role instead of being created without permissions.
        const reload = await client.one('x:Action/set', { create: { reload: { '@type': 'ReloadSettings' } } }, 'rs').catch((err) => ({ notCreated: { reload: { description: err.message } } }));
        problems.push(...setProblems('reload settings', reload));
    }

    // ---- domains ---------------------------------------------------------------------------
    const domainQuery = await client.one('x:Domain/query', { filter: {}, limit: 500 }, 'dq');
    const domainIds = domainQuery.ids || [];
    const domains = domainIds.length
        ? (await client.one('x:Domain/get', { ids: domainIds }, 'dg')).list || []
        : [];
    const byName = new Map(domains.map((d) => [String(d.name || '').toLowerCase(), d]));
    for (const name of plan.domains.all) {
        const domain = String(name || '').toLowerCase();
        if (byName.has(domain)) continue;
        const r = await client.one('x:Domain/set', {
            create: { [domain]: { '@type': 'Domain', name: domain, enable: true, allowRelaying: false } },
        }, 'ds');
        problems.push(...setProblems(`domain ${domain}`, r));
        const id = r.created && r.created[domain] && r.created[domain].id;
        if (id) byName.set(domain, { id, name: domain });
    }
    const baseDomain = byName.get(String(plan.domains.base).toLowerCase());
    if (!baseDomain) throw new Error(`the base domain ${plan.domains.base} is not known to the mail server`);

    const system = await client.one('x:SystemSettings/set', {
        update: {
            singleton: {
                defaultHostname: plan.server.default_hostname,
                defaultDomainId: baseDomain.id,
            },
        },
    }, 's');
    problems.push(...setProblems('system', system));

    // ---- blob store ------------------------------------------------------------------------
    const blob = plan.blob_store;
    const accessKeyId = env[blob.accessKeyIdEnv];
    const secretKey = env[blob.secretKeyEnv];
    if (!accessKeyId || !secretKey) {
        throw new Error(`the blob store needs ${blob.accessKeyIdEnv} and ${blob.secretKeyEnv}`);
    }
    const blobStore = {
        '@type': 'S3',
        region: { '@type': 'Custom', url: blob.endpoint, region: blob.region || 'us-east-1' },
        bucket: blob.bucket,
        accessKeyId: { '@type': 'Value', value: accessKeyId },
        secretKey: { '@type': 'Value', secret: secretKey },
        sessionToken: { '@type': 'None' },
        timeout: blob.timeoutMs,
        maxRetries: blob.maxRetries,
        keyPrefix: blob.keyPrefix || undefined,
        allowInvalidCerts: Boolean(blob.allowInvalidCerts),
        verifyAfterWrite: blob.verifyAfterWrite !== false,
    };
    const blobResult = await client.one('x:BlobStore/set', { update: { singleton: blobStore } }, 'b');
    problems.push(...setProblems('blob store', blobResult));

    // ---- spam ------------------------------------------------------------------------------
    const spam = await client.one('x:SpamSettings/set', {
        update: { singleton: { enable: Boolean(plan.spam.enabled), scoreSpam: plan.spam.score_spam } },
    }, 'sp');
    problems.push(...setProblems('spam', spam));

    // M1 has no submission listener: every SMTP connection is an inbound relay from another mail server. Stalwart's
    // default is `local_port != 25`, which would demand authentication on any test or alternate port; state the
    // invariant (inbound does not authenticate) instead of relying on the port number. Relaying is still refused by
    // MtaStageRcpt.allowRelaying and by the domains' allowRelaying = false.
    const mtaAuth = await client.one('x:MtaStageAuth/set', {
        update: { singleton: { require: { match: {}, else: 'false' } } },
    }, 'ma');
    problems.push(...setProblems('mta auth', mtaAuth));

    // The acceptance test sends 300 messages to one burner in a burst; production keeps Stalwart's inbound
    // throttles (5/second per IP, 25/hour per sender-domain/recipient). Only the harness sets STALWART_TEST_MODE.
    if (String(env.STALWART_TEST_MODE || '') === '1') {
        const tq = await client.one('x:MtaInboundThrottle/query', { filter: {}, limit: 20 }, 'tq');
        if ((tq.ids || []).length) {
            const update = {};
            for (const id of tq.ids) update[id] = { enable: false };
            const throttles = await client.one('x:MtaInboundThrottle/set', { update }, 'tt');
            problems.push(...setProblems('inbound throttle', throttles));
            const reload = await client.one('x:Action/set', { create: { reload: { '@type': 'ReloadSettings' } } }, 'trs')
                .catch((err) => ({ notCreated: { reload: { description: err.message } } }));
            problems.push(...setProblems('reload after test throttles', reload));
        }
    }

    // A debug tracer is opt-in (STALWART_DEBUG=1) and exists for the acceptance test's failure output. It is
    // created in the recovery phase so the normal phase's SMTP sessions are logged.
    if (String(env.STALWART_DEBUG || '') === '1') {
        const existingTracer = await client.one('x:Tracer/query', { filter: {}, limit: 10 }, 'tq').catch(() => ({ ids: [] }));
        if (!(existingTracer.ids || []).length) {
            const tracer = await client.one('x:Tracer/set', {
                create: {
                    stdout: {
                        '@type': 'Stdout',
                        enable: true,
                        level: 'debug',
                        ansi: false,
                        multiline: true,
                        lossy: true,
                    },
                },
            }, 'tr');
            problems.push(...setProblems('tracer', tracer));
        }
    }

    // ---- listeners -------------------------------------------------------------------------
    const listenerQuery = await client.one('x:NetworkListener/query', { filter: {}, limit: 100 }, 'lq');
    const listenerIds = listenerQuery.ids || [];
    const listeners = listenerIds.length
        ? (await client.one('x:NetworkListener/get', { ids: listenerIds }, 'lg')).list || []
        : [];
    const byListener = new Map(listeners.map((l) => [String(l.name || '').toLowerCase(), l]));
    const wanted = new Set(plan.listeners.map((l) => l.name));

    const stale = listeners.filter((l) => !wanted.has(String(l.name || '').toLowerCase())).map((l) => l.id);
    if (stale.length) {
        const r = await client.one('x:NetworkListener/set', { destroy: stale }, 'ld');
        problems.push(...setProblems('listener destroy', r));
    }

    for (const l of plan.listeners) {
        const bind = {};
        for (const address of l.bind) bind[address] = true;
        const value = {
            protocol: l.protocol,
            bind,
            useTls: Boolean(l.use_tls),
            implicitTls: Boolean(l.implicit_tls),
        };
        const found = byListener.get(l.name);
        const r = found
            ? await client.one('x:NetworkListener/set', { update: { [found.id]: value } }, `lu-${l.name}`)
            : await client.one('x:NetworkListener/set', {
                create: { [l.name]: { name: l.name, ...value } },
            }, `lc-${l.name}`);
        problems.push(...setProblems(`listener ${l.name}`, r));
    }

    if (problems.length) {
        throw new Error(`the mail server did not take every setting:\n  ${problems.join('\n  ')}`);
    }
    return { directoryId, domains: [...byName.keys()], listeners: plan.listeners.map((l) => l.name) };
}

async function main() {
    if (!process.env.STALWART_ADMIN_PASSWORD) throw new Error('STALWART_ADMIN_PASSWORD is not set');
    const planPath = path.resolve(arg('--plan', process.env.STALWART_PLAN || path.join(__dirname, 'rendered', 'plan.json')));
    const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
    const client = createClient({
        url: process.env.STALWART_URL || 'http://127.0.0.1:8080',
        user: process.env.STALWART_ADMIN_USER || 'admin',
        password: process.env.STALWART_ADMIN_PASSWORD,
    });
    const summary = await apply(plan, client);
    process.stdout.write(`applied ${path.basename(planPath)}: directory ${summary.directoryId}, ${summary.domains.length} domains, listeners ${summary.listeners.join(', ')}\n`);
}

if (require.main === module) {
    main().catch((err) => {
        process.stderr.write(`apply failed: ${err && err.message ? err.message : err}\n`);
        process.exit(1);
    });
}

module.exports = { apply, createClient };
