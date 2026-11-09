'use strict';
/**
 * What openvibe.email says about itself, in one place, so the home page, its description and the agent files say the
 * same thing. Sending to other providers follows MAIL_OUTBOUND (config.outbound.enabled): the lines about it change
 * with the switch instead of going stale the day it is turned on. (Until 11-09 the page still said "Receive only" and
 * "your own domain comes next" a day after addresses, aliases, custom domains and forwarding went live.)
 */
function mailCopy(config) {
    const sending = !!(config && config.outbound && config.outbound.enabled);
    const what = 'Your own address and domain, masks for every sign-up, ten-minute addresses that show you the code, and inboxes your agents can read.';
    return {
        sending,
        summary: what,
        // Under 160 characters: the page shell cuts a longer description.
        description: sending
            ? 'Your own address and domain, masks, ten-minute addresses and inboxes for your agents, with plain-text sending.'
            : 'Your own address and domain, masks, ten-minute addresses and inboxes for your agents. Mail arrives today; sending opens next.',
        // The "Your address" card's last line and the rules' first line.
        sendLine: sending
            ? 'Write and reply from it in plain text (up to 10 recipients a message, 20 a day to start, rising with your history), and forward a copy to an address you verified.'
            : 'Mail between OpenVibe addresses works now; sending and forwarding to other providers open next.',
        sendRule: sending
            ? 'Sending is plain text with a daily allowance and no bulk lists, and every message is checked for spam before it leaves.'
            : 'Sending to other providers is closed for now. When it opens, every message is checked for spam before it leaves.',
    };
}

module.exports = { mailCopy };
