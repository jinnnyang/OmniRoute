---
title: "E2E Verification Notes (3.8.56) — containerized image"
version: 3.8.56
lastUpdated: 2026-09-27
---

# E2E Verification Notes — `jinnnyang/omniroute:3.8.56`

> Ops log from the 2026-09-27 end-to-end verification of the slimmed runner-base
> image (1.66 GB, tag digest `sha256:6704923e7801b96e…`). Kept so future image
> releases re-use the same probes and avoid the same traps.

## What was verified (all green unless noted)

| Layer                   | Probe                                                 | Result                                                                                                         |
| ----------------------- | ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Hub pull                | `docker pull jinnnyang/omniroute:3.8.56`              | digest match                                                                                                   |
| Boot                    | fresh container, empty volume                         | healthy, `restarts=0`, migrations applied                                                                      |
| Health                  | `GET /api/monitoring/health`                          | 200 `{"status":"healthy","setupComplete":true}`                                                                |
| Auth                    | `POST /api/auth/login` (INITIAL_PASSWORD)             | 200, session cookie                                                                                            |
| Keys                    | `POST /api/keys`                                      | 201, key usable                                                                                                |
| Catalog                 | `GET /v1/models` (Bearer)                             | 200, 482 → 514 models after provider sync                                                                      |
| Providers               | create → activate → `sync-models`                     | 201/200/200                                                                                                    |
| **Real LLM round-trip** | `POST /v1/chat/completions` with true Coding Plan key | **200** `"OK-E2E"` via combo fallback to `volcengine-coding-plan/doubao-seed-2-1-turbo` (5309ms, decisions=51) |
| Persistence             | restart container                                     | ~10s healthy, key+provider+models survive                                                                      |
| Resources               | `docker stats`                                        | ~550 MB RSS (heap budget 1024 MB)                                                                              |

## Pitfalls logged (re-check before the next round)

1. **PowerShell eats inline `curl -d '{"json":...}'` quotes** → server returns
   `400 Invalid JSON body`. Always write the body to a file and use
   `--data-binary "@file"` (UTF-8 no BOM).
2. **Tool-side `docker run` timeouts during engine warm-up are a false alarm** —
   `docker create/run` itself completes in milliseconds; bisect with a detached
   script before assuming the command failed.
3. **opencode-hosted Volcengine credentials ≠ Ark API keys** — direct
   `ark.cn-beijing.volces.com/api/v3` calls return `401 AuthenticationError`.
   Use a console/plan API key for direct providers.
4. **Browser CSP `font-src` blocks `at.alicdn.com` iconfonts** — the requests come
   from a browser extension (`moz-extension://…/861.js`), not the app; the repo has
   no alicdn references. Do NOT widen CSP for plain-http fonts.
5. **`compression_run_telemetry: no such table` at boot** — cleanup sweep
   (`src/lib/db/cleanup.ts:386`) queries a lazily-created table on a fresh DB;
   non-fatal (`Auto-cleanup 0 deleted, 1 errors`), self-heals after the first
   compression run. Candidate one-line fix: ensure the table before the DELETE.
6. **Empty `providerSpecificData.baseUrl` on plan providers** — previously crashed
   sync with `Invalid outbound URL: /models`; fixed in 3.8.56+ by classifying the
   plan providers as named OpenAI-style (registry base fallback) — see
   [VOLCENGINE-PLAN-PROVIDERS.md](../providers/VOLCENGINE-PLAN-PROVIDERS.md).

## Teardown

```bash
docker rm -f or-e2e-3856
docker volume rm omniroute-e2e-data
```

Test data created during e2e: API key `e2e-test`, provider `e2e-volcengine`
(invalid key — deleted on teardown), provider `true-key` (real Coding Plan key —
keep or remove explicitly).
