---
description: "PROTECTED FILE — Service modules export the internal API contract. Exported function names and signatures must not change. New exports can be added."
applyTo: "app/backend/src/services/**"
---
# Protected Service Exports

## Rules

- Exported function names must not be renamed or removed
- New parameters must be optional with default values
- Return value shapes are additive-only
- New functions can be exported freely
- Internal (non-exported) functions can be changed freely

## Before Changing a Service

Check `contracts/v1.json` → `services` section. Every function listed there is part of the public contract and validated by `test/test_backward_compat.mjs`.
