'use strict';

/**
 * Sealing an IMAP password.
 *
 * Mail has no vault of its own, so this is the smallest one that fits: AES-256-GCM with a 32-byte key from
 * MAIL_SECRETS_KEY (base64 or hex, read by reference), a fresh 12-byte IV per value, and the connection's owner and
 * id as the additional authenticated data — a sealed value copied to another person's row does not open.
 *
 * The three parts are base64url text joined by dots: `v1.<iv>.<tag>.<ciphertext>`. Nothing here logs, returns or
 * compares a plaintext beyond the one call that needs it.
 */
const { createCipheriv, createDecipheriv, randomBytes } = require('node:crypto');

const VERSION = 'v1';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

function fail(code, message) {
    const err = new Error(message);
    err.code = code;
    return err;
}

/** The AES key behind MAIL_SECRETS_KEY, or a clear error that says the feature is not configured. */
function keyBytes(raw) {
    const value = String(raw || '').trim();
    if (!value) throw fail('IMAP_NO_KEY', 'Connecting a mailbox is not configured on this server.');
    const bytes = /^[0-9a-f]{64}$/i.test(value) ? Buffer.from(value, 'hex') : Buffer.from(value, 'base64');
    if (bytes.length !== KEY_BYTES) throw fail('IMAP_NO_KEY', 'Connecting a mailbox is not configured on this server.');
    return bytes;
}

/** The AAD binds a sealed password to one person and one connection row. */
function aad(owner, id) {
    return Buffer.from(`mail-imap:${String(owner)}:${String(id)}`, 'utf8');
}

function sealSecret({ key, owner, id, plaintext }) {
    if (typeof plaintext !== 'string' || !plaintext) throw fail('IMAP_SECRET_INVALID', 'An app password is required.');
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', keyBytes(key), iv);
    cipher.setAAD(aad(owner, id));
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [VERSION, iv.toString('base64url'), tag.toString('base64url'), ciphertext.toString('base64url')].join('.');
}

function openSecret({ key, owner, id, sealed }) {
    const parts = String(sealed || '').split('.');
    if (parts.length !== 4 || parts[0] !== VERSION) throw fail('IMAP_SECRET_UNREADABLE', 'The saved app password could not be read.');
    const [iv, tag, ciphertext] = [Buffer.from(parts[1], 'base64url'), Buffer.from(parts[2], 'base64url'), Buffer.from(parts[3], 'base64url')];
    if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) throw fail('IMAP_SECRET_UNREADABLE', 'The saved app password could not be read.');
    try {
        const decipher = createDecipheriv('aes-256-gcm', keyBytes(key), iv);
        decipher.setAAD(aad(owner, id));
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    } catch {
        throw fail('IMAP_SECRET_UNREADABLE', 'The saved app password could not be read.');
    }
}

module.exports = { sealSecret, openSecret, keyBytes, aad, VERSION, KEY_BYTES, IV_BYTES };
