'use strict';

const { randomUUID } = require('node:crypto');
const { sql } = require('openvibe-sdk/db');
const { CATEGORIES } = require('./inbox-ai');

function cleanRule(input) {
    if (!input || typeof input !== 'object') return null;
    const name = String(input.name || '').trim().slice(0, 100);
    const matchFrom = String(input.match_from || '').trim().toLowerCase().slice(0, 254) || null;
    const matchSubject = String(input.match_subject || '').trim().slice(0, 200) || null;
    const category = String(input.category || '');
    if (!name || (!matchFrom && !matchSubject) || !CATEGORIES.includes(category)) return null;
    return { name, match_from: matchFrom, match_subject: matchSubject, category, enabled: input.enabled !== false };
}

async function listRules(db, owner) {
    return db.many(sql`SELECT id, name, match_from, match_subject, category, enabled, created_at, updated_at
        FROM mail_inbox_ai_rules WHERE owner_subject = ${owner} ORDER BY created_at`);
}

async function matchedRule(db, owner, message) {
    const rules = await listRules(db, owner);
    const rawSender = String((message.from || [])[0] || '').toLowerCase();
    const sender = (/<([^<>\s]+@[^<>\s]+)>/.exec(rawSender) || [null, rawSender])[1];
    return rules.find((rule) => rule.enabled &&
        (!rule.match_from || sender === rule.match_from) &&
        (!rule.match_subject || String(message.subject || '').toLowerCase().includes(rule.match_subject.toLowerCase()))) || null;
}

async function createRule(db, owner, input) {
    const value = cleanRule(input);
    if (!value) return null;
    const id = `rule_${randomUUID()}`;
    await db.exec(sql`INSERT INTO mail_inbox_ai_rules (id, owner_subject, name, match_from, match_subject, category, enabled)
        VALUES (${id}, ${owner}, ${value.name}, ${value.match_from}, ${value.match_subject}, ${value.category}, ${value.enabled})`);
    return (await listRules(db, owner)).find((rule) => rule.id === id) || null;
}

async function updateRule(db, owner, id, input) {
    const value = cleanRule(input);
    if (!value) return null;
    return db.maybe(sql`UPDATE mail_inbox_ai_rules SET name = ${value.name}, match_from = ${value.match_from},
        match_subject = ${value.match_subject}, category = ${value.category}, enabled = ${value.enabled}, updated_at = now()
        WHERE owner_subject = ${owner} AND id = ${id}
        RETURNING id, name, match_from, match_subject, category, enabled, created_at, updated_at`);
}

async function undo(db, owner, id) {
    return db.tx(async (t) => {
        const row = await t.maybe(sql`SELECT * FROM mail_inbox_ai_journal WHERE owner_subject = ${owner} AND id = ${id} AND undone_at IS NULL FOR UPDATE`);
        if (!row) return { ok: false, conflict: false };
        const restored = await t.maybe(sql`UPDATE mail_inbox_ai_threads SET category = ${row.previous_category}, updated_at = now()
            WHERE owner_subject = ${owner} AND thread_id = ${row.thread_id} AND category = ${row.action_category}
            RETURNING thread_id`);
        if (!restored) return { ok: false, conflict: true };
        await t.exec(sql`UPDATE mail_inbox_ai_journal SET undone_at = now() WHERE owner_subject = ${owner} AND id = ${id}`);
        return { ok: true, thread_id: row.thread_id, category: row.previous_category };
    });
}

module.exports = { cleanRule, listRules, matchedRule, createRule, updateRule, undo };
