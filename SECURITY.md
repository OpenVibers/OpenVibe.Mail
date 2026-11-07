# Security

OpenVibe.Mail handles addresses, mail metadata and — for a few seconds, in memory — a verification code. It does
not store message bodies. Treat a report about any of the following as security-sensitive.

## Reporting

Report a vulnerability to **security@openvibe.network**. Do not open a public issue for a suspected vulnerability.
Include the affected route, a minimal reproduction and what an attacker gains. We will acknowledge and keep you
informed; do not test against production mailboxes that are not yours.

## What M1 runs

- Stalwart Community receives SMTP on port 25. There is no submission listener (587/465), no POP3, no Sieve and no
  public HTTPS listener; JMAP/management (8080) and IMAP (143) bind loopback only.
- Every domain is created with `allowRelaying = false`; an unauthenticated connection cannot relay.
- The API is behind OpenVibe.Network tokens. A typed token (`typ` or `purpose`) is refused. Another person's mask,
  burner or inbox answers 404, not 403.
- A burner made without an account is limited per IP and capped, and its mail is deleted when it expires.
- Stalwart runs in its own systemd slice with `MemoryMax=1G`, `CPUQuota=100%`, `NoNewPrivileges=true` and
  `ProtectSystem=strict`; the Node service is read-only too.
- Secrets live in `/etc/openvibe/*.env` (root, 0600). The rendered Stalwart `config.json` names the database
  password by environment variable; the S3 keys are read from the environment by `apply.js` and are never written
  to a rendered file or a log.

## Out of scope for M1

Sending, DKIM signing, inbox AI, paid custom domains and the public web UI are later phases. A report that a
receive-only domain has no SPF sending path is not a vulnerability; `v=spf1 -all` is deliberate.

## Secrets in the repository

There are none. `.env.example` names variables without values. CI uses throwaway service containers. If a secret
is ever committed, rotate it first, then remove it from history; deleting the file is not enough.
