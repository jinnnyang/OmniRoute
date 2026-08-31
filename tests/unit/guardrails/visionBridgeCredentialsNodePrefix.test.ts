/**
 * Vision Bridge credential checks — custom-connection prefix resolution (#vision-bridge-vcp).
 *
 * `hasUsableCredentialsForModel()` gates which vision-capable candidates the
 * bridge may use. Before this fix the provider prefix was resolved ONLY
 * through the static PROVIDERS alias map (`resolveProviderId`), so a model id
 * carrying an operator-configured provider-node prefix (e.g. `vcp` for an
 * `openai-compatible` node whose connection row is stored under the node's
 * UUID-like id) resolved to itself, queried `provider = "vcp"`, found zero
 * rows, and returned false — the configured fixedModel was rejected and
 * auto-selection hijacked the describe call (observed: a no-auth free relay
 * won while the operator's keyed vision connection sat idle).
 *
 * Resolution now consults `provider_nodes` too: a node whose prefix (or
 * slugified name) equals the model prefix contributes its node id as a
 * candidate provider key. ID-based only — the mapping comes from the
 * operator's own configuration rows, never from name guessing.
 *
 * Same real-DB pattern as visionBridgeCredentials.test.ts (#10702) — isolated
 * DATA_DIR per PII learnings §3.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-vb-nodeprefix-"));

process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../../src/lib/db/core.ts");
const providersDb = await import("../../../src/lib/db/providers.ts");
const { hasUsableCredentialsForModel, classifyModelCredentials, resolveProviderIdsForModelPrefix } =
  await import("../../../src/lib/guardrails/visionBridgeCredentials.ts");

async function resetStorage() {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

const NODE_ID = "openai-compatible-responses-test-node-id";

async function seedNodeAndConnection() {
  await providersDb.createProviderNode({
    id: NODE_ID,
    name: "Volcengine Coding",
    prefix: "vcp",
    type: "openai-compatible",
  });
  await providersDb.createProviderConnection({
    provider: NODE_ID,
    authType: "apikey",
    apiKey: "ark-key-123",
    isActive: true,
    testStatus: "active",
  });
}

// ── resolveProviderIdsForModelPrefix (pure) ─────────────────────────────────

test("resolveProviderIdsForModelPrefix — index prefix contributes the node id", () => {
  const ids = resolveProviderIdsForModelPrefix("vcp", "vcp", {
    prefixToNode: new Map([["vcp", NODE_ID]]),
  });
  assert.ok(ids.includes(NODE_ID), "node id must be a candidate provider key");
  assert.ok(ids.includes("vcp"), "verbatim prefix stays a candidate (legacy rows)");
  assert.deepEqual([...ids].sort(), [NODE_ID, "vcp"], "no other keys leak in");
});

test("resolveProviderIdsForModelPrefix — no index still yields static + verbatim", () => {
  const ids = resolveProviderIdsForModelPrefix("cmd", "command-code", null);
  assert.deepEqual([...ids].sort(), ["cmd", "command-code"]);
});

test("getProviderPrefixIndex — reserved prefix node is never routable", async () => {
  await resetStorage();
  // A node claiming the built-in prefix "openai" must not become the routable
  // target of that prefix — reserved prefixes stay with the static provider.
  await providersDb.createProviderNode({
    id: "node-reserved",
    name: "Fake OpenAI",
    prefix: "openai",
    type: "openai-compatible",
  });
  const { getProviderPrefixIndex } = await import("../../../src/lib/providerNodePrefixes.ts");
  const index = await getProviderPrefixIndex();
  assert.ok(!index.prefixToNode.has("openai"), "reserved prefix must not map to a node");
});

// ── classifyModelCredentials / hasUsableCredentialsForModel (DB-backed) ────

test("custom-node-prefixed model resolves to the node's connection (#vision-bridge-vcp)", async () => {
  await resetStorage();
  await seedNodeAndConnection();

  const verdict = await classifyModelCredentials("vcp/kimi-k2.7-code");
  assert.equal(verdict, "keyed", "node-prefixed model must find the keyed connection");

  const usable = await hasUsableCredentialsForModel("vcp/kimi-k2.7-code");
  assert.equal(usable, true, "fixedModel with a node prefix must be usable");
});

test("custom-node-prefixed model is unusable when the node connection is dead", async () => {
  await resetStorage();
  await providersDb.createProviderNode({
    id: NODE_ID,
    name: "Volcengine Coding",
    prefix: "vcp",
    type: "openai-compatible",
  });
  await providersDb.createProviderConnection({
    provider: NODE_ID,
    authType: "apikey",
    apiKey: "ark-key-123",
    isActive: true,
    testStatus: "banned",
  });

  const verdict = await classifyModelCredentials("vcp/kimi-k2.7-code");
  assert.equal(verdict, "unusable");
});

test("node prefix with no connection at all is unusable, not noauth", async () => {
  await resetStorage();
  await providersDb.createProviderNode({
    id: NODE_ID,
    name: "Volcengine Coding",
    prefix: "vcp",
    type: "openai-compatible",
  });

  const verdict = await classifyModelCredentials("vcp/kimi-k2.7-code");
  assert.equal(verdict, "unusable", "custom prefixes are never no-auth");
});

test("unknown prefix still returns false (definitive) when table readable", async () => {
  await resetStorage();
  const usable = await hasUsableCredentialsForModel("ghost/no-such-model");
  assert.equal(usable, false);
});
