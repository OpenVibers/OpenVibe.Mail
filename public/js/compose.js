/* Mail composer: uploads stay in this draft until Send; the server validates every limit and sender again. */
(function () {
  'use strict';
  function node(tag, text, cls) { var n = document.createElement(tag); if (text != null) n.textContent = text; if (cls) n.className = cls; return n; }
  function button(text, fn) { var b = node('button', text, 'ib-btn is-quiet'); b.type = 'button'; b.onclick = fn; return b; }
  function preview(file) {
    var d = node('dialog', null, 'ib-preview'), url;
    d.appendChild(button('Close preview', function () { d.close(); }));
    d.appendChild(node('h2', file.name));
    if (/^image\/(png|jpeg|gif|webp)$/.test(file.type)) { var img = node('img'); url = URL.createObjectURL(file); img.src = url; img.alt = file.name; d.appendChild(img); }
    else if (/^text\//.test(file.type) || file.type === 'application/json') { var pre = node('pre'); pre.textContent = 'Reading preview…'; d.appendChild(pre); file.slice(0, 100000).text().then(function (t) { pre.textContent = t; }); }
    else d.appendChild(node('p', 'Preview is available for images and text. Download this file to open it.'));
    var a = node('a', 'Download', 'ib-btn'); var downloadUrl = URL.createObjectURL(file); a.href = downloadUrl; a.download = file.name; d.appendChild(a);
    d.onclose = function () { if (url) URL.revokeObjectURL(url); URL.revokeObjectURL(downloadUrl); d.remove(); };
    document.body.appendChild(d); d.showModal();
  }
  function toFile(a) { var bytes = Uint8Array.from(atob(a.content), function (c) { return c.charCodeAt(0); }); return new File([bytes], a.name, { type:a.type }); }
  function open(options) {
    var p = options.payload || {}, original = options.original || {}, mode = options.mode || '', addresses = options.addresses || [];
    var d = node('dialog', null, 'ib-compose'); var form = node('form');
    form.appendChild(node('h2', mode === 'forward' ? 'Forward' : mode ? 'Reply' : 'New message'));
    var status = node('p', '', 'ib-compose-status'); status.setAttribute('role','status');
    function field(title, input) { var l = node('label', title); l.appendChild(input); form.appendChild(l); return input; }
    function input(title, value, type) { var n = node('input', null, 'ib-input'); n.type = type || 'text'; n.value = value || ''; return field(title,n); }
    var from = node('select', null, 'ib-input');
    addresses.forEach(function (a) { var o = node('option', a.address + (a.kind === 'mailbox' ? '' : ' · ' + a.kind)); o.value = a.address; from.appendChild(o); });
    if (p.from) from.value = p.from;
    else if (original.delivered_to && addresses.some(function (a) { return a.address === original.delivered_to; })) from.value = original.delivered_to;
    else { var named = addresses.find(function (a) { return a.kind === 'name'; }); if (named) from.value = named.address; }   // not the random mailbox address
    field('From',from);
    function addr(value) { var match = /<([^<>]+)>/.exec(value || ''); return (match ? match[1] : value || '').trim().toLowerCase(); }
    var owned = addresses.map(function (a) { return a.address; });
    var targets = mode === 'forward' ? [] : (original.from || []).map(addr);
    if (mode === 'reply-all') targets = targets.concat((original.to || []).map(addr),(original.cc || []).map(addr));
    targets = targets.filter(function (a,i,all) { return a && owned.indexOf(a) === -1 && all.indexOf(a) === i; });
    var to = input('To · separate addresses with commas', p.to ? p.to.join(', ') : targets.join(', ')); to.required = true;
    var cc = input('Cc', (p.cc || []).join(', ')); var bcc = input('Bcc', (p.bcc || []).join(', '));
    var title = p.subject != null ? p.subject : original.subject || '';
    if (mode) title = (mode === 'forward' ? (/^fwd:/i.test(title) ? '' : 'Fwd: ') : (/^re:/i.test(title) ? '' : 'Re: ')) + title;
    var subject = input('Subject',title); subject.maxLength = 500;
    var toolbar = node('div', null, 'ib-editor-tools'); toolbar.setAttribute('aria-label','Text formatting');
    var editor = node('div', null, 'ib-editor'); editor.contentEditable = 'true'; editor.setAttribute('role','textbox'); editor.setAttribute('aria-multiline','true'); editor.setAttribute('aria-label','Message');
    [['Bold','bold'],['List','insertUnorderedList'],['Numbered list','insertOrderedList'],['Quote','formatBlock']].forEach(function (entry) {
      var b = button(entry[0],function () { editor.focus(); document.execCommand(entry[1],false,entry[1] === 'formatBlock' ? 'blockquote' : null); });
      b.onmousedown = function (e) { e.preventDefault(); }; toolbar.appendChild(b);
    });
    var link = button('Link',function () { var url = window.prompt('Link URL (https://…)'); if (url && /^https?:\/\//i.test(url)) { editor.focus(); document.execCommand('createLink',false,url); } }); link.onmousedown = function (e) { e.preventDefault(); }; toolbar.appendChild(link);
    // Pasted content is text; the supported toolbar is the only way to introduce HTML locally.
    editor.addEventListener('paste',function (e) { e.preventDefault(); document.execCommand('insertText',false,e.clipboardData.getData('text/plain')); });
    editor.addEventListener('drop',function (e) { e.preventDefault(); });
    if (p.html) editor.innerHTML = p.html; else editor.textContent = p.text || '';
    if (p.signature && p.html && editor.lastElementChild && editor.lastElementChild.textContent === p.signature) editor.lastElementChild.remove();
    else if (p.signature && !p.html && editor.textContent.endsWith('\n\n' + p.signature)) editor.textContent = editor.textContent.slice(0,-p.signature.length-2);
    if (mode) { editor.appendChild(node('p','')); var quote = node('blockquote', (original.from || []).join(', ') + ' · ' + (original.date || '') + '\n' + (original.text || '')); editor.appendChild(quote); }
    function signature() { return (addresses.find(function (a) { return a.address === from.value; }) || {}).signature || ''; }
    var sig = node('p', options.payload && !p.signature ? '' : signature()); sig.className = 'ib-signature';
    from.onchange = function () { sig.textContent = signature(); };
    form.appendChild(toolbar); form.appendChild(editor); form.appendChild(sig);
    var files = (p.attachments || []).slice(), filesEl = node('ul', null, 'ib-compose-files');
    var upload = node('input'); upload.type = 'file'; upload.multiple = true; field('Attachments · 5 MB each · 10 MB total · up to 10 files',upload);
    function paintFiles() {
      filesEl.textContent = '';
      files.forEach(function (a,i) { var li = node('li'); li.appendChild(node('span', a.name + ' · ' + Math.ceil(a.size / 1024) + ' KB')); li.appendChild(button('Preview',function () { preview(toFile(a)); })); li.appendChild(button('Remove',function () { files.splice(i,1); paintFiles(); })); filesEl.appendChild(li); });
    }
    var reading = false;
    upload.onchange = async function () {
      reading = true; status.textContent = 'Adding attachments…';
      try {
        var batch = Array.from(upload.files || []), total = files.reduce(function (n,a) { return n + a.size; },0) + batch.reduce(function (n,a) { return n + a.size; },0);
        if (files.length + batch.length > 10 || total > 10*1024*1024 || batch.some(function (a) { return a.size > 5*1024*1024; })) throw new Error('Use up to 10 files, 5 MB each and 10 MB total.');
        var added = await Promise.all(batch.map(function (file) { return new Promise(function (resolve,reject) { var r = new FileReader(); r.onload = function () { resolve({ name:file.name,type:file.type,size:file.size,content:r.result.split(',')[1] }); }; r.onerror = reject; r.readAsDataURL(file); }); }));
        files = files.concat(added); paintFiles(); status.textContent = '';
      } catch (err) { status.textContent = err.message || 'Could not read this file.'; }
      finally { reading = false; upload.value = ''; }
    };
    form.appendChild(filesEl); paintFiles();
    if (mode === 'forward' && (original.attachments || []).length) {
      var attachOriginal = button('Include original attachments', async function () {
        attachOriginal.disabled = true; reading = true;
        try {
          var total = files.reduce(function (n,a) { return n + a.size; },0);
          for (var a of original.attachments) {
            if (files.length >= 10 || a.size > 5*1024*1024 || total + a.size > 10*1024*1024) throw new Error('Original attachments exceed the 5 MB/file or 10 MB total limit.');
            var response = await fetch('/api/v1/me/mail/messages/' + encodeURIComponent(original.id) + '/attachments/' + encodeURIComponent(a.part));
            if (!response.ok) throw new Error('Could not load the attachment.');
            var blob = await response.blob();
            var content = await new Promise(function (resolve,reject) { var reader = new FileReader(); reader.onload = function () { resolve(reader.result.split(',')[1]); }; reader.onerror = reject; reader.readAsDataURL(blob); });
            files.push({ name:a.name,type:a.type,size:blob.size,content:content }); total += blob.size;
          }
          paintFiles();
        } catch (err) { status.textContent = err.message; paintFiles(); }
        finally { reading = false; }
      }); form.appendChild(attachOriginal);
    }
    var schedule = input('Schedule send (optional) · ' + Intl.DateTimeFormat().resolvedOptions().timeZone, '', 'datetime-local');
    var send = node('button','Send · 15 seconds to undo','ib-btn'); send.type = 'submit';
    form.appendChild(send); form.appendChild(button('Discard',function () { if (window.confirm('Discard this draft?')) d.close(); })); form.appendChild(status);
    var requestId = crypto.randomUUID(), submitting = false;
    form.onsubmit = async function (event) {
      event.preventDefault(); if (reading || submitting) return;
      submitting = true; send.disabled = true; status.textContent = 'Saving your send…';
      function recipients(value) { return value.split(',').map(function (s) { return s.trim(); }).filter(Boolean); }
      var body = { request_id:requestId,from:from.value,to:recipients(to.value),cc:recipients(cc.value),bcc:recipients(bcc.value),subject:subject.value,
        text:editor.innerText + (sig.textContent ? '\n\n' + sig.textContent : ''),html:editor.innerHTML + (sig.textContent ? sig.outerHTML : ''),signature:sig.textContent,attachments:files };
      if (mode && mode !== 'forward') body.reply_to = original.id;
      if (schedule.value) body.send_at = new Date(schedule.value).toISOString();
      try { var result = await options.api('/api/v1/me/mail/workspace/send',{ method:'POST',body:body }); d.close(); options.onQueued(result); }
      catch (err) { status.textContent = err.message; send.disabled = false; submitting = false; }
    };
    d.oncancel = function (e) { e.preventDefault(); status.textContent = 'Use Discard to close this draft.'; };
    d.onclose = function () { d.remove(); };
    d.appendChild(form); document.body.appendChild(d); d.showModal(); to.focus();
    d.addEventListener('keydown',function (e) { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); form.requestSubmit(); } });
  }
  window.MailCompose = { open:open,preview:preview,toFile:toFile };
})();
