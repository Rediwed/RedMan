---
description: "Use when: modifying API endpoints, database schemas, service exports, route handlers, frontend API client, or any code that is part of the backward compatibility contract. Covers migration requirements, contract validation, and breaking change procedures."
---
# Backward Compatibility Rules

## Golden Rule

**Never remove or rename** an existing API endpoint, database column, service export, or frontend API function. These are part of the v1 contract.

## Levels of Protection

### 1. API Endpoints (routes/)
- Existing endpoints must keep the same HTTP method + path
- Response fields can be ADDED, never removed or type-changed
- Query parameters can be ADDED with defaults, never removed
- Request body fields can be ADDED as optional, never removed or made newly required
- Status codes for success cases must not change

### 2. Database Schema (db.js, seed.js)
- Tables can be ADDED, never dropped
- Columns can be ADDED with DEFAULT values, never dropped or renamed
- Column types must not change (SQLite is flexible but consumers depend on types)
- Indexes can be added freely
- Foreign key relationships must not be removed
- All schema changes go through `migrations.js` — never ad-hoc ALTER TABLE in db.js

### 3. Service Exports (services/*.js)
- Exported function names must not change
- Function signatures: new parameters must be optional with defaults
- Return type shape must be additive-only (new fields ok, removed fields = breaking)
- New exports can be added freely

### 4. Frontend API Client (api/index.js)
- Exported function names must not change
- Endpoint URLs in the client must match the backend routes
- New exports can be added freely

### 5. Peer API (peerApi.js)
- Highest protection — remote peers depend on exact contract
- Endpoint paths, request bodies, and response shapes are frozen
- Version field in /peer/health must reflect actual compatibility

## When You Must Break Compatibility

1. Add the change as a new migration in `migrations.js` with a version number
2. Update `contracts/v1.json` (or create `contracts/v2.json` for major changes)
3. Run `node test/test_backward_compat.mjs` to verify or update the contract
4. Update the version string in package.json, index.js, and peerApi.js
5. Document the breaking change in the migration description

## Contract Test

After any change to routes, schema, services, or API client:
```bash
node test/test_backward_compat.mjs --skip-live   # Static checks only
node test/test_backward_compat.mjs               # Full validation with running server
```
