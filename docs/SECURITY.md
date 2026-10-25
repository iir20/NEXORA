# NEXORA security documentation

## Implemented controls

- **Parameterized queries everywhere** — no string-interpolated SQL. Verified by
  the SQL-injection test (quoted payloads stored literally, tables intact).
- **Output encoding** — the frontend escapes all rendered text (`esc()`); the
  server stores raw input and never renders HTML. Verified by the XSS test.
- **Authentication** — bcrypt passwords (configurable rounds), server-side
  sessions, SHA-256 token hashes at rest, expiry, revocation on logout and on
  account deletion. Login/register/anonymous are rate-limited (10/min/IP-or-user).
- **CSRF** — double-submit tokens on every mutation, including pre-auth flows.
- **Authorization (IDOR defence)** — membership/participant checks inside SQL on
  every conversation, message, file, and delivery access, plus socket-event
  checks. Cross-user access tests cover reads, writes, joins, and downloads.
- **Roles** — `user` / `courier` / `admin`, checked server-side; admins cannot
  change their own role; courier endpoints require a courier profile.
- **Delivery integrity** — server-side state machine (unit-tested), atomic
  courier claim, one-time expiring attempt-limited handover codes (AES-256-GCM
  at rest, never logged), QR carries only the order reference.
- **Files** — magic-byte verification (not MIME/filename), size limits, opaque
  storage keys (no path traversal by construction), signed short-lived download
  URLs with authorization re-checked on download.
- **Rate limits** — auth, messages, uploads, deliveries, global API.
- **Headers** — Helmet with a strict CSP (self-only scripts/styles, no objects).
- **Audit logging** — auth, membership, delivery transitions, disputes, admin
  actions. Audit details strip passwords/tokens/codes/bodies as a backstop.
- **Secrets** — environment only; `.env.example` holds placeholders; no secrets
  in frontend code or the repository.
- **No sensitive logging** — passwords, tokens, codes, message bodies, and
  precise locations are never written to logs.

## Residual risks (stated, not hidden)

1. **No end-to-end encryption.** The server can read messages. Users who need
   E2EE must not use NEXORA chat for sensitive content until a reviewed E2EE
   protocol is implemented.
2. **Session token in a cookie + CSRF token pattern** is sound for same-origin
   use, but cross-origin deployments must set `CORS_ORIGINS` explicitly and run
   behind HTTPS with `Secure` cookies (automatic when `NODE_ENV=production`).
3. **Handover codes are 6 digits** — short by design (human-readable). Risk is
   bounded by 5 attempts, 24 h expiry, single use, stage binding, and courier
   authentication, but a shoulder-surfed code is usable until it expires or is
   used. Treat codes as secrets when sharing them.
4. **Local file storage** is only as private as the host's filesystem
   permissions (`0600` files, opaque keys). For multi-host deployments, move to
   the documented S3-compatible provider (not yet wired).
5. **No malware scanning** on uploads — the spec's "when available" condition is
   not met here. Magic-byte + type/size checks are the current controls.
6. **No WAF / intrusion detection / backup automation** is included. Operators
   must add database backups (`pg_dump` on a schedule) and TLS termination
   (reverse proxy) before production use.
7. **Anonymous accounts are pseudonymous, not untraceable.** The server links
   activity to accounts for moderation; a hosting provider could do the same.
   The UI states this.
8. **Rate limits are in-memory** (per process). Multi-process deployments need a
   shared store (e.g. Redis) for limits to hold across instances.
9. **Seed credentials are public and weak by design** — `npm run seed` refuses
   production, but any dev database must be wiped before promotion.

## Production checklist

- [ ] Real `CODE_ENCRYPTION_KEY` (64 hex chars) and `DATABASE_URL` from a secret
      manager; never commit `.env`.
- [ ] TLS reverse proxy (e.g. Caddy/nginx), `NODE_ENV=production`,
      `TRUST_PROXY=true` only behind that proxy.
- [ ] `npm run migrate` before first boot; `pg_dump` backups scheduled.
- [ ] `CORS_ORIGINS` set to the exact frontend origin(s).
- [ ] Seed data removed; admin password rotated; demo accounts deleted.
- [ ] Log shipping (stdout) without sensitive fields — the app already avoids
      logging them.
- [ ] Decide on maps/S3/mail providers, or keep their endpoints returning
      honest 503s.

## Account deletion semantics

Soft delete: sessions revoked, email/password cleared, profile blanked, but
messages and delivery records keep their NEXORA ID attribution (other
participants rely on those records). A full purge of a user's content is an
operator action: delete the user's rows from `messages` (or anonymize
`sender_id`), `delivery_participants`, and `private_file_metadata` + stored
files, then the `users` row — in that order, respecting foreign keys.
