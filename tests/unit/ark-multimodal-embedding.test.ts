/**
 * Ark multimodal embeddings (#volcengine-coding-builtin).
 *
 * Live-verified upstream contract (2026-08-31, ark.cn-beijing.volces.com
 * /api/coding/v3):
 *  - POST /embeddings          → OpenAI shape, string[] input → N vectors.
 *  - POST /embeddings/multimodal → input array is the PART LIST of ONE fused
 *    vector: [{ type: "text", text }, { type: "image_url", image_url: { url } }]
 *    (http(s) URL or base64 data URI). Batched array-of-arrays is rejected
 *    ("Mismatch type embedding.Input"). Response wraps the single vector as
 *    `data: { embedding: [...] }` — an OBJECT, not the OpenAI array.
 *
 * So the provider registry points baseUrl at the standard /embeddings (plain
 * string[] inputs get true N-vector batching for free), and canonical
 * structured input is translated to the multimodal endpoint with a response
 * normalizer that re-wraps the fused vector into OpenAI shape.
 */
import test from "node:test";
import assert from "node:assert/strict";

process.env.DATA_DIR = process.env.DATA_DIR ?? mkdtempSync(join(tmpdir(), "omniroute-ark-embed-"));

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ARK_BASE = "https://ark.cn-beijing.volces.com/api/coding/v3/embeddings";

function arkProvider() {
  return {
    id: "volcengine-coding",
    baseUrl: ARK_BASE,
    authType: "apikey",
    authHeader: "bearer",
    structuredInputProtocol: "ark-multimodal" as const,
    models: [],
  };
}

test("translates canonical items to Ark's multimodal part-list contract (one fused vector)", async () => {
  const { prepareStructuredEmbeddingRequest } =
    await import("../../open-sse/handlers/embeddingStructuredInput.ts");
  const prepared = await prepareStructuredEmbeddingRequest(
    arkProvider(),
    "doubao-embedding-vision",
    {
      input: [
        { type: "text", text: "caption" },
        { type: "image", source: { type: "url", url: "https://example.com/i.png" } },
        {
          type: "image",
          source: { type: "base64", data: "aQ==", media_type: "image/jpeg" },
        },
      ],
    },
    "ark-token",
    { fetchMedia: async () => ({ buffer: Buffer.from("img"), contentType: "image/png" }) }
  );
  // Standard /embeddings → /embeddings/multimodal derivation.
  assert.equal(prepared.url, `${ARK_BASE}/multimodal`);
  // No auth override — standard Bearer from the apikey path.
  assert.equal(prepared.authHeader, undefined);
  // URL-sourced media is fetched and inlined as a data URI so the shared
  // 16 MiB aggregate cap stays enforceable on OmniRoute's side.
  assert.deepEqual(prepared.body, {
    model: "doubao-embedding-vision",
    input: [
      { type: "text", text: "caption" },
      { type: "image_url", image_url: { url: "data:image/png;base64,aW1n" } },
      { type: "image_url", image_url: { url: "data:image/jpeg;base64,aQ==" } },
    ],
  });
});

test("normalizes Ark's single-object data payload into OpenAI shape", async () => {
  const { prepareStructuredEmbeddingRequest } =
    await import("../../open-sse/handlers/embeddingStructuredInput.ts");
  const prepared = await prepareStructuredEmbeddingRequest(
    arkProvider(),
    "doubao-embedding-vision",
    { input: [{ type: "text", text: "caption" }] },
    "ark-token",
    { fetchMedia: async () => ({ buffer: Buffer.from("img"), contentType: "image/png" }) }
  );
  assert.deepEqual(
    prepared.normalizeResponse?.({
      id: "0217881553678547525",
      model: "doubao-embedding-vision",
      created: 1788155368,
      object: "list",
      data: { embedding: [0.005, -0.017] },
      usage: { prompt_tokens: 21, total_tokens: 21 },
    }),
    {
      object: "list",
      data: [{ object: "embedding", embedding: [0.005, -0.017], index: 0 }],
      usage: { prompt_tokens: 21, total_tokens: 21 },
    }
  );
});

test("rejects non-image media: Ark multimodal embeddings are text+image only", async () => {
  const { prepareStructuredEmbeddingRequest } =
    await import("../../open-sse/handlers/embeddingStructuredInput.ts");
  await assert.rejects(
    prepareStructuredEmbeddingRequest(
      arkProvider(),
      "doubao-embedding-vision",
      {
        input: [
          { type: "text", text: "caption" },
          { type: "audio", source: { type: "base64", data: "YQ==", media_type: "audio/wav" } },
        ],
      },
      "ark-token",
      { fetchMedia: async () => ({ buffer: Buffer.from("x"), contentType: "audio/wav" }) }
    ),
    /text and image/
  );
});

test("registry: volcengine-coding resolves with the suffix-less vision model", async () => {
  const registry = await import("../../open-sse/config/embeddingRegistry.ts");
  const provider = registry.getEmbeddingProvider("volcengine-coding");
  assert.ok(provider, "volcengine-coding must be a registered embedding provider");
  assert.equal(provider.structuredInputProtocol, "ark-multimodal");
  assert.equal(provider.baseUrl, ARK_BASE);
  const vision = provider.models.find((m) => m.id === "doubao-embedding-vision");
  assert.ok(vision, "doubao-embedding-vision must be listed (suffix-less)");
  assert.equal(vision.dimensions, 2048, "dims verified live on 2026-08-31");
  assert.ok(vision.modalities?.includes("image"));
});

test("registry: volcengine-agent resolves with the same suffix-less vision model (multimodal live-verified)", async () => {
  const registry = await import("../../open-sse/config/embeddingRegistry.ts");
  const provider = registry.getEmbeddingProvider("volcengine-agent");
  assert.ok(provider, "volcengine-agent must be a registered embedding provider");
  assert.equal(provider.structuredInputProtocol, "ark-multimodal");
  assert.equal(provider.baseUrl, "https://ark.cn-beijing.volces.com/api/plan/v3/embeddings");
  const vision = provider.models.find((m) => m.id === "doubao-embedding-vision");
  assert.ok(vision, "volcengine-agent must list doubao-embedding-vision");
  assert.equal(vision.dimensions, 2048);
  // Live-verified 2026-10-07 with a real Agent Plan key: /embeddings/multimodal
  // accepts text+image parts (min image dimension 14px) and returns the same
  // fused-vector object contract as Coding Plan.
  assert.ok(vision.modalities?.includes("image"), "Agent Plan supports image embedding (verified)");
});

test("registry: version-suffixed doubao-embedding-vision ids normalize to the suffix-less id", async () => {
  const registry = await import("../../open-sse/config/embeddingRegistry.ts");
  for (const suffix of ["-250615", "-251215"]) {
    const parsed = registry.parseEmbeddingModel(
      `volcengine-coding/doubao-embedding-vision${suffix}`
    );
    assert.equal(parsed.provider, "volcengine-coding");
    assert.equal(parsed.model, "doubao-embedding-vision", `${suffix} must normalize away`);
  }
  const agentParsed = registry.parseEmbeddingModel(
    "volcengine-agent/doubao-embedding-vision-251215"
  );
  assert.equal(agentParsed.provider, "volcengine-agent");
  assert.equal(agentParsed.model, "doubao-embedding-vision");
});
