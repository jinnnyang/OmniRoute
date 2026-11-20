import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { applyContextRequirements } from "../../../open-sse/services/combo/contextRequirements";
import type { ResolvedComboTarget } from "../../../open-sse/services/combo/types";

// Mock logger
const mockLog = {
  info: () => {},
  debug: () => {},
  warn: () => {},
  error: () => {},
};

describe("Context Requirements Integration", () => {
  it("should filter and sort targets with full context requirements", () => {
    // Mix a catalog-known model (gpt-5.6 ~128k) with unknowns so strict mode has
    // at least one known-good survivor and does not fail-open to the unknowns.
    const targets = [
      { modelStr: "gpt-5.6", provider: "openai", weight: 1 },
      { modelStr: "unknown-small-8786", provider: "custom", weight: 1 },
      { modelStr: "another-unknown-8786", provider: "custom", weight: 1 },
    ];

    const requirements = {
      minContextWindow: 32000,
      preferLargeContext: true,
      contextFilterMode: "strict" as const,
    };

    const result = applyContextRequirements(targets, requirements, mockLog);
    assert.ok(result.length < targets.length);
    assert.ok(
      result.every((target) => targets.some((original) => original.modelStr === target.modelStr)),
      "Filtered targets should be a subset of the original list"
    );
    assert.ok(
      result.some((t) => t.modelStr === "gpt-5.6"),
      "Known-good gpt-5.6 should survive minContextWindow=32k"
    );
    assert.ok(
      !result.some((t) => t.modelStr.includes("unknown")),
      "Unknowns stay excluded when a known-good target remains"
    );
  });

  it("should not filter when no requirements specified", () => {
    const targets = [
      { modelStr: "gpt-3.5-turbo", provider: "openai", weight: 1 },
      { modelStr: "gpt-4", provider: "openai", weight: 1 },
    ];

    const result = applyContextRequirements(targets, undefined, mockLog);
    assert.equal(result.length, targets.length);
    assert.equal(result, targets); // Same reference
  });

  it("should handle empty targets array", () => {
    const targets: ResolvedComboTarget[] = [];
    const requirements = {
      minContextWindow: 32000,
      preferLargeContext: true,
    };

    const result = applyContextRequirements(targets, requirements, mockLog);
    assert.equal(result.length, 0);
  });

  it("should filter targets above maxContextWindow in strict mode", () => {
    const targets = [
      { modelStr: "doubao-seed-2.1-lite", provider: "volcengine-coding", weight: 1 }, // 262k
      { modelStr: "doubao-seed-2.1-pro", provider: "volcengine-agent", weight: 1 }, // 262k
      { modelStr: "glm-5.3", provider: "opencode-go", weight: 1 }, // 1000k (1M)
      { modelStr: "claude-sonnet-5.5", provider: "claude", weight: 1 }, // 1000k (1M)
    ];

    const requirements = {
      maxContextWindow: 500000,
      contextFilterMode: "strict" as const,
    };

    const result = applyContextRequirements(targets, requirements, mockLog);
    assert.equal(result.length, 2);
    assert.ok(
      result.every(
        (target) =>
          target.modelStr === "doubao-seed-2.1-lite" || target.modelStr === "doubao-seed-2.1-pro"
      ),
      "Should only include targets with context window <= 500000"
    );
  });

  it("should handle lenient mode with unknown context models", () => {
    const targets = [
      { modelStr: "gpt-5.6", provider: "openai", weight: 1 },
      { modelStr: "unknown-model", provider: "custom", weight: 1 },
    ];

    const requirements = {
      minContextWindow: 32000,
      contextFilterMode: "lenient" as const,
    };

    const result = applyContextRequirements(targets, requirements, mockLog);

    // Should include unknown-model in lenient mode
    assert.ok(
      result.some((t) => t.modelStr === "unknown-model"),
      "Should include unknown model in lenient mode"
    );
  });

  it("should handle strict mode with unknown context models", () => {
    // Known-good survivor required — otherwise #8786 fail-open would restore unknowns.
    const targets = [
      { modelStr: "gpt-5.6", provider: "openai", weight: 1 },
      { modelStr: "unknown-model", provider: "custom", weight: 1 },
    ];

    const requirements = {
      minContextWindow: 32000,
      contextFilterMode: "strict" as const,
    };

    const result = applyContextRequirements(targets, requirements, mockLog);

    assert.ok(
      !result.some((t) => t.modelStr === "unknown-model"),
      "Should exclude unknown model in strict mode when a known-good target remains"
    );
    assert.ok(result.some((t) => t.modelStr === "gpt-5.6"));
  });
});
