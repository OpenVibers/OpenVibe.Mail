'use strict';
/**
 * openvibe.email's page (Opus, 11-07): a ten-minute address that shows its code, for anyone, and a signed-in person's
 * own addresses. It is drawn by openvibe-shared/shell (the navbar, the footer, the theme), complete without
 * JavaScript except for the parts that need the API, and it says only what M1 does today: it receives, shows a code,
 * and never shows a message body.
 *
 *   GET /           the page
 *   GET /css/*, /js/*   its own files, by content hash (immutable when the hash matches)
 *   GET /shared/*   openvibe-shared's files
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const shell = require('openvibe-shared/shell');
const ovServe = require('openvibe-shared/serve');
const cache = require('openvibe-shared/cache-policy');
const contracts = require('openvibe-contracts');

const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');
const NETWORK_URL = 'https://openvibe.network';

/**
 * The navbar's service id and display name from the site block in OpenVibe.Contracts (the `mail` manifest), with the
 * names the page shipped with before that manifest existed. The site block says "Email", so the page reads
 * "OpenVibe.Email"; the service id is what Shared's navbar, history and theme use.
 */
function siteIdentity(manifest) {
    const short = manifest && manifest.site && manifest.site.name;
    return {
        service: (manifest && manifest.id) || 'mail',
        name: short ? (/^Open[A-Z]/.test(short) ? short : `OpenVibe.${short}`) : 'OpenVibe.Email',
    };
}
const SITE = siteIdentity(contracts.services && contracts.services.get && contracts.services.get('mail'));
const SITE_NAME = SITE.name;
const SERVICE = SITE.service;

const hashes = new Map();
function assetVersion(rel) {
    if (hashes.has(rel)) return hashes.get(rel);
    let v = 'dev';
    try { v = crypto.createHash('sha256').update(fs.readFileSync(path.join(PUBLIC_DIR, rel))).digest('hex').slice(0, 10); } catch { /* missing */ }
    hashes.set(rel, v);
    return v;
}
const asset = (rel) => `/${rel}?v=${assetVersion(rel)}`;

/** The page's own policy: its scripts, Shared's, Network's sign-in, and nothing framed. */
const CSP = [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' https://openvibe.network https://static.cloudflareinsights.com",
    "style-src 'self' 'unsafe-inline' https://openvibe.network https://fonts.googleapis.com",
    "font-src 'self' data: https://fonts.gstatic.com",
    "img-src 'self' data: https://openvibe.network https://openvibe.media",
    "connect-src 'self' https://openvibe.network https://openvibe.chat https://openvibe.events https://cloudflareinsights.com",
    "frame-src 'self' https://openvibe.network",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self' https://openvibe.network",
].join('; ');

const BODY = fs.readFileSync(path.join(__dirname, '..', 'views', 'home.html'), 'utf8');

