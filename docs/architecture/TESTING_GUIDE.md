---
title: Testing Guide
---

# Testing Guide

This document is the maintainability contract for OmniRoute's automated test suite.
It explains how the suite is layered, the principles that keep it healthy, and the
reference material behind those principles. It is the authoritative guide for
anyone adding or modifying tests.

## 1. Test layers

Tests are split by level into directories + npm scripts. The split is a
**test pyramid** (many fast unit tests at the base, fewer slow e2e at the top),
with an extra "live" tier that talks to real upstreams and is opt-in.

| Layer        | Location                                                           | Script(s)                                                                        | Concurrency           | Network                                               |
| ------------ | ------------------------------------------------------------------ | -------------------------------------------------------------------------------- | --------------------- | ----------------------------------------------------- |
| Unit         | `tests/unit/**`                                                    | `test` / `test:unit` (+ `:ci`, `:fast`, `:shard:*`, `:serial`)                   | 20 (serial subset: 1) | none (mocked)                                         |
| Integration  | `tests/integration/*.test.ts` + `combo-matrix/*.test.ts`           | `test:integration` (+ `:ci` shard)                                               | **1 (fully serial)**  | mock upstreams only                                   |
| Chaos / heap | `tests/integration/resilience-chaos.test.ts`, `heap-growth`        | `test:chaos`, `test:heap`                                                        | 1                     | mock                                                  |
| Live         | `tests/combo-live/*.live.test.ts`, `tests/boundary/*.live.test.ts` | `test:combo:live`, `test:boundary:live`, `test:ark:smoke`, `test:combo:live:vps` | 1                     | **real upstreams, opt-in** (`RUN_COMBO_LIVE=1` / VPS) |
| E2E          | `tests/e2e/*.spec.ts`                                              | `test:e2e` (Playwright), `test:protocols:e2e`                                    | —                     | browser / real clients                                |
| Other        | —                                                                  | `test:vitest*`, `test:mutation` (Stryker), `test:ecosystem`, `test:coverage`     | —                     | —                                                     |

`test:integration` is deliberately **fully serial** (`--test-concurrency=1`):
integration tests spawn real server child processes, open real SQLite files and
bind random ports; parallelism would make them interfere. `test:scoped` runs only
tests touched by the current git change set — the everyday fast path. `test:all`
is the release-grade chain (unit → vitest → vitest:ui → ecosystem → e2e); the
integration suite runs in CI via sharded jobs instead.

## 2. The eight maintainability principles

