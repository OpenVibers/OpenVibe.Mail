'use strict';

/**
 * The addresses we hand out.
 *
 *   a mask       <words>.<4 characters>@<mask domain>      amazon.k7fq@mask.openvibe.email
 *   a burner     <8 characters>@<one of the burner domains>  q7fq2k9d@burn2.openvibe.email
 *   an agent     <agent>.<user>@<base domain>                helper.alice@openvibe.email
 *
 * The words are the person's own ("amazon" for the Amazon mask) so they can recognise the address later; the four
 * characters after the dot keep two people from guessing each other's mask. A burner has no words at all: it is
 * meant to be thrown away, and it rotates over the burner domains so a site that blocks one domain does not block
 * the next.
 *
 * Nothing here talks to the network: an address is a string, and the database has the last word on whether it is
 * free.
 */
const crypto = require('crypto');

// No vowels (so a word cannot spell one) and no look-alikes: 0/o, 1/l/i.
const ALPHABET = 'bcdfghjkmnpqrstvwxyz23456789';
const WORDS_RE = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

function randomChars(length, alphabet = ALPHABET) {
    const bytes = crypto.randomBytes(length * 2);
    let out = '';
    for (let i = 0; out.length < length && i < bytes.length; i++) {
        const b = bytes[i];
        // Rejection sampling: no modulo bias.
        if (b < 256 - (256 % alphabet.length)) out += alphabet[b % alphabet.length];
    }
    return out.length === length ? out : out + randomChars(length - out.length, alphabet);
}

/** The words of a mask: what the person asked for, cleaned up, or a neutral default. */
function maskWords(input) {
    const words = String(input || '')
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 32);
    return WORDS_RE.test(words) ? words : 'mail';
}

/** A mask address: <words>.<4 characters>@<mask domain>. */
function maskAddress(words, maskDomain) {
    return `${maskWords(words)}.${randomChars(4)}@${maskDomain}`;
}

/** A burner address on the given domain. */
function burnerAddress(domain) {
    return `${randomChars(8)}@${domain}`;
}

/** An agent's inbox: <agent>.<user>@<base domain>. The agent id and the user's mailbox name are both cleaned up. */
function agentInboxAddress(agentId, userLocal, baseDomain) {
    const agent = String(agentId || '')
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 32);
    const user = String(userLocal || '')
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 32);
    if (!agent || !user) throw new Error('an agent inbox needs an agent and a user');
    return `${agent}.${user}@${baseDomain}`;
}

/** A person's mailbox: <local>@<base domain>. */
function mailboxAddress(local, baseDomain) {
    const name = String(local || '')
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 32);
    if (!name) throw new Error('a mailbox needs a name');
    return `${name}@${baseDomain}`;
}

/**
 * The local part of a person's mailbox, taken from their Network subject id.
 *
 * A subject id is `usr_01H…`; the mailbox is named after the id without its prefix, so two people never share a
 * mailbox and nobody has to be remembered by their name. Stalwart takes the local part as the account name and the
 * base domain as the domain, so `usr_01H…` becomes the account `01h…` at openvibe.email.
 */
function mailboxLocalFor(subjectId) {
    const raw = String(subjectId || '').trim();
    const withoutPrefix = raw.includes('_') ? raw.slice(raw.indexOf('_') + 1) : raw;
    const local = withoutPrefix.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '').slice(0, 32);
    if (!local) throw new Error('a mailbox needs a subject id');
    return local;
}

/** The domain an address lives on, lowercased, or null when it has none. */
function domainOf(address) {
    const at = String(address || '').lastIndexOf('@');
    return at > 0 ? String(address).slice(at + 1).toLowerCase() : null;
}

/** The local part of an address, lowercased. */
function localOf(address) {
    const at = String(address || '').lastIndexOf('@');
    return at > 0 ? String(address).slice(0, at).toLowerCase() : String(address || '').toLowerCase();
}

module.exports = {
    ALPHABET,
    randomChars,
    maskWords,
    maskAddress,
    burnerAddress,
    agentInboxAddress,
    mailboxAddress,
    mailboxLocalFor,
    domainOf,
    localOf,
};
