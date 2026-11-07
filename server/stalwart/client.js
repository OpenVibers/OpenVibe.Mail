'use strict';

/**
 * The mail server (Stalwart) over loopback: JMAP for reading a person's mail, the management API for the domains
 * and for the cache.
 *
 * Two things are worth knowing about the shape of this client.
 *
 * The service reads a person's mailbox as the server's administrator and names the account it wants, because the
 * mail server has one account per person and the service has to be able to read any of them. The administrator
 * credential never leaves this file and never goes near a log line.
 *
 * The service never writes a message body anywhere. `messageBody` fetches one blob to read it, hands the text to
 * the code extractor, and forgets it: the body of a message is not a log line, not an event and not a database row.
 */
const { URL } = require('url');

const USING = ['urn:ietf:params:jmap:core', 'urn:stalwart:jmap', 'urn:ietf:params:jmap:mail', 'urn:ietf:params:jmap:blob'];
const ADDRESS_RE = /^[^\s@<>,;:"]+@[^\s@<>,;:"]+$/;

function basicAuth(user, password) {
    return 'Basic ' + Buffer.from(`${user}:${password}`, 'utf8').toString('base64');
}

class StalwartError extends Error {
    constructor(message, { status = 0, code = '' } = {}) {
        super(message);
        this.name = 'StalwartError';
        this.status = status;
        this.code = code;
    }
}

