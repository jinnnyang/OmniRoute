/**
 * Verify MiMo V2.6 vision resolution across providers (generation cleanup
 * 2026-11-20: the V2.5 generation, including mimo-v2.5 and its *-pro sibling,
 * was removed from MODEL_SPECS).
 *
 * mimo-v2.6-pro / mimo-v2.6-flash are registered in ModelSpec with
 * `supportsVision: true` (native multimodal per Xiaomi docs), so
 * resolveVisionCapability() picks the flag up from `spec.supportsVision` without
 * needing a registry flag.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { getResolvedModelCapabilities } from "../../src/lib/modelCapabilities.ts";
import { isVisionModelId } from "../../src/shared/constants/visionModels.ts";
import { MODEL_SPECS } from "../../src/shared/constants/modelSpecs.ts";

const MIMO_V26_CASES: [string, boolean][] = [
  ["opencode-go/mimo-v2.6-flash", true],
  ["bai/mimo-v2.6-flash", true],
  ["mimo-v2.6-flash", true],
  ["opencode-go/mimo-v2.6-pro", true],
  ["mimo-v2.6-pro", true],
];

for (const [modelId, expected] of MIMO_V26_CASES) {
  test(`${modelId} → supportsVision=${expected}`, () => {
    const caps = getResolvedModelCapabilities(modelId);
    assert.equal(caps.supportsVision, expected, `${modelId} supportsVision must be ${expected}`);
  });
}

test("retired MiMo V2.5 ids keep their capability rows", () => {
  // Additive policy: providers still serving these ids must resolve their real
  // windows/flags instead of the 128K heuristic fallback.
  for (const retired of [
    "mimo-v2.5",
    "mimo-v2.5-pro",
    "mimo-v2-pro",
    "mimo-v2-omni",
    "mimo-v2-flash",
  ]) {
    assert.equal(typeof MODEL_SPECS[retired], "object", `${retired} must keep a spec row`);
  }
  assert.equal(MODEL_SPECS["mimo-v2.5"].supportsVision, true);
  assert.equal(MODEL_SPECS["mimo-v2-pro"].supportsVision, false);
});

test("mimo-vl fragment heuristic still detects vision ids", () => {
  assert.equal(isVisionModelId("mimo-vl-a3b"), true, "mimo-vl must be detected as vision");
});
