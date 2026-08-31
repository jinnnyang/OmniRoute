/**
 * Per-target image dispatch for mixed combos (#vision-bridge-vcp P1).
 *
 * Before: the vision bridge replaced image parts with "[Image N]: <desc>" ONCE
 * and the combo forwarded that single rewritten body to EVERY target — the
 * vision-capable target never saw the original image, so it answered from the
 * description text instead of the actual pixels.
 *
 * After: when the bridge describes (mixed combo "process" decision), the
 * ORIGINAL container (messages/input) is stashed on the body under an internal
 * key. The combo's per-target dispatch restores the raw container for targets
 * that HAVE vision capability and keeps the described version for text-only
 * targets. Non-combo / non-mixed paths are untouched.
 */
import test from "node:test";
import assert from "node:assert/strict";

const {
  stashVisionBridgeRawContainer,
  restoreVisionBridgeRawContainerForTarget,
  VISION_BRIDGE_RAW_CONTAINER_KEY,
} = await import("../../../src/lib/guardrails/visionBridgeHelpers.ts");

const baseBody = () => ({
  model: "combo-test",
  messages: [
    {
      role: "user",
      content: [
        { type: "text", text: "What color?" },
        { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgo" } },
      ],
    },
  ],
});

test("stash keeps the original messages and replace swaps in descriptions", () => {
  const body = baseBody() as Record<string, unknown>;
  stashVisionBridgeRawContainer(body);
  assert.ok(body[VISION_BRIDGE_RAW_CONTAINER_KEY], "raw container must be stashed");

  // Simulate the describe rewrite (replaceImageParts output shape).
  const described = {
    ...body,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "What color?" },
          { type: "text", text: "[Image 1]: a solid red square" },
        ],
      },
    ],
  };

  // Restore for a VISION target returns the original image-bearing container.
  const restored = restoreVisionBridgeRawContainerForTarget(
    described as never,
    "vcp/kimi-k2.7-code"
  );
  assert.ok(restored, "vision target must get a restored body");
  const content = (restored.messages as Array<{ content: Array<Record<string, unknown>> }>)[0]
    .content;
  assert.equal(
    content.some((part) => part.type === "image_url"),
    true,
    "restored container must carry the original image part"
  );
  assert.equal(
    restored[VISION_BRIDGE_RAW_CONTAINER_KEY],
    undefined,
    "internal stash key must not leak into the dispatch body"
  );

  // Restore for a TEXT-ONLY target keeps the described version (returns null
  // meaning "no restore needed").
  const textOnly = restoreVisionBridgeRawContainerForTarget(
    described as never,
    "vcp/deepseek-v4-flash"
  );
  assert.equal(textOnly, null, "text-only target must keep the described body");
});

test("restore never happens when the stash is absent (non-bridge requests)", () => {
  const body = baseBody() as Record<string, unknown>;
  assert.equal(restoreVisionBridgeRawContainerForTarget(body as never, "vcp/kimi-k2.7-code"), null);
});

test("capability gate: only an EXPLICIT vision verdict restores raw images", () => {
  // Indeterminate capability (unknown model on an unknown provider) must NOT
  // restore — the described fallback is the safe default.
  const body = baseBody() as Record<string, unknown>;
  stashVisionBridgeRawContainer(body);
  assert.equal(
    restoreVisionBridgeRawContainerForTarget(body as never, "totally-unknown/never-heard-of-xyz"),
    null
  );
});

test("restored body preserves the target's model field", () => {
  const body = baseBody() as Record<string, unknown>;
  stashVisionBridgeRawContainer(body);
  const described = { ...body, model: "vcp/kimi-k2.7-code", messages: [] };
  const restored = restoreVisionBridgeRawContainerForTarget(
    described as never,
    "vcp/kimi-k2.7-code"
  ) as Record<string, unknown> | null;
  assert.ok(restored);
  assert.equal(restored.model, "vcp/kimi-k2.7-code");
});