function homePage(config) {
    const base = String(config.baseUrl || 'https://openvibe.email').replace(/\/+$/, '');
    const nav = {
        service: SERVICE,
        apiBase: NETWORK_URL,
        links: [{ label: 'Home', href: '/', active: true }],
        history: { type: 'page', title: SITE_NAME },
        silentLogin: `${base}/auth/login?silent=1&next={url}`,
        sessionUrl: '/auth/me',
        loginUrl: '/auth/login?next={path}',
        logoutUrl: '/auth/logout?next={path}',
    };
    const footer = { service: SERVICE, variant: 'full', mount: '#ov-footer', brandName: SITE_NAME };
    return shell.page({
        name: SITE_NAME,
        lang: 'en',
        title: `${SITE_NAME}: an address for every sign-up`,
        siteName: SITE_NAME,
        description: 'Ten-minute addresses that show you the code, and inboxes your agents can read. Receive only: nothing here sends mail.',
        canonical: `${base}/`,
        robots: 'index, follow',
        jsonLd: [{ '@context': 'https://schema.org', '@type': 'WebApplication', name: SITE_NAME, url: `${base}/`, applicationCategory: 'CommunicationApplication', offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' } }],
        home: '/',
        navLinks: nav.links,
        navbar: nav,
        footer,
        head: `<meta name="referrer" content="strict-origin-when-cross-origin">
<link rel="stylesheet" href="${ovServe.url('kit.css')}">
<link rel="stylesheet" href="${asset('css/mail.css')}">
<script src="${asset('js/mail.js')}" defer></script>`,
        body: `<a class="skip" href="#main">Skip to content</a>
<div id="navbar-mount"></div>
${BODY}
<script>
window.__OV_PAGE = ${JSON.stringify({ navbar: nav, footer }).replace(/</g, '\\u003c')};
document.addEventListener('DOMContentLoaded', function () {
  try { if (window.OpenVibeFooter) OpenVibeFooter.init(window.__OV_PAGE.footer); } catch (e) { /* the Frame is optional */ }
});
</script>`,
    });
}

/**
 * The inbox (M1.5): the shell public/js/inbox.js fills from /api/v1/me/mail/*. Its policy differs from the home page's
 * in one way: a message's frame inherits it, so img-src allows https images, which the frame's own policy keeps off
 * until the person asks to show them (public/js/inbox.js frameFor).
 */
const INBOX_CSP = CSP.replace("img-src 'self' data: https://openvibe.network https://openvibe.media", "img-src 'self' data: https:");

function inboxPage(config) {
    const base = String(config.baseUrl || 'https://openvibe.email').replace(/\/+$/, '');
    const nav = {
        service: SERVICE,
        apiBase: NETWORK_URL,
        links: [{ label: 'Home', href: '/' }, { label: 'Inbox', href: '/inbox', active: true }],
        history: { type: 'page', title: `Inbox · ${SITE_NAME}` },
        silentLogin: `${base}/auth/login?silent=1&next={url}`,
        sessionUrl: '/auth/me',
        loginUrl: '/auth/login?next={path}',
        logoutUrl: '/auth/logout?next={path}',
    };
    return shell.page({
        name: SITE_NAME,
        lang: 'en',
        title: `Inbox · ${SITE_NAME}`,
        siteName: SITE_NAME,
        description: 'The mail that came to your mailbox, your masks and your agents.',
        canonical: `${base}/inbox`,
        robots: 'noindex, nofollow',
        home: '/',
        navLinks: nav.links,
        navbar: nav,
        head: `<meta name="referrer" content="no-referrer">
<link rel="stylesheet" href="${ovServe.url('kit.css')}">
<link rel="stylesheet" href="${asset('css/inbox.css')}">
<script src="${asset('js/inbox.js')}" defer></script>`,
        body: `<div id="navbar-mount"></div>
<main data-mail-inbox id="main"><section data-mail-addresses aria-label="Your addresses"></section><section data-mail-list aria-label="Messages"></section><section data-mail-read aria-label="The message"></section></main>
<script type="application/json" id="mail-data">{}</script>
<script>window.__OV_PAGE = ${JSON.stringify({ navbar: nav }).replace(/</g, '\\u003c')};</script>`,
    });
}

function providerAdminPage(config) {
    const base = String(config.baseUrl || 'https://openvibe.email').replace(/\/+$/, '');
    const nav = { service: SERVICE, apiBase: NETWORK_URL, links: [{ label: 'Home', href: '/' }, { label: 'Inbox', href: '/inbox' }, { label: 'Mail providers', href: '/admin/mail/providers', active: true }], history: { type: 'page', title: 'Mail providers' }, silentLogin: `${base}/auth/login?silent=1&next={url}`, sessionUrl: '/auth/me', loginUrl: '/auth/login?next={path}', logoutUrl: '/auth/logout?next={path}' };
    return shell.page({
        name: SITE_NAME, lang: 'en', title: `Mail providers · ${SITE_NAME}`, siteName: SITE_NAME,
        description: 'Owner controls for outbound mail providers and monthly budgets.', canonical: `${base}/admin/mail/providers`,
        robots: 'noindex, nofollow', home: '/', navLinks: nav.links, navbar: nav,
        head: `<meta name="referrer" content="no-referrer"><link rel="stylesheet" href="${ovServe.url('kit.css')}"><link rel="stylesheet" href="${asset('css/mail.css')}"><script src="${asset('js/mail-providers.js')}" defer></script>`,
        body: `<div id="navbar-mount"></div><main id="main" data-mail-provider-admin><h1>Outbound mail providers</h1><p>External delivery stays closed unless MAIL_OUTBOUND is enabled by the service operator. Every paid provider needs a monthly cap.</p><p data-status role="status">Loading provider settings…</p><section aria-labelledby="configured-heading"><h2 id="configured-heading">Configured providers</h2><div data-provider-list></div></section><section aria-labelledby="add-heading"><h2 id="add-heading">Add mail provider</h2><form data-provider-form><label>Provider <select name="adapter"><option value="smtp">Generic SMTP</option><option value="ses">Amazon SES v2</option><option value="cloudflare">Cloudflare Email Sending</option><option value="brevo">Brevo</option><option value="mailjet">Mailjet</option><option value="mailersend">MailerSend</option><option value="resend">Resend</option><option value="smtp2go">SMTP2GO</option><option value="zeptomail">Zoho ZeptoMail</option><option value="postmark">Postmark</option></select></label><label>Name <input name="name" required maxlength="100"></label><label>SMTP host (generic SMTP only) <input name="host" required maxlength="253"></label><label>Port <input name="port" type="number" min="1" max="65535" value="587" required></label><label>Username <input name="username" maxlength="200"></label><label>Credential (API token, or JSON for SES/Mailjet) <input name="password" type="password" autocomplete="new-password"></label><label>Provider settings JSON, such as {"account_id":"…"} or {"region":"us-east-1"} <input name="settings_json" value="{}"></label><label>Free messages each month <input name="free_monthly" type="number" min="0" value="0"></label><label>Price per 1,000 after free allowance (USD) <input name="price_per_thousand" type="number" min="0" step="0.000001" value="0"></label><label>Monthly budget cap (USD) <input name="monthly_budget" type="number" min="0" step="0.01" value="0" required></label><label>Priority <input name="priority" type="number" value="100"></label><label><input name="secure" type="checkbox"> TLS from connection (SMTP)</label><label><input name="starttls" type="checkbox" checked> Use STARTTLS when offered (SMTP)</label><label><input name="enabled" type="checkbox"> Enable provider</label><button type="submit">Save provider</button></form></section><p data-error role="alert" hidden></p></main><script>window.__OV_PAGE = ${JSON.stringify({ navbar: nav }).replace(/</g, '\\u003c')};</script>`,
    });
}

/** Mount the page, its files and Shared's. Before the API's 404 handler. */
function mountPages(app, { config }) {
    app.use('/shared', ovServe.handler());
    app.use(['/css', '/js'], (req, res, next) => {
        const rel = `${req.baseUrl.slice(1)}${req.path}`;
        res.setHeader('Cache-Control', cache.assetHeaders(rel, { hashed: !!req.query.v && req.query.v === assetVersion(rel) }));
        next();
    });
    app.use('/css', express.static(path.join(PUBLIC_DIR, 'css'), { index: false, redirect: false }));
    app.use('/js', express.static(path.join(PUBLIC_DIR, 'js'), { index: false, redirect: false }));
    app.use(['/css', '/js'], (_req, res) => res.status(404).set('Cache-Control', 'no-store').type('text/plain').send('Not found'));
    let inbox = null;
    app.get(['/inbox', '/inbox/:id'], (req, res) => {
        // A person's own mail: signed in, or sent to sign in and back here. The page is private and never cached.
        if (!(req.user && req.user.subject_id)) return res.redirect(302, `/auth/login?next=${encodeURIComponent(req.originalUrl || '/inbox')}`);
        inbox = inbox || inboxPage(config);
        res.set('Content-Security-Policy', INBOX_CSP);
        res.set('Cache-Control', 'private, no-store');
        res.type('html').send(inbox);
    });
    app.get('/admin/mail/providers', (req, res) => {
        if (!req.user || req.user.role !== 'owner') return res.status(404).type('text/plain').send('Not found');
        res.set('Content-Security-Policy', INBOX_CSP);
        res.set('Cache-Control', 'private, no-store');
        res.type('html').send(providerAdminPage(config));
    });
    let html = null;
    app.get('/', (req, res) => {
        html = html || homePage(config);
        res.set('Content-Security-Policy', CSP);
        res.set('Cache-Control', cache.htmlHeaders({ private: false }));
        res.type('html').send(html);
    });
}

module.exports = { mountPages, homePage, inboxPage, providerAdminPage, siteIdentity, CSP, INBOX_CSP, asset };
