'use strict';

/**
 * A very small SMTP client: enough to hand one message to the mail server or to an outbound relay.
 *
 * It is deliberately not a mail library. Mail sends exactly one kind of message (an agent's plain-text reply, built
 * in server/domain/agent-reply.js) and it sends it one of two ways:
 *
 *   * to an address in one of our own domains, over loopback to the mail server itself (no relay is needed: the
 *     recipient is local);
 *   * to anyone else, through the outbound relay when one is configured (MAIL_RELAY_HOST and friends). Until the
 *     owner buys a relay, that path is closed and says so in plain words — it never pretends a letter left.
 *
 * The protocol here is the minimum: EHLO, optional STARTTLS, optional AUTH PLAIN, MAIL FROM, RCPT TO, DATA, QUIT.
 * Nothing here writes a body to a log; a failure says the server's reply code and text and nothing about the
 * message.
 */
const net = require('net');
const tls = require('tls');

const TIMEOUT_MS = 20_000;

class SmtpError extends Error {
    constructor(message, { code = 0, stage = '' } = {}) {
        super(message);
        this.name = 'SmtpError';
        this.code = code;
        this.stage = stage;
    }
}

/** One reply from the server: the code and the lines, until a line whose 4th character is a space. */
function readReply(socket, state, timeoutMs = TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => finish(new SmtpError('the mail server did not answer', { stage: 'timeout' })), timeoutMs);
        let buffer = '';
        let settled = false;
        const finish = (err, value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            socket.off('data', onData);
            socket.off('error', onError);
            socket.off('close', onClose);
            state.onData = null;
            if (err) reject(err); else resolve(value);
        };
        const onData = (chunk) => {
            buffer += chunk.toString('utf8');
            const lines = buffer.split('\r\n').filter(Boolean);
            const last = lines[lines.length - 1];
            if (!last || !/^\d{3}(?: |$)/.test(last)) return;
            finish(null, { code: Number(last.slice(0, 3)), lines: lines.slice() });
        };
        const onError = (err) => finish(new SmtpError(`the mail server broke the connection: ${err && err.message}`, { stage: state.stage }));
        const onClose = () => finish(new SmtpError('the mail server closed the connection', { stage: state.stage }));
        socket.on('data', onData);
        socket.on('error', onError);
        socket.on('close', onClose);
    });
}

/** Command → its reply; a 4xx/5xx is thrown with the server's own words. */
async function command(socket, state, line, { accept = [250, 251, 252, 220, 235, 354, 503] } = {}) {
    socket.write(`${line}\r\n`);
    const reply = await readReply(socket, state);
    if (!accept.includes(reply.code)) {
        throw new SmtpError(String(reply.lines.slice(-1)[0] || 'refused').slice(4).trim() || 'the mail server refused it', { code: reply.code, stage: state.stage });
    }
    return reply;
}

function connect({ host, port, secure = false, timeoutMs = TIMEOUT_MS }) {
    return new Promise((resolve, reject) => {
        const socket = secure ? tls.connect({ host, port, servername: host }) : net.createConnection({ host, port });
        socket.setTimeout(timeoutMs);
        const onError = (err) => { socket.destroy(); reject(new SmtpError(`could not reach the mail server at ${host}:${port}: ${err && err.message}`, { stage: 'connect' })); };
        const onTimeout = () => { socket.destroy(); reject(new SmtpError(`the mail server at ${host}:${port} did not answer`, { stage: 'connect' })); };
        socket.once('error', onError);
        socket.once('timeout', onTimeout);
        const ready = secure ? 'secureConnect' : 'connect';
        socket.once(ready, () => {
            socket.off('error', onError);
            socket.off('timeout', onTimeout);
            resolve(socket);
        });
    });
}

