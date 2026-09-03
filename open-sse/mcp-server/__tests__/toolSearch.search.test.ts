import { describe, it, expect } from "vitest";
import { searchTools } from "../toolSearch/search.ts";

const E = [
  {
    name: "omniroute_get_health",
    description: "health status uptime memory",
    scopes: ["read:health"],
  },
  {
    name: "omniroute_list_combos",
    description: "list combos and strategies",
    scopes: ["read:combos"],
  },
  {
    name: "omniroute_check_quota",
    description: "remaining quota per provider",
    scopes: ["read:quota"],
  },
];

describe("searchTools", () => {
  it("ranks name+desc hit on top", () => {
    const r = searchTools(E, "health", 8);
    expect(r[0].name).toBe("omniroute_get_health");
  });
  it("no hit ⇒ empty", () => {
    expect(searchTools(E, "zzzzz", 8)).toEqual([]);
  });
  it("respects limit + deterministic tie-break", () => {
    const r = searchTools(E, "omniroute", 2);
    expect(r.length).toBe(2);
    expect(r[0].name < r[1].name).toBe(true); // tie-break alfabético
  });
  it("ReDoS-safe: pathological query does not hang", () => {
    const start = Date.now();
    searchTools(E, "(a+)+".repeat(20), 8);
    expect(Date.now() - start).toBeLessThan(200);
  });
});

// SysOps F1 regression (2026-08-19): a broad query ("web search") over a large
// catalog used to return the entire hit list (146 entries) and the huge tool
// payload made downstream models (doubao) fail with 400 "missing input.content".
// The MIN/MAX limit clamp in searchTools must cap results even when every
// catalog entry matches, regardless of the caller-supplied limit.
describe("searchTools F1 payload cap", () => {
  const big = Array.from({ length: 200 }, (_, i) => ({
    name: `omniroute_web_search_${i}`,
    description: "web search across providers",
    scopes: ["read:search"],
  }));

  it("caps results to MAX_LIMIT when all 200 entries match (huge caller limit)", () => {
    const r = searchTools(big, "web search", 500);
    expect(r.length).toBeLessThanOrEqual(25);
  });

  it("caps results to the default 8 when limit is omitted", () => {
    const r = searchTools(big, "web search", undefined as unknown as number);
    expect(r.length).toBeLessThanOrEqual(8);
  });
});
