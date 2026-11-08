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
  var settingsPage = root.hasAttribute('data-mail-settings'), folder = 'inbox', search = '', selectedLabel = '', workspace = { addresses:[], labels:[] }, openedMessage = null, customDomains = [], forwards = [];
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
    if (!settingsPage) { paintFolders(); return; }
    side.appendChild(el('h1', '', 'Mail settings'));
    var backLink = el('a', 'ib-btn is-quiet', '← Inbox'); backLink.href = '/inbox'; side.appendChild(backLink);
    side.appendChild(el('h2', 'ib-h', 'Addresses (' + addresses.length + ')'));
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
      b.addEventListener('click', function () { location.href = '/inbox?address=' + encodeURIComponent(a.address); });
      li.appendChild(b);
      ul.appendChild(li);
    });
    side.appendChild(ul);
    var personal = el('section', 'ib-person');
    personal.appendChild(el('h2', 'ib-h', 'Your address'));
    var addressForm = el('form', 'ib-rule-form');
    var addressName = el('input', 'ib-input'); addressName.placeholder = 'name'; addressName.required = true; addressName.setAttribute('aria-label', 'New address name');
    var addressDomain = el('select', 'ib-input'); addressDomain.setAttribute('aria-label', 'Address domain');
    [{ domain: 'openvibe.email' }].concat(customDomains.filter(function (d) { return d.mx_verified; })).forEach(function (d) { var option = el('option', '', '@' + d.domain); option.value = d.domain; addressDomain.appendChild(option); });
    var addressGo = el('button', 'ib-btn is-quiet', 'Create address'); addressGo.type = 'submit';
    var addressNote = el('p', 'ib-quiet');
    addressForm.appendChild(addressName); addressForm.appendChild(addressDomain); addressForm.appendChild(addressGo); addressForm.appendChild(addressNote);
    addressForm.addEventListener('submit', function (event) {
      event.preventDefault(); addressGo.disabled = true;
      api('/api/v1/me/mail/person-addresses', { method: 'POST', body: { name: addressName.value, domain: addressDomain.value, kind: addressDomain.value !== 'openvibe.email' ? 'custom' : addresses.some(function (a) { return a.kind === 'name'; }) ? 'alias' : 'name' } })
        .then(function () { return api('/api/v1/me/mail/addresses'); }).then(function (result) { addresses = result.addresses || []; return loadPersonControls(); }).then(function () { paintSide(); })
        .catch(function (err) { addressGo.disabled = false; addressNote.textContent = err.message; });
    });
    personal.appendChild(addressForm);
    personal.appendChild(el('h2', 'ib-h', 'Custom domains (' + customDomains.length + ')'));
    customDomains.forEach(function (domain) {
      var card = el('div', 'ib-person-domain'); card.appendChild(el('strong', '', domain.domain + ' · ' + domain.status.replace(/_/g, ' ')));
      var records = el('pre', 'ib-dns', JSON.stringify(domain.dns, null, 2)); card.appendChild(records);
      var verify = el('button', 'ib-btn is-quiet', 'Check DNS'); verify.type = 'button';
      verify.addEventListener('click', function () { verify.disabled = true; api('/api/v1/me/mail/custom-domains/' + encodeURIComponent(domain.domain) + '/verify', { method: 'POST' }).then(loadPersonControls).then(paintSide).catch(function (err) { verify.disabled = false; card.appendChild(el('p', 'ib-problem', err.message)); }); });
      card.appendChild(verify); personal.appendChild(card);
    });
    var domainForm = el('form', 'ib-rule-form');
    var domainName = el('input', 'ib-input'); domainName.placeholder = 'example.com'; domainName.setAttribute('aria-label', 'Custom domain'); domainName.required = true;
    var domainGo = el('button', 'ib-btn is-quiet', 'Add domain'); domainGo.type = 'submit';
    var domainNote = el('p', 'ib-quiet');
    domainForm.appendChild(domainName); domainForm.appendChild(domainGo); domainForm.appendChild(domainNote);
    domainForm.addEventListener('submit', function (event) { event.preventDefault(); domainGo.disabled = true; api('/api/v1/me/mail/custom-domains', { method: 'POST', body: { domain: domainName.value } }).then(loadPersonControls).then(paintSide).catch(function (err) { domainGo.disabled = false; domainNote.textContent = err.message; }); });
    personal.appendChild(domainForm);
    personal.appendChild(el('h2', 'ib-h', 'Forwarding (' + forwards.length + ')'));
    personal.appendChild(el('p', 'ib-quiet', 'Add and verify your other address on your Network account first. A copy stays in this inbox.'));
    forwards.forEach(function (rule) {
      var line = el('div', 'ib-forward'); line.appendChild(el('span', '', (rule.source_address || 'All mail') + ' → ' + rule.target_address));
      var remove = el('button', 'ib-btn is-quiet', 'Remove'); remove.type = 'button';
      remove.addEventListener('click', function () { remove.disabled = true; api('/api/v1/me/mail/forwards/' + encodeURIComponent(rule.id), { method: 'DELETE' }).then(loadPersonControls).then(paintSide).catch(function () { remove.disabled = false; }); });
      line.appendChild(remove); personal.appendChild(line);
    });
    var forwardForm = el('form', 'ib-rule-form');
    var forwardSource = el('select', 'ib-input'); forwardSource.setAttribute('aria-label', 'Forward mail sent to');
    [{ address: 'all' }].concat(addresses).forEach(function (a) { var option = el('option', '', a.address === 'all' ? 'All mail' : a.address); option.value = a.address; forwardSource.appendChild(option); });
    var forwardTarget = el('input', 'ib-input'); forwardTarget.type = 'email'; forwardTarget.placeholder = 'you@gmail.com'; forwardTarget.required = true; forwardTarget.setAttribute('aria-label', 'Verified forwarding email');
    var forwardGo = el('button', 'ib-btn is-quiet', 'Add forwarding'); forwardGo.type = 'submit';
    var forwardNote = el('p', 'ib-quiet');
    forwardForm.appendChild(forwardSource); forwardForm.appendChild(forwardTarget); forwardForm.appendChild(forwardGo); forwardForm.appendChild(forwardNote);
    forwardForm.addEventListener('submit', function (event) { event.preventDefault(); forwardGo.disabled = true; api('/api/v1/me/mail/forwards', { method: 'POST', body: { source: forwardSource.value, target: forwardTarget.value } }).then(loadPersonControls).then(paintSide).catch(function (err) { forwardGo.disabled = false; forwardNote.textContent = err.message; }); });
    personal.appendChild(forwardForm);
    side.appendChild(personal);
    var aiBox = el('section', 'ib-ai-settings');
    aiBox.id = 'inbox-ai';   // openvibe.my's Receipts card links here to turn Inbox AI on
    aiBox.appendChild(el('h2', 'ib-h', 'Inbox AI (' + (aiEnabled ? '1 enabled' : '0 enabled') + ')'));
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
    imapBox.appendChild(el('h2', 'ib-h', 'Connected mailboxes (' + imapMailboxes.length + ')'));
    imapBox.appendChild(el('p', 'ib-quiet', 'Read another mailbox over IMAP. Mail only reads it; nothing there is moved or deleted. Use an app password, not your usual password.'));
    imapMailboxes.forEach(function (connection) {
      var item = el('div', 'ib-imap-item');
      item.appendChild(el('p', 'ib-imap-who', connection.username + ' · ' + connection.host));
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
      var imapUser = el('input', 'ib-input'); imapUser.placeholder = 'you@gmail.com'; imapUser.setAttribute('aria-label', 'IMAP username');
      var imapPass = el('input', 'ib-input'); imapPass.type = 'password'; imapPass.autocomplete = 'new-password'; imapPass.placeholder = 'App password'; imapPass.setAttribute('aria-label', 'App password');
      var imapGo = el('button', 'ib-btn is-quiet', 'Connect'); imapGo.type = 'submit';
      var imapNote = el('p', 'ib-quiet');
      imapForm.appendChild(imapHost); imapForm.appendChild(imapUser); imapForm.appendChild(imapPass); imapForm.appendChild(imapGo); imapForm.appendChild(imapNote);
      imapForm.addEventListener('submit', function (event) {
        event.preventDefault();
        imapGo.disabled = true; imapNote.textContent = 'Checking the mailbox…';
        api('/api/v1/me/mail/imap-mailboxes', { method: 'POST', body: { host: imapHost.value.trim(), username: imapUser.value.trim(), password: imapPass.value } })
          .then(function () { imapPass.value = ''; return loadAiControls(); }).then(paintSide)
          .catch(function (err) { imapGo.disabled = false; imapNote.textContent = err.message; });
      });
      imapBox.appendChild(imapForm);
    } else if (!imapMailboxes.length) {
      imapBox.appendChild(el('p', 'ib-quiet', 'Turn on Inbox AI to connect a mailbox.'));
    }
    side.appendChild(imapBox);
    var rulesBox = el('section', 'ib-ai-rules');
    rulesBox.appendChild(el('h2', 'ib-h', 'Rules (' + aiRules.length + ')'));
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
    journalBox.appendChild(el('h2', 'ib-h', 'Rule journal (' + aiJournal.length + ')'));
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
    side.appendChild(el('h2', 'ib-h', 'Masks (' + addresses.filter(function (a) { return a.kind === 'mask'; }).length + ')'));
    side.appendChild(form);
    side.appendChild(made);
    paintSignatures();
    side.querySelectorAll('input:not([type=checkbox]),select').forEach(function (input) { if (input.parentElement.tagName === 'LABEL') return; var label = el('label', 'ib-field', input.getAttribute('aria-label') || input.placeholder || 'Value'); input.parentNode.insertBefore(label,input); label.appendChild(input); });
  }

  // ── the list ──
  function loadList(more) {
    if (settingsPage) return;
    if (folder === 'scheduled' || folder === 'sent') { loadOutbox(); return; }
    if (loading) { pendingLoad = true; return; }
    loading = true;
    if (!more) { listEl.textContent = ''; listEl.appendChild(el('p', 'ib-quiet', 'Loading your mail…')); }
    var q = '?folder=' + encodeURIComponent(folder) + '&q=' + encodeURIComponent(search) + '&label=' + encodeURIComponent(selectedLabel) + '&address=' + encodeURIComponent(current) + (more && cursor ? '&cursor=' + encodeURIComponent(cursor) : '');
    api('/api/v1/me/mail/workspace/messages' + q).then(function (b) {
      rows = (more ? rows : []).concat(b.messages || []);
      cursor = b.next_cursor || null;
      api('/api/v1/me/mail/triage').then(function (triage) { triageThreads = triage.threads || []; paintList(); }).catch(function () { triageThreads = []; paintList(); });
    }).catch(function (err) {
      listEl.textContent = '';
      listEl.appendChild(el('p', 'ib-problem', err.status === 401 ? 'Sign in again to see your mail.' : 'Your mail could not be loaded. ' + err.message));
    }).then(function () { loading = false; if (pendingLoad) { pendingLoad = false; loadList(); } });
  }
  function paintList() {
    listEl.textContent = '';
    var head = el('div', 'ib-listhead');
    var a = addresses.find(function (x) { return x.address === current; });
    head.appendChild(el('h2', 'ib-h', search ? 'Search results' : folder.charAt(0).toUpperCase() + folder.slice(1)));
    listEl.appendChild(head);
    var triageHost = el('details', 'ib-triage-fold'); triageHost.appendChild(el('summary', '', 'Inbox AI (' + triageThreads.length + ')'));
    if (current === 'all' && triageThreads.length && folder === 'inbox' && !search) {
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
        triageHost.appendChild(section);
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
    var seenThreads = new Set();
    rows.forEach(function (m) {
      if (seenThreads.has(m.thread_id)) return; seenThreads.add(m.thread_id);
      var li = el('li');
      var b = el('button', 'ib-row' + (m.unread ? ' is-unread' : '') + (openId === m.id ? ' is-open' : ''));
      b.type = 'button';
      var top = el('span', 'ib-row-top');
      top.appendChild(el('span', 'ib-row-from', who(m.from)));
      top.appendChild(el('time', 'ib-row-when', when(m.received_at)));
      b.appendChild(top);
      var sub = el('span', 'ib-row-subject', m.subject || '(no subject)');
      if (m.has_attachments) sub.appendChild(el('span', 'ib-clip', ' · attachment'));
      var threadCount = rows.filter(function (r) { return r.thread_id === m.thread_id; }).length;
      if (threadCount > 1) sub.appendChild(el('span', '', ' · ' + threadCount + ' messages'));
      if (m.starred) sub.appendChild(el('span', '', ' · ★'));
      if (m.labels && m.labels.length) sub.appendChild(el('span', '', ' · ' + m.labels.join(', ')));
      b.appendChild(sub);
      if (current === 'all' && m.to) b.appendChild(el('span', 'ib-row-to', 'to ' + (Array.isArray(m.to) ? m.to[0] : m.to)));
      b.addEventListener('click', function () { openMessage(m.id, false); });
      var swipeStart;
      b.addEventListener('touchstart', function (e) { swipeStart = { x:e.changedTouches[0].clientX,y:e.changedTouches[0].clientY }; }, { passive:true });
      b.addEventListener('touchend', function (e) { var t = e.changedTouches[0]; if (swipeStart && Math.abs(t.clientX-swipeStart.x)>90 && Math.abs(t.clientY-swipeStart.y)<35) { updateMessage(m.id,{ archived:true }).then(function () { notice('Archived.'); var undo = el('button','ib-btn is-quiet','Undo archive'); undo.onclick = function () { updateMessage(m.id,{ archived:false }).then(function () { notice('Returned to inbox.'); }); }; statusBar.appendChild(undo); }); } }, { passive:true });
      li.appendChild(b);
      ul.appendChild(li);
    });
    listEl.appendChild(ul);
    if (triageHost.childElementCount > 1) listEl.appendChild(triageHost);
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
    if (folder !== 'scheduled' && folder !== 'sent') paintList();
    readEl.textContent = '';
    readEl.appendChild(el('p', 'ib-quiet', 'Opening…'));
    showRead(true);
    try { if (location.pathname !== '/inbox/' + encodeURIComponent(id)) history.pushState({ mail: id }, '', '/inbox/' + encodeURIComponent(id)); } catch (e) { /* old browser */ }
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
    openedMessage = m;
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
    messageActions(m,bar);
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
    var thread = el('details', 'ib-thread'); var summary = el('summary', '', 'Conversation'); thread.appendChild(summary); readEl.appendChild(thread);
    api('/api/v1/me/mail/workspace/threads/' + encodeURIComponent(m.thread_id || m.id)).then(function (result) { summary.textContent = 'Conversation (' + (result.ids.length + (result.sent || []).length) + ')'; (result.sent || []).forEach(function (sent) { var outgoing = el('details'); outgoing.appendChild(el('summary','','Sent · ' + new Date(sent.send_at).toLocaleString())); outgoing.appendChild(el('p','ib-text',sent.text)); thread.appendChild(outgoing); }); result.ids.forEach(function (id,i) { var b = el('button','ib-btn is-quiet',id === m.id ? 'Current message' : 'Message ' + (i+1)); b.onclick = function () { openMessage(id,false); }; thread.appendChild(b); }); }).catch(function () { summary.textContent = 'Conversation unavailable'; });
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
        var preview = el('button','ib-btn is-quiet','Preview'); preview.onclick = async function () { try { var r = await fetch(link.href); if (!r.ok) throw new Error('Could not open attachment.'); window.MailCompose.preview(new File([await r.blob()],a.name,{ type:a.type })); } catch (err) { notice(err.message); } }; li.appendChild(preview);
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
    if (m && m[1] !== 'settings') openMessage(decodeURIComponent(m[1]), false); else { openId = null; showRead(false); paintList(); }
  });

  var statusBar, pendingLoad = false;
  function notice(text) { if (statusBar) statusBar.textContent = text; }
  function compose(payload,original,mode) { window.MailCompose.open({ api:api,addresses:workspace.addresses, payload:payload,original:original,mode:mode,onQueued:queued }); }
  function queued(result) {
    notice('Queued for ' + new Date(result.send_at).toLocaleString() + '.');
    var undo = el('button','ib-btn','Undo send');
    undo.onclick = function () { undo.disabled = true; api('/api/v1/me/mail/workspace/outbox/' + result.id + '/cancel',{ method:'POST' }).then(function (b) { notice('Send cancelled.'); compose(b.payload); if (folder === 'scheduled') loadOutbox(); }).catch(function (err) { notice(err.message); }); };
    statusBar.appendChild(undo);
    var remaining = Math.max(0,Date.parse(result.undo_until)-Date.now());
    setTimeout(function () { if (undo.isConnected) { undo.remove(); var link = el('a','','View scheduled sends'); link.href = '/inbox?folder=scheduled'; statusBar.appendChild(link); } },remaining);
    if (folder === 'scheduled') loadOutbox();
  }
  function paintToolbar() {
    if (settingsPage) return;
    var toolbar = el('header','ib-toolbar');
    var title = el('h1','','Mail'); toolbar.appendChild(title);
    var newMessage = el('button','ib-btn','Compose'); newMessage.onclick = function () { compose(); }; toolbar.appendChild(newMessage);
    var settings = el('a','ib-btn is-quiet','Settings'); settings.href = '/inbox/settings'; toolbar.appendChild(settings); var helpButton = el('button','ib-btn is-quiet','?'); helpButton.setAttribute('aria-label','Keyboard shortcuts and gestures'); helpButton.onclick = function () { notice('c compose · / search · r reply · e archive · j/k next/previous · Esc back · Ctrl/⌘ Enter send. Swipe a message to archive.'); }; toolbar.appendChild(helpButton);
    var form = el('form','ib-search'); var searchInput = el('input','ib-input'); searchInput.type = 'search'; searchInput.placeholder = 'Search mail'; searchInput.setAttribute('aria-label','Search mail');
    var help = el('p','ib-search-help','from: to: subject: "words" has:attachment after:2026-01-01 before:2026-12-31 · dates use UTC'); help.id = 'search-help'; searchInput.setAttribute('aria-describedby',help.id);
    var go = el('button','ib-btn is-quiet','Search'); go.type = 'submit'; form.appendChild(searchInput); form.appendChild(go);
    form.onsubmit = function (e) { e.preventDefault(); search = searchInput.value; folder = search ? 'all' : 'inbox'; cursor = null; paintFolders(); loadList(); };
    toolbar.appendChild(form); toolbar.appendChild(help);
    statusBar = el('p','ib-status'); statusBar.setAttribute('role','status'); toolbar.appendChild(statusBar);
    root.prepend(toolbar);
    folder = new URLSearchParams(location.search).get('folder') || 'inbox';
  }
  function paintFolders() {
    side.textContent = '';
    var nav = el('nav','ib-folders'); nav.setAttribute('aria-label','Mail folders');
    [['inbox','Inbox'],['starred','Starred'],['archive','Archive']].forEach(function (f) { var b = el('button','ib-btn is-quiet' + (folder === f[0] ? ' is-on' : ''),f[1]); b.setAttribute('aria-pressed',String(folder===f[0])); b.onclick = function () { folder = f[0]; selectedLabel = ''; cursor = null; paintFolders(); loadList(); showRead(false); }; nav.appendChild(b); });
    var more = el('select','ib-input ib-more-folders'); more.setAttribute('aria-label','More folders and labels');
    [['','More…'],['all','All mail'],['snoozed','Snoozed'],['scheduled','Scheduled'],['sent','Sent']].concat((workspace.labels || []).map(function (l) { return ['label:'+l.name,l.name]; })).forEach(function (f) { var o = el('option','',f[1]); o.value = f[0]; more.appendChild(o); });
    more.value = selectedLabel ? 'label:'+selectedLabel : ['all','snoozed','scheduled','sent'].includes(folder) ? folder : '';
    more.onchange = function () { if (!more.value) return; selectedLabel = more.value.startsWith('label:') ? more.value.slice(6) : ''; folder = selectedLabel ? 'all' : more.value; cursor = null; paintFolders(); loadList(); showRead(false); }; nav.appendChild(more); side.appendChild(nav);
  }
  function paintSignatures() {
    var section = el('section','ib-signatures'); section.appendChild(el('h2','ib-h','Signatures (' + workspace.addresses.length + ')'));
    workspace.addresses.forEach(function (a) { var form = el('form','ib-rule-form'), label = el('label','ib-field',a.address), text = el('textarea','ib-input'); text.value = a.signature || ''; text.maxLength = 4000; label.appendChild(text); form.appendChild(label); var save = el('button','ib-btn is-quiet','Save signature'); save.type = 'submit'; form.appendChild(save); var status = el('p','ib-quiet'); status.setAttribute('role','status'); form.appendChild(status);
      form.onsubmit = function (e) { e.preventDefault(); save.disabled = true; api('/api/v1/me/mail/workspace/signature',{ method:'PUT',body:{ address:a.address,signature:text.value } }).then(function () { a.signature = text.value; status.textContent = 'Saved.'; }).catch(function (err) { status.textContent = err.message; }).finally(function () { save.disabled = false; }); }; section.appendChild(form); });
    side.appendChild(section);
  }
  function updateMessage(id,body) { return api('/api/v1/me/mail/workspace/messages/' + encodeURIComponent(id),{ method:'PUT',body:body }).then(function () { loadList(); return api('/api/v1/me/mail/workspace/settings'); }).then(function (b) { workspace = b; paintFolders(); }).catch(function (err) { notice(err.message); throw err; }); }
  function messageActions(m,bar) {
    ['reply','reply-all','forward'].forEach(function (mode) { var b = el('button','ib-btn is-quiet',mode === 'reply-all' ? 'Reply all' : mode === 'reply' ? 'Reply' : 'Forward'); b.onclick = function () { compose(null,m,mode); }; bar.appendChild(b); });
    var row = rows.find(function (r) { return r.id === m.id; }) || {};
    var star = el('button','ib-btn is-quiet',row.starred ? 'Unstar' : 'Star'); star.onclick = function () { updateMessage(m.id,{ starred:!row.starred }).then(function () { row.starred = !row.starred; star.textContent = row.starred ? 'Unstar' : 'Star'; }).catch(function () {}); }; bar.appendChild(star);
    var archive = el('button','ib-btn is-quiet',row.archived ? 'Move to inbox' : 'Archive'); archive.onclick = function () { updateMessage(m.id,{ archived:!row.archived }).then(function () { showRead(false); notice(row.archived ? 'Moved to inbox.' : 'Archived.'); }).catch(function () {}); }; bar.appendChild(archive);
    var label = el('button','ib-btn is-quiet','Label'); label.onclick = function () { var name = window.prompt('Label (1–40 characters)'); if (name) updateMessage(m.id,{ label:name }).catch(function () {}); }; bar.appendChild(label);
    (row.labels || []).forEach(function (name) { var remove = el('button','ib-btn is-quiet','Remove ' + name); remove.onclick = function () { updateMessage(m.id,{ label:name,remove:true }).then(function () { remove.remove(); }).catch(function () {}); }; bar.appendChild(remove); });
    var snooze = el('input','ib-input ib-snooze'); snooze.type = 'datetime-local'; snooze.setAttribute('aria-label','Snooze until (your local time)'); bar.appendChild(snooze);
    var go = el('button','ib-btn is-quiet','Snooze'); go.onclick = function () { if (!snooze.value) { snooze.focus(); return; } updateMessage(m.id,{ snooze_until:new Date(snooze.value).toISOString() }).then(function () { showRead(false); notice('Snoozed until ' + new Date(snooze.value).toLocaleString()); }).catch(function () {}); }; bar.appendChild(go);
    if (folder === 'snoozed') { var wake = el('button','ib-btn is-quiet','Return now'); wake.onclick = function () { updateMessage(m.id,{ snooze_until:null,archived:false }).catch(function () {}); }; bar.appendChild(wake); }
  }
  function loadOutbox() {
    api('/api/v1/me/mail/workspace/outbox').then(function (result) {
      listEl.textContent = ''; listEl.appendChild(el('h2','ib-h',folder === 'sent' ? 'Sent' : 'Scheduled and pending'));
      var messages = result.messages.filter(function (m) { return folder === 'sent' ? m.state === 'sent' : ['queued','sending','failed','uncertain'].includes(m.state); });
      if (!messages.length) listEl.appendChild(el('p','ib-quiet','No messages here.'));
      messages.forEach(function (m) { var item = el('article','ib-outbox-item'); var open = el('button','ib-row',m.subject || '(no subject)'); item.appendChild(open); item.appendChild(el('p','ib-quiet',m.state + ' · ' + new Date(m.send_at).toLocaleString()));
        open.onclick = function () { api('/api/v1/me/mail/workspace/outbox/' + m.id).then(function (b) { readEl.textContent = ''; var back = el('button','ib-btn is-quiet','← Mail'); back.onclick = function () { showRead(false); }; readEl.appendChild(back); readEl.appendChild(el('h2','ib-subject',b.payload.subject)); readEl.appendChild(el('p','ib-meta','From ' + b.payload.from + ' · To ' + b.payload.to.join(', '))); readEl.appendChild(el('pre','ib-text',b.payload.text)); (b.payload.attachments || []).forEach(function (a) { var p = el('button','ib-btn is-quiet',a.name); p.onclick = function () { window.MailCompose.preview(window.MailCompose.toFile(a)); }; readEl.appendChild(p); }); (b.outcomes || []).forEach(function (o) { readEl.appendChild(el('p','ib-quiet',(o.to || 'Send') + ': ' + (o.status || o.state) + (o.reason ? ' · ' + o.reason : ''))); }); showRead(true); }).catch(function (err) { notice(err.message); }); };
        if (m.state === 'queued') { var cancel = el('button','ib-btn is-quiet','Cancel and edit'); cancel.onclick = function () { api('/api/v1/me/mail/workspace/outbox/' + m.id + '/cancel',{ method:'POST' }).then(function (b) { compose(b.payload); loadOutbox(); }).catch(function (err) { notice(err.message); }); }; item.appendChild(cancel); }
        if (m.state === 'uncertain' || m.state === 'failed') item.appendChild(el('p','ib-problem','Open for recipient outcomes. Delivery is not retried automatically.'));
        listEl.appendChild(item);
      });
    }).catch(function (err) { notice(err.message); });
  }
  document.addEventListener('keydown',function (e) {
    if (settingsPage || e.ctrlKey || e.metaKey || e.altKey || e.target.closest('input,textarea,select,[contenteditable],dialog')) return;
    if (e.key === 'c') { e.preventDefault(); compose(); }
    if (e.key === '/') { e.preventDefault(); root.querySelector('input[type=search]').focus(); }
    if (e.key === 'Escape') showRead(false);
    if (e.key === 'r' && openedMessage) compose(null,openedMessage,'reply');
    if (e.key === 'e' && openId) updateMessage(openId,{ archived:true }).then(function () { showRead(false); }).catch(function () {});
    if (e.key === 'j' || e.key === 'k') { var index = rows.findIndex(function (r) { return r.id === openId; }); index = Math.max(0,Math.min(rows.length-1,index+(e.key === 'j' ? 1 : -1))); if (rows[index]) openMessage(rows[index].id,false); }
    if (e.key === '?') notice('Shortcuts: c compose · / search · r reply · e archive · j/k next/previous · Esc back · Ctrl/⌘ Enter sends a draft. Swipe a message to archive on a phone.');
  });

  // The addresses come from the API when the shell does not carry them.
  function begin() {
    current = new URLSearchParams(location.search).get('address') || 'all';
    paintToolbar();
    paintSide();
    api('/api/v1/me/mail/workspace/settings').then(function (b) { workspace = b; if (settingsPage) paintSide(); else paintFolders(); }).catch(function (err) { notice(err.message); });
    if (settingsPage) loadPersonControls().then(paintSide).catch(function () {});
    loadAiControls().then(function () {
      paintSide();
      // A link from openvibe.my's Receipts card to #inbox-ai lands on the switch, which only exists after this paint.
      if (location.hash === '#inbox-ai' && !settingsPage) { location.replace('/inbox/settings#inbox-ai'); return; }
      if (location.hash === '#inbox-ai') {
        var ai = document.getElementById('inbox-ai');
        if (ai && ai.scrollIntoView) ai.scrollIntoView({ block: 'center' });
      }
    }).catch(function () {});
    loadList();
  }
  function loadPersonControls() {
    return Promise.all([api('/api/v1/me/mail/custom-domains'),api('/api/v1/me/mail/forwards'),api('/api/v1/me/mail/workspace/settings')]).then(function (results) { customDomains = results[0].domains || []; forwards = results[1].forwards || []; workspace = results[2]; });
  }
  function loadAiControls() {
    return Promise.all([api('/api/v1/me/mail/ai-settings'), api('/api/v1/me/mail/ai-rules'), api('/api/v1/me/mail/ai-journal'), api('/api/v1/me/mail/imap-mailboxes')])
      .then(function (results) { aiEnabled = !!results[0].enabled; aiRules = results[1].rules || []; aiJournal = results[2].entries || []; imapMailboxes = results[3].mailboxes || []; });
  }
  if (addresses.length) begin();
  else api('/api/v1/me/mail/addresses').then(function (b) { addresses = b.addresses || []; begin(); }).catch(function () { begin(); });
  var start = /^\/inbox\/([^/]+)$/.exec(location.pathname);
  if (start && start[1] !== 'settings') openMessage(decodeURIComponent(start[1]), false);
  else if (readEl && !settingsPage) { readEl.textContent = ''; readEl.appendChild(el('p', 'ib-quiet ib-pick', 'Pick a message to read it here.')); }
  narrow.addEventListener && narrow.addEventListener('change', function () { if (!narrow.matches) showRead(!!openId); });
})();
