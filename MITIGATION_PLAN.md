# RedMan Mitigation Plan

*Derived from the combined findings of [REVIEW.md](REVIEW.md) (static engineering + defensive-security review) and [ai-review-2.md](ai-review-2.md) (dynamic audit with adversarial probes). Reviewed state: commit `118ab79` + uncommitted working tree, 2026-07-17.*

This plan merges both reviews, dedupes overlapping items, keeps the **higher** severity where the two disagreed, and sequences the work so that data-integrity and auth blockers land before polish. Each item lists the source finding IDs, the files to touch, and a concrete **done-when** verification (most of which double as the regression tests both reviews said are missing).

**Release gate:** Do not ship for unattended use until every item in Phases 0 and 1 is fixed *and* covered by a regression test.

---

## Phase 0 — Release blockers: silent data loss & incorrect restore

These break the product's core promise (recover the right bytes; don't delete originals). Do these first.

### P0-1. Fix historical restore returning the wrong revision
- **Sources:** REVIEW §2 (🔴), ai-review-2 C4 (proved: `expected revision-1, actual revision-3`)
- **Files:** `app/backend/src/services/versionBrowser.js` (`resolveFilePath` ~L224, `browseSnapshot` ~L124)
- **Fix:** With rsync `--backup-dir`, the state at snapshot `T_s` is the copy in the **earliest** version dir newer than `T_s`. Iterate versions **ascending** among those newer than the requested timestamp and take the first match; in `browseSnapshot`, stop overlaying a name once found.
- **Done when:** A regression test writes a file, backs up, then mutates + backs up **three** times, and asserts byte-for-byte content at *every* selectable snapshot (preview, download, and restore paths).

### P0-2. Make delete-after-import safe (or default it off)
- **Sources:** ai-review-2 C5 (unique to review 2)
- **Files:** `app/backend/src/services/immichImport.js` (`--on-errors continue`, `deleteMediaFiles`), plus the SSD/media UI toggle
- **Fix:** Delete only files individually recorded as uploaded or server-confirmed duplicates — build a per-file ledger from immich-go output, not a process exit code. Require an explicit destructive confirmation, keep a durable deletion audit, and **default the feature off**.
- **Done when:** A test with one failing upload proves that file is *not* deleted while confirmed ones are; the toggle ships off by default with consequence copy in the UI.

### P0-3. Empty-source deletion guard on all destructive engines
- **Sources:** ai-review-2 H7; REVIEW §7 (notes the SSD guard exists but not the others)
- **Files:** `app/backend/src/services/rsync.js` (hyper `--delete-after`), `app/backend/src/services/rclone.js` (`sync`)
- **Fix:** Generalize the pending SSD empty-source safeguard into one shared source-health policy: mount-identity / minimum-item-count check + explicit empty-source opt-in for every engine that deletes at the destination.
- **Done when:** A test with an unmounted (empty) source aborts the run instead of wiping the destination, for SSD, Hyper, and Rclone.

---

## Phase 1 — Release blockers: authentication & host trust

Any one of these hands an attacker admin or host root.

### P1-1. Stop trusting all RFC1918 clients for forward-auth headers
- **Sources:** ai-review-2 C1 (Critical — proved 401→200), REVIEW M4 (rated Medium; **take the higher severity**)
- **Files:** `app/backend/src/middleware/auth.js` (L9/L21/L98), `docker-compose.yml`, `deploy.sh`
- **Fix:** (1) Trust only the exact Traefik/Pangolin proxy IP or a narrow container subnet. (2) Make an **empty** `TRUSTED_PROXIES` mean "trust none" (require a `*` sentinel for trust-all). (3) Stop publishing port `8090` on an untrusted interface — bind to loopback / internal Docker network.
- **Done when:** A test proves a direct request carrying forged `remote-user` headers from a non-proxy IP is rejected (401), and `TRUSTED_PROXIES=""` rejects all forwarded identity.

### P1-2. Restrict the SSH key written on pairing (host RCE)
- **Sources:** REVIEW C2, ai-review-2 C2
- **Files:** `app/backend/src/services/sshManager.js` (`authorizeKey` ~L108), `app/backend/src/services/hyperBackup.js` (`SSH_USER` default root)
- **Fix:** Use a dedicated **unprivileged** backup account. Write the entry with `restrict` plus a forced command scoped to the peer's prefix: `command="rrsync <prefix>",restrict,from="<peer-ip>"`. Validate the submitted key is exactly one well-formed line before appending (prevents newline-injected extra keys). Surface in the accept dialog that pairing grants host SSH access; consider making it opt-in.
- **Done when:** A paired peer's key cannot open an interactive SSH session or escape its prefix; a multi-line key value is rejected.

