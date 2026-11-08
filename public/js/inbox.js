/* openvibe.email: your inbox (Mail M1.5, Opus's design). The page shell (server/http/pages.js, /inbox and
   /inbox/:id) gives <main data-mail-inbox> with three empty regions and the person's addresses as JSON in #mail-data:

   - data-mail-addresses: All mail, then each address (your mailbox, your masks, your agents' inboxes) with what came
     to it; New mask makes one for a site in one line;
   - data-mail-list: the newest first, 50 at a time, from /api/v1/me/mail/messages;
   - data-mail-read: one message. Its HTML was cleaned on the server and is shown in a sandboxed frame that can run
     no script at all, with remote images off until you ask (they are how senders track opening).

   On a phone the list and the message are two screens (Back returns), not tabs. Everything a sender wrote is set as
   text or goes into the sandboxed frame; nothing of it is ever parsed into this page. */
(function () {
  'use strict';
  var root = document.querySelector('main[data-mail-inbox]');
  var dataEl = document.getElementById('mail-data');
  if (!root || !dataEl) return;
  var data;
  try { data = JSON.parse(dataEl.textContent || '{}'); } catch (e) { return; }
  var side = root.querySelector('[data-mail-addresses]');
  var listEl = root.querySelector('[data-mail-list]');
  var readEl = root.querySelector('[data-mail-read]');
  var addresses = Array.isArray(data.addresses) ? data.addresses : [];
  var current = 'all', cursor = null, rows = [], openId = null, loading = false, aiEnabled = false, triageThreads = [], aiRules = [], aiJournal = [], imapMailboxes = [];
  var KIND = { mailbox: 'Your mailbox', mask: 'Mask', agent: 'Agent inbox', burner: 'Burner' };

  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function api(path, opts) {
    opts = opts || {};
    return fetch(path, { method: opts.method || 'GET', credentials: 'same-origin', headers: Object.assign({ Accept: 'application/json' }, opts.body ? { 'Content-Type': 'application/json' } : {}), body: opts.body ? JSON.stringify(opts.body) : undefined })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (b) { if (!r.ok) { var e = new Error(b.detail || b.title || ('HTTP ' + r.status)); e.status = r.status; throw e; } return b; }); });
  }
  function who(list) {
    var a = Array.isArray(list) ? list[0] : list;
    if (!a) return 'Unknown sender';
    if (typeof a === 'string') return a.replace(/\s*<[^>]+>\s*$/, '') || a;
    return a.name || a.email || 'Unknown sender';
  }
  function when(iso) {
    var d = new Date(iso);
    if (isNaN(d)) return '';
    var now = new Date();
    if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    if (now - d < 6 * 864e5) return d.toLocaleDateString([], { weekday: 'short' });
    return d.toLocaleDateString([], { day: 'numeric', month: 'short', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' });
  }
  function copy(text, button) {
    var done = function () { var t = button.textContent; button.textContent = 'Copied'; setTimeout(function () { button.textContent = t; }, 1400); };
    if (navigator.clipboard) navigator.clipboard.writeText(text).then(done, function () {});
  }
  var narrow = window.matchMedia('(max-width: 860px)');
  function showRead(on) { root.classList.toggle('is-reading', !!on); }

  // ── the addresses ──
  function paintSide() {
    side.textContent = '';
    side.appendChild(el('h2', 'ib-h', 'Addresses'));
    var ul = el('ul', 'ib-addrs');
    var all = [{ address: 'all', kind: 'all', label: 'All mail' }].concat(addresses);
    all.forEach(function (a) {
      var li = el('li');
      var b = el('button', 'ib-addr' + (current === a.address ? ' is-on' : ''));
      b.type = 'button';
      b.setAttribute('aria-pressed', current === a.address ? 'true' : 'false');
      // The mailbox is "Your mailbox" with its address under it (the address is long and says nothing first).
      var name = a.kind === 'all' ? 'All mail' : a.kind === 'mailbox' ? 'Your mailbox' : (a.label || a.address);
      b.appendChild(el('span', 'ib-addr-name', name));
      if (a.kind === 'mailbox') b.appendChild(el('span', 'ib-addr-sub', a.address));
      else if (a.kind !== 'all') b.appendChild(el('span', 'ib-addr-sub', (KIND[a.kind] || 'Address') + (a.label ? ' · ' + a.address : '') + (a.enabled === false ? ' · off' : '')));
      b.addEventListener('click', function () { current = a.address; cursor = null; rows = []; paintSide(); loadList(); showRead(false); });
      li.appendChild(b);
      ul.appendChild(li);
    });
    side.appendChild(ul);
    var aiBox = el('section', 'ib-ai-settings');
    aiBox.appendChild(el('h2', 'ib-h', 'Inbox AI'));
    var aiLabel = el('label', 'ib-ai-label');
    var aiToggle = el('input');
    aiToggle.type = 'checkbox'; aiToggle.checked = aiEnabled; aiToggle.setAttribute('aria-label', 'Turn on Inbox AI for this mailbox');
    aiToggle.addEventListener('change', function () {
      aiToggle.disabled = true;
      api('/api/v1/me/mail/ai-settings', { method: 'PUT', body: { enabled: aiToggle.checked } })
        .then(function (state) { aiEnabled = !!state.enabled; aiCopy.textContent = aiEnabled ? 'On · uses your OpenVibe.AI allowance. Drafts wait for your click.' : 'Off · your mail is not sent for AI triage.'; })
        .catch(function (err) { aiToggle.checked = aiEnabled; aiCopy.textContent = 'Could not save this setting. ' + err.message; })
        .finally(function () { aiToggle.disabled = false; });
    });
    aiLabel.appendChild(aiToggle); aiLabel.appendChild(el('span', '', 'Triage new mail with AI'));
    aiBox.appendChild(aiLabel);
    var aiCopy = el('p', 'ib-quiet', aiEnabled ? 'On · uses your OpenVibe.AI allowance. Drafts wait for your click.' : 'Off · your mail is not sent for AI triage.');
    aiBox.appendChild(aiCopy);
    side.appendChild(aiBox);
    // Connected mailboxes: Inbox AI reading another provider over IMAP. Read only, app password, and Disconnect is
    // the way back out; the summaries it pulled go only when the person asks.
    var imapBox = el('section', 'ib-ai-rules ib-imap');
    imapBox.appendChild(el('h2', 'ib-h', 'Connected mailboxes'));
    imapBox.appendChild(el('p', 'ib-quiet', 'Read another mailbox over IMAP. Mail only reads it; nothing there is moved or deleted. Use an app password, not your usual password.'));
    imapMailboxes.forEach(function (connection) {
      var item = el('div', 'ib-imap-item');
      item.appendChild(el('p', 'ib-imap-who', connection.username + ' · ' + connection.host + ':' + connection.port));
      item.appendChild(el('p', 'ib-quiet', connection.last_sync_at ? 'Last checked ' + when(connection.last_sync_at) : 'Not checked yet.'));
      if (connection.last_error) item.appendChild(el('p', 'ib-problem', connection.last_error));
      var also = el('input'); also.type = 'checkbox';
      also.setAttribute('aria-label', 'Also delete the summaries pulled from this mailbox');
      var alsoLabel = el('label', 'ib-rule-enabled'); alsoLabel.appendChild(also);
      alsoLabel.appendChild(document.createTextNode(' Also delete its AI summaries'));
      var off = el('button', 'ib-btn is-quiet is-danger', 'Disconnect'); off.type = 'button';
      off.addEventListener('click', function () {
        if (!window.confirm(also.checked ? 'Disconnect ' + connection.username + ' and delete the summaries pulled from it?' : 'Disconnect ' + connection.username + '?')) return;
        off.disabled = true;
        api('/api/v1/me/mail/imap-mailboxes/' + encodeURIComponent(connection.id) + '?delete_triage=' + (also.checked ? '1' : '0'), { method: 'DELETE' })
          .then(function () { return loadAiControls(); }).then(paintSide)
          .catch(function (err) { off.disabled = false; item.appendChild(el('p', 'ib-problem', 'Could not disconnect: ' + err.message)); });
      });
      item.appendChild(alsoLabel); item.appendChild(off);
      imapBox.appendChild(item);
    });
    if (aiEnabled) {
      var imapForm = el('form', 'ib-rule-form');
      var imapHost = el('input', 'ib-input'); imapHost.placeholder = 'imap.gmail.com'; imapHost.setAttribute('aria-label', 'IMAP host');
      var imapPort = el('input', 'ib-input'); imapPort.type = 'number'; imapPort.min = '1'; imapPort.max = '65535'; imapPort.value = '993'; imapPort.setAttribute('aria-label', 'IMAP port');
      var imapUser = el('input', 'ib-input'); imapUser.placeholder = 'you@gmail.com'; imapUser.setAttribute('aria-label', 'IMAP username');
      var imapPass = el('input', 'ib-input'); imapPass.type = 'password'; imapPass.autocomplete = 'new-password'; imapPass.placeholder = 'App password'; imapPass.setAttribute('aria-label', 'App password');
      var imapGo = el('button', 'ib-btn is-quiet', 'Connect'); imapGo.type = 'submit';
      var imapNote = el('p', 'ib-quiet');
      imapForm.appendChild(imapHost); imapForm.appendChild(imapPort); imapForm.appendChild(imapUser); imapForm.appendChild(imapPass); imapForm.appendChild(imapGo); imapForm.appendChild(imapNote);
      imapForm.addEventListener('submit', function (event) {
        event.preventDefault();
        imapGo.disabled = true; imapNote.textContent = 'Checking the mailbox…';
        api('/api/v1/me/mail/imap-mailboxes', { method: 'POST', body: { host: imapHost.value.trim(), port: Number(imapPort.value), username: imapUser.value.trim(), password: imapPass.value } })
          .then(function () { imapPass.value = ''; return loadAiControls(); }).then(paintSide)
          .catch(function (err) { imapGo.disabled = false; imapNote.textContent = err.message; });
      });
      imapBox.appendChild(imapForm);
    } else if (!imapMailboxes.length) {
      imapBox.appendChild(el('p', 'ib-quiet', 'Turn on Inbox AI to connect a mailbox.'));
    }
    side.appendChild(imapBox);
    var rulesBox = el('section', 'ib-ai-rules');
    rulesBox.appendChild(el('h2', 'ib-h', 'Rules'));
    function ruleForm(rule) {
      var form = el('form', 'ib-rule-form');
      var name = el('input', 'ib-input'); name.placeholder = 'Rule name'; name.value = rule.name || ''; name.setAttribute('aria-label', 'Rule name');
      var from = el('input', 'ib-input'); from.placeholder = 'Sender email (optional)'; from.value = rule.match_from || ''; from.setAttribute('aria-label', 'Match sender email');
      var subjectMatch = el('input', 'ib-input'); subjectMatch.placeholder = 'Subject contains (optional)'; subjectMatch.value = rule.match_subject || ''; subjectMatch.setAttribute('aria-label', 'Match subject text');
      var category = el('select', 'ib-input'); category.setAttribute('aria-label', 'Move matching threads to');
      [['needs_reply','Needs a reply'],['to_read','To read'],['receipts','Receipts'],['newsletters','Newsletters'],['other','The rest']].forEach(function (entry) {
        var option = el('option', '', entry[1]); option.value = entry[0]; option.selected = rule.category === entry[0]; category.appendChild(option);
      });
      var enabled = el('input'); enabled.type = 'checkbox'; enabled.checked = rule.enabled !== false;
      var enabledLabel = el('label', 'ib-rule-enabled'); enabledLabel.appendChild(enabled); enabledLabel.appendChild(document.createTextNode(' Enabled'));
      var save = el('button', 'ib-btn is-quiet', rule.id ? 'Save rule' : 'Add rule'); save.type = 'submit';
      form.appendChild(name); form.appendChild(from); form.appendChild(subjectMatch); form.appendChild(category); form.appendChild(enabledLabel); form.appendChild(save);
      form.addEventListener('submit', function (event) {
        event.preventDefault(); save.disabled = true;
        var value = { name: name.value, match_from: from.value, match_subject: subjectMatch.value, category: category.value, enabled: enabled.checked };
        api('/api/v1/me/mail/ai-rules' + (rule.id ? '/' + encodeURIComponent(rule.id) : ''), { method: rule.id ? 'PUT' : 'POST', body: value })
          .then(function () { return api('/api/v1/me/mail/ai-rules'); }).then(function (result) { aiRules = result.rules || []; paintSide(); })
          .catch(function (err) { save.disabled = false; save.textContent = 'Could not save: ' + err.message; });
      });
      if (rule.id) {
        var remove = el('button', 'ib-btn is-quiet', 'Delete'); remove.type = 'button';
        remove.addEventListener('click', function () { remove.disabled = true; api('/api/v1/me/mail/ai-rules/' + encodeURIComponent(rule.id), { method: 'DELETE' }).then(function () { aiRules = aiRules.filter(function (r) { return r.id !== rule.id; }); paintSide(); }).catch(function () { remove.disabled = false; }); });
        form.appendChild(remove);
      }
      return form;
    }
    aiRules.forEach(function (rule) { rulesBox.appendChild(ruleForm(rule)); });
    rulesBox.appendChild(ruleForm({ category: 'other', enabled: true }));
    side.appendChild(rulesBox);
    var journalBox = el('section', 'ib-ai-journal');
    journalBox.appendChild(el('h2', 'ib-h', 'Rule journal'));
    aiJournal.forEach(function (entry) {
      var line = el('div', 'ib-journal-entry');
      line.appendChild(el('span', '', entry.rule_name + ' moved a thread to ' + entry.action_category.replace('_', ' ')));
      if (!entry.undone_at) {
        var undo = el('button', 'ib-btn is-quiet', 'Undo'); undo.type = 'button';
        undo.addEventListener('click', function () { undo.disabled = true; api('/api/v1/me/mail/ai-journal/' + encodeURIComponent(entry.id) + '/undo', { method: 'POST' }).then(function () { return loadAiControls(); }).then(paintSide).catch(function () { undo.disabled = false; }); });
        line.appendChild(undo);
      } else line.appendChild(el('span', 'ib-quiet', 'Undone'));
      journalBox.appendChild(line);
    });
    side.appendChild(journalBox);
    // New mask: one line, for one site.
    var form = el('form', 'ib-newmask');
    var input = el('input', 'ib-input');
    input.type = 'text'; input.maxLength = 60; input.placeholder = 'A site, e.g. shoes shop'; input.setAttribute('aria-label', 'What the new mask is for');
    var go = el('button', 'ib-btn', 'New mask');
    go.type = 'submit';
    form.appendChild(input); form.appendChild(go);
    var made = el('p', 'ib-made');
    made.hidden = true;
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      go.disabled = true;
      api('/api/v1/masks', { method: 'POST', body: { label: input.value.trim() || null } }).then(function (b) {
        var m = b.mask || {};
        addresses.push({ address: m.address, kind: 'mask', label: m.label || null, enabled: true });
        input.value = '';
        paintSide();
        var p = side.querySelector('.ib-made');
        p.hidden = false; p.textContent = '';
        p.appendChild(el('span', 'ib-made-addr', m.address));
        var c = el('button', 'ib-btn is-quiet', 'Copy');
        c.type = 'button';
        c.addEventListener('click', function () { copy(m.address, c); });
        p.appendChild(c);
      }).catch(function (err) { made.hidden = false; made.textContent = err.message; }).then(function () { go.disabled = false; });
    });
    side.appendChild(form);
    side.appendChild(made);
  }

  // ── the list ──
  function loadList(more) {
    if (loading) return;
    loading = true;
    if (!more) { listEl.textContent = ''; listEl.appendChild(el('p', 'ib-quiet', 'Loading your mail…')); }
    var q = '?address=' + encodeURIComponent(current) + (more && cursor ? '&cursor=' + encodeURIComponent(cursor) : '');
    api('/api/v1/me/mail/messages' + q).then(function (b) {
      rows = (more ? rows : []).concat(b.messages || []);
      cursor = b.next_cursor || null;
      api('/api/v1/me/mail/triage').then(function (triage) { triageThreads = triage.threads || []; paintList(); }).catch(function () { triageThreads = []; paintList(); });
    }).catch(function (err) {
      listEl.textContent = '';
      listEl.appendChild(el('p', 'ib-problem', err.status === 401 ? 'Sign in again to see your mail.' : 'Your mail could not be loaded. ' + err.message));
    }).then(function () { loading = false; });
  }
  function paintList() {
    listEl.textContent = '';
    var head = el('div', 'ib-listhead');
    var a = addresses.find(function (x) { return x.address === current; });
    head.appendChild(el('h2', 'ib-h', current === 'all' ? 'All mail' : (a && a.label) || current));
    listEl.appendChild(head);
    if (current === 'all' && triageThreads.length) {
      var groups = [
        ['needs_reply', 'Needs a reply'], ['to_read', 'To read'], ['receipts', 'Receipts'],
        ['newsletters', 'Newsletters'], ['other', 'The rest'],
      ];
      groups.forEach(function (group) {
        var items = triageThreads.filter(function (item) { return item.category === group[0]; });
        var section = el('section', 'ib-triage-group');
        section.appendChild(el('h3', 'ib-triage-heading', group[1] + ' · ' + items.length));
        items.forEach(function (item) {
          var card = el('article', 'ib-triage-card');
          card.appendChild(el('p', 'ib-triage-summary', item.summary));
          if (group[0] === 'needs_reply' && item.draft_state === 'draft') {
            var subject = el('input', 'ib-input'); subject.value = item.draft_subject || ''; subject.setAttribute('aria-label', 'Draft subject');
            var editor = el('textarea', 'ib-input ib-draft'); editor.value = item.draft_body || ''; editor.setAttribute('aria-label', 'Edit suggested reply');
            var save = el('button', 'ib-btn is-quiet', 'Save draft'); save.type = 'button';
            var send = el('button', 'ib-btn', 'Send'); send.type = 'button';
            var status = el('p', 'ib-quiet');
            save.addEventListener('click', function () {
              save.disabled = true;
              api('/api/v1/me/mail/triage/' + encodeURIComponent(item.thread_id) + '/draft', { method: 'PUT', body: { subject: subject.value, body: editor.value } })
                .then(function () { status.textContent = 'Draft saved.'; }).catch(function (err) { status.textContent = 'Could not save: ' + err.message; })
                .finally(function () { save.disabled = false; });
            });
            send.addEventListener('click', function () {
              if (!window.confirm('Send this reply to ' + item.draft_to + '?')) return;
              send.disabled = true; status.textContent = 'Sending…';
              api('/api/v1/me/mail/triage/' + encodeURIComponent(item.thread_id) + '/send', { method: 'POST', body: { subject: subject.value, body: editor.value } })
                .then(function () { status.textContent = 'Sent.'; return api('/api/v1/me/mail/triage'); })
                .then(function (triage) { triageThreads = triage.threads || []; paintList(); })
                .catch(function (err) { status.textContent = err.status === 409 ? 'Sending is unavailable for this recipient yet.' : 'Not sent: ' + err.message; send.disabled = false; });
            });
            card.appendChild(subject); card.appendChild(editor); card.appendChild(save); card.appendChild(send); card.appendChild(status);
          } else if (item.draft_state === 'sent') card.appendChild(el('p', 'ib-quiet', 'Reply sent.'));
          section.appendChild(card);
        });
        listEl.appendChild(section);
      });
    }
    if (!rows.length) {
      var e = el('div', 'ib-empty');
      e.appendChild(el('p', null, current === 'all' ? 'Nothing here yet.' : 'Nothing has arrived at this address yet.'));
      if (current !== 'all') {
        var line = el('p', 'ib-empty-addr');
        line.appendChild(el('code', null, current));
        var c = el('button', 'ib-btn is-quiet', 'Copy');
        c.type = 'button';
        c.addEventListener('click', function () { copy(current, c); });
        line.appendChild(c);
        e.appendChild(line);
      }
      listEl.appendChild(e);
      return;
    }
    var ul = el('ul', 'ib-rows');
    rows.forEach(function (m) {
      var li = el('li');
      var b = el('button', 'ib-row' + (m.unread ? ' is-unread' : '') + (openId === m.id ? ' is-open' : ''));
      b.type = 'button';
      var top = el('span', 'ib-row-top');
      top.appendChild(el('span', 'ib-row-from', who(m.from)));
      top.appendChild(el('time', 'ib-row-when', when(m.received_at)));
      b.appendChild(top);
      var sub = el('span', 'ib-row-subject', m.subject || '(no subject)');
      if (m.has_attachments) sub.appendChild(el('span', 'ib-clip', ' · attachment'));
      b.appendChild(sub);
      if (current === 'all' && m.to) b.appendChild(el('span', 'ib-row-to', 'to ' + (Array.isArray(m.to) ? m.to[0] : m.to)));
      b.addEventListener('click', function () { openMessage(m.id, false); });
      li.appendChild(b);
      ul.appendChild(li);
    });
    listEl.appendChild(ul);
    if (cursor) {
      var more = el('button', 'ib-btn is-quiet ib-more', 'Older mail');
      more.type = 'button';
      more.addEventListener('click', function () { loadList(true); });
      listEl.appendChild(more);
    }
  }

  // ── one message ──
  function openMessage(id, images) {
    openId = id;
    paintList();
    readEl.textContent = '';
    readEl.appendChild(el('p', 'ib-quiet', 'Opening…'));
    showRead(true);
    try { history.pushState({ mail: id }, '', '/inbox/' + encodeURIComponent(id)); } catch (e) { /* old browser */ }
    api('/api/v1/me/mail/messages/' + encodeURIComponent(id) + (images ? '?images=1' : '')).then(function (b) {
      var m = b.message || {};
      paintMessage(m, images);
      var row = rows.find(function (r) { return r.id === id; });
      if (row && row.unread) { row.unread = false; paintList(); api('/api/v1/me/mail/messages/' + encodeURIComponent(id) + '/read', { method: 'POST' }).catch(function () {}); }
    }).catch(function (err) {
      readEl.textContent = '';
      readEl.appendChild(el('p', 'ib-problem', err.status === 404 ? 'That message is not here any more.' : 'It could not be opened. ' + err.message));
    });
  }
  function paintMessage(m, images) {
    readEl.textContent = '';
    var bar = el('div', 'ib-readbar');
    var back = el('button', 'ib-btn is-quiet ib-back', '← Inbox');
    back.type = 'button';
    back.addEventListener('click', function () { showRead(false); try { history.back(); } catch (e) { /* */ } });
    bar.appendChild(back);
    var unread = el('button', 'ib-btn is-quiet', 'Mark unread');
    unread.type = 'button';
    unread.addEventListener('click', function () {
      api('/api/v1/me/mail/messages/' + encodeURIComponent(m.id) + '/unread', { method: 'POST' }).then(function () {
        var row = rows.find(function (r) { return r.id === m.id; }); if (row) row.unread = true; paintList();
      }).catch(function () {});
    });
    var del = el('button', 'ib-btn is-quiet is-danger', 'Delete');
    del.type = 'button';
    del.addEventListener('click', function () {
      del.disabled = true;
      api('/api/v1/me/mail/messages/' + encodeURIComponent(m.id), { method: 'DELETE' }).then(function () {
        rows = rows.filter(function (r) { return r.id !== m.id; });
        openId = null; paintList(); readEl.textContent = ''; readEl.appendChild(el('p', 'ib-quiet', 'Moved to the trash. It is gone for good after 30 days.')); showRead(false);
      }).catch(function () { del.disabled = false; });
    });
    bar.appendChild(unread); bar.appendChild(del);
    readEl.appendChild(bar);
    var head = el('header', 'ib-msghead');
    head.appendChild(el('h2', 'ib-subject', m.subject || '(no subject)'));
    var meta = el('p', 'ib-meta');
    meta.appendChild(el('b', null, who(m.from)));
    var to = Array.isArray(m.to) ? m.to.join(', ') : (m.to || '');
    if (to) meta.appendChild(document.createTextNode(' to ' + to));
    if (m.date) meta.appendChild(el('time', 'ib-meta-when', ' · ' + new Date(m.date).toLocaleString()));
    head.appendChild(meta);
    readEl.appendChild(head);
    if (m.blocked_images > 0 && !images) {
      var note = el('p', 'ib-images');
      note.appendChild(document.createTextNode(m.blocked_images + ' remote image' + (m.blocked_images === 1 ? ' is' : 's are') + ' off, so the sender cannot see that you opened this. '));
      var show = el('button', 'ib-btn is-quiet', 'Show images');
      show.type = 'button';
      show.addEventListener('click', function () { openMessage(m.id, true); });
      note.appendChild(show);
      readEl.appendChild(note);
    }
    if (m.html) readEl.appendChild(frameFor(m.html, images));
    else {
      var pre = el('div', 'ib-text');
      textNodes(pre, String(m.text || ''));
      readEl.appendChild(pre);
    }
    var att = Array.isArray(m.attachments) ? m.attachments : [];
    if (att.length) {
      var ul = el('ul', 'ib-att');
      att.forEach(function (a) {
        var li = el('li');
        var link = el('a', 'ib-att-link', a.name || 'attachment');
        link.href = '/api/v1/me/mail/messages/' + encodeURIComponent(m.id) + '/attachments/' + encodeURIComponent(a.part);
        link.setAttribute('download', '');
        li.appendChild(link);
        if (a.size) li.appendChild(el('span', 'ib-att-size', ' · ' + Math.max(1, Math.round(a.size / 1024)) + ' KB'));
        ul.appendChild(li);
      });
      readEl.appendChild(ul);
    }
  }
  // The cleaned HTML in a frame that runs no script (no allow-scripts) and loads nothing remote unless asked; links
  // leave the frame in a new tab. Without scripts, allow-same-origin only lets this page size the frame to its text.
  function frameFor(html, images) {
    var f = el('iframe', 'ib-frame');
    f.setAttribute('sandbox', 'allow-same-origin allow-popups allow-popups-to-escape-sandbox');
    f.setAttribute('referrerpolicy', 'no-referrer');
    f.setAttribute('title', 'The message');
    var csp = "default-src 'none'; style-src 'unsafe-inline'; img-src data:" + (images ? ' https:' : '') + '; font-src data:';
    f.srcdoc = '<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="' + csp + '">' +
      '<base target="_blank"><style>html,body{margin:0;padding:0;background:#fff;color:#111;font:15px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;overflow-wrap:anywhere}body{padding:16px}img{max-width:100%;height:auto}table{max-width:100%}a{color:#1d4ed8}</style></head><body>' + html + '</body></html>';
    f.addEventListener('load', function () {
      try { var h = f.contentDocument.documentElement.scrollHeight; f.style.height = Math.min(Math.max(h, 120), 20000) + 'px'; } catch (e) { f.style.height = '70vh'; }
    });
    return f;
  }
  function textNodes(parent, text) {
    var re = /https?:\/\/[^\s<>"']+/g, last = 0, mm;
    while ((mm = re.exec(text))) {
      if (mm.index > last) parent.appendChild(document.createTextNode(text.slice(last, mm.index)));
      var url = mm[0].replace(/[.,!?)]+$/, ''), a = el('a', null, url);
      a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer';
      parent.appendChild(a); last = mm.index + url.length; re.lastIndex = last;
    }
    if (last < text.length) parent.appendChild(document.createTextNode(text.slice(last)));
  }

  window.addEventListener('popstate', function () {
    var m = /^\/inbox\/([^/]+)$/.exec(location.pathname);
    if (m) openMessage(decodeURIComponent(m[1]), false); else { openId = null; showRead(false); paintList(); }
  });

  // The addresses come from the API when the shell does not carry them.
  function begin() {
    paintSide();
    loadAiControls().then(paintSide).catch(function () {});
    loadList();
  }
  function loadAiControls() {
    return Promise.all([api('/api/v1/me/mail/ai-settings'), api('/api/v1/me/mail/ai-rules'), api('/api/v1/me/mail/ai-journal'), api('/api/v1/me/mail/imap-mailboxes')])
      .then(function (results) { aiEnabled = !!results[0].enabled; aiRules = results[1].rules || []; aiJournal = results[2].entries || []; imapMailboxes = results[3].mailboxes || []; });
  }
  if (addresses.length) begin();
  else api('/api/v1/me/mail/addresses').then(function (b) { addresses = b.addresses || []; begin(); }).catch(function () { begin(); });
  var start = /^\/inbox\/([^/]+)$/.exec(location.pathname);
  if (start) openMessage(decodeURIComponent(start[1]), false);
  else if (readEl) { readEl.textContent = ''; readEl.appendChild(el('p', 'ib-quiet ib-pick', 'Pick a message to read it here.')); }
  narrow.addEventListener && narrow.addEventListener('change', function () { if (!narrow.matches) showRead(!!openId); });
})();
