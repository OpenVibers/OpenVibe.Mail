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

const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');
const SITE_NAME = 'OpenVibe.Email';
const NETWORK_URL = 'https://openvibe.network';

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
        service: 'mail',
        apiBase: NETWORK_URL,
        links: [{ label: 'Home', href: '/', active: true }],
        history: { type: 'page', title: SITE_NAME },
        silentLogin: `${base}/auth/login?silent=1&next={url}`,
        sessionUrl: '/auth/me',
        loginUrl: '/auth/login?next={path}',
        logoutUrl: '/auth/logout?next={path}',
    };
    const footer = { service: 'mail', variant: 'full', mount: '#ov-footer', brandName: SITE_NAME };
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
    let html = null;
    app.get('/', (req, res) => {
        html = html || homePage(config);
        res.set('Content-Security-Policy', CSP);
        res.set('Cache-Control', cache.htmlHeaders({ private: false }));
        res.type('html').send(html);
    });
}

module.exports = { mountPages, homePage, CSP, asset };