### P1-3. Default `allowed_path_prefix` away from `/`
- **Sources:** REVIEW C1 (its own Critical); overlaps ai-review-2 H3/C2
- **Files:** `app/backend/src/services/pairing.js` (payload ~L279, INSERT ~L302), `app/backend/src/routes/peers.js` (accept UI ~L80)
- **Fix:** Never default to `/`. Require an explicit writable backup sub-directory at accept time (add a path field to the accept UI) or fall back to a conservative `pairing_default_allowed_prefix` setting. Keep `storage_limit_bytes` bounded by default.
- **Done when:** A newly paired peer with no explicit prefix cannot read `/etc` or write outside its assigned sub-directory.

### P1-4. Resolve path prefixes with realpath (symlink escape)
- **Sources:** ai-review-2 H3 (proved: browsed `/etc` via symlink)
- **Files:** peer path validation in `app/backend/src/peerApi.js` (`/peer/browse`, `/peer/backup/prepare`), and the SSH transport
- **Fix:** `realpath` both the configured prefix and requested existing ancestors; reject symlink traversal; create missing paths one segment at a time; re-check the final real path. Enforce the same boundary in the SSH transport (ties to P1-2).
- **Done when:** A `prefix/escape -> /etc` symlink yields 403/404, not a directory listing.

### P1-5. Bind the pairing handshake transcript & confirm fingerprint
- **Sources:** REVIEW H3, ai-review-2 C3 (proved: instance/ssh_key/callback_url swappable post-signature)
- **Files:** `app/backend/src/services/handshake.js` (`signEphemeral` ~L100, `validateRequest` ~L233), `app/backend/src/services/pairing.js`
- **Fix:** Sign a canonical transcript containing protocol version, role, token, instance identity, ephemeral key, static key, callback URL, **and** SSH key — on both request and callback. Show the fingerprint prominently in the accept dialog and require explicit operator comparison against the initiator. Version the handshake (v2 is already new on this branch, so no extra compat break).
- **Done when:** Replacing any signed field after signing fails validation; the accept UI blocks acceptance without fingerprint confirmation.

### P1-6. Idempotent baseline schema migration (fresh-install crash)
- **Sources:** REVIEW §1 (🔴), ai-review-2 H1 (reproduced: `no such table: ssd_backup_configs`)
- **Files:** `app/backend/src/db.js`, `app/backend/src/migrations.js`, `app/backend/src/seed.js`
- **Fix:** Add migration 0 that `CREATE TABLE IF NOT EXISTS` for every core table + index. Fold `db.js` inline migrations into numbered migrations (removes the third schema home). Reduce `seed.js` to demo data only.
- **Done when:** CI starts RedMan with an empty temporary `DB_PATH` and it boots without error.

---

## Phase 2 — High: peer isolation, quotas, reliability

Primary workflows that can't currently be trusted, but not an immediate compromise/loss path.

### P2-1. Enforce peer storage quotas
- **Sources:** ai-review-2 H2 (proved: 1-byte limit reported as unlimited)
- **Files:** `app/backend/src/middleware/auth.js` (`req.peer` omits `storage_limit_bytes`), `peerApi.js` (`/peer/storage`, `/peer/backup/prepare`)
- **Fix:** Copy the quota into the authenticated peer context and enforce it; reserve projected incoming size, not just current usage.
- **Done when:** An over-limit `prepare` returns a quota error for a peer with a small limit.

### P2-2. Scope peer-shutdown to the notifying peer
- **Sources:** REVIEW §2 (🔴), ai-review-2 H4 (reproduced: two jobs, both failed)
- **Files:** `app/backend/src/peerApi.js` (~L263–282; unused `jobUrl`/`peerHost`)
- **Fix:** Persist a stable peer identity on hyper jobs/runs; on shutdown, mark failed only rows belonging to `req.peer.id`. Fix `affectedCount` to increment only on a match.
- **Done when:** In a two-peer test, peer B's shutdown leaves peer A's in-flight run untouched.

### P2-3. Scope `/peer/backup/status/:runId` to the requesting peer
- **Sources:** REVIEW H1 (security), ai-review-2 H5
- **Files:** `app/backend/src/peerApi.js` (~L240)
- **Fix:** Filter to `feature='hyper-backup'` and the requesting peer's runs; return 404 otherwise. Stays within the frozen peer-API contract.
- **Done when:** Enumerating other runIds returns 404, not row data.

