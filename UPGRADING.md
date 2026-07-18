# Upgrading Through the Readiness Bridge

The readiness bridge is an intermediate RedMan release for installations created before the hardened deployment model. It prepares the application database and NAS host without replacing the container image or applying the hardened schema. Production bridge mode is a maintenance window: schedules, job mutations, drive/Docker monitoring, and the peer API are paused.

## Safety Boundary

The browser and RedMan container never receive host-root access. The wizard performs read-only assessment, creates a SQLite online backup, and generates commands and configuration. The host command downloads all three helper scripts from the official `v1.1.0` tag, verifies embedded SHA-256 checksums, and only then asks for root execution.

The bridge does not:

- change existing job, peer, media, or authentication data;
- replace the RedMan container image;
- modify the hardened-release schema;
- enable Docker monitoring sidecars;
- restore unrestricted root SSH access.

## Installing the Bridge

The bridge is published as source tag `v1.1.0`. Build that exact tag locally; do not use an unpinned `latest` image.

1. Record the current container image ID and export its inspection before changing it.
2. Check out `v1.1.0` in a clean directory.
3. Copy `.env.example` to `.env` and set the existing app-data path, exact reverse-proxy source address, and forward-auth administrator group and/or role. Pangolin Badger provides `Remote-Role`; Authelia commonly provides `Remote-Groups`.
4. Build the bridge image from the pinned Dockerfile: `docker compose build --pull redman`.
5. Stop the existing RedMan container during a maintenance window, retain its image, and start the bridge with `docker compose up -d redman`.
6. Confirm `/api/health` reports `"upgradeBridge": true`, then open **Settings > Upgrade** through the trusted reverse proxy.

Do not mount the Docker socket, user shares, cache, removable media, or peer port into the bridge. Normal jobs are intentionally unavailable until hardened cutover.

## Wizard Stages

Open **Settings > Upgrade**.

### 1. Assess

The assessment checks:

- SQLite integrity and active database-backed jobs;
- Hyper Backup jobs that still use root SSH;
- enabled peer grants with root scope, unlimited quota, or missing stable identity;
- delete-after-import settings that the hardened release will disable;
- direct Docker socket configuration;
- presence of the application backup and host receipt.

Warnings are migration consequences that require review. Blocked checks must be resolved before continuing.

### 2. Back Up

Select **Create verified backup**. RedMan uses SQLite's online backup API, runs an integrity check against the resulting file, stores the receipt under `upgrade-readiness/`, and retains the three newest bridge backups.

Do not replace this with a live filesystem copy of `redman.db`; an active WAL database may have committed data in sidecar files.

### 3. Prepare the Host

Choose Unraid or generic Linux, enter the existing host app-data path, and explicitly list the narrow host roots that peers may use for restricted backups. No broad root is selected by default. Generate and copy the command, then run it in the NAS host terminal.

The host helper:

1. verifies the bridge container is running and has no active jobs;
2. re-validates the exact receipt-bound backup size, SHA-256, and SQLite integrity;
3. saves the current container inspection and image identity;
4. stops the bridge container to prevent writes racing with rollback capture;
5. copies the verified database and sensitive runtime files into a mode-`0700` rollback directory;
6. provisions the non-root `redman-backup` account and approved roots;
7. installs the canonical forced-`rrsync` key reader and Unraid persistence;
8. writes the hashed artifact manifest and non-secret `host-prepared.json` receipt atomically while the bridge remains stopped;
9. restarts the bridge, with an exit trap providing restart-on-failure behavior.

Return to the wizard and select **Check receipt**. Do not fabricate or edit the receipt.

### 4. Configure

Select the future authentication mode and provide:

- the exact public HTTPS origin;
- the exact reverse-proxy source address;
- the numeric private SSH address reachable by the other RedMan peer;
- host data, storage, and media paths;
- whether Docker monitoring is required.

The wizard emits a non-secret environment template. Local authentication uses a placeholder for a new high-entropy bootstrap token; generate that token on the host and do not store it in issue trackers or shell history.

### 5. Ready

The final page requires:

- a verified database backup;
- a valid host preparation receipt;
- generated hardened configuration;
- no active jobs.

Keep the rollback directory and generated configuration outside the container lifecycle until the hardened upgrade is validated.

## Hardened Release Cutover

After every participating NAS has completed the bridge:

1. disable schedules or choose a maintenance window;
2. confirm the bridge assessment has no blocked checks;
3. stop the bridge container;
4. retain its image or immutable image digest;
5. install the hardened container definition with the generated configuration;
6. start RedMan without seeding;
7. verify schema migration, authentication, storage roots, peers, and representative jobs;
8. remove the bootstrap token after creating the first local administrator.

Expect root-based Hyper jobs to move to `redman-backup`, unsafe legacy peer grants to be disabled, delete-after-import to be reset, and direct Docker socket monitoring to remain unavailable until the exact-path sidecars are enabled.

## Rollback

Do not run the old bridge image against a database already migrated by the hardened release.

For rollback:

1. stop the hardened container;
2. restore the bridge image and its previous container configuration from `container-inspect.json`;
3. replace app-data with the rollback directory's verified `redman.db` and copied identity/configuration files;
4. start the bridge container and verify health before re-enabling jobs.

The restricted host account may remain installed during rollback. Removing it is unnecessary and is safer than reinstating unrestricted root SSH.
