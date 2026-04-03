---
description: "PROTECTED FILE — API route handlers define the public contract. Removing or renaming endpoints breaks backward compatibility. New endpoints can be added freely."
applyTo: "app/backend/src/routes/**"
---
# Protected Route Files

## Rules

- Existing `router.get/post/put/delete()` handlers must keep the same path
- Response shapes are additive-only: add fields, never remove
- Query/body parameters: add optional ones with defaults, never remove or make newly required
- New route handlers can be added freely
- Before modifying any route, check `contracts/v1.json` — the endpoint must still match after your change

## Breaking Change Procedure

If you must change an endpoint's path or remove a field:
1. Keep the old endpoint working (deprecate, don't remove)
2. Add the new endpoint alongside it
3. Update contracts/v1.json
4. Bump version in package.json and health endpoint
