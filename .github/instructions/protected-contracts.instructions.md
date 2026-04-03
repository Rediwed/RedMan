---
description: "PROTECTED FILE — This is part of the RedMan backward compatibility contract. DO NOT modify, rename, or delete without explicit user approval. Changes to this file break the v1 contract and require a migration."
applyTo:
  - "app/backend/src/contracts/**"
  - "app/backend/src/migrations.js"
---
# Protected Contract Files — READ ONLY

These files define the immutable backward compatibility contract for RedMan.

## STOP — Before Making Any Change

1. **contracts/v1.json** — The source of truth for all API, DB, and service contracts. This file is validated by `test/test_backward_compat.mjs`. Modifying it means you are intentionally changing the compatibility contract.

2. **migrations.js** — The formal migration registry. Published migrations must NEVER be modified. New migrations are append-only with incrementing version numbers.

## Allowed Changes

- **Append** a new migration to the `migrations` array in `migrations.js`
- **Create** a new `contracts/v2.json` for a major version bump (keeping v1.json intact)
- **Add** new entries to v1.json (new endpoints, new columns, new exports) — additive only

## Forbidden Changes

- Removing any entry from v1.json
- Modifying an existing migration's `up()` function
- Changing migration version numbers
- Deleting or renaming any contract file