/** Run one SMTP session; `fn` gets the socket and the session state. Always tries to QUIT. */
async function session(opts, fn) {
    const socket = await connect(opts);
    const state = { stage: 'greeting', onData: null };
    try {
        const greeting = await readReply(socket, state, opts.timeoutMs);
        if (greeting.code !== 220) throw new SmtpError(`the mail server did not greet us: ${greeting.lines.join(' ')}`, { code: greeting.code, stage: 'greeting' });
        state.stage = 'ehlo';
        const ehlo = await command(socket, state, 'EHLO openvibe.email');
        const features = ehlo.lines.map((l) => l.slice(4).toUpperCase());
        return await fn(socket, state, features);
    } finally {
        try { socket.write('QUIT\r\n'); } catch { /* already gone */ }
        try { socket.destroy(); } catch { /* already closed */ }
    }
}

/** Does this session offer STARTTLS? */
const offersStartTls = (features) => features.some((f) => f.trim() === 'STARTTLS');

/** Wrap an existing connection in TLS (STARTTLS). */
function upgrade(socket) {
    return new Promise((resolve, reject) => {
        const secure = tls.connect({ socket, servername: 'openvibe.email' }, () => resolve(secure));
        secure.once('error', (err) => reject(new SmtpError(`the mail server's TLS handshake failed: ${err && err.message}`, { stage: 'starttls' })));
    });
}

/**
 * Send one already-built message. `from` and `to` are bare addresses; `message` is the full RFC 5322 text with CRLF
 * line endings. Answers { ok, code, reason } and never throws for a refusal: the caller reads the answer.
 *
 *   opts: host, port, secure (TLS from the start), starttls (upgrade when offered), user, password, timeoutMs
 */
async function sendMessage(opts, { from, to, message }) {
    try {
        return await session({ ...opts, secure: Boolean(opts.secure) }, async (socket, state, features) => {
            let link = socket;
            let linkState = state;
            if (!opts.secure && opts.starttls !== false && offersStartTls(features)) {
                state.stage = 'starttls';
                await command(socket, state, 'STARTTLS', { accept: [220] });
                link = await upgrade(socket);
                linkState = { stage: 'ehlo-tls', onData: null };
                await command(link, linkState, 'EHLO openvibe.email');
            }
            if (opts.user) {
                linkState.stage = 'auth';
                const token = Buffer.from(`\u0000${opts.user}\u0000${opts.password || ''}`, 'utf8').toString('base64');
                const reply = await command(link, linkState, `AUTH PLAIN ${token}`, { accept: [235] }).catch(async () => {
                    // Some servers want the two-step form.
                    await command(link, linkState, 'AUTH PLAIN', { accept: [334] });
                    return command(link, linkState, token, { accept: [235] });
                });
                if (reply.code !== 235) throw new SmtpError('the relay did not accept the credentials', { code: reply.code, stage: 'auth' });
            }
            linkState.stage = 'from';
            await command(link, linkState, `MAIL FROM:<${from}>`);
            linkState.stage = 'rcpt';
            await command(link, linkState, `RCPT TO:<${to}>`, { accept: [250, 251, 252] });
            linkState.stage = 'data';
            await command(link, linkState, 'DATA', { accept: [354] });
            linkState.stage = 'body';
            // Dot-stuffing (RFC 5321 §4.5.2): a line that starts with '.' gets one more.
            const body = String(message).replace(/\r\n/g, '\n').split('\n').map((l) => (l.startsWith('.') ? `.${l}` : l)).join('\r\n');
            link.write(`${body}\r\n.\r\n`);
            const accepted = await readReply(link, linkState);
            if (accepted.code !== 250) {
                return { ok: false, code: accepted.code, reason: String(accepted.lines.slice(-1)[0] || '').slice(4).trim().slice(0, 300) || 'the mail server refused the message' };
            }
            return { ok: true, code: accepted.code, reason: null };
        });
    } catch (err) {
        const reason = String((err && err.message) || err).slice(0, 300);
        return { ok: false, code: Number(err && err.code) || 0, reason };
    }
}

module.exports = { sendMessage, SmtpError, readReply, connect, session, offersStartTls, TIMEOUT_MS };
