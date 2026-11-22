import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { cavemanCompress } from "../../../open-sse/services/compression/caveman.ts";

// Regression: cleanupArtifacts ran AFTER restorePreservedBlocks, so the restored
// fenced block's multi-space indentation was collapsed by `[ \t]{2,} -> " "`,
// validateCompression then rejected the rewrite and the whole textPart silently
// fell back to the original (0% savings) for any message with an indented
// fenced code block. Cleanup must not touch restored blocks.
describe("caveman cleanup ordering", () => {
  it("compresses prose around an indented fenced code block without falling back", () => {
    const code = "function add(a, b) {\n    return a + b;\n}";
    const content = [
      "Please could you help me analyze this code? I would like you to provide a detailed explanation of what it does.",
      "",
      "```js",
      code,
      "```",
      "",
      "Thank you so much for your help!",
    ].join("\n");
    const body = { messages: [{ role: "user", content }] };
    const result = cavemanCompress(body, {
      enabled: true,
      compressRoles: ["user"],
      skipRules: [],
      minMessageLength: 50,
      preservePatterns: [],
    });
    assert.equal(result.compressed, true);
    assert.ok(result.stats?.fallbackApplied !== true, "must not fall back to the original");
    const out = (result.body as { messages: Array<{ content: string }> }).messages[0].content;
    assert.ok(out.includes(code), "fenced code block must survive verbatim");
  });
});
