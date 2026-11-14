'use strict';

/**
 * OpenVibe.Mail's owner settings (the Setup tab, plan §AB.16 and §AB.18): the namespaces
 *
 *   mail.sending     the sending providers (Amazon SES, Postmark, Resend, Mailgun, SendGrid, Brevo) and a plain
 *                    SMTP relay, each one row: every field of a provider shares one x-required-for
 *   mail.receiving   Cloudflare Email Routing, the receiving side
 *   mail.dns         the DNS check of a sending domain: MX, SPF, DKIM, DMARC and BIMI, read live
 *
 * The keys are secret class: they are written through the write-only route (/internal/config/<namespace>/secrets/<key>),
 * sealed with the service's KEK and never shown again. There is no environment pin: the vault is the only place these
 * values live, and nothing reads them from the environment.
 *
 * Network's admin proxy reaches these namespaces with the capability mail.config.manage, acting for the owner
 * (X-OV-Subject); a secret change needs X-OV-Fresh: 1. The test route answers { ok, message } in one line, like
 * openvibe-shared's own test hook: one cheap authenticated read per provider (server/mail-probes.js), never a send,
 * and never a key in the answer.
 */
const { createConfigStore, adminRoutes } = require('openvibe-shared/config');
const { sql } = require('openvibe-sdk/db');
const {
    SENDING_NAMESPACE, RECEIVING_NAMESPACE, DNS_NAMESPACE,
    SENDING_PROVIDERS, RECEIVING_PROVIDERS, DNS_PROVIDER,
    ALL_FIELDS, SECRET_KEYS, fieldsOf,
} = require('./mail-providers');
const { PROBES } = require('./mail-probes');
const { checkDomain } = require('./dns-check');

const SERVICE = 'mail';
const BASE_PATH = '/internal/config';
const GROUP = 'Email';

/** The schema of a namespace, built from the provider registry, so a provider is described in one place only. */
function schemaFor(title, description, providers) {
    return Object.freeze({
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        title,
        description,
        type: 'object',
        additionalProperties: false,
        properties: Object.fromEntries(providers.flatMap((provider) => provider.keys.map((key) => [key.name, {
            type: 'string',
            minLength: key.required ? 1 : 0,
            maxLength: 512,
            ...(key.pattern ? { pattern: key.pattern } : {}),
            title: key.title,
            description: key.words,
            'x-group': provider.group || GROUP,
            'x-example': key.example,
            'x-owner-input': {
                group: 'email',
                unlocks: provider.unlocks,
                get_it_at: provider.get_it_at,
                get_it_how: provider.get_it_how,
                test: true,
            },
            'x-required-for': provider.requiredFor,
        }]))),
    });
}

const SENDING_SCHEMA = schemaFor(
    'Mail providers',
    'The providers OpenVibe.Mail sends mail with: Amazon SES, Postmark, Resend, Mailgun, SendGrid, Brevo and a plain SMTP relay. A provider with no key is skipped; the test of a provider only reads from it and never sends a letter.',
    SENDING_PROVIDERS,
);

const RECEIVING_SCHEMA = schemaFor(
    'Receiving mail',
    'How OpenVibe.Mail receives mail: Cloudflare Email Routing forwards the mail of a domain to the address you chose. The test reads your routing rules and changes nothing.',
    RECEIVING_PROVIDERS,
);

const DNS_SCHEMA = schemaFor(
    'Mail records',
    'The mail records a sending domain needs: MX, SPF, DKIM, DMARC and, if you want a logo in the inbox, BIMI. The test reads them live and names the record to add with the exact value to paste.',
    [DNS_PROVIDER],
);

const NAMESPACES = [SENDING_NAMESPACE, RECEIVING_NAMESPACE, DNS_NAMESPACE];
const classify = (key) => (SECRET_KEYS.has(key) ? 'secret' : 'internal');

/** The words of a failure, without a key in it. */
function safeWords(value, secrets) {
    let words = String((value && value.message) || value || 'the request failed').split(/\s+/).join(' ');
    for (const secret of secrets) if (secret && secret.length > 3) words = words.split(secret).join('[redacted]');
    return words.slice(0, 200);
}

