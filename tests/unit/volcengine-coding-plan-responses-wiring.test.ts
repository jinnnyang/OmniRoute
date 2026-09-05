/**
 * Volcengine Coding Plan builtin provider — Responses API wiring (方案乙).
 *
 * Design: _tasks/superpowers/specs/2026-08-31-volcengine-coding-builtin-provider-design.md (v4)
 *
 * The Ark coding endpoint serves BOTH protocols at the same base (both
 * live-verified 200 on 2026-08-31):
 *   POST /api/coding/v3/chat/completions
 *   POST /api/coding/v3/responses
 *
 * Protocol switching is per-model targetFormat (no connection-level apiType):
 * resolveExecutionCredentials sees the RESOLVED targetFormat=openai-responses
 * (static registry marks AND #2905 DB overrides both funnel through it) and
 * injects _omnirouteForceResponsesUpstream; DefaultExecutor.buildUrl checks
 * the marker ALONE (single disjunction — registry/psd.targetFormat
 * re-disjunctions would be dead code: nothing writes either for this
 * provider).
 *
 * The registry entry must NOT hardcode per-model targetFormat — chatCore's
 * resolution priority is "static registry > DB override > provider default",
 * so a registry mark would shadow the operator's #2905 override.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

const { DefaultExecutor } = await import("../../open-sse/executors/default.ts");
const { resolveExecutionCredentials } =
  await import("../../open-sse/handlers/chatCore/executionCredentials.ts");
const { getRegistryEntry } = await import("../../open-sse/config/providerRegistry.ts");

const CHAT_URL = "https://ark.cn-beijing.volces.com/api/coding/v3/chat/completions";
const RESPONSES_URL = "https://ark.cn-beijing.volces.com/api/coding/v3/responses";

test("registry: volcengine-coding-plan carries responsesBaseUrl + liveCatalogAuthoritative:false", () => {
  const entry = getRegistryEntry("volcengine-coding-plan");
  assert.ok(entry, "builtin entry must exist");
  assert.equal(entry.baseUrl, CHAT_URL);
  assert.equal(entry.responsesBaseUrl, RESPONSES_URL);
  assert.equal(entry.liveCatalogAuthoritative, false);
  // Models the noisy live /models catalog omits must exist statically (the
  // whole point of liveCatalogAuthoritative:false).
  const ids = entry.models.map((m: { id: string }) => m.id);
  for (const id of [
    "glm-5.3",
    "glm-5.3-flash",
    "doubao-seed-evolving",
    "kimi-k2.7-code",
    "minimax-m3",
  ]) {
    assert.ok(ids.includes(id), `static catalog must list ${id}`);
  }
  // glm-5.3 is text-only upstream (8-30 image request 400) — the explicit
  // false must be preserved so the name heuristic can never flip it.
  const glm53 = entry.models.find((m: { id: string }) => m.id === "glm-5.3");
  assert.equal(glm53?.supportsVision, false);
  // User-facing dotted spelling aliases to the same static model.
  const turbo = entry.models.find((m: { id: string }) => m.id === "doubao-seed-2-1-turbo");
  assert.ok(turbo?.aliases?.includes("doubao-seed-2.1-turbo"));
});

test("buildUrl: no marker → chat/completions (regression guard)", () => {
  const executor = new DefaultExecutor("volcengine-coding-plan");
  const url = executor.buildUrl("glm-5.3", false, 0, { apiKey: "k" });
  assert.equal(url, CHAT_URL);
});

test("buildUrl: marker → /responses", () => {
  const executor = new DefaultExecutor("volcengine-coding-plan");
  const url = executor.buildUrl("glm-5.3", false, 0, {
    apiKey: "k",
    providerSpecificData: { _omnirouteForceResponsesUpstream: true },
  });
  assert.equal(url, RESPONSES_URL);
});

test("resolveExecutionCredentials: resolved openai-responses targetFormat injects the marker", () => {
  const out = resolveExecutionCredentials({
    credentials: { providerSpecificData: {} } as Record<string, unknown>,
    nativeCodexPassthrough: false,
    endpointPath: "/v1/responses",
    targetFormat: "openai-responses",
    provider: "volcengine-coding-plan",
    ccSessionId: null,
  }) as { providerSpecificData: Record<string, unknown> };
  assert.equal(out.providerSpecificData._omnirouteForceResponsesUpstream, true);
});

test("resolveExecutionCredentials: plain openai targetFormat leaves no marker", () => {
  const out = resolveExecutionCredentials({
    credentials: { providerSpecificData: {} } as Record<string, unknown>,
    nativeCodexPassthrough: false,
    endpointPath: "/v1/chat/completions",
    targetFormat: "openai",
    provider: "volcengine-coding-plan",
    ccSessionId: null,
  }) as { providerSpecificData: Record<string, unknown> };
  assert.notEqual(out.providerSpecificData._omnirouteForceResponsesUpstream, true);
});

test("lockstep (e2e unit): marker injection → buildUrl /responses, removal → chat/completions", () => {
  const executor = new DefaultExecutor("volcengine-coding-plan");
  // The DB-override path resolves through chatCore to the same resolved
  // targetFormat; resolveExecutionCredentials is the shared funnel for both
  // sources, so simulating the resolved value exercises the full contract.
  const withResponses = resolveExecutionCredentials({
    credentials: { providerSpecificData: {} } as Record<string, unknown>,
    nativeCodexPassthrough: false,
    endpointPath: "/v1/responses",
    targetFormat: "openai-responses",
    provider: "volcengine-coding-plan",
    ccSessionId: null,
  });
  const responsesUrl = executor.buildUrl(
    "glm-5.3",
    false,
    0,
    withResponses as unknown as Record<string, unknown>
  );
  assert.equal(responsesUrl, RESPONSES_URL);

  const withChat = resolveExecutionCredentials({
    credentials: { providerSpecificData: {} } as Record<string, unknown>,
    nativeCodexPassthrough: false,
    endpointPath: "/v1/chat/completions",
    targetFormat: "openai",
    provider: "volcengine-coding-plan",
    ccSessionId: null,
  });
  const chatUrl = executor.buildUrl(
    "glm-5.3",
    false,
    0,
    withChat as unknown as Record<string, unknown>
  );
  assert.equal(chatUrl, CHAT_URL);
});
