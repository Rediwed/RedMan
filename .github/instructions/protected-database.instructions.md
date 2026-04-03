---
description: "PROTECTED FILE — Core database initialization and inline migrations. Changes here affect all existing installations. New schema changes must go through migrations.js instead."
applyTo:
  - "app/backend/src/db.js"
  - "app/backend/src/seed.js"
---
# Protected Database Files

## db.js — Frozen Inline Migrations

The inline migrations in `db.js` (tableExists checks, ALTER TABLE, CREATE TABLE IF NOT EXISTS) are **frozen for v1**. They handle upgrades from any v1.x database to the current schema.

### Rules

- Do NOT add new ALTER TABLE or CREATE TABLE statements to db.js
- Do NOT modify existing migration blocks — they must remain idempotent
- New schema changes go in `migrations.js` as numbered migrations
- The `runMigrations(db)` call at the end of db.js handles all future changes

## seed.js — Reference Schema

seed.js defines the complete schema for fresh installations. When adding columns/tables:

1. Add the column/table to seed.js (so new installs get it)
2. Add a migration in migrations.js (so existing installs get it)
3. Add the column/table to contracts/v1.json (so the test knows about it)
4. All three must stay in sync
