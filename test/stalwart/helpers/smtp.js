'use strict';

/**
 * A tiny SMTP client for the integration test: enough of RFC 5321 to deliver messages and to read the code the
 * server answers with. It is deliberately not a mail library — a test that used the service's own stack to deliver
 * the mail could hide a bug in that stack.
 */
const net = require('net');

function readReply(socket, timeoutMs = 15_000) {
    return new Promise((resolve, reject) => {
        let buffer = '';
        const timer = setTimeout(() => cleanup(new Error('the SMTP server did not answer')), timeoutMs);
        const onData = (chunk) => {
            buffer += chunk.toString('utf8');
            const lines = buffer.split('\r\n').filter(Boolean);
            const last = lines[lines.length - 1];
            if (!last || !/^\d{3}(?: |$)/.test(last)) return;
            const code = Number(last.slice(0, 3));
            cleanup(null, { code, lines: lines.slice() });
        };
        const onError = (err) => cleanup(err);
        const cleanup = (err, value) => {
            clearTimeout(timer);
            socket.off('data', onData);
            socket.off('error', onError);
            if (err) reject(err); else resolve(value);
        };
        socket.on('data', onData);
        socket.on('error', onError);
    });
}

function write(socket, line) {
    socket.write(`${line}\r\n`);
}

function message(opts, index) {
    const {
        from = 'sender@example.net', to, subject = 'Hello', text = '', html = null,
        toHeader = null, cc = null, extraHeaders = [],
    } = opts;
    const topic = typeof subject === 'function' ? subject(index) : subject;
    const headers = [
        `From: ${from}`,
        `To: ${toHeader || to}`,
        `Subject: ${topic}`,
        `Message-ID: <${Date.now()}.${index}.${Math.random().toString(16).slice(2)}@example.net>`,
        'MIME-Version: 1.0',
    ];
    if (cc) headers.push(`Cc: ${cc}`);
    for (const header of extraHeaders) headers.push(header);
    let body;
    if (html) {
        headers.push('Content-Type: text/html; charset=utf-8');
        body = html;
    } else {
        headers.push('Content-Type: text/plain; charset=utf-8');
        body = text;
    }
    return `${headers.join('\r\n')}\r\n\r\n${body}\r\n.\r\n`;
}

async function deliverOn(socket, opts, index) {
    const { from = 'sender@example.net', to } = opts;
    write(socket, `MAIL FROM:<${from}>`);
    const sender = await readReply(socket);
    if (sender.code >= 400) throw Object.assign(new Error(`MAIL FROM refused: ${sender.code}`), { smtp: sender });
    write(socket, `RCPT TO:<${to}>`);
    const recipient = await readReply(socket);
    if (recipient.code >= 400) throw Object.assign(new Error(`RCPT TO refused: ${recipient.code}`), { smtp: recipient, refused: true });
    write(socket, 'DATA');
    const data = await readReply(socket);
    if (data.code >= 400) throw Object.assign(new Error(`DATA refused: ${data.code}`), { smtp: data, refused: true });
    socket.write(message(opts, index));
    const accepted = await readReply(socket);
    if (accepted.code >= 400) throw Object.assign(new Error(`the message was refused: ${accepted.code}`), { smtp: accepted, refused: true });
    return accepted;
}

async function withSession(opts, fn) {
    const host = opts.host || '127.0.0.1';
    const socket = net.createConnection({ host, port: opts.port });
    socket.setTimeout(opts.timeoutMs || 20_000);
    try {
        await readReply(socket);
        write(socket, 'EHLO test.openvibe.invalid');
        await readReply(socket);
        const result = await fn(socket);
        write(socket, 'QUIT');
        await readReply(socket).catch(() => null);
        return result;
    } finally {
        try { socket.destroy(); } catch { /* already closed */ }
    }
}

/** Send one message. Rejects with `refused` when the envelope recipient or the data is refused. */
async function send(opts) {
    return withSession(opts, (socket) => deliverOn(socket, opts, 0));
}

/** Send `count` messages over one connection: enough to fill a mailbox without 300 TCP handshakes. */
async function sendMany(opts) {
    const count = Number(opts.count) || 1;
    return withSession(opts, async (socket) => {
        const accepted = [];
        for (let i = 0; i < count; i++) accepted.push(await deliverOn(socket, opts, i));
        return accepted;
    });
}

module.exports = { send, sendMany, readReply };