### P2-4. Centralize run locking across all trigger sources
- **Sources:** REVIEW §3 (🟡; **take review 2's High**), ai-review-2 H6
- **Files:** manual run endpoints in ssdBackup/hyperBackup/rclone routers; shared executor boundary
- **Fix:** Move the lock into a shared executor boundary used by scheduler *and* manual triggers; acquire transactionally before inserting the run; return `409 Conflict` with the active run ID. Normalize lock keys with `Number(configId)` (REVIEW §3 `withConfigLock`).
- **Done when:** A double-clicked "Run Now" and a manual/scheduled overlap both return 409 instead of starting a second `--delete-after`.

### P2-5. Cancelled runs must stay cancelled
- **Sources:** REVIEW §2 (🟠), ai-review-2 M1
- **Files:** `app/backend/src/routes/ssdBackup.js` (~L225), hyperBackup equivalent; model on `rclone.js:144` (checks null/143/-15)
- **Fix:** In the rsync executors, check DB status (or exit codes null/143/-15) before overwriting; don't stamp `failed` over `cancelled`.
- **Done when:** A cancelled run ends in `cancelled` state, verified by test.

### P2-6. Safe SQLite backup/restore around WAL
- **Sources:** REVIEW §3 (🟠), ai-review-2 H8
- **Files:** `app/backend/src/services/dbBackup.js` (`backupDatabase`, `restoreDbFromBackup` ~L203)
- **Fix:** Use better-sqlite3 `db.backup()` for online backups; validate with `PRAGMA integrity_check`. Stage restores beside the live DB and swap atomically on next boot; remove stale WAL/SHM.
- **Done when:** A backup taken under concurrent writes passes integrity_check; restore doesn't corrupt a live DB.

### P2-7. Triage the dependency graph
- **Sources:** ai-review-2 H9 (`npm audit --omit=dev`: 1 critical, 2 high, 11 moderate)
- **Files:** `app/backend/package.json` (dockerode → protobufjs/@grpc/grpc-js; express → path-to-regexp)
- **Fix:** Upgrade or replace the vulnerable chains; document any that are unreachable in RedMan.
- **Done when:** `npm audit --omit=dev` shows no critical/high, or each remaining advisory has a documented reachability rationale.

---

## Phase 3 — Medium: correctness, performance, resource bounds

### P3-1. Stream/batch hyper-backup output parsing
- **Sources:** REVIEW §1 (🟠), ai-review-2 M3 — reuse the SSD streaming parser instead of buffering `stdout` and re-parsing (`rsync.js` ~L477, `hyperBackup.js` ~L125).

### P3-2. Fix progress polling
- **Sources:** REVIEW §2+§4 (🟠/🟡), ai-review-2 M4 — treat `partial` as terminal in `useJobProgress.js:49`; add a `?progressOnly=true` (or generalize `/media-import/runs/:id/progress`); stop polling when the document is hidden.

### P3-3. Cron correctness
- **Sources:** REVIEW §2+§6 (🟠/🟡), ai-review-2 M7 — validate cron in create/update routes (return 400); replace hand-rolled `getNextRun` (`scheduler.js:154`) with `cron-parser`; fix `SchedulePicker` `*/8`→"6h" mangling and dropped minutes.

### P3-4. Timestamp UTC-vs-local
- **Sources:** REVIEW §2 (🟠; unique) — append `Z` when parsing in `versionBrowser.js:512` / `deltaVersion.js:526`, or generate local timestamps. Fixes retention-age math and UI drift on `TZ=Europe/Amsterdam`.

### P3-5. Pairing peer matching & stuck states
- **Sources:** REVIEW §2 (🟠 ×2; unique) — match peers on `static_pubkey` not display name (`pairing.js:290`); do the expiry check before setting `accepting` and wrap so any failure → `failed` (`pairing.js:254`).

### P3-6. Bound audit/summary growth & write load
- **Sources:** REVIEW §4 (🟡), ai-review-2 M5 — retention for `backup_runs`/peer audit; rate-limit `auth_success` + `last_seen` writes (once per peer per minute).

### P3-7. Fail fast on uncaught exceptions
- **Sources:** REVIEW §3 (🟡), ai-review-2 M6 — log, flush, `exit(1)` (Docker `restart: unless-stopped` already configured).

### P3-8. Misc reliability
- **Sources:** REVIEW §3, ai-review-2 M2/M8 — add fetch abort timeout to `callPeerApi` (`hyperBackup.js`); move scan-completion side-effects into `runScan` (`mediaImport.js:126`); fix `getFileDate` hardcoded `/mnt/disks` and concurrent-import log collisions (`immichImport.js:493`).

### P3-9. SSRF hardening
- **Sources:** REVIEW M1/M2 (🟡; unique depth) — restrict server-initiated peer fetches + `callback_url` to private ranges (centralize `isValidPrivateIp`); fix IPv4-only/octet-range gaps and constrain callback port.

---

## Phase 4 — UX & accessibility

- **P4-1. Surface form-validation errors** (REVIEW §6 🟠, ai-review-2 UX3): add try/catch rendering `err.message` in SSD/Hyper/Rclone modals — otherwise the new safety validations are invisible. *Highest-leverage UX fix; consider pulling into Phase 1 alongside the guards it exposes.*
- **P4-2. Mobile/tablet overflow** (ai-review-2 UX1): fix Settings (538px@390), SSD (402px), Overview clipping, header wrap.
- **P4-3. Accessible modal primitive** (ai-review-2 UX2): one shared component with `role="dialog"`, `aria-modal`, focus trap/restore, Escape, `inert` background, labelled icon buttons.
- **P4-4. Retention out from under the delta gate** (REVIEW §6 🟠): pruning applies to all versioned configs but is only editable when delta is on (`SsdBackupPage.jsx:373`).
- **P4-5. Per-config backup health** (ai-review-2 UX5): show last success/failure, age, next run on config cards.
- **P4-6. Consequence copy on destructive controls** (REVIEW §6, ai-review-2 UX6): delete-after-import, job delete (orphaned `.versions`), restore.

---

## Phase 5 — Task-fit: finish or remove half-built features

- **P5-1. Notification start/cancel/progress** (REVIEW §5 🟠, ai-review-2 T1): `notifyJobStarted`/`notifyJobCancelled`/`notifyJobProgress` have zero call sites — wire into executors or remove the toggles + settings UI. Also fix `partial`→"Job failed" notification (REVIEW §2).
- **P5-2. Hyper pull / custom SSH** (REVIEW §5 🟠, ai-review-2 T2): `direction`/`ssh_*` in state with no inputs — add the advanced section or drop the state. Fix the "Enter URL manually" dead-end (REVIEW §5, ai-review-2 UX4).
- **P5-3. Pending SSD safety features UI** (REVIEW §5 🟡, ai-review-2 T3): expose `exclude_patterns`, `ssd_allow_empty_source`, `run_files_retention_days` in the form, and sync the README/contracts.

---

## Phase 6 — Code health, tests, docs

- **P6-1. Fix the test harness** (ai-review-2 test findings): `test/setup_local_test.sh` needs `REDMAN_LOCAL_DEV=1`; make the live suite require successful protected responses (it counted `401` as pass → "373 passed" was hollow); `chmod +x pre-push.sh`; make the handshake test import production primitives (so it can catch C3-class bugs).
- **P6-2. Add the missing regression tests** — the "done-when" checks above, consolidated: empty-volume startup, multi-revision restore, quota, symlink escape, cross-peer shutdown/authorization, manual/scheduled overlap, cancel-to-terminal, delete-after-import ledger, mobile overflow, modal a11y.
- **P6-3. Dead-code sweep** (REVIEW §5): `rebaseDeltas`, `getChainLength`, `findOldestKeyframe`, `redact()/redactString()`, `getLocalIp()`→`0.0.0.0`, `execSync('rm -rf')`→`rmSync`, six-way `formatBytes` → `utils/`.
- **P6-4. Structural** (both): collapse the two migration systems (ties to P1-6); factor the run/cancel/history route triplets into a shared factory; unify the two rsync parsers; whitelist `PUT /api/settings` keys.
- **P6-5. Docs** (both, security notes): document Docker-socket = host-root (consider a socket proxy with a minimal endpoint allowlist); secret-store blast radius; fix `PEER_API_PORT`/`PEER_PORT` env mismatch (`index.js:57`).

---

## Sequencing summary

| Phase | Theme | Gate |
|---|---|---|
| 0 | Silent data loss / wrong restore (P0-1..3) | **Release blocker** |
| 1 | Auth bypass / host RCE / fresh-install (P1-1..6) | **Release blocker** |
| 2 | Peer isolation, quotas, run locking, DB safety, deps (P2-1..7) | High — before unattended use |
| 3 | Correctness, performance, resource bounds | Medium |
| 4 | UX & accessibility (pull P4-1 forward) | Medium |
| 5 | Finish/remove half-built features | Medium |
| 6 | Tests, dead code, docs | Ongoing |

**Do P6-1 (test harness) early** — without it, none of the Phase 0–2 regression tests can actually run green, and the audit showed the current suite's green checkmarks were partly illusory.
