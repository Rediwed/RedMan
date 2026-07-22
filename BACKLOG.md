# RedMan — Backlog

## Authentication / Access Control

- [x] **Add native user login, sessions, and authorization**
  Explicit proxy/local modes, Argon2id local credentials, opaque sessions, CSRF, one-time recovery, admin/viewer roles, account/audit UI, and fail-closed route permissions are implemented. OIDC remains out of scope; see `docs/adr/001-authentication-modes.md`.

## SSH / Connectivity

- [x] **Provision and diagnose the dedicated backup account**
  Root SSH is forbidden. The portable installer creates `redman-backup`, updates
  a global `AllowUsers` directive when present, validates/reloads sshd, and the
  Unraid wrapper persists the same setup at boot. Pairing writes only forced,
  source- and path-restricted Ed25519 entries. Connection errors identify the
  dedicated account instead of suggesting that `root` be authorized.
