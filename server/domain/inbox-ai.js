'use strict';

/** The mailbox's review categories. Unknown model output is rejected, never silently reinterpreted. */
const CATEGORIES = Object.freeze(['needs_reply', 'to_read', 'receipts', 'newsletters', 'other']);

function validateTriage(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const category = String(value.category || '');
    const summary = String(value.summary || '').trim();
    if (!CATEGORIES.includes(category) || !summary || summary.length > 240) return null;
    const draft = value.draft == null ? null : String(value.draft).trim();
    if (category === 'needs_reply' && (!draft || draft.length > 20_000)) return null;
    if (category !== 'needs_reply' && draft) return null;
    return { category, summary, draft: category === 'needs_reply' ? draft : null };
}

/** Consent is mailbox-scoped and must be checked immediately before every AI call. */
async function triageMailbox({ consent, messages, analyze }) {
    if (consent !== true) return { state: 'opted_out', items: [] };
    if (typeof analyze !== 'function') throw new TypeError('an AI analyzer is required');
    const items = [];
    for (const message of messages) {
        const result = validateTriage(await analyze(message));
        if (result) items.push({ id: message.id, ...result });
    }
    return { state: 'complete', items };
}

/** Drafts are inert data. This module deliberately has no send operation. */
function createDraft({ threadId, to, subject, body }) {
    if (!threadId || !to || !body) throw new TypeError('thread, recipient and body are required');
    return { thread_id: String(threadId), to: String(to), subject: String(subject || ''), body: String(body), state: 'draft' };
}

module.exports = { CATEGORIES, validateTriage, triageMailbox, createDraft };
