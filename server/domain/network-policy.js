'use strict';

const { createServiceTokenClient } = require('openvibe-sdk/auth');
const { createTrustClient } = require('openvibe-sdk/trust');

function createNetworkPolicy(config, fetchImpl = globalThis.fetch) {
    const tokens = config.oauth.clientSecret && createServiceTokenClient({
        tokenUrl: `${config.network.internalUrl}/oauth/token`, clientId: config.oauth.clientId,
        clientSecret: config.oauth.clientSecret, audience: 'openvibe.network',
        scope: 'identity.trust.read identity.emails.read', fetch: fetchImpl,
    });
    const getToken = async () => {
        if (!tokens) throw new Error('Mail cannot verify ownership until its Network service credentials are configured.');
        return tokens.getToken();
    };
    const trust = createTrustClient({ networkUrl: config.network.internalUrl, getToken, fetchImpl });
    return {
        trust: (subject) => trust.of(subject),
        async verifiedEmail(subject, email) {
            const response = await fetchImpl(`${config.network.internalUrl}/api/v1/identity/emails/verified-check`, {
                method: 'POST',
                headers: { Authorization: `Bearer ${await getToken()}`, 'Content-Type': 'application/json', Accept: 'application/json' },
                body: JSON.stringify({ subject, email }), signal: AbortSignal.timeout(5000),
            });
            if (!response.ok) throw new Error('Network could not verify this forwarding address.');
            const body = await response.json();
            return body.verified === true;
        },
    };
}

module.exports = { createNetworkPolicy };
