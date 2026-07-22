# RedMan Engineering Review

*Date: 2026-07-17 — reviewed at commit `118ab79` plus uncommitted working-tree changes (path-overlap validation, empty-source guard, run-file retention).*

**Scope:** task fit, UI & UX, architecture rigor, performance, reliability, code health (dead code, unfinished features, functional bugs, edge cases), and coding best practices. This is a constructive code-quality review, not a security audit; security observations are limited to one-line notes at the end.

**Combined remediation:** See [MITIGATION_PLAN.md](MITIGATION_PLAN.md) for the phased plan derived from this review and `ai-review-2.md`.

**Overall impression:** A genuinely well-conceived homelab tool. The problem decomposition (scheduler + per-feature executors + shared `backup_runs` table), the safety thinking around rsync `--delete` (path-overlap validation, empty-source guard, protected roots), and the pairing UX are all above average for a project of this type. The main weaknesses are: a fragile database bootstrap story, several correctness bugs in the version browser and cancellation flows, unbounded memory in the hyper-backup path, and a fair amount of dead/unfinished code — including UI toggles that are wired to nothing.

Severity legend: 🔴 High · 🟠 Medium · 🟡 Low

---

## 1. Architecture rigor

### 🔴 Fresh installs crash: schema creation is split across three places with no non-destructive bootstrap
Core tables (`settings`, `ssd_backup_configs`, `backup_runs`, `hyper_backup_jobs`, `rclone_jobs`, `media_drives`, …) are created only by `app/backend/src/seed.js`, which is a *destructive* script (it `DROP TABLE`s everything) and is not run by the container entrypoint (`CMD ["node", "src/index.js"]`). On a brand-new data volume, `db.js` runs its inline migrations, then `migrations.js` migration 7 executes `ALTER TABLE ssd_backup_configs …` and migration 9 inserts into `settings` — both throw "no such table", `runMigrations` throws at import time, and the process dies. The system only works because existing deployments already have a seeded DB.

**Fix:** make baseline schema creation idempotent (`CREATE TABLE IF NOT EXISTS`) as migration 0, and reduce `seed.js` to demo data only.

### 🟠 Two parallel migration systems
`db.js:15-126` still carries ad-hoc inline migrations while `migrations.js` is the "formal" system. Some changes exist in both (the `backup_run_files` index appears in `db.js:107`, migration 1, and `seed.js:239`). The comment acknowledges the split, but every new schema change now has three candidate homes, and the inline ones run before `busy_timeout` is set. Fold the `db.js` inline block into numbered migrations.

### 🟠 `runRsyncWithSsh` buffers entire rsync stdout in memory
`services/rsync.js:477-478` accumulates `stdout += text` for the whole run, and `services/hyperBackup.js:125` then re-parses that string line-by-line to insert file rows. The README advertises "multi-TB datasets"; with `--itemize-changes` on millions of files this is potentially gigabytes of V8 string. The SSD path already does this correctly (streaming parse + batched inserts in `runRsync`); the hyper path should reuse it instead of duplicating a worse version of the same parser.

