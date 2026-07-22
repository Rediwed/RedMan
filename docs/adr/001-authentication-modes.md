# ADR 001: Authentication Modes and Authorization

- Status: Accepted
- Date: 17-07-2026
- Decision owners: RedMan maintainers

## Context

RedMan historically delegated main-API authentication to Pangolin Badger or a compatible forward-auth proxy. The peer API remains a separate machine-to-machine boundary with per-peer bearer credentials. Direct access to the main API cannot be considered supported until RedMan can authenticate it without trusting client-supplied identity headers.

## Decision

RedMan supports exactly two main-API authentication modes:

- `proxy`: a trusted forward-auth proxy authenticates the browser and injects normalized identity headers. RedMan still resolves that identity to an enabled local account and applies RedMan roles.
- `local`: RedMan owns password credentials, sessions, CSRF protection, recovery, and account administration.

`oidc` is not implemented. Unknown, missing, or conflicting production mode configuration fails startup. Development bypass remains available only through the existing double gate (`AUTH_DISABLED=true`, `REDMAN_LOCAL_DEV=1`, non-production) and always receives an in-memory admin identity.

There is no fallback between modes. A failed proxy identity does not fall back to a local cookie. A failed local session does not inspect proxy headers.

## Trust Boundaries

- Main API (`:8090`): protected by the selected `AUTH_MODE`, then by route authorization.
- Peer API (`:8091`): unchanged; protected by per-peer bearer keys and peer scope. Main-API cookies are ignored.
- Forward-auth headers: accepted only in `proxy` mode and only from `TRUSTED_PROXIES`.
- SQLite: stores account metadata, Argon2id password hashes, hashed opaque session/recovery tokens, and audit events.
- Browser: receives an HttpOnly session cookie and a separate CSRF cookie. State-changing cookie-authenticated requests must echo the CSRF value in a header.

## Roles and Permissions

Initial roles are `admin` and `viewer`.

- `viewer`: read-only access to backup configuration summaries, run history, progress, snapshots, downloads, health, and container metrics.
- `admin`: all viewer access plus job execution/cancellation, restore, deletion, peer management, Docker mutation, discovery, secrets, settings, database recovery, and account management.

Every `/api` route has a declared permission. Undeclared routes fail closed. Secret-bearing settings and peer/account/audit endpoints are admin-only even when requested with `GET`.

## Proxy Mode

A normalized proxy subject is looked up as a RedMan account with provider `proxy`. Unknown identities are denied unless `PROXY_AUTO_PROVISION_ROLE` is explicitly set to `admin` or `viewer`; in that case the first trusted request creates the account with that role. Existing accounts can be disabled or have roles changed from RedMan account management.

Shipped deployment templates explicitly select an auth mode but do not enable admin auto-provisioning. Operators provision known proxy subjects through the host CLI. `PROXY_AUTO_PROVISION_ROLE` remains an explicit temporary migration option and should be cleared immediately.

## Local Credentials

Local passwords are hashed with Argon2id using the maintained `argon2` package and per-password random salts. RedMan ships no default username or password. Passwords must be 12-128 characters.

Login has both IP rate limiting and per-account exponential lockout. Responses are generic so username existence, disabled state, and lockout state are not disclosed.

## Sessions and CSRF

Sessions use 256-bit random opaque tokens. Only SHA-256 token hashes are stored. Login rotates session state. Logout, password rotation, account disablement, role change, and recovery revoke applicable sessions.

Cookies are `HttpOnly`, `Secure` in production, `SameSite=Strict`, and path-scoped. Sessions have configurable idle and absolute expiry with conservative defaults of 30 minutes and 24 hours. A readable random CSRF cookie is bound by hash to the server-side session; POST, PUT, PATCH, and DELETE require a matching `X-CSRF-Token` header.

## First-Run Bootstrap

In `local` mode, a clean database exposes only authentication status, login, bootstrap, and recovery endpoints. Creating the first admin requires the explicit `REDMAN_BOOTSTRAP_TOKEN` environment value. The token is never generated as a default and is rejected after the first account exists. Successful bootstrap creates one admin and rotates directly into a new session.

The frontend presents first-admin setup only when the server reports that local mode has no users. It asks for the configured bootstrap token, username, and password.

## Recovery

Recovery does not require direct database edits. An operator with container/host command access runs the recovery CLI, which creates and prints a one-time 256-bit token valid for 15 minutes. The API consumes that token with the target username and a new password, records the event, and revokes every existing session for the account.

Recovery preserves an administratively disabled account. A separate audited host command (`auth:promote-admin`) can explicitly enable and promote a local account if local mode has no enabled administrator.

Losing both application credentials and host/container command access is outside RedMan's recovery boundary.

## Reverse Proxy and Direct Access

Proxy mode requires Pangolin/forward-auth and a narrow `TRUSTED_PROXIES` allowlist. Port 8090 remains firewalled from ordinary LAN/VPN clients.

Local mode supports direct application authentication but still requires HTTPS because production session cookies are secure. The recommended topology remains an HTTPS reverse proxy to RedMan; local mode removes the dependency on external identity, not transport security.

Production local mode also requires an exact `REDMAN_PUBLIC_ORIGIN=https://...`; bootstrap, login, and recovery requests carrying another `Origin` are rejected.

## Headless API Access

The browser-oriented main API does not issue permanent bearer tokens in this phase. Headless automation can establish a local session, retain cookies, and send the CSRF header, or use the peer API for supported machine-to-machine backup operations. Long-lived main-API tokens require a separate scoped-token design.

## Mode Changes and Failure Behavior

Changing `AUTH_MODE` requires restart. Sessions from local mode are ignored in proxy mode; proxy headers are ignored in local mode. Switching to local mode without a local admin re-enters controlled bootstrap and requires `REDMAN_BOOTSTRAP_TOKEN`. Switching to proxy mode without a matching account or explicit auto-provision role denies all administrative requests.

Startup logs the selected mode without credentials. Invalid mode, absent production mode, insecure production cookie override, or an impossible timeout configuration fails startup.

## Consequences

- Proxy deployments avoid a redundant second login while gaining RedMan roles and auditability.
- Local deployments gain native login and recovery without weakening proxy mode.
- Deployment templates must set explicit auth configuration.
- Account/session/recovery tables become part of database backup and restore.
- All current routes need an authorization declaration and tests.