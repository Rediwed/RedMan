---
description: "PROTECTED FILE — Frontend API client defines the frontend-to-backend contract. Exported function names must not change. New functions can be added."
applyTo: "app/frontend/src/api/**"
---
# Protected Frontend API Client

## Rules

- Exported function names must not be renamed or removed
- The endpoint URLs inside each function must match the backend route contract
- Function signatures can gain optional parameters but not lose existing ones
- New API functions can be added freely

## Before Changing

Check `contracts/v1.json` → `frontendApi.exports`. Every function listed there is validated by `test/test_backward_compat.mjs`.
