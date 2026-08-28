import { test } from "node:test";
import assert from "node:assert/strict";

import { compressionSettingsUpdateSchema } from "../../src/shared/validation/compressionConfigSchemas.ts";

// Regression guard for the LLMLingua/SLM engine removal (branch `less`).
//
// The SLM tier was deleted from `ultraConfigSchema`, but the dashboard's
// CompressionSettingsTab kept sending `slmFallbackToAggressive` / `modelPath`
// in its PUT body. Because `ultraConfigSchema` is `.strict()`, every save from
// the Ultra settings panel was rejected with HTTP 400 — the whole panel became
// unwritable, not just the two removed fields.
//
// The fix strips the SLM controls from the UI. These tests pin both halves of
// the contract so the two sides cannot drift apart again.

test("ultra config accepts the post-SLM-removal field set", () => {
  const result = compressionSettingsUpdateSchema.safeParse({
    ultra: {
      enabled: true,
      compressionRate: 0.5,
      minScoreThreshold: 0.3,
      maxTokensPerMessage: 0,
      preserveSystemPrompt: true,
    },
  });

  assert.equal(result.success, true, "surviving ultra fields must still validate");
});

test("ultra config rejects removed SLM fields (strict schema is intentional)", () => {
  for (const removed of ["slmFallbackToAggressive", "modelPath"]) {
    const result = compressionSettingsUpdateSchema.safeParse({
      ultra: { enabled: true, [removed]: removed === "modelPath" ? "/x.onnx" : true },
    });

    assert.equal(result.success, false, `${removed} must not be accepted after SLM removal`);
  }
});

test("dashboard Ultra panel no longer sends removed SLM fields", async () => {
  const { readFile } = await import("node:fs/promises");
  const tab = await readFile(
    new URL(
      "../../src/app/(dashboard)/dashboard/settings/components/CompressionSettingsTab.tsx",
      import.meta.url
    ),
    "utf8"
  );

  // The UI builds its PUT body from local state, so any lingering reference to a
  // removed field means the panel is shipping a body the API will 400 on.
  assert.equal(
    tab.includes("slmFallbackToAggressive"),
    false,
    "CompressionSettingsTab must not reference slmFallbackToAggressive"
  );
  assert.equal(
    tab.includes("modelPath"),
    false,
    "CompressionSettingsTab must not reference ultra.modelPath"
  );
});