### 🟡 Duplication between the two rsync paths
`runRsync` and `runRsyncWithSsh` in `services/rsync.js` share the itemize regex, progress parsers, and process-tracking logic but drift subtly (the itemize character classes differ: one allows a space, the other doesn't). Same for the three near-identical `runs` / `runs/:id` / `cancel` route triplets across the ssdBackup/hyperBackup/rclone routers — a shared factory would collapse ~200 lines.

### 🟡 `activeProcesses` map is shared across features but cancel endpoints aren't scoped
`cancelHyperRun` is literally `cancelSsdRun` (`services/hyperBackup.js:12-14`), and the SSD cancel route looks up the run without a `feature` filter — `POST /api/ssd-backup/runs/:id/cancel` can kill a hyper-backup run and vice versa. Harmless today because run IDs are globally unique, but it makes the route contracts misleading.

### 🟡 Config env-var mismatch
`docker-compose.yml` sets `PEER_PORT=8091`, but `index.js:57` reads `PEER_API_PORT`. It works only because the default happens to match; changing the compose value would silently do nothing.

---

## 2. Correctness / functional bugs

### 🔴 Version browser returns the wrong file revision when a file changed more than once after the selected snapshot
With rsync `--backup-dir`, version dir `T` holds a file's content *as it was just before run T*. So the state at snapshot `T_s` is the copy in the **earliest** version dir newer than `T_s`. But `versionBrowser.js` `resolveFilePath` (line 224) scans versions **newest-first** and returns the first hit, and `browseSnapshot` (line 124) overlays newer versions in ascending order so the newest wins. Both return the content just before the *latest* change, not the state at `T_s`. Preview/download/restore of anything but the most recent snapshot of a multiply-changed file silently produces the wrong bytes — the worst kind of bug for a restore tool.

**Fix:** iterate ascending among versions newer than the requested timestamp and take the first match (and in `browseSnapshot`, stop overlaying once a name is found).

### 🔴 Any peer's shutdown notification fails *all* running hyper-backup runs, not just that peer's
In `peerApi.js:263-282`, the loop computes `jobUrl` and `peerHost` but never uses them — every job with a running run is marked failed regardless of which peer is shutting down, and `affectedCount` increments even when nothing matched. The intended URL/IP match was never implemented (the unused variables are the fossil). A two-peer topology will see peer B's restart kill an in-flight transfer record for peer A.

### 🟠 Cancelled runs get re-marked as "failed"
The cancel routes (`routes/ssdBackup.js:225-237` and the hyperBackup equivalent) set status `cancelled`, but the still-running `executeSsdBackup`/`executeHyperBackup` sees the SIGTERM'd rsync exit non-zero and overwrites the row with `failed` plus an error message. Rclone got this right (`services/rclone.js:144` checks exit codes null/143/-15); the rsync paths need the same guard, or should check the DB status before overwriting.

### 🟠 Frontend progress polling never stops for `partial` runs
`hooks/useJobProgress.js:49` only treats `completed|failed|cancelled` as terminal. A run that finishes as `partial` (which the SSD/rclone executors produce routinely) is polled every second forever — and each poll hits the run-detail endpoint that returns up to 1,000 file rows. Add `partial` to the terminal set, and consider a lightweight progress-only endpoint for polling.

### 🟠 `getNextRun` reports wrong next-run times for weekly/monthly crons
`services/scheduler.js:154-188` hand-rolls next-run estimation and treats `0 2 * * 1` (Mondays) as "daily at 02:00" because it only inspects the day-of-month field. The dashboard will show "tomorrow 02:00" for a weekly job. `cron-parser` is a tiny dependency that does this correctly; alternatively return null for anything with dow/dom set.

### 🟠 Snapshot timestamps are UTC but parsed as local time
Timestamps come from `new Date().toISOString()` (`services/rsync.js:177`) — UTC — but `parseTimestamp` in `versionBrowser.js:512` and `deltaVersion.js:526` produces a bare `YYYY-MM-DDTHH:MM:SS` string, which `new Date()` interprets as **local** time. On a non-UTC server (compose sets `TZ=Europe/Amsterdam`), every retention-age and keyframe-age calculation is off by the UTC offset, and the UI displays snapshot times shifted by 1–2 hours. Either generate timestamps in local time or append `Z` when parsing.

### 🟠 Pairing peers are matched by display name, which defaults to "RedMan"
`services/pairing.js:290` does `SELECT id FROM authorized_peers WHERE name = ?` using the remote's self-reported `instance_name`. Two distinct peers that both kept the default name will overwrite each other's API key and static pubkey on pairing. Match on `static_pubkey` (that's what it's stored for) with name as fallback.

### 🟠 `acceptPairing` can strand a request in the `accepting` state
`services/pairing.js:254-262` sets status to `accepting` *before* the expiry check; if the request is expired (or `prepareCallback` throws), some paths update to expired/failed but a thrown exception in between leaves it `accepting` forever — not pending (so no Accept button), not terminal. Do the expiry check first, and wrap the rest so any failure transitions to `failed`.

### 🟡 `parseItemizeAction`'s deletion branch is unreachable
`services/rsync.js:395` checks `type === '*' && flags.includes('deleting')`, but the itemize regex that feeds it can never capture the string `deleting` (its character class excludes most of those letters). Deletions are handled by the separate `*deleting` regex; this branch is dead.

### 🟡 `partial` SSD runs notify as failures
`executeSsdBackup` calls `notifyBackupResult(..., 'partial', …)` and `services/notify.js:254-260` treats everything non-`completed` as an error, so a mostly-successful run pushes a high-priority "Job failed — Unknown error" notification.

### 🟡 SchedulePicker mangles every-8-hours crons
`components/SchedulePicker.jsx:191` maps `*/8` to `'6h'`, so opening the edit form on an 8-hour job displays "Every 6 hours" and saving rewrites the schedule. Also `describeCron` drops the minute for daily jobs ("daily at 02:00" even for `30 2 * * *`).

### 🟡 `getFileDate` hardcodes `/mnt/disks`
`services/immichImport.js:493` builds paths from a hardcoded root while `getFailedPathsFromLog` correctly derives them from the drive's actual `mount_path`. Photo dates are silently null for drives mounted anywhere else. Additionally, both functions grab "the most recent log file" from immich-go's cache dir — with two concurrent imports they can read each other's logs.

### 🟡 `ejectDrive` cannot work in the shipped container
`umount` requires `CAP_SYS_ADMIN`, but compose does `cap_drop: ALL` with only `DAC_READ_SEARCH` added. `eject_after_import` will always hit the "Eject failed" warn path. Either add the capability (documented) or hide/disable the feature in-container.

---

## 3. Reliability

### 🟠 Shutdown kills rsync but doesn't wait for it
`index.js` `shutdown()` (line 189) sends SIGTERM to children, immediately marks runs failed, and calls `process.exit(0)`. In-flight batched `backup_run_files` inserts are dropped and rsync may not have flushed its partial-dir state. A short grace period (await child `close` with a timeout) would make crash-recovery records more truthful.

### 🟠 Live DB restore copies over an open SQLite database
`services/dbBackup.js` `restoreDbFromBackup` (line 203) `copyFile`s the backup over `db.name` while better-sqlite3 holds the file open in WAL mode — the note says "requires a restart" but until that restart, live writers can corrupt the just-restored file (stale WAL/SHM also aren't removed). Safer: write to a staging name and swap on next boot, or close the connection first. Similarly, `backupDatabase` should use better-sqlite3's online `db.backup()` API instead of checkpoint-then-copy, which races with concurrent writes.

### 🟡 Manual runs bypass the skip-if-running guard
The scheduler prevents overlapping scheduled runs, but `POST /configs/:id/run` happily starts a second concurrent rsync on the same config (double-click on "Run Now"). Two rsyncs with `--delete-after` into the same destination can interleave destructively. Check `isJobRunning` plus DB `running` state in the trigger routes. (The UI disables the button only after progress polling picks the run up.)

### 🟡 Scheduler retry inserts a new run row per attempt
`executeWithRetry` (`services/scheduler.js:65`) re-runs the whole executor on transient failure, so one cron tick can log up to 4 failed `backup_runs` rows. Consider passing the run ID through, or marking retries.

### 🟡 Media-import scan completion uses an unbounded `setInterval`
`routes/mediaImport.js:126-138` polls scan progress every second and only clears itself on completed/failed. If the scan object is cleared or the drive record deleted mid-scan, `getScanProgress` returns null forever and the interval leaks. Move the completion side-effects into `runScan` itself (the service already owns the state).

### 🟡 `withConfigLock` keys are type-sensitive
The lock Map is keyed by whatever callers pass; route paths pass `parseInt(req.params.id)` while service paths pass through DB values. Current call sites appear consistent, but nothing enforces it — normalize with `Number(configId)` inside the lock to guarantee mutual exclusion.

### 🟡 Uncaught-exception handler swallows fatal errors
`index.js:39-42` logs and continues on `uncaughtException`. For a tool whose job is data integrity, running in an unknown state after an uncaught throw is riskier than a supervised restart (`restart: unless-stopped` is already configured). Log, flush, exit non-zero.

---

## 4. Performance

### 🟠 `computeVersionStats` and `listSnapshots` walk the entire `.versions` tree
`computeVersionStats` (`services/deltaVersion.js:609`) stats every file of every snapshot after **every** backup run and after every prune; `listSnapshots` re-counts files recursively per snapshot per request. On the hourly default schedule with months of GFS retention this is a large, repeated I/O bill on the array. Incremental accounting (store per-snapshot totals in the manifest at deltaify time) would make both O(snapshots).

### 🟡 `verifyDeltaChain` is a synchronous HTTP request
It reconstructs every delta to a temp file — fine as a deliberate deep-verify, but it's exposed as a plain POST with no progress reporting; on a big tree the request hangs for minutes. Make it a tracked background job like scans/imports.

### 🟡 Per-request `du -sk` for quota checks
`getDiskUsage` (`peerApi.js:461`) shells out to `du` (30 s timeout) on `/peer/backup/prepare` and `/peer/storage` — on a multi-TB prefix this can block, and it runs twice in `prepare` (quota check + storage info). Cache with a short TTL.

### 🟡 1 Hz polling of heavy run-detail endpoints
`useJobProgress` polls `GET /runs/:id` every second per active run; that endpoint includes up to 1,000 `backup_run_files` rows and, on the SSD variant, an extra `GROUP BY` aggregation. A `?progressOnly=true` mode (or the existing `/media-import/runs/:id/progress` pattern generalized) would cut this to a trivial query.

### 🟡 `peerAuth` writes two rows per authenticated request
A `last_seen` UPDATE plus an `auth_success` audit insert on every call — during an active transfer with status polling this is constant write load on the same SQLite file the run recorder is writing to. Rate-limit `auth_success` logging (e.g., once per peer per minute).

---

## 5. Code health — dead code & unfinished features

### 🟠 The "notify on start" feature is a no-op end to end
`notify_on_start` exists as a DB column (migration 7), a form toggle in all three job forms, and a `shouldNotify(job, 'start')` branch — but nothing ever calls it: `notifyJobStarted` has **zero call sites** (grep-confirmed), and no executor sends a start event. Users toggling "On start" get nothing. Same for `notifyJobCancelled` and `notifyJobProgress` (plus the whole `ntfy_on_progress` / `ntfy_progress_interval` settings UI, including the interval slider in SettingsPage) — all dead. Either wire them into the executors (cheap: one call at the top of each `execute*`) or remove the toggles.

### 🟠 `rebaseDeltas` is dead and non-functional
`services/deltaVersion.js:279-329`, with a 15-line stream-of-consciousness comment ("But wait… Actually… DESIGN:") that documents its own abandonment; `dirty` is never set. Only `rebaseDeltasWithTimestamp` is used. Delete it. Also dead: `getChainLength`, `findOldestKeyframe` (their logic was inlined into `deltaifySnapshot`), the unused `lastBase` variable in `reconstructFile`, and `findBaseFile`'s ignored `versionsDir`/`timestamp` parameters.

### 🟠 Hyper-backup form has orphaned state and dead-end flows
In `pages/HyperBackupPage.jsx`: `showAdvanced` is set by `handleNewJobManual` but no advanced section exists in the rendered form; consequently `direction` (push/pull), `ssh_user`, `ssh_host`, and `ssh_port` are in form state but have **no inputs** — pull jobs and custom SSH settings are API-only. Worse, the "Enter URL manually" button promises a manual-URL path but the form's destination is a select of already-paired peers, so with no pairs the user lands on a form they cannot complete.

### 🟠 Native application authentication is unfinished
RedMan has no application-owned users, login page, sessions, account recovery, or authorization roles. The main API currently delegates authentication to Pangolin Badger (or another compatible forward-auth proxy) and consumes the validated `Remote-User`, `Remote-Name`, and `Remote-Email` headers it injects. The `autheliaAuth` name and Authelia-only documentation are historical and obscure the actual deployment contract.

Pangolin Badger strips client-supplied `Remote-*` identity headers before adding authenticated values, so the public Pangolin path is not the direct spoofing path. The risk is port 8090 being separately reachable while RedMan trusts broad private-network ranges as header sources. Treat native login as a planned but unfinished capability; until it exists, make proxy mode explicit, trust only the exact proxy source, and firewall direct access to port 8090.

### 🟡 `exclude_patterns` (in the pending diff) has no UI
The backend/migration work is done, but the SSD form neither displays nor submits it. If this working-tree change is meant to ship as a feature, the form field is the missing half; if it's API-only by design, say so in the README table.

### 🟡 Assorted leftovers
- `getLocalIp()` returning `'0.0.0.0'` as an "sshHost" fallback (`peerApi.js:473`) is never a usable host.
- `suggestedSuffix`/`setSuggestedSuffix` plumbing in HyperBackupPage feeds `RemotePathPicker` a prop of marginal value.
- Unused `const p = …` in SsdBackupPage's preview download handler.
- `seed.js` still seeds legacy `ntfy_url`/`ntfy_token` keys "for backward compat" that new code paths only half-honor.
- `redact()`/`redactString()` in `utils/logRedact.js` appear unused.
- `immichImport.js` uses `execSync('rm -rf …')` where `rmSync` would do.

---

## 6. UI & UX

### 🟠 Form submissions swallow errors
`handleSubmit` in SsdBackupPage/HyperBackupPage/RclonePage has no try/catch: when the backend rejects (e.g., the new path-overlap validation returns 400 with a carefully written message), the promise rejects unhandled, the modal stays open, and **the user never sees the validation message** — the entire value of the guard is lost at the UI layer. This is the highest-leverage UX fix in the codebase: catch and render `err.message` in the modal.

### 🟠 Retention policy is only editable when delta versioning is on
In `pages/SsdBackupPage.jsx:373-440` the retention grid lives inside the `delta_versioning && showAdvanced` block, but `pruneVersions` applies the policy to *all* versioned configs. Users of plain versioning are silently governed by defaults they can't see or change. Move retention out from under the delta gate.

### 🟡 Invalid cron expressions fail silently
Custom cron input isn't validated client- or server-side; `scheduleJob` returns `false` and just logs. The job shows as "enabled" but never runs. Validate with `cron.validate` in the create/update routes and return 400.

### 🟡 Run-history filter doesn't apply until "Refresh"
Changing the config filter select in SsdBackupPage only sets state; the list refetches only via the Refresh button or pagination. A `useEffect` on `filterConfig` fixes it.

### 🟡 `alert()`/`confirm()` for error and destructive-action UX
Throughout SettingsPage and the delete flows, while the same pages have a nice modal system. Also: deleting an SSD config leaves its `.versions` data orphaned on disk with no mention — a "keep/delete snapshots?" prompt would prevent surprise disk usage.

### 🟡 Minor polish
- `formatBytes` is copy-pasted in six frontend files (and again in `notify.js` backend) — move to `utils/`.
- The pairing "Try Again" path reuses an already-consumed token flow state.
- Snapshot `<option>` text packs date+count+tier+savings into one long string that truncates in narrow selects.

---

## 7. Task fit

The feature set matches the stated mission well, and the dangerous-rsync guardrails (overlap validation, dangerous-dest list, empty-source guard in the pending diff) show the right instincts for a backup tool. Two fit-level gaps:

1. **Restore correctness is under-tested relative to backup.** The test directory has handshake/delta/backward-compat scripts but nothing that exercises the browse/restore overlay semantics — which is where the one High correctness bug lives. A test that writes a file, backs up, mutates it twice with runs between, then asserts the content at each snapshot would have caught it.
2. **The pending working-tree changes (overlap validation, empty-source guard, run-file retention) are good and coherent.** Before committing: surface `validateConfigPaths` errors in the UI (see §6), and consider whether the destination-overlap check should also block a new config whose *source* is inside another config's destination (currently only dest↔dest is checked).

---

## 8. Security notes (one-liners, out of scope — covered separately)

- Peer API keys are compared via direct SQL lookup (timing side channel).
- `POST /hyper-backup/test-connection` and the pairing callback fetch accept arbitrary URLs from an authenticated admin (SSRF-ish).
- immich-go receives the Immich API key as a CLI argument, visible in `ps`.
- `PUT /api/settings` accepts arbitrary keys with no whitelist.

---

## Suggested priority order

1. Version-browser wrong-revision bug (restore integrity) — `services/versionBrowser.js`
2. Fresh-install bootstrap crash — `db.js` / `migrations.js` / `seed.js`
3. Surface form-validation errors in the UI (makes the new safety checks in the working tree actually visible)
4. Peer-shutdown marks all runs failed — `peerApi.js:263`
5. Cancelled→failed status overwrite + `partial` polling leak
6. Stream/batch the hyper-backup output parsing
7. Dead-feature cleanup (start notifications, `rebaseDeltas`, orphaned form state)

---

# Defensive Security Review

*Date: 2026-07-17 — reviewed at commit `118ab79` plus uncommitted working-tree changes. Authorized by the owner for their own homelab backup tool. No code was modified as part of this review.*

**Scope:** delegated forward-auth vs peer-API auth boundaries, input validation, path handling/traversal, command & SQL injection, SSRF, the Noise-XX pairing/trust model, secret handling, and the Docker-socket / host-SSH privilege surface.

Severity legend: 🔴 Critical · 🟠 High · 🟡 Medium · ⚪ Low/informational

**Bottom line:** Input-validation, SQL, and command-injection posture is solid — parameterized queries throughout, argv-array process spawning, and metacharacter filtering. Risk is concentrated in the **peer trust model**: C1 (default prefix `/`) and C2 (unrestricted host SSH key) together mean accepting a pairing hands a peer full read/write and command execution on the host; H2 leaves RedMan's own secret store reachable via the authenticated file picker. Must-fix set: C1, C2, H2. Next tier: H1, H3.

---

## 🔴 C1 — Accepting a pairing grants the peer the entire filesystem

**Where:** `app/backend/src/services/pairing.js:279` (payload) and `:302` (INSERT into `authorized_peers`).

`acceptPairing()` hardcodes `allowed_path_prefix: '/'` and `storage_limit_bytes: 0` (unlimited) for every newly paired peer. The peer API enforces paths against that prefix, so with `/` the peer can, using its Bearer key:
- `GET /peer/browse?dir=/etc` — enumerate the whole filesystem (`peerApi.js:317`);
- `POST /peer/backup/prepare` with any `remotePath` — `mkdirSync(anyPath)` and receive an rsync destination anywhere (`peerApi.js:203`);
- `GET /peer/roots` including `/` (`peerApi.js:386`).

The accept UI (`routes/peers.js:80`) collects no prefix, so the destructive default is the only default. High-value targets reachable this way: `/app/backend/data` (SQLite DB, `rclone.conf` cloud creds, `identity.json`, `.ssh` keys).

**Risk:** A malicious or later-compromised peer — or an attacker whose pairing the user clicks Accept on (see H3) — reads/writes any path on the host.

**Remediation:** Never default to `/`. Require an explicit writable backup sub-directory at accept time (add a path field to the accept UI), or fall back to a conservative configured default (e.g. a `pairing_default_allowed_prefix` setting). Keep `storage_limit_bytes` bounded by default. `PUT /api/peers/:id` already allows narrowing the prefix; only the insecure default needs fixing.

## 🔴 C2 — Pairing writes an unrestricted SSH key to the host's authorized_keys (host RCE)

**Where:** `app/backend/src/services/sshManager.js:108` (`authorizeKey`), called from `pairing.js:171` and `:311`.

The remote peer's SSH public key is appended verbatim to `/host-ssh/authorized_keys` with **no key options** — no `restrict`, no `command="…"`, no `from=`:
```js
appendFileSync(HOST_AUTHORIZED_KEYS, '\n' + pubKey.trim() + '\n');
```
`/host-ssh` is intended to be the host user's `~/.ssh`, and the rsync-over-SSH transport connects as `SSH_USER || 'root'` (`hyperBackup.js:92`). So a paired peer gets an unrestricted SSH login as that user — arbitrary command execution, not just rsync.

Secondary issues in the same function:
- `pubKey` comes from the pairing request/callback body (`pairing.js:218`, authorized at `:171/:311`) and is trusted as a single line; a value containing a newline would inject additional authorized_keys entries. Add a single-line/format check before writing.
- Dedup via `existing.includes(pubKey.trim())` is fine now but breaks once options are added — match on the key body.

**Risk:** Full host compromise granted by a pairing the user believes is just a backup link.

**Remediation:** Write the entry with hardening options — at minimum `restrict` (kills tunnels/agent/X11/PTY while still allowing rsync), ideally a forced command wrapper (`command="rrsync <prefix>",restrict`) scoped to the peer's `allowed_path_prefix`, optionally `from="<peer-ip>"`. Validate the key is one well-formed line before appending. Surface in the accept dialog that pairing grants host SSH access, and consider making the host-key write opt-in.

---

## 🟠 H1 — Cross-peer / cross-feature run disclosure over the peer API

**Where:** `app/backend/src/peerApi.js:240` (`GET /peer/backup/status/:runId`).

```js
const run = db.prepare('SELECT * FROM backup_runs WHERE id = ?').get(req.params.runId);
```
Any authenticated peer can fetch **any** `backup_runs` row by iterating `runId` — including local SSD/rclone/media-import runs and other peers' runs. Rows include `error_message`, which routinely contains absolute filesystem paths and rsync/ssh error text.

**Remediation:** Scope the query to `feature = 'hyper-backup'` and ideally to runs associated with the requesting peer; return 404 otherwise. Stays within the frozen peer-API contract (same shape, same 404).

## 🟠 H2 — Filesystem picker's "allowed roots" guard is a no-op; exposes the secrets dir

**Where:** `app/backend/src/routes/filesystem.js:34` (`isUnderAllowedRoot`) with `:12` (`getAllowedRoots`).

The guard is meant to stop an admin session browsing sensitive paths (its own comment cites `/app/backend/data/.ssh`, `/etc`, `/proc`), but `/` is always a candidate root and:
```js
if (root === '/') return true; // '/' explicitly advertised → full access
```
Since `/` exists everywhere, the check returns `true` for every path — the restriction never fires. The endpoint lists directories anywhere, including RedMan's own data dir (SQLite DB, `rclone.conf`, `identity.json`, `.ssh/id_ed25519`). Directory names only, not contents — but it confirms structure and key-material existence, and the same paths are writable destinations elsewhere. The same effective no-op exists at `peerApi.js:386` (`/peer/roots`).

**Remediation:** Drop `/` from the auto-allowed set so root-scoping actually applies, or add an explicit denylist blocking the RedMan data directory, `.ssh`, and `identity.json` regardless of root.

## 🟠 H3 — Pairing trust is TOFU with no enforced fingerprint verification

**Where:** `app/backend/src/services/handshake.js:100` (`signEphemeral`) / `:233` (`validateRequest`).

The handshake authenticates the static-key holder and derives the API key via ECDH so it never crosses the wire — good. But:
- Acceptance is trust-on-first-use; the receiver sees a fingerprint (`pairing.js:221`) but the UI doesn't require out-of-band comparison. An on-path attacker on the LAN/VPN can substitute their own keys and be accepted, since nothing pins the expected fingerprint.
- `signEphemeral` signs the ephemeral public key **alone** — it doesn't bind the `token`, instance identity, or direction/role. Token-as-HKDF-salt plus single-use ephemeral keys mitigate straightforward replay, but binding context into the signed message is cheap defense-in-depth.

**Remediation:** Show the fingerprint prominently in the accept dialog and require explicit operator confirmation (compare against a value shown on the initiator). Include `token` (and instance/role) in the signed message on both request and callback. Handshake v2 is new on this branch, so strengthening now avoids a later compat break.

---

## 🟡 M1 — SSRF: server fetches operator-supplied URLs with no destination restriction

**Where:** `app/backend/src/services/pairing.js:91` (initiate), `routes/peers.js:118` (`/pair/sync`), `:170` (`/connectivity`), `routes/hyperBackup.js:217` (`/test-connection`).

`validateUrl` (`validation.js:128`) only checks the scheme is http/https — no private-range restriction. Authelia-admin-only, so this is admin→server SSRF, but the app becomes a request-forwarding primitive (internal-only services, cloud metadata endpoints) with requests originating from the RedMan host.

**Remediation:** Restrict outbound peer URLs to private/RFC1918 + CGNAT ranges (reuse `isValidPrivateIp` from `discovery.js:43` or the private-IP logic in `peerApi.js:80`; centralize it). Resolve the hostname and validate the resolved IP to defeat DNS-rebinding; allowlist explicitly configured VPN hostnames if needed.

## 🟡 M2 — `callback_url` in the pairing request is only partially validated

**Where:** `app/backend/src/peerApi.js:74`; callback sent at `pairing.js:319`.

The private-IP check (`peerApi.js:80`) blocks public IPs by falling back to the socket IP, but only parses IPv4 (`cbHost.split('.').map(Number)`), doesn't validate octet ranges (`10.0.0.999` passes the `parts[0]===10` test), and imposes no port constraint — a peer can direct the callback POST at `http://<private-ip>:<any-port>`. Limited (JSON POST to a private address), but driven by unauthenticated input.

**Remediation:** Validate the parsed address with a strict private-IPv4/IPv6 validator (reuse the M1 helper) and constrain the callback port to the expected peer-API port.

## 🟡 M3 — `du`/`df` on peer-influenced paths (no injection; DoS note)

**Where:** `app/backend/src/peerApi.js:461` (`getDiskUsage` → `execFileSync('du', ['-sk', dirPath])`).

Not command injection — args are passed as an array and `normalizePath` (`validation.js:12`) rejects shell metacharacters; the protection is sound. Residual concern is that `du -sk` on a peer-chosen path (bounded by the prefix) can force expensive directory walks (DoS), mitigated by the 30s timeout and the 120 req/min rate limiter (`peerApi.js:29`). No action required beyond noting it.

## 🟡 M4 — Development auth bypass and forward-auth trust defaults

**Where:** `app/backend/src/middleware/auth.js:9` and `:21`.

`AUTH_DISABLED` is correctly triple-gated and warns if set-but-ignored. The deployed public path uses Pangolin Badger, which validates the resource session, removes client-supplied `Remote-*` identity headers, and injects authenticated values before forwarding to RedMan. However, RedMan's own source check defaults `TRUSTED_PROXIES` to all RFC1918 + loopback, and an **empty string is treated as "trust all"** (`isTrustedProxy` returns `true` when the list is empty). Because port 8090 is also host-published, a LAN/VPN client can bypass Pangolin and supply the trusted header directly.

**Remediation:** Make empty mean "trust none", require the exact Pangolin/Newt proxy source in production, and prevent ordinary LAN/VPN clients from reaching port 8090 directly. Native RedMan login remains an unfinished future capability rather than a substitute for fixing proxy mode.

---

## ⚪ Low / informational

- **Secret-store blast radius.** SSH private key generated with empty passphrase (`sshManager.js:78`); `identity.json` stores the Ed25519 secret base64-plaintext (`handshake.js:45`); `rclone.conf` holds cloud creds plaintext. All mode-0600 in the data volume — standard for unattended automation, but anyone who can read `/app/backend/data` (see C1, H2) gets SSH identity, peer identity, and cloud tokens. Document the blast radius; consider volume-level encryption.
- **API keys stored plaintext, matched by direct equality** (`auth.js:141`). Keys are 256-bit random so the indexed lookup isn't a practical timing oracle, but storing a hash means a DB read doesn't hand over live credentials.
- **No SQL injection found.** All queries use parameterized `better-sqlite3` statements; the only dynamic table name (`scheduler.js:205`) comes from a fixed internal allowlist.
- **No command injection found.** All child processes use `spawn`/`execFile` with argv arrays (no shell). Path/host/user inputs are validated (`normalizePath`, `validateSshHost`/`validateSshUser`, whitelisted rclone keys). The one `execSync` with interpolation (`immichImport.js:155,187`) interpolates a constant (`/tmp/immich-retry`).
- **Docker socket = host root (by design).** Mounted `:ro` (`docker-compose.yml:18`, `unraid/redman.xml`), but `:ro` on a Unix socket does NOT restrict Docker API calls — `discovery.js:168` in fact creates a `NetworkMode: host` container. Any admin-reachable Docker function is root-equivalent on the host. Document this and consider a socket proxy (e.g. tecnativa/docker-socket-proxy) limited to the container/list/stats endpoints actually used.
- **Config mismatch (functional).** `index.js:57` reads `PEER_API_PORT`, but compose/unraid set `PEER_PORT`; the peer API always binds the 8091 default.

---

## Suggested security priority order

1. C1 — default `allowed_path_prefix` away from `/` (`pairing.js:279/302`)
2. C2 — restrict/scope the host SSH key written on pairing (`sshManager.js:108`)
3. H2 — make the file-picker root guard effective / denylist the secrets dir (`filesystem.js:34`)
4. H1 — scope `/peer/backup/status/:runId` to the requesting peer (`peerApi.js:240`)
5. H3 — enforce fingerprint confirmation + bind token into the handshake signature
6. M1/M2 — private-range validation for all server-initiated peer fetches and callback URLs
