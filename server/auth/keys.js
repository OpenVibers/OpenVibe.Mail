'use strict';
// openvibe-sdk/site (0.174.0) is the one implementation every site shares (the consolidation of 2026-11-16).
// The Network's signing key; this file stays for one release so nothing that requires it changes.
// A hand merge: Mail's copy also had verifyDock, the Companion's Dock token (issuer <network issuer>/dock): a person's
// token checked like a session token against the same key with the dock issuer, which the caller passes. It is the
// SDK's verifyUser with that issuer.
const site = require('openvibe-sdk/site');

function createKeyStore(o = {}) {
    const store = site.createKeyStore({ name: 'OpenVibe.Mail', ...o });
    return { ...store, verifyDock: (token, opts) => store.verifyUser(token, opts) };
}

module.exports = { createKeyStore, jwksUrl: site.jwksUrl, publicReason: site.publicReason };
