'use strict';

/**
 * The small TOML reader OpenVibe.Mail's Stalwart configuration needs.
 *
 * The file is ours, not Stalwart's (v0.16+ stopped reading TOML), so this reader supports exactly the TOML the
 * file uses: tables, string/integer/float/boolean values and one-line arrays. It does not pretend to be a general
 * TOML parser; a line it does not understand is an error with its line number, never a silently ignored setting.
 */

function fail(line, message) {
    throw new Error(`config.toml:${line}: ${message}`);
}

/** Remove a `#` comment that is not inside a quoted string. */
function stripComment(line) {
    let quote = null;
    for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (quote) {
            if (c === '\\' && quote === '"') i += 1;
            else if (c === quote) quote = null;
        } else if (c === '"' || c === "'") {
            quote = c;
        } else if (c === '#') {
            return line.slice(0, i);
        }
    }
    return line;
}

function unescape(value) {
    let out = '';
    for (let i = 0; i < value.length; i++) {
        const c = value[i];
        if (c !== '\\') { out += c; continue; }
        const next = value[++i];
        if (next === 'n') out += '\n';
        else if (next === 't') out += '\t';
        else if (next === 'r') out += '\r';
        else if (next === '"') out += '"';
        else if (next === '\\') out += '\\';
        else fail(0, `unknown escape \\${next}`);
    }
    return out;
}

function parseValue(raw, line) {
    const text = String(raw).trim();
    if (!text) fail(line, 'a value is missing');
    if (text.startsWith('"')) {
        if (!text.endsWith('"') || text.length < 2) fail(line, 'an unterminated string');
        return unescape(text.slice(1, -1));
    }
    if (text.startsWith("'")) {
        if (!text.endsWith("'") || text.length < 2) fail(line, 'an unterminated string');
        return text.slice(1, -1);
    }
    if (text.startsWith('[')) {
        if (!text.endsWith(']')) fail(line, 'an unterminated array');
        const inner = text.slice(1, -1).trim();
        if (!inner) return [];
        return splitArray(inner, line).map((item) => parseValue(item, line));
    }
    if (text === 'true') return true;
    if (text === 'false') return false;
    if (/^-?\d+$/.test(text)) return Number(text);
    if (/^-?\d+\.\d+$/.test(text)) return Number(text);
    fail(line, `a value this reader does not know: ${text}`);
}

/** Split an array body on commas outside strings. */
function splitArray(body, line) {
    const out = [];
    let quote = null;
    let start = 0;
    for (let i = 0; i < body.length; i++) {
        const c = body[i];
        if (quote) {
            if (c === '\\' && quote === '"') i += 1;
            else if (c === quote) quote = null;
        } else if (c === '"' || c === "'") {
            quote = c;
        } else if (c === ',') {
            out.push(body.slice(start, i));
            start = i + 1;
        }
    }
    out.push(body.slice(start));
    return out.map((s) => s.trim()).filter(Boolean);
}

function parse(source) {
    const root = {};
    let table = root;
    String(source).split(/\r?\n/).forEach((raw, index) => {
        const line = index + 1;
        const text = stripComment(raw).trim();
        if (!text) return;
        if (text.startsWith('[')) {
            if (!text.endsWith(']')) fail(line, 'an unterminated table name');
            const path = text.slice(1, -1).trim().split('.').map((s) => s.trim()).filter(Boolean);
            if (!path.length) fail(line, 'an empty table name');
            table = root;
            for (const key of path) {
                if (!table[key] || typeof table[key] !== 'object' || Array.isArray(table[key])) table[key] = {};
                table = table[key];
            }
            return;
        }
        const eq = text.indexOf('=');
        if (eq < 1) fail(line, 'expected key = value');
        const key = text.slice(0, eq).trim();
        if (!/^[A-Za-z0-9_-]+$/.test(key)) fail(line, `an invalid key: ${key}`);
        table[key] = parseValue(text.slice(eq + 1), line);
    });
    return root;
}

module.exports = { parse };
