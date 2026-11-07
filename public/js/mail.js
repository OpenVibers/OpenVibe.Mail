/* OpenVibe.Email's page (Opus, 11-07): a ten-minute address that shows its code, for anyone, and a signed-in person's
 * own addresses. Everything is real: the address is made by POST /api/v1/burners and its code read from
 * GET /api/v1/burners/:id/code with the burner's own token, kept in this browser until the address expires. Nothing
 * here sends mail, and no message body is ever shown: only the code, the sender and the time. */
(function () {
    'use strict';
    var KEY = 'ov_mail_burner';
    var root = document.querySelector('[data-mail-burner]');
    if (!root) return;
    var start = root.querySelector('[data-mail-start]');
    var box = root.querySelector('[data-mail-box]');
    var addr = root.querySelector('[data-mail-address]');
    var copy = root.querySelector('[data-mail-copy]');
    var left = root.querySelector('[data-mail-left]');
    var wait = root.querySelector('[data-mail-wait]');
    var codeBox = root.querySelector('[data-mail-code]');
    var codeText = root.querySelector('[data-mail-code-text]');
    var codeFrom = root.querySelector('[data-mail-code-from]');
    var codeCopy = root.querySelector('[data-mail-code-copy]');
    var problem = root.querySelector('[data-mail-problem]');
    var poll = null, tick = null, current = null;

    function save(b) { try { localStorage.setItem(KEY, JSON.stringify(b)); } catch (e) { /* private mode: this tab only */ } }
    function load() { try { var b = JSON.parse(localStorage.getItem(KEY) || 'null'); return b && Date.parse(b.expires_at) > Date.now() ? b : null; } catch (e) { return null; } }
    function forget() { try { localStorage.removeItem(KEY); } catch (e) { /* */ } }
    function say(text) { problem.textContent = text || ''; problem.hidden = !text; }
    function copyText(btn, text) {
        if (!navigator.clipboard) return;
        navigator.clipboard.writeText(text).then(function () {
            var was = btn.textContent; btn.textContent = 'Copied';
            setTimeout(function () { btn.textContent = was; }, 1400);
        }, function () {});
    }
    function stop() { clearInterval(poll); clearInterval(tick); poll = tick = null; }

    function show(b) {
        current = b;
        start.hidden = true;
        box.hidden = false;
        addr.textContent = b.address;
        codeBox.hidden = true;
        wait.hidden = false;
        stop();
        var paint = function () {
            var ms = Date.parse(b.expires_at) - Date.now();
            if (ms <= 0) { expire(); return; }
            var m = Math.floor(ms / 60000), s = Math.floor((ms % 60000) / 1000);
            left.textContent = m + ':' + (s < 10 ? '0' : '') + s + ' left';
        };
        paint();
        tick = setInterval(paint, 1000);
        var ask = function () {
            if (document.hidden || !current) return;
            fetch('/api/v1/burners/' + encodeURIComponent(b.id) + '/code', { headers: { Accept: 'application/json', 'x-mail-burner-token': b.token }, credentials: 'same-origin' })
                .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { return { ok: r.ok, status: r.status, j: j }; }); })
                .then(function (res) {
                    if (res.ok && res.j && res.j.code) {
                        codeText.textContent = res.j.code;
                        codeFrom.textContent = (res.j.from ? 'From ' + res.j.from : 'Arrived') + (res.j.received_at ? ' at ' + new Date(res.j.received_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '');
                        codeBox.hidden = false;
                        wait.hidden = true;
                    } else if (res.status === 404 && res.j && res.j.code !== 'mail.no_code') {
                        expire();
                    }
                })
                .catch(function () {});
        };
        ask();
        poll = setInterval(ask, 4000);
    }
    function expire() {
        stop();
        forget();
        current = null;
        box.hidden = true;
        start.hidden = false;
        start.querySelector('button').textContent = 'Get another 10-minute address';
        say('That address has expired, and its mail is deleted.');
    }

    start.querySelector('button').addEventListener('click', function () {
        var btn = this;
        btn.disabled = true;
        say('');
        fetch('/api/v1/burners', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: '{}' })
            .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { return { ok: r.ok, status: r.status, j: j }; }); })
            .then(function (res) {
                btn.disabled = false;
                if (!res.ok || !res.j.burner || !res.j.token) {
                    say(res.status === 429 ? 'You have made a lot of addresses from here this hour. Try again later, or sign in.'
                        : res.status === 503 ? 'Every free address is in use right now. Try again in a few minutes.'
                            : (res.j && res.j.detail) || 'No address was made. Try again.');
                    return;
                }
                var b = { id: res.j.burner.id, address: res.j.burner.address, expires_at: res.j.burner.expires_at, token: res.j.token };
                save(b);
                show(b);
            })
            .catch(function () { btn.disabled = false; say('The network did not answer. Try again.'); });
    });
    copy.addEventListener('click', function () { if (current) copyText(copy, current.address); });
    codeCopy.addEventListener('click', function () { copyText(codeCopy, codeText.textContent); });
    var kept = load();
    if (kept) show(kept);

    // A signed-in person's own addresses (GET /api/v1/me/mail): the kind, the address, its state and the count of
    // messages. A visitor gets 401 and the section stays hidden. Nothing here reads a message.
    var mine = document.querySelector('[data-mail-mine]');
    if (!mine) return;
    var list = mine.querySelector('[data-mail-mine-list]');
    var empty = mine.querySelector('[data-mail-mine-empty]');
    var KIND = { masks: 'Mask', burners: 'Ten-minute address', agent_inboxes: 'Agent inbox' };
    var STATE = { active: 'Active', disabled: 'Off', expired: 'Expired', consumed: 'Used' };
    fetch('/api/v1/me/mail', { credentials: 'same-origin', headers: { Accept: 'application/json' } })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (j) {
            if (!j) return;
            mine.hidden = false;
            var rows = [];
            ['agent_inboxes', 'burners', 'masks'].forEach(function (k) { (j[k] || []).forEach(function (x) { rows.push({ kind: k, x: x }); }); });
            empty.hidden = rows.length > 0;
            rows.forEach(function (r) {
                var li = document.createElement('li'); li.className = 'ml-row';
                var a = document.createElement('span'); a.className = 'ml-row-addr'; a.textContent = r.x.address || '';
                var st = document.createElement('span'); st.className = 'ml-row-state' + (r.x.state === 'active' ? ' is-on' : ''); st.textContent = STATE[r.x.state] || r.x.state || '';
                var meta = document.createElement('span'); meta.className = 'ml-row-meta';
                var n = r.x.counts && typeof r.x.counts.messages === 'number' ? r.x.counts.messages : 0;
                meta.textContent = KIND[r.kind] + (r.x.purpose ? ' · ' + r.x.purpose : '') + ' · ' + n + (n === 1 ? ' message' : ' messages');
                li.appendChild(a); li.appendChild(st); li.appendChild(meta);
                list.appendChild(li);
            });
        })
        .catch(function () {});
})();
