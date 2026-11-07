'use strict';

/**
 * A tiny SMTP client for the integration test: enough of RFC 5321 to deliver one message and to read the code the
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

/**
 * Send one message. Resolves with the SMTP codes; rejects with a `refused` error (and the code) when the server
 * refuses the sender, the recipient or the data.
 */
async function send({ host = '127.0.0.1', port, from = 'sender@example.net', to, subject = 'Hello', text = '', html = null, timeoutMs = 20_000 }) {
    const socket = net.createConnection({ host, port });
    socket.setTimeout(timeoutMs);
    const close = () => { try { socket.destroy(); } catch { /* already closed */ } };
    try {
        await readReply(socket);
        write(socket, 'EHLO test.openvibe.invalid');
        await readReply(socket);
        write(socket, `MAIL FROM:<${from}>`);
        const sender = await readReply(socket);
        if (sender.code >= 400) throw Object.assign(new Error(`MAIL FROM refused: ${sender.code}`), { smtp: sender });
        write(socket, `RCPT TO:<${to}>`);
        const recipient = await readReply(socket);
        if (recipient.code >= 400) throw Object.assign(new Error(`RCPT TO refused: ${recipient.code}`), { smtp: recipient, refused: true });
        write(socket, 'DATA');
        const data = await readReply(socket);
        if (data.code >= 400) throw Object.assign(new Error(`DATA refused: ${data.code}`), { smtp: data, refused: true });

        const headers = [
            `From: ${from}`,
            `To: ${to}`,
            `Subject: ${subject}`,
            `Message-ID: <${Date.now()}.${Math.random().toString(16).slice(2)}@example.net>`,
            'MIME-Version: 1.0',
        ];
        let body;
        if (html) {
            headers.push('Content-Type: text/html; charset=utf-8');
            body = html;
        } else {
            headers.push('Content-Type: text/plain; charset=utf-8');
            body = text;
        }
        socket.write(`${headers.join('\r\n')}\r\n\r\n${body}\r\n.\r\n`);
        const accepted = await readReply(socket);
        if (accepted.code >= 400) throw Object.assign(new Error(`the message was refused: ${accepted.code}`), { smtp: accepted, refused: true });
        write(socket, 'QUIT');
        await readReply(socket).catch(() => null);
        return accepted;
    } finally {
        close();
    }
}

module.exports = { send, readReply };