function createSettings({ db, config = {}, env = process.env, log = console, fetchImpl = globalThis.fetch, probes = null, lookups = null, keks = undefined } = {}) {
    const stores = {};
    const ready = Promise.all(NAMESPACES.map((namespace) => createConfigStore({
        db, service: SERVICE, namespace,
        schema: namespace === SENDING_NAMESPACE ? SENDING_SCHEMA : namespace === RECEIVING_NAMESPACE ? RECEIVING_SCHEMA : DNS_SCHEMA,
        classify,
        env: env || process.env,
        ...(keks ? { keks } : {}),
        log,
    }))).then((made) => {
        stores.sending = made[0];
        stores.receiving = made[1];
        stores.dns = made[2];
        return made[0];
    });

    /** The values of one namespace, read from the vault. */
    const values = (namespace) => (stores[namespace === SENDING_NAMESPACE ? 'sending' : namespace === RECEIVING_NAMESPACE ? 'receiving' : 'dns']
        ? stores[namespace === SENDING_NAMESPACE ? 'sending' : namespace === RECEIVING_NAMESPACE ? 'receiving' : 'dns'].get()
        : {});

    /** The credentials of a provider, read from the vault. */
    function credsOf(provider) {
        const stored = values(provider === DNS_PROVIDER ? DNS_NAMESPACE : SENDING_PROVIDERS.includes(provider) ? SENDING_NAMESPACE : RECEIVING_NAMESPACE);
        const out = {};
        for (const key of provider.keys) {
            const value = stored[key.name];
            out[key.local] = value == null ? '' : String(value);
        }
        return out;
    }

    /** The secret values of a provider, so a refusal never carries one. */
    function secretsOf(provider) {
        return provider.keys.filter((key) => key.secret).map((key) => credsOf(provider)[key.local]).filter(Boolean);
    }

    /** The test of a provider: one cheap authenticated read that never sends. */
    async function testProvider(provider) {
        const creds = credsOf(provider);
        const missing = provider.keys.filter((key) => key.required && !creds[key.local]);
        if (missing.length) {
            return { ok: false, message: `${provider.name} is not set up yet: paste the ${missing.map((key) => key.title).join(' and ')} first.` };
        }
        const probe = (probes && probes[provider.id]) || PROBES[provider.id];
        if (!probe) return { ok: false, message: `${provider.name} has no test yet.` };
        try {
            const answer = await probe(creds, { fetchImpl });
            return { ok: answer.ok !== false, message: String(answer.detail || answer.message || 'It works.') };
        } catch (err) {
            return { ok: false, message: `failed — ${provider.name} said: ${safeWords(err, secretsOf(provider))}` };
        }
    }

    /**
     * The DNS check: the live records of the named sending domain, with the exact value to add for the one that is
     * missing. What OpenVibe knows is asked of the database: the MX hosts of a domain it receives mail for, the
     * SPF includes and the DKIM records of the providers a domain is configured with.
     */
    async function testDns() {
        const domain = String((values(DNS_NAMESPACE) || {}).dns_check_domain || '').trim().toLowerCase().replace(/\.$/, '');
        if (!domain) return { ok: false, message: 'Name the sending domain to check first: put it in the field and save.' };
        let rows = [];
        let custom = null;
        try {
            rows = await db.many(sql`SELECT d.spf_include, d.dkim_records FROM mail_outbound_domains d
                JOIN mail_outbound_providers p ON p.id = d.provider_id AND p.enabled = true WHERE d.domain = ${domain}`);
        } catch { /* the table is not there yet: the check goes on without it */ }
        try {
            custom = await db.maybe(sql`SELECT domain FROM mail_custom_domains WHERE domain = ${domain}`);
        } catch { /* the same */ }

        const includes = [...new Set(rows.map((row) => row.spf_include).filter(Boolean))];
        if (!includes.length) {
            // No domain row: the provider whose key is in the vault still knows its own include.
            const provider = SENDING_PROVIDERS.find((item) => item.spfInclude && credsOf(item)[item.keys[0].local]);
            if (provider) includes.push(provider.spfInclude);
        }
        const spfValue = includes.length ? `v=spf1 ${includes.map((host) => `include:${host}`).join(' ')} -all` : null;
        const dkimRecords = rows.flatMap((row) => {
            let list = [];
            try { list = typeof row.dkim_records === 'string' ? JSON.parse(row.dkim_records) : (row.dkim_records || []); } catch { list = []; }
            return Array.isArray(list) ? list : [];
        });
        const mxHosts = custom ? ((config.inbound && config.inbound.mx) || []) : [];
        const dmarcValue = `v=DMARC1; p=none; rua=mailto:dmarc@${domain}`;
        try {
            const answer = await checkDomain({
                domain, mxHosts, spfValue, spfIncludes: includes, dkimRecords, dmarcValue,
                lookupMx: (lookups && lookups.mx) || undefined,
                lookupTxt: (lookups && lookups.txt) || undefined,
            });
            const message = answer.message || (answer.ok ? 'ok — every record is there.' : 'failed — some records are missing.');
            return { ok: answer.ok, message, lines: answer.lines };
        } catch (err) {
            return { ok: false, message: `failed — the lookup of ${domain} did not finish: ${safeWords(err, [])}` };
        }
    }

    /** The test of any field of these namespaces. */
    async function test(namespace, key) {
        if (namespace === DNS_NAMESPACE) return key === 'dns_check_domain' ? await testDns() : { ok: false, message: 'That setting has no test.' };
        const field = ALL_FIELDS.find((item) => item.name === key && item.namespace === namespace);
        if (!field) return { ok: false, message: 'That setting has no test.' };
        return await testProvider(field.provider);
    }

    function mount(app, { guard, log: appLog = log } = {}) {
        if (!stores.sending) throw new Error('createSettings: await ready before mount()');
        const routes = adminRoutes([stores.sending, stores.receiving, stores.dns], {
            basePath: BASE_PATH,
            requireAdmin: guard,
            actor: (req) => {
                const id = String(req.get('x-ov-subject') || '').trim();
                return /^usr_[0-9A-HJKMNP-TV-Z]{26}$/.test(id) ? { type: 'user', id } : null;
            },
            requireFresh: (req) => String(req.get('x-ov-fresh') || '') === '1',
            log: appLog,
        });
        // The owner's test route stands in front of the store's dispatcher: openvibe-shared's own test hook wants an
        // acting subject, this one the service-token capability of the proxy.
        app.post(`${BASE_PATH}/:namespace/test/:key`, guard, async (req, res) => {
            if (!NAMESPACES.includes(req.params.namespace)) return res.status(404).json({ error: 'no such configuration namespace' });
            let key = String(req.params.key || '');
            try { key = decodeURIComponent(key); } catch { /* keep it as it is */ }
            const schema = req.params.namespace === SENDING_NAMESPACE ? SENDING_SCHEMA : req.params.namespace === RECEIVING_NAMESPACE ? RECEIVING_SCHEMA : DNS_SCHEMA;
            if (!schema.properties[key]) return res.status(404).json({ error: 'no such setting' });
            try {
                const out = await test(req.params.namespace, key);
                const message = String(out.message || '').replace(/\s+/g, ' ').trim().slice(0, 300);
                return res.status(200).json({ ok: Boolean(out.ok), message, detail: out.lines || message });
            } catch (err) {
                appLog.warn(`[config] ${req.params.namespace}: the test for ${key} failed: ${String((err && err.message) || err).slice(0, 160)}`);
                return res.status(200).json({ ok: false, message: 'failed — the test did not finish. The service log has the reason.' });
            }
        });
        app.use(routes.handle);
        return routes;
    }

    return {
        service: SERVICE,
        namespaces: NAMESPACES,
        sendingSchema: SENDING_SCHEMA, receivingSchema: RECEIVING_SCHEMA, dnsSchema: DNS_SCHEMA,
        ready, values, credsOf, test, testProvider, testDns, mount, stores,
    };
}

module.exports = {
    SERVICE, BASE_PATH, SENDING_NAMESPACE, RECEIVING_NAMESPACE, DNS_NAMESPACE,
    SENDING_SCHEMA, RECEIVING_SCHEMA, DNS_SCHEMA, schemaFor, classify, createSettings,
};
