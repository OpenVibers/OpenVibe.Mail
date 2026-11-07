'use strict';
/**
 * Reading your own mail (M1.5): a message's HTML made safe on the server, before the page puts it in a sandboxed
 * frame that runs no script anyway. Two layers, so one mistake is not a hole.
 *
 * The rule set is an allow-list (sanitize-html, MIT):
 *   - tags: text, headings, lists, quotes, tables and images; no script, style, form, input, iframe, object, embed,
 *     svg, math, link, meta or base;
 *   - attributes: a few per tag (href, src, alt, sizes, table layout) and `style` with a short list of properties
 *     whose values can never hold url(), expression() or an @import;
 *   - schemes: links http, https and mailto; images https (only when the person asked) and data:image/*;
 *   - links open in a new tab with rel="noopener noreferrer"; nothing keeps a window.opener.
 *
 * Remote images are how senders learn that a message was opened (and where, and when). They are replaced by their
 * alt text until the person asks for them, and the answer says how many were held back.
 *
 * Nothing here logs, stores or emits a body: the caller sends the result to its owner and forgets it.
 */
const sanitizeHtml = require('sanitize-html');

const MAX_HTML_BYTES = 1024 * 1024;
const SAFE_VALUE = /^(?!.*(?:url\s*\(|expression\s*\(|@import|javascript:|behavior\s*:|-moz-binding))[^<>{};]*$/i;
const STYLE_PROPS = [
    'color', 'background-color', 'font-family', 'font-size', 'font-weight', 'font-style', 'line-height',
    'text-align', 'text-decoration', 'text-transform', 'letter-spacing', 'white-space', 'vertical-align',
    'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
    'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
    'border', 'border-top', 'border-right', 'border-bottom', 'border-left', 'border-color', 'border-width',
    'border-style', 'border-radius', 'border-collapse', 'border-spacing',
    'width', 'max-width', 'min-width', 'height', 'max-height', 'min-height', 'display',
];
const DATA_IMAGE = /^data:image\/(png|gif|jpe?g|webp);base64,[a-z0-9+/=\s]+$/i;

/**
 * The HTML a person may read: cleaned, links made safe, and remote images held back unless `images`.
 * Returns { html, blockedImages }.
 */
function cleanHtml(raw, { images = false } = {}) {
    let html = String(raw || '');
    if (Buffer.byteLength(html, 'utf8') > MAX_HTML_BYTES) html = html.slice(0, MAX_HTML_BYTES);
    let blocked = 0;
    const allowedStyles = { '*': Object.fromEntries(STYLE_PROPS.map((p) => [p, [SAFE_VALUE]])) };
    const out = sanitizeHtml(html, {
        allowedTags: [
            'a', 'abbr', 'b', 'blockquote', 'br', 'caption', 'center', 'code', 'col', 'colgroup', 'dd', 'del', 'div',
            'dl', 'dt', 'em', 'font', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'img', 'ins', 'kbd', 'li', 'mark',
            'ol', 'p', 'pre', 'q', 's', 'small', 'span', 'strike', 'strong', 'sub', 'sup', 'table', 'tbody', 'td',
            'tfoot', 'th', 'thead', 'tr', 'u', 'ul',
        ],
        disallowedTagsMode: 'discard',
        allowedAttributes: {
            a: ['href', 'title', 'target', 'rel'],
            img: ['src', 'alt', 'width', 'height', 'title'],
            td: ['colspan', 'rowspan', 'align', 'valign', 'width', 'height', 'bgcolor'],
            th: ['colspan', 'rowspan', 'align', 'valign', 'width', 'height', 'bgcolor'],
            table: ['width', 'cellpadding', 'cellspacing', 'border', 'align', 'bgcolor'],
            col: ['span', 'width'],
            font: ['color', 'size', 'face'],
            '*': ['style', 'dir', 'align', 'lang'],
        },
        allowedStyles,
        allowedSchemes: ['http', 'https', 'mailto'],
        allowedSchemesByTag: { img: ['https', 'data'] },
        allowedSchemesAppliedToAttributes: ['href', 'src'],
        allowProtocolRelative: false,
        transformTags: {
            a: (tagName, attribs) => {
                const href = String(attribs.href || '');
                const safe = /^(https?:|mailto:)/i.test(href) ? href : null;
                return { tagName: 'a', attribs: { ...(safe ? { href: safe } : {}), ...(attribs.title ? { title: attribs.title } : {}), target: '_blank', rel: 'noopener noreferrer' } };
            },
            img: (tagName, attribs) => {
                const src = String(attribs.src || '').trim();
                const alt = attribs.alt ? String(attribs.alt).slice(0, 200) : '';
                const size = { ...(attribs.width ? { width: attribs.width } : {}), ...(attribs.height ? { height: attribs.height } : {}) };
                if (DATA_IMAGE.test(src)) return { tagName: 'img', attribs: { src, alt, ...size } };
                if (/^https:\/\//i.test(src) && images) return { tagName: 'img', attribs: { src, alt, ...size } };
                if (/^https?:\/\//i.test(src) || src.startsWith('//')) blocked += 1;
                // Held back: its alt text in its place, so the layout still says what was there.
                return { tagName: 'span', attribs: {}, text: alt ? `[${alt}]` : '' };
            },
        },
        textFilter: (text) => text,
    });
    return { html: out, blockedImages: blocked };
}

/** The attachment types a browser may be told; everything else downloads as bytes. */
const DOWNLOAD_TYPES = new Set([
    'application/pdf', 'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'text/plain', 'text/csv', 'text/calendar',
    'application/zip', 'application/json', 'audio/mpeg', 'video/mp4',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
]);
function downloadType(type) {
    const t = String(type || '').toLowerCase().split(';')[0].trim();
    return DOWNLOAD_TYPES.has(t) ? t : 'application/octet-stream';
}
/** A file name safe for Content-Disposition (ASCII fallback plus RFC 5987 filename*). */
function dispositionFor(name) {
    const clean = String(name || 'attachment').replace(/[\r\n"\\/]/g, '_').slice(0, 180) || 'attachment';
    const ascii = clean.replace(/[^\x20-\x7e]/g, '_');
    return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(clean)}`;
}

module.exports = { cleanHtml, downloadType, dispositionFor, MAX_HTML_BYTES, STYLE_PROPS };
