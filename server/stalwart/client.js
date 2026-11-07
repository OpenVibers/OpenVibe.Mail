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

    let domainCache = null;
    async function domainNames() {
        if (domainCache) return domainCache;
        const domains = await listDomains();
        domainCache = new Map(domains.map((d) => [String(d.id), String(d.name || '').toLowerCase()]));
        return domainCache;
    }

    /**
     * The mail server's account id for a mailbox address. Stalwart names an account by its local part and points it
     * at a domain, so the full address is `name@domain`; a burner and a person can share a local part on different
     * domains. The account is created by the mail server itself when a directory row first receives mail, so this
     * may answer null before the first message.
     */
    async function accountIdFor(mailboxAddress) {
        const key = String(mailboxAddress || '').toLowerCase();
        if (!ADDRESS_RE.test(key)) throw new StalwartError('a mailbox address is needed');
        if (accountCache.has(key)) return accountCache.get(key);
        const local = key.slice(0, key.lastIndexOf('@'));
        const domains = await domainNames();
        let position = 0;
        // An account list can be longer than one page once there are hundreds of burners. Walk it until the
        // matching full address is found; if two accounts claim it, refuse rather than read the wrong mailbox.
        for (let page = 0; page < 20; page++) {
            const result = await one('x:Account/query', { filter: {}, limit: 500, position }, 'q');
            const ids = result.ids || [];
            if (!ids.length) return null;
            const accounts = await one('x:Account/get', {
                ids,
                properties: ['id', 'name', 'domainId', 'aliases'],
            }, 'g');
            const matches = (accounts.list || []).filter((a) => {
                const name = String(a.name || '').toLowerCase();
                if (name.includes('@')) return name === key;
                if (name !== local) return false;
                const domain = a.domainId === undefined || a.domainId === null
                    ? null
                    : domains.get(String(a.domainId));
                // If the server did not give the domain, one local-only match is unambiguous; more than one is not.
                return domain ? `${name}@${domain}` === key : true;
            });
            if (matches.length === 1) {
                accountCache.set(key, matches[0].id);
                return matches[0].id;
            }
            if (matches.length > 1) return null;
            if (ids.length < 500) return null;
            position += ids.length;
        }
        return null;
    }

    /**
     * The envelope recipient Stalwart stamped at delivery, and only that.
     *
     * Stalwart prepends `Delivered-To` for the SMTP envelope recipient. A sender can put their own `Delivered-To`,
     * `To` or `Cc` in the message, so the first `Delivered-To` is the only one that says where the server actually
     * delivered. A message with no server stamp has no attributable recipient and matches nothing.
     */
    function stampedRecipient(message) {
        const headers = message.headers || [];
        const first = headers.find((h) => String(h && h.name || '').toLowerCase() === 'delivered-to');
        if (!first) return null;
        let value = String(first.value || '').trim().toLowerCase();
        const angle = /<([^>]+)>/.exec(value);
        if (angle) value = angle[1].trim().toLowerCase();
        return value || null;
    }

    /**
     * The newest messages of a mailbox. Metadata only: the id, the sender, the subject and when it arrived. There
     * is no preview and no body: the body is read once, by the code extractor, and forgotten.
     *
     * A burner's mailbox is the burner, so `recipient` is null and every message in the account is its own. A mask
     * or agent inbox shares the person's mailbox, so `recipient` is set and a message is kept only when the first
     * `Delivered-To` header — the one Stalwart stamps — names it. Sender-written To/Cc/Delivered-To is never read.
     */
    async function listMessages({ mailboxAddress, recipient = null, limit = 20 }) {
        const accountId = await accountIdFor(mailboxAddress);
        if (!accountId) return [];
        const wanted = recipient ? String(recipient).trim().toLowerCase() : null;
        const perPage = Math.min(Math.max(Number(limit) || 20, 1), 100);
        // A shared mailbox needs a larger window to find an address's mail; the account never changes the answer
        // for a burner. 500 is a bound, not a correctness rule: the match is on the server's stamp.
        const scan = wanted ? Math.min(Math.max(perPage * 25, 100), 500) : perPage;
        const queried = await one('Email/query', {
            accountId,
            filter: {},
            limit: scan,
            sort: [{ property: 'receivedAt', isAscending: false }],
        }, 'q');
        const ids = queried.ids || [];
        if (!ids.length) return [];
        const properties = ['id', 'from', 'subject', 'receivedAt', 'keywords'];
        if (wanted) properties.push('headers');
        const got = await one('Email/get', { accountId, ids, properties }, 'e');
        const messages = [];
        for (const m of got.list || []) {
            if (wanted && stampedRecipient(m) !== wanted) continue;
            messages.push({
                id: m.id,
                from: (m.from || []).map((a) => a.email).filter(Boolean),
                subject: m.subject || null,
                receivedAt: m.receivedAt || null,
                spam: Boolean(m.keywords && m.keywords.$junk),
            });
            if (messages.length >= perPage) break;
        }
        return messages;
    }

    /**
     * Delete messages from a mailbox: a burner's mail when it expires, and nothing else. A burner's mailbox is its
     * own account, so every id in it belongs to that burner.
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

    /**
     * Delete the Stalwart account a burner owned. The purge job removes the directory row first (so the address
     * stops resolving), then the account's mail and, here, the empty account itself. An account that never received
     * anything does not exist and needs no deletion.
     */
    async function destroyAccount({ mailboxAddress }) {
        const key = String(mailboxAddress || '').toLowerCase();
        const accountId = await accountIdFor(key);
        if (!accountId) return false;
        const result = await one('x:Account/set', { destroy: [accountId] }, 'd');
        const destroyed = (result.destroyed || []).map(String).includes(String(accountId));
        if (!destroyed) {
            const why = result && result.notDestroyed && result.notDestroyed[accountId];
            throw new StalwartError(`the mail server did not destroy the burner account: ${(why && (why.description || why.type)) || 'refused'}`);
        }
        accountCache.delete(key);
        // The directory row is already gone; the account must be gone too, or the address could still resolve
        // through the server's account cache. If it is still there, keep the burner row for the next purge run.
        if (await accountIdFor(key)) {
            throw new StalwartError(`the burner account ${key} still exists after destroy`);
        }
        return true;
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
        domainCache = null;
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

    // ---- reading your own mail (M1.5): the owner's page asks, the answer goes to them and is not kept ----

    const READ_LIST_PROPS = ['id', 'from', 'to', 'subject', 'receivedAt', 'keywords', 'hasAttachment', 'headers'];

    /**
     * A page of the person's mailbox, newest first. `recipient` keeps the messages the server stamped for one of their
     * addresses (a mask or an agent inbox); without it, every message in the mailbox. `position` is where the last page
     * stopped in the mailbox's own order. Answers { messages, next } (next is null at the end).
     */
    async function readMessages({ mailboxAddress, recipient = null, position = 0, limit = 50 }) {
        const accountId = await accountIdFor(mailboxAddress);
        if (!accountId) return { messages: [], next: null };
        const wanted = recipient ? String(recipient).trim().toLowerCase() : null;
        const perPage = Math.min(Math.max(Number(limit) || 50, 1), 100);
        const scan = wanted ? 500 : perPage;
        const start = Math.max(0, Math.floor(Number(position) || 0));
        const queried = await one('Email/query', { accountId, filter: {}, sort: [{ property: 'receivedAt', isAscending: false }], position: start, limit: scan }, 'q');
        const ids = queried.ids || [];
        if (!ids.length) return { messages: [], next: null };
        const got = await one('Email/get', { accountId, ids, properties: READ_LIST_PROPS }, 'e');
        const byId = new Map((got.list || []).map((m) => [m.id, m]));
        const messages = [];
        let used = 0;
        for (const id of ids) {
            used += 1;
            const m = byId.get(id);
            if (!m) continue;
            const to = stampedRecipient(m);
            if (wanted && to !== wanted) continue;
            messages.push({
                id: m.id,
                from: (m.from || []).map((a) => (a.name ? `${a.name} <${a.email}>` : a.email)).filter(Boolean),
                to: to ? [to] : (m.to || []).map((a) => a.email).filter(Boolean).slice(0, 1),
                subject: m.subject || null,
                receivedAt: m.receivedAt || null,
                unread: !(m.keywords && m.keywords.$seen),
                hasAttachment: Boolean(m.hasAttachment),
                spam: Boolean(m.keywords && m.keywords.$junk),
            });
            if (messages.length >= perPage) break;
        }
        const more = used < ids.length || ids.length === scan;
        return { messages, next: more ? start + used : null };
    }

    /**
     * One message for its owner to read: headers that matter, the text and HTML bodies (each at most 1 MB, raw: the
     * caller cleans the HTML), and the attachments (part id, name, type, size). Null when it is not in that mailbox.
     */
    async function readMessage({ mailboxAddress, id }) {
        const accountId = await accountIdFor(mailboxAddress);
        if (!accountId) return null;
        const got = await one('Email/get', {
            accountId, ids: [id],
            properties: ['id', 'from', 'to', 'cc', 'subject', 'receivedAt', 'sentAt', 'keywords', 'textBody', 'htmlBody', 'attachments', 'bodyValues'],
            fetchTextBodyValues: true, fetchHTMLBodyValues: true, maxBodyValueBytes: 1024 * 1024,
        }, 'e');
        const m = (got.list || [])[0];
        if (!m) return null;
        const values = m.bodyValues || {};
        const join = (parts, html) => (parts || [])
            .filter((p) => p && values[p.partId] && (html ? String(p.type || '').toLowerCase() === 'text/html' : String(p.type || '').toLowerCase() !== 'text/html'))
            .map((p) => values[p.partId].value).join('\n');
        const addr = (list) => (list || []).map((a) => (a.name ? `${a.name} <${a.email}>` : a.email)).filter(Boolean);
        return {
            id: m.id,
            from: addr(m.from), to: addr(m.to), cc: addr(m.cc),
            subject: m.subject || null,
            date: m.sentAt || m.receivedAt || null,
            unread: !(m.keywords && m.keywords.$seen),
            text: join(m.textBody, false),
            html: join(m.htmlBody, true),
            attachments: (m.attachments || []).filter((a) => a && a.blobId).map((a) => ({ part: String(a.partId || a.blobId), blobId: a.blobId, name: a.name || null, type: a.type || null, size: Number(a.size) || 0 })),
        };
    }

    /** An attachment's bytes, when that part belongs to that message in that mailbox; null otherwise. */
    async function readAttachment({ mailboxAddress, id, part, maxBytes = 25 * 1024 * 1024 }) {
        const message = await readMessage({ mailboxAddress, id });
        if (!message) return null;
        const att = message.attachments.find((a) => a.part === String(part));
        if (!att) return null;
        if (att.size > maxBytes) throw new StalwartError('the attachment is too large to download here', { status: 413, code: 'mail.attachment_too_large' });
        const accountId = await accountIdFor(mailboxAddress);
        const blobs = await one('Blob/get', { accountId, ids: [att.blobId], properties: ['data:asBase64', 'size'] }, 'b');
        const blob = (blobs.list || [])[0];
        if (!blob || typeof blob['data:asBase64'] !== 'string') return null;
        return { name: att.name, type: att.type, bytes: Buffer.from(blob['data:asBase64'], 'base64') };
    }

    /** Read or unread, on the person's own message. */
    async function setSeen({ mailboxAddress, id, seen }) {
        const accountId = await accountIdFor(mailboxAddress);
        if (!accountId) return false;
        const result = await one('Email/set', { accountId, update: { [id]: { 'keywords/$seen': seen ? true : null } } }, 's');
        return Boolean(result.updated && Object.prototype.hasOwnProperty.call(result.updated, id));
    }

    /** Move a message to the mailbox's Trash (Stalwart expunges it after its retention); false when it is not there. */
    async function trashMessage({ mailboxAddress, id }) {
        const accountId = await accountIdFor(mailboxAddress);
        if (!accountId) return false;
        const boxes = await one('Mailbox/query', { accountId, filter: { role: 'trash' } }, 'm');
        const trash = (boxes.ids || [])[0];
        if (!trash) {
            const result = await one('Email/set', { accountId, destroy: [id] }, 's');
            return (result.destroyed || []).includes(id);
        }
        const result = await one('Email/set', { accountId, update: { [id]: { mailboxIds: { [trash]: true } } } }, 's');
        return Boolean(result.updated && Object.prototype.hasOwnProperty.call(result.updated, id));
    }

    return {
        jmap,
        one,
        accountIdFor,
        listMessages,
        readMessages,
        readMessage,
        readAttachment,
        setSeen,
        trashMessage,
        deleteMessages,
        destroyAccount,
        messageBody,
        invalidateCaches,
        ensureDomain,
        listDomains,
        forgetAccount: (mailboxAddress) => accountCache.delete(String(mailboxAddress || '').toLowerCase()),
    };
}

module.exports = { createStalwartClient, StalwartError, ADDRESS_RE };
