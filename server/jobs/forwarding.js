'use strict';

const { createNetworkPolicy } = require('../domain/network-policy');
const { run } = require('../domain/forwarding');

function startForwardingJob({ db, stalwart, config, log = console, fetchImpl = globalThis.fetch, intervalMs = 60_000 }) {
    const policy = createNetworkPolicy(config, fetchImpl);
    let timer;
    let stopped = false;
    async function tick() {
        if (stopped) return;
        try { await run({ db, stalwart, config, policy, fetchImpl }); }
        catch { (log.warn || log.log).call(log, '[mail] forwarding run failed'); }
        if (!stopped) { timer = setTimeout(tick, intervalMs); timer.unref?.(); }
    }
    timer = setTimeout(tick, intervalMs);
    timer.unref?.();
    return { stop() { stopped = true; clearTimeout(timer); }, runNow: tick };
}

module.exports = { startForwardingJob };
