---
title: "Volcengine Ark Plan Providers (Coding Plan / Agent Plan)"
version: 3.8.56
lastUpdated: 2026-09-27
---

# Volcengine Ark Plan Providers

> Internal/ops reference for the two Volcano Ark subscription providers:
> `volcengine-coding-plan` and `volcengine-agent-plan`.

## Endpoint structure — they differ, handle them separately

|                            | Coding Plan                                                                   | Agent Plan                                                             |
| -------------------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Provider id                | `volcengine-coding-plan`                                                      | `volcengine-agent-plan`                                                |
| Chat base URL              | `https://ark.cn-beijing.volces.com/api/coding/v3`                             | `https://ark.cn-beijing.volces.com/api/plan/v3`                        |
| Chat endpoint              | `/api/coding/v3/chat/completions`                                             | `/api/plan/v3/chat/completions`                                        |
| Responses API              | `/api/coding/v3/responses` (same base)                                        | —                                                                      |
| `GET /models`              | **YES** — `/api/coding/v3/models` (Bearer key)                                | **NO** — `/api/plan/v3/models` returns 404                             |
| Registry catalog           | `open-sse/config/providers/registry/volcengine/coding-plan` (12 models)       | `open-sse/config/providers/registry/volcengine/agent-plan` (11 models) |
| `liveCatalogAuthoritative` | `false` — remote /models catalog is noisy/stale and must not veto curated ids | (n/a — no remote catalog)                                              |

Using the wrong base URL returns `401` even with a valid key (the standard `/api/v3`
endpoint does NOT serve plan keys; the plans do NOT serve standard keys). Volcengine
also warns against pointing Coding Plan at `/api/v3`: it does not consume plan quota
(per-token billing instead) — always use `/api/coding/v3`.

## Protocol support (Chat API + Responses API)

Coding Plan is OpenAI-protocol compatible on **both** protocols (Volcengine docs:
"Coding Plan … supports Responses API, Chat API — Responses API recommended"). Both
were live-verified against OmniRoute 2026-09-27 (real Coding Plan key, 200):

| Protocol          | Endpoint                  | Verified                                              |
| ----------------- | ------------------------- | ----------------------------------------------------- |
| Chat Completions  | `{base}/chat/completions` | 200, `"OK-E2E"`                                       |
| Responses (Codex) | `{base}/responses`        | 200, `"OK-RESP"` (resp_…, reasoning + message output) |

So both registry URLs are correct — `baseUrl` serves chat-format clients and
`responsesBaseUrl` serves Responses/Codex clients; the executor switches on the
`_omnirouteForceResponsesUpstream` marker (see `open-sse/executors/default.ts`
`case "volcengine-coding-plan"`). Official docs recommend Responses for best
reasoning quality.

## Two auth styles for the same provider id

1. **Console session** (`Connect Volcano Account`): `volcConsoleCookie` + `volcCsrfToken`
   stored in `providerSpecificData`. Model discovery goes through the console top-level
   Ark actions (`ListArkCodeLatestModel` / `ListAgentPlanLatestModel`) — the
   authoritative catalog. See `src/lib/providers/volcenginePlanBinding.ts` and
   `volcenginePlanModelDiscovery.ts`.
2. **API key** (`Ark … Plan subscription API key`): only `apiKey` is set, no console
   session. Sync falls through to the standard remote-discovery path:
   - **Coding Plan**: hits `GET {base}/models` (live, Bearer key).
   - **Agent Plan**: no `/models` endpoint; the 404 makes discovery fall back to the
     curated local catalog (registry models) — do NOT point Agent Plan at `/models`.

## Model discovery / sync behavior (#volcengine-plan-vN)

- Both providers are in `NAMED_OPENAI_STYLE_PROVIDERS`
  (`src/app/api/providers/[id]/models/discovery/providerSets.ts`), so the models route
  falls back to the **registry base URL** when `providerSpecificData.baseUrl` is empty.
  Before this, an API-key connection with no base URL produced
  `Invalid outbound URL: /models` (503) on every sync (`?refresh=true` bypasses
  auto-fetch-disabled).
- Endpoint candidates skip the `/v1/models` variant when the base already carries a
  path version segment (`/vN`), so coding/agent never attempt a nonexistent
  `/v3/v1/models`.
- The dashboard prefills the correct plan base URLs
  (`DEFAULT_PROVIDER_BASE_URLS` in `providerPageHelpers.ts`).

## Known pitfalls

- **`Invalid outbound URL: /models` on save**: root cause was an empty
  `providerSpecificData.baseUrl` + plan provider unclassified → default discovery
  path concatenated `/models` onto nothing. Fixed by the classification above; keep
  base URLs aligned with the table when overriding.
- **Volcengine console discovery requires the console session**: an API-key-only
  connection cannot enumerate plan models via the console APIs; it uses `/models`
  (coding) or the curated catalog (agent).
- **opencode-hosted Volcengine credentials are NOT Ark keys**: keys minted for
  OpenCode's provider (e.g. `~/.local/share/opencode/auth.json`) return
  `401 AuthenticationError` when called directly against
  `ark.cn-beijing.volces.com/api/v3`. Use keys from the Ark console for direct use.
