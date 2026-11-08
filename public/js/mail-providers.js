(function () {
    'use strict';
    var root = document.querySelector('[data-mail-provider-admin]');
    if (!root) return;
    var list = root.querySelector('[data-provider-list]');
    var form = root.querySelector('[data-provider-form]');
    var status = root.querySelector('[data-status]');
    var error = root.querySelector('[data-error]');
    function say(text) { error.textContent = text || ''; error.hidden = !text; }
    function request(url, options) {
        return fetch(url, Object.assign({ credentials: 'same-origin', headers: { Accept: 'application/json', 'Content-Type': 'application/json' } }, options || {}))
            .then(function (r) { return r.json().catch(function () { return {}; }).then(function (body) { if (!r.ok) throw new Error(body.detail || 'The provider request failed.'); return body; }); });
    }
    function load() {
        request('/api/v1/admin/mail/providers').then(function (data) {
            status.textContent = data.outbound_enabled ? 'Outbound delivery is enabled by MAIL_OUTBOUND.' : 'Outbound delivery is closed by MAIL_OUTBOUND.';
            list.replaceChildren();
            (data.providers || []).forEach(function (provider) {
                var card = document.createElement('article');
                var title = document.createElement('h3'); title.textContent = provider.name;
                var detail = document.createElement('p'); detail.textContent = provider.host + ':' + provider.port + ' · ' + (provider.enabled ? 'enabled' : 'disabled') + ' · ' + provider.attempts_this_month + ' attempts this month · ' + (provider.has_credential ? 'credential saved' : 'no credential');
                var remove = document.createElement('button'); remove.type = 'button'; remove.textContent = 'Remove';
                remove.addEventListener('click', function () { request('/api/v1/admin/mail/providers/' + encodeURIComponent(provider.id), { method: 'DELETE' }).then(load).catch(function (e) { say(e.message); }); });
                card.append(title, detail, remove); list.append(card);
            });
            if (!data.providers || !data.providers.length) list.textContent = 'No outbound providers are configured.';
        }).catch(function (e) { status.textContent = ''; say(e.message); });
    }
    form.addEventListener('submit', function (event) {
        event.preventDefault(); say('');
        var values = new FormData(form); var id = 'smtp_' + crypto.randomUUID();
        var body = { adapter: values.get('adapter'), settings: {}, name: values.get('name'), host: values.get('host'), port: Number(values.get('port')), username: values.get('username'), password: values.get('password'), free_monthly: Number(values.get('free_monthly')), price_per_thousand: Number(values.get('price_per_thousand')), monthly_budget: Number(values.get('monthly_budget')), priority: Number(values.get('priority')), secure: form.elements.secure.checked, starttls: form.elements.starttls.checked, enabled: form.elements.enabled.checked };
        try { body.settings = JSON.parse(values.get('settings_json') || '{}'); } catch (_) { say('Provider settings must be valid JSON.'); return; }
        request('/api/v1/admin/mail/providers/' + encodeURIComponent(id), { method: 'PUT', body: JSON.stringify(body) }).then(function () { form.reset(); form.elements.port.value = '587'; form.elements.starttls.checked = true; status.textContent = 'Provider saved. Credentials will not be shown again.'; load(); }).catch(function (e) { say(e.message); });
    });
    load();
}());
