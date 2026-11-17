# Disabled workflows (fork policy, 2026-11-16)

These files were moved out of `.github/workflows/` so GitHub stops scheduling them.
Nothing was deleted — `git log --follow` still reaches the original history.

## Why

The fork `jinnnyang/OmniRoute` is developed and shipped independently of
`cheaper-inference/OmniRoute` (upstream). The vendored upstream workflows below
target branches, registries and release channels this fork does not have, so they
either never trigger or would fail structurally:

| File | Reason |
|---|---|
| `docker-publish.yml` | Pushes to the **upstream** namespace (`diegosouzapw/omniroute`, now `cheaper-inference`). We cannot push there; production images are built by our own pipeline. |
| `npm-publish.yml` | Publishes the `omniroute` npm package owned by upstream. |
| `deploy-vps.yml` | Deploys `npm i -g omniroute@latest` (a public package) instead of our build; it has no configured variables/secrets anyway. |
| `electron-release.yml` | Desktop release channel we do not ship. |
| `radar-export.yml` | Exports upstream's radar dataset. |
| `wiki-sync.yml` | Syncs upstream docs wiki. |
| `opencode-plugin-ci.yml` | Bound to `release/v3.8.2` (dead branch). |
| `opencode-provider-ci.yml` | Bound to `release/v3.8.0` (dead branch). |
| `lock-released-branch.yml` | Locks released branches in upstream's release model. |
| `build.yml` (`Build App`) | Re-targeted at `less` in the fork, so it did run — but it builds with `OMNIROUTE_USE_TURBOPACK=1` and archives an artifact nothing consumes, duplicating `less-ci`'s `build (webpack)` job (the mode we actually ship) on every push. Disabled 2026-11-17; it is not a required check. |

## Not yet decided

`ci.yml`, `quality.yml`, `codeql.yml`, `semgrep.yml`, `dast-smoke.yml`,
`scorecard.yml`, `nightly-*.yml` are still in `.github/workflows/` but bind to
`main` / `release/**` and therefore never run here (verified 2026-11-17 by reading
every `on:` block; `build.yml` was the only leftover that targeted `less`). They are candidates for
either re-targeting at `less` or moving here — see
`reviews/20261116-less/00-SYNTHESIS-改造清单.md` (T1 items).

## Restoring one

    git mv .github/workflows-disabled/<file>.yml .github/workflows/<file>.yml

and fix its `branches:` filters / registry namespace first.