function createStalwartClient({ config, fetchImpl = globalThis.fetch, log = console } = {}) {
    const base = String(config.stalwart.url || '').replace(/\/+$/, '');
    const auth = basicAuth(config.stalwart.adminUser || 'admin', config.stalwart.adminPassword || '');
    const timeoutMs = config.stalwart.requestTimeoutMs || 20_000;
    const accountCache = new Map(); // mailbox address → account id

    async function jmap(methodCalls, { accountId = null } = {}) {
        const body = { using: USING, methodCalls: methodCalls.map(([name, args, id]) => [name, args, id]) };
        const res = await fetchImpl(`${base}/jmap`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: auth },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(timeoutMs),
        });
        const text = await res.text();
        let parsed = null;
        try { parsed = JSON.parse(text); } catch { /* the error below says more */ }
        if (!res.ok || !parsed || !Array.isArray(parsed.methodResponses)) {
            const detail = (parsed && (parsed.detail || parsed.description)) || `HTTP ${res.status}`;
            throw new StalwartError(`the mail server refused a request: ${String(detail).slice(0, 200)}`, { status: res.status });
        }
        return parsed.methodResponses.map(([name, result, id]) => ({ name, result, id }));
    }

    /** One method call, unwrapped: the result or a thrown error. */
    async function one(name, args, id = '0') {
        const [response] = await jmap([[name, args, id]]);
        if (!response) throw new StalwartError('the mail server answered nothing');
        if (response.name === 'error') {
            throw new StalwartError(`the mail server refused ${name}: ${response.result.description || response.result.type}`, {
                status: 0,
                code: response.result.type || '',
            });
        }
        return response.result;
    }

    /**
     * The mail server's account id for a person's mailbox (alice@openvibe.email → the account "alice"). The
     * account is created by the mail server itself the first time a message is delivered, so this may answer null
     * for a person who has not received anything yet.
     */
    async function accountIdFor(mailboxAddress) {
        const key = String(mailboxAddress || '').toLowerCase();
        if (!ADDRESS_RE.test(key)) throw new StalwartError('a mailbox address is needed');
        if (accountCache.has(key)) return accountCache.get(key);
        const local = key.slice(0, key.lastIndexOf('@'));
        const result = await one('x:Account/query', { filter: {}, limit: 500 }, 'q');
        const ids = result.ids || [];
        if (ids.length) {
            const accounts = await one('x:Account/get', { ids, properties: ['id', 'name'] }, 'g');
            const found = (accounts.list || []).find((a) => {
                const name = String(a.name || '').toLowerCase();
                // Stalwart names the account by the local part; a later release may use the full address.
                return name === local || name === key;
            });
            if (found) {
                accountCache.set(key, found.id);
                return found.id;
            }
        }
        return null;
    }

    /**
     * The recipients of one message, as they are stored: the `Delivered-To` header Stalwart writes for every
     * delivery, then the To and Cc it parsed from the message itself.
     *
     * The header is the one that identifies a mask or burner reliably: a Bcc delivery has no To, and a message
     * with a missing or broken To header still carries the address the SMTP envelope named. Stalwart's `to`
     * filter only searches the parsed header, so the recipient is checked here, where both are visible.
     */
    function recipientsOf(message) {
        const out = new Set();
        const delivered = message['header:Delivered-To'];
        if (delivered) {
            for (const value of Array.isArray(delivered) ? delivered : [delivered]) {
                const address = String(value || '').trim().toLowerCase();
                if (address) out.add(address);
            }
        }
        for (const group of [message.to, message.cc]) {
            for (const address of group || []) {
                if (address && address.email) out.add(String(address.email).toLowerCase());
            }
        }
        return out;
    }

    /**
     * The newest messages of a person's mailbox that were sent to one of our addresses. Metadata only: the id, the
     * sender, the subject and when it arrived. There is no preview and no body: the body is read once, by the code
     * extractor, and forgotten.
     *
     * A recipient is checked against the message's own `Delivered-To` header and its To/Cc, not left to the
     * server's `to` filter: that filter matches only a parsed To header, and a mask may be reached through Bcc or
     * through an alias the header never names. The scan is bounded, so a busy mailbox does not make a burner's
     * code wait for every older letter.
     */
    async function listMessages({ mailboxAddress, recipient = null, limit = 20 }) {
        const accountId = await accountIdFor(mailboxAddress);
        if (!accountId) return [];
        const wanted = recipient ? String(recipient).toLowerCase() : null;
        const perPage = Math.min(Math.max(Number(limit) || 20, 1), 100);
        const scan = wanted ? Math.min(Math.max(perPage * 5, 50), 200) : perPage;
        const queried = await one('Email/query', {
            accountId,
            filter: {},
            limit: scan,
            sort: [{ property: 'receivedAt', isAscending: false }],
        }, 'q');
        const ids = queried.ids || [];
        if (!ids.length) return [];
        const got = await one('Email/get', {
            accountId,
            ids,
            properties: ['id', 'from', 'to', 'cc', 'subject', 'receivedAt', 'keywords', 'header:Delivered-To'],
        }, 'e');
        const messages = [];
        for (const m of got.list || []) {
            if (wanted && !recipientsOf(m).has(wanted)) continue;
            messages.push({
                id: m.id,
                from: (m.from || []).map((a) => a.email).filter(Boolean),
                to: (m.to || []).map((a) => a.email).filter(Boolean),
                subject: m.subject || null,
                receivedAt: m.receivedAt || null,
                spam: Boolean(m.keywords && m.keywords.$junk),
            });
            if (messages.length >= perPage) break;
        }
        return messages;
    }

    /**
     * Delete messages from a mailbox: a burner's mail when it expires, and nothing else.
     *
     * The ids come from a query filtered by the burner's own address, so only that burner's mail goes.
     */
    async function deleteMessages({ mailboxAddress, ids }) {
        const list = (ids || []).filter(Boolean);
        if (!list.length) return 0;
        const accountId = await accountIdFor(mailboxAddress);
        if (!accountId) return 0;
        const result = await one('Email/set', { accountId, destroy: list }, 's');
        return (result.destroyed || []).length;
    }

    /**
     * The body of one message, as text and as html. Used by the code extractor and by nothing else: the caller
     * must not keep it.
     */
    async function messageBody({ mailboxAddress, id }) {
        const accountId = await accountIdFor(mailboxAddress);
        if (!accountId) return { text: '', html: '' };
        const got = await one('Email/get', {
            accountId,
            ids: [id],
            properties: ['id', 'textBody', 'htmlBody'],
        }, 'e');
        const email = (got.list || [])[0];
        if (!email) return { text: '', html: '' };
        // The same blob may be named by both lists (a text-only message is both its text and its html body).
        // Keep the first name and its part type: the type is what says whether the bytes are html.
        const parts = new Map();
        for (const [group, asHtml] of [[email.textBody, false], [email.htmlBody, true]]) {
            for (const part of group || []) {
                if (!part || !part.blobId || parts.has(part.blobId)) continue;
                parts.set(part.blobId, { asHtml, type: String(part.type || '').toLowerCase() });
            }
        }
        if (!parts.size) return { text: '', html: '' };
        const blobs = await one('Blob/get', {
            accountId,
            ids: [...parts.keys()],
            properties: ['data:asText', 'type'],
        }, 'b');
        let text = '';
        let html = '';
        for (const blob of blobs.list || []) {
            const value = blob['data:asText'];
            if (typeof value !== 'string') continue;
            const part = parts.get(blob.id) || { asHtml: false, type: String(blob.type || '').toLowerCase() };
            const isHtml = (part.asHtml && part.type !== 'text/plain') || (!part.type && /<[a-z][\s\S]*>/i.test(value));
            if (isHtml) html += `${html ? '\n' : ''}${value}`;
            else text += `${text ? '\n' : ''}${value}`;
        }
        return { text, html };
    }

    /** Forget the directory's answers, so an address that was turned off stops resolving at once. */
    async function invalidateCaches() {
        const result = await one('x:Action/set', { create: { invalidate: { '@type': 'InvalidateCaches' } } }, 'a');
        if (result && result.notCreated && Object.keys(result.notCreated).length) {
            const detail = Object.values(result.notCreated)[0];
            throw new StalwartError(`the mail server did not invalidate its cache: ${(detail && detail.description) || 'refused'}`);
        }
        return true;
    }

    /** Make sure the mail server accepts a domain (a burner domain that was added to the configuration). */
    async function ensureDomain(name) {
        const domain = String(name || '').trim().toLowerCase();
        if (!domain) throw new StalwartError('a domain name is needed');
        const existing = await listDomains();
        if (existing.some((d) => String(d.name || '').toLowerCase() === domain)) return false;
        const result = await one('x:Domain/set', {
            create: {
                [domain]: { '@type': 'Domain', name: domain, enable: true, allowRelaying: false },
            },
        }, 'd');
        const refused = result && result.notCreated && result.notCreated[domain];
        if (refused) {
            throw new StalwartError(`the mail server refused the domain ${domain}: ${refused.description || refused.type || 'refused'}`);
        }
        return Boolean(result && result.created && result.created[domain]);
    }

    /** Which domains the mail server knows, so a new burner domain can be checked against it. */
    async function listDomains() {
        const result = await one('x:Domain/query', { filter: {}, limit: 500 }, 'q');
        const ids = result.ids || [];
        if (!ids.length) return [];
        const got = await one('x:Domain/get', { ids, properties: ['id', 'name', 'enable'] }, 'g');
        return got.list || [];
    }

    return {
        jmap,
        one,
        accountIdFor,
        listMessages,
        deleteMessages,
        messageBody,
        invalidateCaches,
        ensureDomain,
        listDomains,
        forgetAccount: (mailboxAddress) => accountCache.delete(String(mailboxAddress || '').toLowerCase()),
    };
}

module.exports = { createStalwartClient, StalwartError, ADDRESS_RE };
