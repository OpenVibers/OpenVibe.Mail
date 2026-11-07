'use strict';

/**
 * The verification code out of a message.
 *
 * A burner exists to receive one code, so the code is the one thing the service has to find in a message it has
 * never seen and never asked for. The extractor reads the text and the html of a message, in that order, and
 * returns the first code it can stand behind — or nothing at all. It never guesses: a message without a code
 * gives no code, and the caller says so.
 *
 * The rules, in order:
 *
 *   1. a labelled code — "your verification code is 482913", "code: 482913", "one-time PIN 482913";
 *   2. a code in the subject on its own — the subject "482913" or "Your code: 482913";
 *   3. a code standing alone in the body — a line that is nothing but the digits.
 *
 * A candidate must be a run of four to eight digits that does not continue into other digits (so a phone number is
 * not a code), and a four-digit candidate that reads like a year is only accepted when it was labelled.
 */

const LABELLED = [
    // your verification code is 482913 · your code: 482913 · code 482913
    /(?:verification|confirmation|security|access|sign[- ]?in|login|one[- ]?time|onetime|otp|2fa|mfa|auth(?:entication)?|confirmation)\s*(?:code|pin|passcode|key|number|no\.)?\s*(?:is|are|:|-|–|—)?\s*(?:is\s+)?([0-9]{4,8})(?![0-9])/i,
    // your one-time code
    /(?:code|pin|passcode)\s*(?:is|:|-|–|—)?\s*([0-9]{4,8})(?![0-9])/i,
    // 482913 is your verification code
    /\b([0-9]{4,8})(?![0-9])\s*(?:is|are)\s+(?:your|the)\s+(?:verification|confirmation|security|access|one[- ]?time|sign[- ]?in|login)?\s*(?:code|pin|passcode)\b/i,
    // otp 482913 · otp: 482913
    /\botp\b\s*(?:is|:|-|–|—)?\s*([0-9]{4,8})(?![0-9])/i,
];

const ALONE_LINE = /^\s*([0-9]{4,8})\s*$/;
const ALONE_TOKEN = /(?<![0-9])([0-9]{4,8})(?![0-9])/g;

function decodeEntities(text) {
    return String(text || '')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&quot;/gi, '"')
        .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n) || 32))
        .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16) || 32));
}

/** The readable text of an html body: no tags, no scripts, blocks on their own lines. */
function htmlToText(html) {
    return decodeEntities(String(html || '')
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/(p|div|tr|li|h[1-6]|table|blockquote)>/gi, '\n')
        .replace(/<[^>]+>/g, ' '))
        .replace(/[ \t ]+/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

function looksLikeYear(code) {
    return code.length === 4 && Number(code) >= 1950 && Number(code) <= 2099;
}

/** A digit run that is not part of a longer number: 482913 in "order 48291312" is not a code. */
function isWholeRun(text, index, length) {
    const before = index > 0 ? text[index - 1] : '';
    const after = index + length < text.length ? text[index + length] : '';
    return !/[0-9]/.test(before) && !/[0-9]/.test(after);
}

/**
 * The code in a message, or null.
 *
 *   extractCode({ subject, text, html }) → { code, from } | null
 *
 * `from` says where the code was found: 'label', 'subject' or 'body'.
 */
function extractCode({ subject = '', text = '', html = '' } = {}) {
    const body = htmlToText(html);
    const plain = [String(text || ''), body].filter(Boolean).join('\n');
    const subjectText = String(subject || '').trim();

    // 1. a labelled code, in the subject first and then in the body.
    for (const source of [subjectText, plain]) {
        if (!source) continue;
        for (const pattern of LABELLED) {
            const m = pattern.exec(source);
            if (!m) continue;
            const code = m[1];
            const at = m.index + m[0].lastIndexOf(code);
            if (!isWholeRun(source, at, code.length)) continue;
            return { code, from: source === subjectText ? 'subject' : 'label' };
        }
    }

    // 2. the subject on its own: "482913" or "Your code 482913" without a label word we know.
    if (subjectText) {
        const alone = ALONE_LINE.exec(subjectText);
        if (alone) return { code: alone[1], from: 'subject' };
        const token = ALONE_TOKEN.exec(subjectText);
        if (token && !looksLikeYear(token[1])) {
            const at = token.index;
            if (isWholeRun(subjectText, at, token[1].length)) return { code: token[1], from: 'subject' };
        }
    }

    // 3. a line in the body that is nothing but the code.
    for (const line of plain.split('\n')) {
        const alone = ALONE_LINE.exec(line);
        if (!alone) continue;
        if (looksLikeYear(alone[1])) continue;
        return { code: alone[1], from: 'body' };
    }

    // 4. the first standalone number in the body that is not a year and not part of a longer number.
    const scan = plain.slice(0, 4000);
    ALONE_TOKEN.lastIndex = 0;
    let token = ALONE_TOKEN.exec(scan);
    while (token) {
        const code = token[1];
        if (!looksLikeYear(code) && isWholeRun(scan, token.index, code.length)) return { code, from: 'body' };
        token = ALONE_TOKEN.exec(scan);
    }

    return null;
}

module.exports = { extractCode, htmlToText, decodeEntities };
