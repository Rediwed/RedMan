---
description: "PROTECTED FILE — Peer API handles machine-to-machine communication. Highest protection level — remote peers depend on exact endpoint paths, request/response shapes, and auth mechanism."
applyTo: "app/backend/src/peerApi.js"
---
# Protected Peer API — HIGHEST PROTECTION

The Peer API (port 8091) is the most sensitive contract in RedMan. Remote peers running different versions depend on exact compatibility.

## Frozen Contract

- All endpoint paths under `/peer/` are frozen
- Request body shapes for `/peer/backup/prepare` and `/peer/backup/complete` are frozen
- Response shapes including the `version` field in `/peer/health` are frozen
- Bearer key authentication mechanism is frozen
- Audit logging behavior must not change

## Absolutely Forbidden

- Removing or renaming any `/peer/*` endpoint
- Changing required fields in request bodies
- Removing fields from responses
- Changing the authentication mechanism
- Changing error status codes for existing error conditions

## Adding Features

- New `/peer/*` endpoints can be added
- Response objects can gain new fields
- Request bodies can accept new optional fields with defaults
