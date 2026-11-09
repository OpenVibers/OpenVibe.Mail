(function () {
    'use strict';
    var root = document.querySelector('[data-mail-provider-admin]');
    if (!root) return;
    var list = root.querySelector('[data-provider-list]');
    var form = root.querySelector('[data-provider-form]');
    var spamForm = root.querySelector('[data-spam-form]');
    var domainForm = root.querySelector('[data-domain-form]');
    var domainProviders = root.querySelector('[data-domain-providers]');
    var domainStatus = root.querySelector('[data-domain-status]');
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
            spamForm.elements.hold_score.value = data.spam_thresholds.hold_score;
            spamForm.elements.refuse_score.value = data.spam_thresholds.refuse_score;
            list.replaceChildren();
            domainProviders.replaceChildren();
            (data.providers || []).forEach(function (provider) {
                var option = document.createElement('option'); option.value = provider.id; option.textContent = provider.name + (provider.enabled ? '' : ' (disabled)'); domainProviders.append(option);
                var card = document.createElement('article');
                var title = document.createElement('h3'); title.textContent = provider.name;
                var detail = document.createElement('p'); detail.textContent = provider.adapter + ' · ' + (provider.enabled ? 'enabled' : 'disabled') + ' · sent today ' + provider.sent_today + ', this month ' + provider.sent_this_month + ' · free left ' + (provider.free_left_today === null ? 'unlimited today' : provider.free_left_today + ' today') + ' / ' + provider.free_left_this_month + ' this month · spend $' + Number(provider.spend_this_month).toFixed(4) + ' / $' + Number(provider.monthly_budget).toFixed(2) + ' · bounce ' + (Number(provider.bounce_rate) * 100).toFixed(2) + '% · complaints ' + (Number(provider.complaint_rate) * 100).toFixed(3) + '% · health ' + provider.health + ' · rate ' + provider.rate_limit_per_minute + '/min · ' + (provider.has_credential ? 'credential saved' : 'no credential') + ' · webhook: ' + window.location.origin + '/api/v1/mail/provider-webhooks/' + provider.id + (provider.has_webhook_secret ? ' (signing secret saved)' : ' (configure provider authentication)');
                var remove = document.createElement('button'); remove.type = 'button'; remove.textContent = 'Remove';
                remove.addEventListener('click', function () { request('/api/v1/admin/mail/providers/' + encodeURIComponent(provider.id), { method: 'DELETE' }).then(load).catch(function (e) { say(e.message); }); });
                card.append(title, detail, remove); list.append(card);
            });
            if (!data.providers || !data.providers.length) list.textContent = 'No outbound providers are configured.';
    }).catch(function (e) { status.textContent = ''; say(e.message); });
    }
    spamForm.addEventListener('submit', function (event) {
        event.preventDefault(); say('');
        var body = { hold_score: Number(spamForm.elements.hold_score.value), refuse_score: Number(spamForm.elements.refuse_score.value) };
        request('/api/v1/admin/mail/spam-settings', { method: 'PUT', body: JSON.stringify(body) })
            .then(function () { status.textContent = 'Spam thresholds saved.'; load(); }).catch(function (e) { say(e.message); });
    });
    form.addEventListener('submit', function (event) {
        event.preventDefault(); say('');
        var values = new FormData(form); var id = 'smtp_' + crypto.randomUUID();
        var body = { adapter: values.get('adapter'), settings: {}, name: values.get('name'), host: values.get('host'), port: Number(values.get('port')), username: values.get('username'), password: values.get('password'), webhook_secret: values.get('webhook_secret'), free_daily: Number(values.get('free_daily')), free_monthly: Number(values.get('free_monthly')), price_per_thousand: Number(values.get('price_per_thousand')), monthly_budget: Number(values.get('monthly_budget')), rate_limit_per_minute: Number(values.get('rate_limit_per_minute')), enabled_kinds: Array.from(form.querySelectorAll('[name="kind"]:checked')).map(function (input) { return input.value; }), priority: Number(values.get('priority')), secure: form.elements.secure.checked, starttls: form.elements.starttls.checked, enabled: form.elements.enabled.checked };
        try { body.settings = JSON.parse(values.get('settings_json') || '{}'); } catch (_) { say('Provider settings must be valid JSON.'); return; }
        request('/api/v1/admin/mail/providers/' + encodeURIComponent(id), { method: 'PUT', body: JSON.stringify(body) }).then(function () { form.reset(); form.elements.port.value = '587'; form.elements.starttls.checked = true; status.textContent = 'Provider saved. Credentials will not be shown again.'; load(); }).catch(function (e) { say(e.message); });
    });
    domainForm.addEventListener('submit', function (event) {
        event.preventDefault(); say('');
        var values = new FormData(domainForm); var records;
        try { records = JSON.parse(values.get('dkim_records') || '[]'); } catch (_) { say('DNS records must be valid JSON.'); return; }
        var body = { domain: values.get('domain'), dkim_records: records, return_path: values.get('return_path'), spf_include: values.get('spf_include') };
        request('/api/v1/admin/mail/domains/' + encodeURIComponent(values.get('provider_id')), { method: 'PUT', body: JSON.stringify(body) }).then(renderDomains).catch(function (e) { say(e.message); });
    });
    function renderDomains(data) {
        domainStatus.replaceChildren();
        var heading = document.createElement('h3'); heading.textContent = 'DNS setup for ' + data.domain;
        var spf = document.createElement('p'); spf.textContent = 'SPF: ' + data.spf + ' · lookup count ' + data.lookup_count + '/10' + (data.lookup_count_uncertain ? ' (some provider SPF records could not be resolved)' : '');
        domainStatus.append(heading, spf);
        if (data.warn_before_limit) { var warning = document.createElement('p'); warning.textContent = 'SPF is near the 10 DNS lookup limit or its provider records could not be counted.'; domainStatus.append(warning); }
        (data.records || []).forEach(function (record) {
            var card = document.createElement('p'); card.textContent = record.name + ' (' + (record.priority ? 'MX ' + record.priority : record.type) + '): ' + record.value + (record.return_path ? ' · return-path ' + record.return_path : ''); domainStatus.append(card);
        });
    }
    load();
}());
