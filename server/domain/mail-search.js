'use strict';

// Search is evaluated by JMAP across the mailbox, before pagination, not against the loaded page.
function parseSearch(input = '') {
    if (typeof input !== 'string' || input.length > 1000) throw new Error('Search is limited to 1,000 characters.');
    const tokens = input.match(/(?:[^\s"]|"[^"]*")+/g) || [];
    if ((input.match(/"/g) || []).length % 2) throw new Error('Close the quoted search phrase.');
    const conditions = [];
    for (const token of tokens) {
        const match = /^(from|to|subject|has|after|before):(.+)$/i.exec(token);
        const value = (match ? match[2] : token).replace(/"/g, '');
        if (!value.trim()) throw new Error('Search fields need a value.');
        if (!match) { conditions.push({ text: value }); continue; }
        const field = match[1].toLowerCase();
        if (field === 'has') {
            if (value !== 'attachment') throw new Error('Use has:attachment.');
            conditions.push({ hasAttachment: true });
        } else if (field === 'after' || field === 'before') {
            const date = new Date(value + 'T00:00:00.000Z');
            if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw new Error('Dates use YYYY-MM-DD (UTC).');
            conditions.push({ [field]: date.toISOString() });
        } else conditions.push({ [field]: value });
    }
    return conditions;
}
function labelKeyword(name) {
    if (typeof name !== 'string' || !name.trim() || name.length > 40 || /[\x00-\x1f]/.test(name)) throw new Error('Labels need 1–40 characters.');
    return 'ov-label-' + Buffer.from(name.trim()).toString('hex');
}
function searchFilter({ q = '', folder = 'inbox', label = '' } = {}) {
    const conditions = parseSearch(q);
    if (folder === 'inbox') conditions.push({ notKeyword: 'ov-archived' }, { notKeyword: 'ov-snoozed' });
    else if (folder === 'archive') conditions.push({ hasKeyword: 'ov-archived' });
    else if (folder === 'starred') conditions.push({ hasKeyword: '$flagged' });
    else if (folder === 'snoozed') conditions.push({ hasKeyword: 'ov-snoozed' });
    else if (folder !== 'all') throw new Error('Unknown folder.');
    if (label) conditions.push({ hasKeyword: labelKeyword(label) });
    return conditions.length ? { operator: 'AND', conditions } : {};
}
module.exports = { parseSearch, searchFilter, labelKeyword };
