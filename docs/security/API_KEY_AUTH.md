---
title: "API Key Authentication"
---

# API Key Authentication

## Overview

API-key authentication for client-facing API routes (`/v1/*`) is enforced by the
`clientApiPolicy` route guard in `src/server/authz/policies/clientApi.ts`. It is
independent of dashboard session auth, and is toggled by `REQUIRE_API_KEY`.

## Behavior matrix

| `REQUIRE_API_KEY`            | No Authorization header                  | Invalid Bearer key                                                | Valid Bearer key        |
| ---------------------------- | ---------------------------------------- | ----------------------------------------------------------------- | ----------------------- |
| `false` (default, local/dev) | allowed (anonymous)                      | allowed, degraded to anonymous with a `[clientApiPolicy]` warning | allowed (key id logged) |
| `true` (deployed)            | `401 AUTH_002 "Authentication required"` | `401 AUTH_002 "Invalid API key"`                                  | allowed                 |

Error responses carry `{"code":"AUTH_002", ...}` plus a `correlation_id`; no
upstream/provider detail is leaked.

## Valid key sources

`validateApiKey` (`src/lib/db/apiKeys.ts`) accepts a key when either:

1. It equals `OMNIROUTE_API_KEY` / `ROUTER_API_KEY` (env-configured key), or
2. It matches a non-revoked, non-expired, active row in the `api_keys` table
   (plaintext `key` or its `key_hash`), managed from the dashboard.

Note: the API-key guard is distinct from `isAuthRequired`
(`src/shared/utils/apiAuth.ts`), which gates model-catalog and management
routes on login/password/OIDC configuration.

## Verified 2026-09-24

On an isolated server (`REQUIRE_API_KEY=true`, env key
`sk-auth-test-valid-key-2026`), against `volcengine-coding-plan/deepseek-v4-flash`
via `/v1/responses`:

| Scenario                                       | Result                                                            |
| ---------------------------------------------- | ----------------------------------------------------------------- |
| Valid key `Bearer sk-auth-test-valid-key-2026` | `200` — full Responses reply `AUTH-OK` (real upstream round-trip) |
| Invalid key `Bearer sk-wrong-key-12345`        | `401 AUTH_002 "Invalid API key"` in ~0.2 s                        |
| No key                                         | `401 AUTH_002 "Authentication required"` in ~0.2 s                |

The default E2E/open-mode server (`REQUIRE_API_KEY=false`) intentionally allows
anonymous traffic, including invalid keys; this is test configuration, not a
defect.
