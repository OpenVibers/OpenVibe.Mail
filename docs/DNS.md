# DNS for M1 (receive only)

M1 receives for `openvibe.email`, `mask.openvibe.email` and each burner subdomain in `BURNER_DOMAINS`. It does not
send: until M2 there is no DKIM key and no sending path, so SPF and DMARC are strict and closed.

Replace `203.0.113.10` with the host's public IPv4 (and `2001:db8::10` with its IPv6, if the host has one). The MX
target is the same host as the web server for M1; M3's sending reputation wants a separate mail IPv4, not a new
name.

## Records

### `openvibe.email` (the mailboxes and agent inboxes)

| Type | Name | Value | TTL |
|---|---|---|---|
| `MX` | `openvibe.email.` | `10 mail.openvibe.email.` | 300 |
| `A` | `mail.openvibe.email.` | `203.0.113.10` | 300 |
| `AAAA` | `mail.openvibe.email.` | `2001:db8::10` (only if the host has IPv6) | 300 |
| `TXT` | `openvibe.email.` | `v=spf1 -all` | 300 |
| `TXT` | `_dmarc.openvibe.email.` | `v=DMARC1; p=reject; adkim=s; aspf=s; pct=100; rua=mailto:dmarc@openvibe.email` | 300 |

`v=spf1 -all` says "no host is allowed to send as this domain". That is correct while nothing sends. When M3 starts
sending, replace it with the sending hosts and keep `-all`; do not weaken DMARC to `p=none` for convenience.

`rua` needs a mailbox that exists. Provision `dmarc@openvibe.email` before publishing, or point `rua` at an
address the owner already reads. A report address that bounces loses the reports.

### `mask.openvibe.email` (site masks)

| Type | Name | Value | TTL |
|---|---|---|---|
| `MX` | `mask.openvibe.email.` | `10 mail.openvibe.email.` | 300 |
| `TXT` | `mask.openvibe.email.` | `v=spf1 -all` | 300 |
| `TXT` | `_dmarc.mask.openvibe.email.` | `v=DMARC1; p=reject; adkim=s; aspf=s; pct=100; rua=mailto:dmarc@openvibe.email` | 300 |

### Each burner subdomain in `BURNER_DOMAINS`

For every name in `BURNER_DOMAINS` (e.g. `burn1.openvibe.email`, `burn2.openvibe.email`,
`burn3.openvibe.email`):

| Type | Name | Value | TTL |
|---|---|---|---|
| `MX` | `burn1.openvibe.email.` | `10 mail.openvibe.email.` | 300 |
| `TXT` | `burn1.openvibe.email.` | `v=spf1 -all` | 300 |
| `TXT` | `_dmarc.burn1.openvibe.email.` | `v=DMARC1; p=reject; adkim=s; aspf=s; pct=100; rua=mailto:dmarc@openvibe.email` | 300 |

A new burner domain is a DNS record and an entry in `BURNER_DOMAINS`; there is no code change and no service
restart needed for the address generator to use it, though the service adds the domain to Stalwart at boot.

## Things that break receiving

- **Cloudflare proxy (orange cloud) on the MX target.** Cloudflare does not proxy SMTP. The `mail` A/AAAA record
  must be **DNS only** (grey cloud). Do the same for any CNAME that ends at the mail host.
- **A second MX with a different priority.** M1 has one host; a second MX that does not accept mail causes
  retries and lost mail.
- **Publishing MX before the A record resolves.** Wait for the A record, then the MX.
- **A wildcard `*.openvibe.email` MX.** It would also catch names that are not ours to receive; list the burner
  domains explicitly instead.
- **Uppercase or trailing-dot mistakes.** MX targets are names, not addresses; keep the trailing dot in a zone
  file.

## Not needed for M1

- **PTR / reverse DNS** matters for sending, not receiving. Add `mail.openvibe.email` as the PTR when M3 turns on
  direct sending.
- **DKIM** has no key because nothing signs. Stalwart generates a DKIM key per domain and shows the records in
  `Domain.dnsZoneFile`; publish them when sending starts, not before.
- **MTA-STS and `_smtp._tls`** are useful once the server has a valid TLS certificate and clients fetch policy
  over HTTPS. M1's SMTP listener can offer STARTTLS with the host certificate; add the records when that
  certificate is in place. Do not publish an MTA-STS policy that promises a mode the host cannot serve.
- **Autodiscover/autoconfig** for the public: JMAP and IMAP are loopback-only in M1, so there is nothing for a
  mail client to discover yet.

## Check

```sh
dig +short MX openvibe.email
dig +short MX mask.openvibe.email
dig +short TXT openvibe.email
dig +short TXT _dmarc.openvibe.email
dig +short A mail.openvibe.email
```

Then, from outside the host:

```sh
python3 - <<'PY'
import smtplib
s = smtplib.SMTP('mail.openvibe.email', 25, timeout=10)
print(s.ehlo())
print(s.noop())
s.quit()
PY
```

A `250` greeting with `mail.openvibe.email` is the receive path working. Do not use a burner or mask address you do
not own for the check.