A test suite is maintainable when it does not degrade by itself. Degradation
signals: the full run takes so long nobody runs it; tests are flaky ("passes on
retry" is an isolation problem); one implementation change forces edits in ten
tests; a failure cannot be attributed quickly.

### 2.1 Layers are fixed by directory + script

The pyramid ratio is a **relative heuristic**, not a hard 70/20/10. Exception:
if your high-level tests are fast, reliable and cheap to change, you need fewer
lower-level ones (the "testing trophy" argument).

### 2.2 Isolation is a hard constraint

Every test owns its state: independent data dir, random port, temp dir, clean
teardown. Shared mutable state / order dependence is the #1 flaky root cause
(~20%). Teardown must tolerate resources that outlive the process (Windows file
locks). See the `fs.rm` `maxRetries`/`retryDelay` pattern and per-suite
`closeDbInstance()` used across integration suites.

### 2.3 Determinism first (kill flakes)

- Wait for real state, never `sleep` as the primary sync mechanism.
- Give timeouts headroom: cold start + internal retries blow past fixed short
  timeouts (fingerprint-expansion: 30s → 90s).
- Align env vars with actual runtime conditions — when a test server listens on
  a random port, set `OMNIROUTE_BASE_URL` so in-process loopback callbacks do
  not fall back to the hard-coded default `127.0.0.1:20128`.
- Seed randomness, freeze time, mock external calls.

### 2.4 Failures must be attributable

- Failure messages carry context: request body, child-process log tails.
- Keep verification snapshots (before/after full-suite results) so regressions
  can be attributed to a commit.
- Group failures by root cause, don't firefight one by one.

### 2.5 Regression gates

CI gates are the wall that stops a suite from rotting back. OmniRoute already
runs 40+ `check:*` gates (`check:test-masking`, `check:forgotten-sibling-tests`,
mutation coverage, `check:tracked-artifacts`, …); test changes must not weaken
them.

### 2.6 Cost tiers

Keep a fast feedback loop and deep verification coexisting: live tests are
opt-in, CI shards the big suites, `test:scoped` gives a seconds-level path. No
one should skip tests because the full run is too slow.

### 2.7 Decision documentation

Record _why_ a change was made (symptom → root cause → fix → verification) in
commit messages and design notes, so the next maintainer does not have to
re-archaeologise. See commit history for the 65-failure → 0-failure integration
baseline campaign.

### 2.8 Anti-regression detection

- Flaky detection: a test that only passes on retry is an isolation problem
  (`--fail-on-flaky-tests` in Playwright).
- Mutation testing: do the tests actually catch bugs?
- Periodic full-suite snapshots compared against the baseline.

## 3. Reference material

Read in this order.

### 3.1 Foundations

| Resource                                                                                                | Notes                                                                      |
| ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| [Test Pyramid — Martin Fowler](https://martinfowler.com/bliki/TestPyramid.html)                         | Layer mental model (CN mirror: martinfowler.com.cn/bliki/TestPyramid.html) |
| [The Practical Test Pyramid — Ham Vocke](https://martinfowler.com/articles/practical-test-pyramid.html) | Practical treatment; the most recommended single read                      |
| [Software Testing Guide — Martin Fowler](https://martinfowler.com/testing/)                             | Terminology overview                                                       |
| _Succeeding with Agile_ — Mike Cohn (2009)                                                              | Original source of the pyramid concept                                     |

### 3.2 Test smells & patterns

_XUnit Test Patterns_ — Gerard Meszaros (2007): the "Design Patterns" book of
testing. Names exactly the failure modes we fight: Erratic Tests, Shared
Fixture, Interacting Tests, Non-Deterministic Tests, Test Run War, Resource
Optimism. Free materials at <http://xunitpatterns.com/>.

### 3.3 Flaky-test engineering

| Resource                                                                                                                     | Notes                                    |
| ---------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| [Fixing Flaky Unit Tests — Chromium](https://www.chromium.org/developers/testing/fixing-flaky-tests/fixing_flaky_unittests/) | Big-company methodology                  |
| [Playwright Best Practices](https://playwright.dev/docs/best-practices)                                                      | Isolation-first                          |
| [Flaky test root-cause statistics](https://www.test-lab.ai/blog/flaky-tests-guide)                                           | Shared state ~20%, order dependence ~12% |

### 3.4 Node/JS ecosystem

| Resource                                                                                 | Notes                                                                                         |
| ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| [Node.js test runner docs](https://nodejs.org/api/test.html)                             | `node:test` reference                                                                         |
| [Node testing best practices](https://nodejs.codeguides.io/testing/best-practices/)      | Testcontainers, per-suite DB isolation, migration parity                                      |
| [Testcontainers](https://qaskills.sh/blog/testcontainers-mysql-node-integration-testing) | Containerised real dependencies (the heavier sibling of our lightweight `MockUpstreamServer`) |

## 4. Checklist for new test work

- Put the test in the correct layer directory + wire up its script.
- Isolation: own data dir / random port / temp dir / clean teardown.
- Mock upstreams (reuse `MockUpstreamServer`; Testcontainers only when a real
  dependency is unavoidable).
- Determinism: env alignment, timeout headroom, no sleeps.
- Failure diagnostics: child-process log capture, context in assertion messages.
- CI gates still pass (including the `check:*` suite).
- Cost tier respected: never default live tests on.
- Document the change (symptom → root cause → fix → verification).
