import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Volcengine Agent Plan image provider (doubao-seedream).
//
// The Agent Plan images endpoint (/api/plan/v3/images/generations) is
// OpenAI-compatible for the basic fields but uses a dedicated
// `volcengine-image` format handler because: (1) image-to-image / multi-image
// input uses the upstream `image` field (single URL string or array of URLs),
// not `image_url`; (2) Volcengine-specific `output_format` / `watermark`
// controls must be forwarded (the generic OpenAI handler drops them).

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "omniroute-volcengine-image-"));

const { getImageProvider, parseImageModel, getAllImageModels } =
  await import("../../open-sse/config/imageRegistry.ts");
const { handleImageGeneration } = await import("../../open-sse/handlers/imageGeneration.ts");

test("volcengine-agent is registered as an image provider with the volcengine-image format", () => {
  const cfg = getImageProvider("volcengine-agent");
  assert.ok(cfg, "expected an IMAGE_PROVIDERS entry for volcengine-agent");
  assert.equal(cfg.id, "volcengine-agent");
  assert.equal(cfg.format, "volcengine-image", "must use the dedicated volcengine-image handler");
  assert.equal(cfg.authType, "apikey");
  assert.equal(cfg.authHeader, "bearer");
  assert.equal(cfg.baseUrl, "https://ark.cn-beijing.volces.com/api/plan/v3/images/generations");
});

test("volcengine-agent image provider exposes the Seedream 5.0 models", () => {
  const cfg = getImageProvider("volcengine-agent");
  const ids = (cfg?.models || []).map((m) => m.id);
  assert.ok(
    ids.includes("doubao-seedream-5.0-pro"),
    `expected doubao-seedream-5.0-pro, got: ${ids.join(", ")}`
  );
  assert.ok(
    ids.includes("doubao-seedream-5.0-lite"),
    `expected doubao-seedream-5.0-lite, got: ${ids.join(", ")}`
  );
  assert.deepEqual(cfg?.supportedSizes, ["2K", "3K", "4K"]);
  // Both models accept text + image input (i2i / multi-image).
  for (const m of cfg?.models || []) {
    assert.ok(m.inputModalities?.includes("image"), `${m.id} must support image input`);
  }
});

test("volcengine-agent models are listed in the image catalog and parse with provider prefix", () => {
  const catalogIds = getAllImageModels().map((m) => m.id);
  assert.ok(catalogIds.includes("volcengine-agent/doubao-seedream-5.0-pro"));
  const parsed = parseImageModel("volcengine-agent/doubao-seedream-5.0-pro");
  assert.deepEqual(parsed, { provider: "volcengine-agent", model: "doubao-seedream-5.0-pro" });
});

test("volcengine-image handler forwards text-to-image params incl. watermark/output_format", async () => {
  const originalFetch = globalThis.fetch;
  let captured;

  globalThis.fetch = async (url, options = {}) => {
    captured = {
      url: String(url),
      headers: options.headers,
      body: JSON.parse(String(options.body || "{}")),
    };
    return new Response(
      JSON.stringify({
        created: 123,
        data: [{ url: "https://ark-cdn.example.com/out.png", size: "2K" }],
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  };

  try {
    const result = await handleImageGeneration({
      body: {
        model: "volcengine-agent/doubao-seedream-5.0-pro",
        prompt: "a lighthouse at dusk",
        size: "2K",
        n: 1,
        response_format: "url",
        output_format: "png",
        watermark: false,
      },
      credentials: { apiKey: "agent-plan-key" },
      log: null,
    });

    assert.equal(result.success, true);
    assert.equal(captured.url, "https://ark.cn-beijing.volces.com/api/plan/v3/images/generations");
    assert.equal(captured.headers.Authorization, "Bearer agent-plan-key");
    assert.deepEqual(captured.body, {
      model: "doubao-seedream-5.0-pro",
      prompt: "a lighthouse at dusk",
      size: "2K",
      n: 1,
      response_format: "url",
      output_format: "png",
      watermark: false,
    });
    assert.equal(result.data.data[0].url, "https://ark-cdn.example.com/out.png");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("volcengine-image handler maps single image input to the upstream image field", async () => {
  const originalFetch = globalThis.fetch;
  let captured;

  globalThis.fetch = async (url, options = {}) => {
    captured = { url: String(url), body: JSON.parse(String(options.body || "{}")) };
    return new Response(
      JSON.stringify({ created: 1, data: [{ url: "https://ark-cdn.example.com/out.png" }] }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  };

  try {
    const result = await handleImageGeneration({
      body: {
        model: "volcengine-agent/doubao-seedream-5.0-lite",
        prompt: "keep the pose, change fabric to glass",
        image_url: "https://example.com/source.png",
        size: "2K",
      },
      credentials: { apiKey: "agent-plan-key" },
      log: null,
    });

    assert.equal(result.success, true);
    assert.equal(captured.body.image, "https://example.com/source.png");
    assert.equal(captured.body.model, "doubao-seedream-5.0-lite");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("volcengine-image handler maps multi-image input to an upstream image array", async () => {
  const originalFetch = globalThis.fetch;
  let captured;

  globalThis.fetch = async (url, options = {}) => {
    captured = { url: String(url), body: JSON.parse(String(options.body || "{}")) };
    return new Response(
      JSON.stringify({ created: 1, data: [{ url: "https://ark-cdn.example.com/out.png" }] }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  };

  try {
    const result = await handleImageGeneration({
      body: {
        model: "volcengine-agent/doubao-seedream-5.0-pro",
        prompt: "merge outfit from both references",
        imageUrls: ["https://example.com/a.png", "https://example.com/b.png"],
      },
      credentials: { apiKey: "agent-plan-key" },
      log: null,
    });

    assert.equal(result.success, true);
    assert.deepEqual(captured.body.image, [
      "https://example.com/a.png",
      "https://example.com/b.png",
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("volcengine-image handler rejects requests without credentials", async () => {
  const result = await handleImageGeneration({
    body: { model: "volcengine-agent/doubao-seedream-5.0-pro", prompt: "hello" },
    credentials: {},
    log: null,
  });
  assert.equal(result.success, false);
  assert.equal(result.status, 401);
});
