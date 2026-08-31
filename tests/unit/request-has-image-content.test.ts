/**
 * requestHasImageContent — the shared "does this request carry image content?"
 * verdict feeding auto-combo vision scoring (design: task 1 threading).
 *
 * Must reuse the vision-bridge extraction contract (detectMediaParts via
 * extractImageParts) so routing, the guardrail, and lite compression can never
 * disagree on what counts as an image part (#4072 single-source rule).
 */
import test from "node:test";
import assert from "node:assert/strict";

const { requestHasImageContent } = await import("../../src/lib/guardrails/visionBridgeHelpers.ts");

test("detects image_url parts in chat-completions messages", () => {
  assert.equal(
    requestHasImageContent({
      messages: [
        { role: "user", content: [{ type: "text", text: "what is this?" }] },
        {
          role: "user",
          content: [{ type: "image_url", image_url: { url: "https://example.com/x.png" } }],
        },
      ],
    }),
    true
  );
});

test("detects input_image parts in Responses-API input arrays", () => {
  assert.equal(
    requestHasImageContent({
      input: [
        {
          role: "user",
          content: [{ type: "input_image", image_url: "https://example.com/x.png" }],
        },
      ],
    }),
    true
  );
});

test("pure text requests are not flagged", () => {
  assert.equal(
    requestHasImageContent({
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    }),
    false
  );
  assert.equal(
    requestHasImageContent({ messages: [{ role: "user", content: "plain string content" }] }),
    false
  );
});

test("missing or malformed bodies fail closed to false", () => {
  assert.equal(requestHasImageContent(undefined), false);
  assert.equal(requestHasImageContent(null), false);
  assert.equal(requestHasImageContent({}), false);
  assert.equal(requestHasImageContent({ messages: undefined }), false);
  assert.equal(requestHasImageContent({ messages: [] }), false);
});
