---
title: "Release & Deploy (fork policy)"
---

# Release & deploy (fork policy)

> Applies to `jinnnyang/OmniRoute` only. Upstream (`cheaper-inference/OmniRoute`) has its own
> multi-registry, multi-arch, npm + Electron release machinery; we deliberately do not run it.

## Versioning

The fork keeps its own version line (first independent release: `3.9.0`).
`package.json`, `open-sse/package.json` and `docs/openapi.yaml` must agree, and the
git tag must equal that version:

```
node scripts/release/bump-version.mjs 3.9.0   # the three files, one place of truth
git commit -am "release: 3.9.0"
git tag v3.9.0 && git push origin less --tags
```

`release-less.yml` refuses to build when the tag and `package.json` disagree, so a
mis-tagged release fails before anything is published.

Every image also carries `OMNIROUTE_BUILD_SHA` (= commit) and the OCI `revision` label,
so `GET /api/monitoring/health` (management-authenticated) answers "which commit is this?".

## What a release produces

| Artifact | Where |
|---|---|
| `jinnnyang/omniroute:<version>`, `:sha-<short>`, `:latest` | Docker Hub |
| `omniroute-<version>.tar.gz` (docker load-able) | GitHub Release |
| `sbom-<version>.cdx.json` (CycloneDX) | GitHub Release |

The image is scanned with Trivy (**CRITICAL, blocking**) and booted for real —
`/api/monitoring/health` must be healthy and the boot log must show
`[DB] Driver: better-sqlite3` — before anything is pushed.

Required secrets: `DOCKERHUB_USERNAME`, `DOCKERHUB_TOKEN` (Read & Write).

## Deploy

Production is deployed with **scp + docker load**, not by pulling from the registry:

```
./scripts/deploy/scp-load.sh 3.9.0
```

The script downloads the release tarball (or takes `--tarball`), uploads it to
`/opt/omniroute/incoming/`, `docker load`s it, rewrites the `IMAGE=` line of
`/opt/omniroute/recreate-omniroute.sh`, recreates the container and waits for
`{"status":"healthy","setupComplete":true}` (both fields — `setupComplete:false` is the
"dashboard 500" failure mode, see 坑 11).

It prints the rollback command with the previous tag on exit.

## Nightly guards

`nightly-incidents.yml` keeps only the three guards that map to real incidents:

| Job | Incident | Guard |
|---|---|---|
| `driver-fallback` | 17 篇 (sql.js fallback → heap exhaustion) | image boots with `[DB] Driver: better-sqlite3` |
| `resilience` | 21/011 篇 (queue timeouts, combo retry storms) | rate-limit / combo / timeout tests |
| `catalog-policy` | 014 篇 (`/v1/models` drift vs call-time policy) | catalog / API-key policy tests |

Test jobs run through `scripts/quality/unit-ratchet.mjs`, so they fail only on **new**
failures relative to `config/quality/unit-known-failures.json`.

## Auto-deploy

`deploy-less.yml` deploys the image that a successful `release-less` run produced:

```
release-less (tag v*)  ──success──▶  deploy-less  ──▶  VPS: curl asset → docker load → recreate → health
```

- **Trigger**: `workflow_run` on `release-less` completion, plus manual dispatch with a version.
- **Rail**: a failed build / Trivy finding / smoke failure never reaches the host.
- **Secret**: `production` environment → `VPS_SSH_KEY` (private key; its public half belongs in
  `root@<host>:/root/.ssh/authorized_keys`). Optional variable `VPS_HOST` (defaults to
  `155.103.156.145`).
- **Rollback**: `scp-load.sh` records the previous `IMAGE=` and, if the container is not
  `{"status":"healthy","setupComplete":true}` within ~2 minutes, re-points it back and
  recreates. A failed deploy therefore ends with production serving the previous version.
- **Approval gate (optional)**: add required reviewers to the `production` environment to turn
  auto-deploy into "build automatically, approve the rollout".
