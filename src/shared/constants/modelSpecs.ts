/**
 * Centralized specifications for AI Models.
 * Contains maximum token caps and thinking budgets to prevent API errors
 * when clients request more than the model supports.
 */

export interface ModelSpec {
  maxOutputTokens?: number;
  contextWindow?: number;
  defaultThinkingBudget?: number;
  thinkingBudgetCap?: number;
  thinkingOverhead?: number; // buffer de tokens para thinking
  adaptiveMaxTokens?: number; // tokens disponíveis para output quando thinking ativo
  aliases?: string[]; // IDs alternativos para este modelo
  supportsThinking?: boolean;
  supportsTools?: boolean;
  supportsVision?: boolean;
  supportsAudio?: boolean;
  supportsVideo?: boolean;
  // Model defaults to adaptive thinking and REJECTS an explicit `thinking.type:"disabled"`
  // (upstream returns 400). Used to normalize the request when a combo/route substitutes
  // this model after the client already chose `disabled`. See issue #3554.
  rejectsThinkingDisabled?: boolean;
  // Model ONLY supports adaptive thinking: manual extended thinking was removed. Sending
  // `thinking.type:"enabled"` or any `thinking.budget_tokens` returns HTTP 400; reasoning
  // is steered exclusively by `output_config.effort` (low/medium/high/xhigh/max). True for
  // Claude Opus 4.7 and later (Opus 4.7/4.8/5, Fable 5). Per Anthropic's migration guide,
  // any request that tries to set a fixed thinking budget gets a 400 error.
  adaptiveThinkingOnly?: boolean;
  // Highest effort accepted while `thinking.type:"disabled"` is present. Claude Opus 5
  // rejects disabled thinking with xhigh/max, while accepting it through high.
  maxEffortWhenThinkingDisabled?: "high";
  // Explicit operator override for the no-thinking gateway alias (Fase 8.1). When unset,
  // the catalog auto-advertises a `no-think/…` variant for
  // Claude-family thinking-capable models that honor `disabled`. Set `true` to force the
  // variant on for any other model, or `false` to suppress it. See open-sse/utils/noThinkingAlias.ts.
  noThinkingAlias?: boolean;
  // Per-model default reasoning effort (#6879). When the incoming request carries no
  // `reasoning_effort` / `reasoning` / `thinking` field of any shape, the resolved
  // upstream model's `defaultReasoningEffort` is injected as `reasoning_effort` on the
  // OpenAI-format dispatch path before the request leaves the gateway. An explicit
  // client value — including one forwarded verbatim through a combo leg — always wins;
  // this is a no-op for it. Unset preserves current behavior (no injection). Lets an
  // operator strip-by-default a thinks-by-default model (measured: gemini-flash-lite
  // burns ~277 reasoning tokens on a plain request; `reasoning_effort:"none"` → 0)
  // without patching every client. See open-sse/services/defaultReasoningEffort.ts.
  defaultReasoningEffort?: "none" | "low" | "medium" | "high";
}

const BEDROCK_CLAUDE_ALIASES = (...modelIds: string[]) => [
  ...new Set(
    modelIds.flatMap((modelId) => [
      modelId,
      `anthropic.${modelId}`,
      `eu.anthropic.${modelId}`,
      `us.anthropic.${modelId}`,
      `global.anthropic.${modelId}`,
      `bedrock/anthropic.${modelId}`,
      `bedrock/eu.anthropic.${modelId}`,
      `bedrock/us.anthropic.${modelId}`,
      `bedrock/global.anthropic.${modelId}`,
    ])
  ),
];

// GLM-5.3 IDs: discovery/sync sources can under-report them (200K/128K). The
// native window is 1M, so pin it here; everything else declares its own.
const AUTHORITATIVE_CONTEXT_WINDOW_MODEL_IDS = new Set([
  "glm-5.3",
  "glm-5.3-high",
  "glm-5.3-low",
  "glm-5.3-max",
  "glm-5.3-flash",
]);
// Empty on purpose: every previous entry targeted the retired GLM-5.2
// generation. Providers that still serve GLM-5.2 keep their registry windows.
const AUTHORITATIVE_PROVIDER_CONTEXT_WINDOWS = new Map<string, number>();

const GPT_5_6_MODEL_SPEC = {
  maxOutputTokens: 128000,
  contextWindow: 1050000,
  // Reserve 32K for visible response: thinking + response must both fit
  // under maxOutputTokens. A cap equal to maxOutputTokens leaves zero room
  // for the actual response when thinking consumes the full budget.
  thinkingBudgetCap: 96000,
  supportsThinking: true,
  supportsTools: true,
  supportsVision: true,
} satisfies ModelSpec;

export const MODEL_SPECS: Record<string, ModelSpec> = {
  "gpt-5.6": {
    ...GPT_5_6_MODEL_SPEC,
    aliases: ["openai/gpt-5.6"],
  },
  "gpt-5.6-sol": {
    ...GPT_5_6_MODEL_SPEC,
    aliases: ["openai/gpt-5.6-sol"],
  },
  "gpt-5.6-terra": {
    ...GPT_5_6_MODEL_SPEC,
    aliases: ["openai/gpt-5.6-terra"],
  },
  "gpt-5.6-luna": {
    ...GPT_5_6_MODEL_SPEC,
    aliases: ["openai/gpt-5.6-luna"],
  },

  // ── Gemini 4 Argon (1M context) ──────────────────────────────────
  "gemini-4-argon": {
    maxOutputTokens: 65536,
    contextWindow: 1048576,
    supportsThinking: true,
    supportsTools: true,
    supportsVision: true,
  },

  // ── Claude 5.5 family (1M context, 128K max output) ─────────────
  // Generation cleanup (2026-11-20): only the 5.5 generation is kept.
  "claude-sonnet-5.5": {
    maxOutputTokens: 128000,
    contextWindow: 1000000,
    defaultThinkingBudget: 32000,
    thinkingBudgetCap: 120000,
    supportsThinking: true,
    supportsTools: true,
    supportsVision: true,
    adaptiveThinkingOnly: true,
    aliases: BEDROCK_CLAUDE_ALIASES("claude-sonnet-5.5", "claude-sonnet-5-5"),
  },
  "claude-opus-5.5": {
    maxOutputTokens: 128000,
    contextWindow: 1000000,
    defaultThinkingBudget: 32000,
    thinkingBudgetCap: 120000,
    supportsThinking: true,
    supportsTools: true,
    supportsVision: true,
    adaptiveThinkingOnly: true,
    maxEffortWhenThinkingDisabled: "high",
    aliases: BEDROCK_CLAUDE_ALIASES("claude-opus-5.5", "claude-opus-5-5"),
  },
  "claude-haiku-5.5": {
    // OpenCode Go exposes the dashed wire id `claude-haiku-5-5`; BAI uses the
    // dotted `claude-haiku-5.5`. Both land on this single spec.
    maxOutputTokens: 64000,
    contextWindow: 1000000,
    defaultThinkingBudget: 10000,
    thinkingBudgetCap: 62000,
    supportsThinking: true,
    supportsTools: true,
    supportsVision: true,
    aliases: BEDROCK_CLAUDE_ALIASES("claude-haiku-5.5", "claude-haiku-5-5"),
  },

  // ── Kimi K3 (Moonshot API — 1M context/output, native vision) ────
  // `k3` is the Kimi Coding / kimi-coding-apikey wire id (#8250).
  "kimi-k3": {
    maxOutputTokens: 1048576,
    contextWindow: 1048576,
    thinkingBudgetCap: 32768,
    supportsThinking: true,
    supportsTools: true,
    supportsVision: true,
    aliases: ["k3"],
  },

  // ── Qwen3.8 Max (Bailian — multimodal, 1M context) ───────────────
  // §5b: preview ids merge into the standard name (no standalone preview combo).
  "qwen3.8-max": {
    maxOutputTokens: 65536,
    contextWindow: 1000000,
    thinkingBudgetCap: 38912,
    supportsThinking: true,
    supportsTools: true,
    supportsVision: true,
    aliases: ["qwen3.8-max-preview"],
  },

  // ── Xiaomi MiMo V2.6 (native multimodal, per vendor docs) ──
  // Both mimo-v2.6-pro and mimo-v2.6-flash are native multimodal (accept
  // image and video input) per Xiaomi's official docs — unlike the V2.5
  // *-pro chat models which are text-only. Synced catalogs did not carry a
  // vision marker, so without this entry the Vision Bridge treated them as
  // text-only and rerouted image requests to a (possibly stale) vision model.
  "mimo-v2.6-pro": {
    maxOutputTokens: 131072,
    contextWindow: 1048576,
    supportsTools: true,
    supportsVision: true,
  },
  "mimo-v2.6-flash": {
    maxOutputTokens: 131072,
    contextWindow: 1048576,
    supportsTools: true,
    supportsVision: true,
  },

  // ── Z.AI GLM-5.3 (1M context mirrored from 5.2 — same base model; 128K max
  // output; effort via reasoning_effort param, tiers are OmniRoute aliases) ──
  "glm-5.3": {
    maxOutputTokens: 131072,
    contextWindow: 1000000,
    thinkingBudgetCap: 38912,
    supportsThinking: true,
    supportsTools: true,
  },
  "glm-5.3-high": {
    maxOutputTokens: 131072,
    contextWindow: 1000000,
    thinkingBudgetCap: 38912,
    supportsThinking: true,
    supportsTools: true,
  },
  "glm-5.3-low": {
    maxOutputTokens: 131072,
    contextWindow: 1000000,
    thinkingBudgetCap: 38912,
    supportsThinking: true,
    supportsTools: true,
  },
  "glm-5.3-max": {
    maxOutputTokens: 131072,
    contextWindow: 1000000,
    thinkingBudgetCap: 38912,
    supportsThinking: true,
    supportsTools: true,
  },
  "glm-5.3-flash": {
    maxOutputTokens: 131072,
    contextWindow: 1000000,
    thinkingBudgetCap: 38912,
    supportsThinking: true,
    supportsTools: true,
    aliases: ["glm-5-3-flash-260828"],
  },

  // ── MiniMax M3.1 Flash (1M context) ─────────────────────────────
  "minimax-m3.1-flash": {
    maxOutputTokens: 512000,
    contextWindow: 1048576,
    thinkingBudgetCap: 32768,
    supportsThinking: true,
    supportsTools: true,
  },

  // ── DeepSeek V4.1 Flash (1M context, 384K max output) ────────────
  "deepseek-v4.1-flash": {
    maxOutputTokens: 384000,
    contextWindow: 1000000,
    thinkingBudgetCap: 380000,
    supportsThinking: true,
    supportsTools: true,
    aliases: [
      "deepseek-v4-1-flash",
      "deepseek-v4-1-flash-260910",
      "deepseek-v4-1-flash-261017",
      "deepseek-v4-1-flash-economy-261017",
      "deepseek-v4.1-flash-economy",
    ],
  },

  // ── Doubao Seed 2.1 family (262K context) ───────────────────────
  // One spec per tier; every date-suffixed wire id is an alias so the dated
  // plan ids (…-260915 / …-260628) resolve the same window provider-agnostically.
  "doubao-seed-2.1-turbo": {
    contextWindow: 262144,
    supportsThinking: true,
    supportsTools: true,
    supportsVision: true,
    aliases: ["doubao-seed-2-1-turbo", "doubao-seed-2-1-turbo-260628"],
  },
  "doubao-seed-2.1-lite": {
    contextWindow: 262144,
    supportsThinking: true,
    supportsTools: true,
    supportsVision: true,
    aliases: ["doubao-seed-2-1-lite", "doubao-seed-2-1-lite-260915"],
  },
  "doubao-seed-2.1-pro": {
    contextWindow: 262144,
    supportsThinking: true,
    supportsTools: true,
    supportsVision: true,
    aliases: ["doubao-seed-2-1-pro", "doubao-seed-2-1-pro-260915"],
  },
  // ── Tencent Hunyuan 3 Preview ────────────────────────────────────
  "hy3-preview": {
    maxOutputTokens: 262144,
    contextWindow: 262144,
    thinkingBudgetCap: 32768,
    supportsThinking: true,
    supportsTools: true,
  },
  // ── xAI Grok 4.6 (500K context, operator-confirmed 2026-11-20) ───
  "grok-4.6": {
    contextWindow: 500000,
    supportsThinking: true,
    supportsTools: true,
    supportsVision: true,
  },

  // Defaults
  __default__: {},
};

// #8697-adjacent: getCanonicalModelSpecId() re-scanned Object.keys/entries(MODEL_SPECS)
// up to 3 times per call (exact ci, alias ci, prefix) — the top hotspot in a full
// catalog-rebuild profile once the pricing-path bottlenecks were fixed. MODEL_SPECS is
// a static module constant (never mutated at runtime), so the lowercase index below is
// built once, lazily, on first use and never invalidated. Iteration order for the
// prefix-match candidates is preserved exactly (same Object.keys() insertion order) so
// resolution outcomes for ambiguous prefixes are unchanged.
let modelSpecIndex: {
  exactCi: Map<string, string>;
  aliasCi: Map<string, string>;
  aliasExact: Map<string, string>;
  prefixCandidates: Array<[lowerKey: string, canonical: string]>;
} | null = null;

function getModelSpecIndex() {
  if (modelSpecIndex) return modelSpecIndex;
  const exactCi = new Map<string, string>();
  const aliasCi = new Map<string, string>();
  const aliasExact = new Map<string, string>();
  const prefixCandidates: Array<[string, string]> = [];
  for (const [canonical, spec] of Object.entries(MODEL_SPECS)) {
    const lowerCanonical = canonical.toLowerCase();
    if (!exactCi.has(lowerCanonical)) exactCi.set(lowerCanonical, canonical);
    for (const alias of spec.aliases || []) {
      const lowerAlias = alias.toLowerCase();
      if (!aliasCi.has(lowerAlias)) aliasCi.set(lowerAlias, canonical);
      if (!aliasExact.has(alias)) aliasExact.set(alias, canonical);
    }
    if (canonical !== "__default__") prefixCandidates.push([lowerCanonical, canonical]);
  }
  modelSpecIndex = { exactCi, aliasCi, aliasExact, prefixCandidates };
  return modelSpecIndex;
}

/**
 * Exact + alias case-insensitive lookup only (no prefix phase) — shared by
 * modelCapabilities.ts's getStaticSpecCanonicalModelId(), which tries multiple id
 * candidates and never wanted prefix matching. Reuses the same lazy index as
 * getCanonicalModelSpecId() below instead of each caller maintaining its own cache
 * over the same static MODEL_SPECS table.
 *
 * Contract: returns `null` for `__default__` (never a real canonical id), for an
 * unrecognized `modelId`, or for an empty string. Matching is case-insensitive on
 * both the canonical id and its aliases; there is no prefix-matching phase (unlike
 * getCanonicalModelSpecId() below) — callers that need prefix matching should use
 * that function instead.
 */
export function findModelSpecIdByExactOrAlias(modelId: string): string | null {
  const lower = modelId.toLowerCase();
  const index = getModelSpecIndex();
  const exactHit = index.exactCi.get(lower);
  if (exactHit && exactHit !== "__default__") return exactHit;
  const aliasHit = index.aliasCi.get(lower);
  if (aliasHit && aliasHit !== "__default__") return aliasHit;
  return null;
}

export function getCanonicalModelSpecId(modelId: string): string | null {
  if (MODEL_SPECS[modelId]) return modelId;

  // Case-insensitive lookups: upstream model ids are often capitalized
  // (e.g. "MiniMax-M2.7") while specs/aliases use lowercase ids (#3141).
  const lower = modelId.toLowerCase();
  const index = getModelSpecIndex();

  // Exact match (case-insensitive)
  const exactHit = index.exactCi.get(lower);
  if (exactHit) return exactHit;

  // Buscas por alias (case-insensitive)
  const aliasHit = index.aliasCi.get(lower);
  if (aliasHit) return aliasHit;

  // Prefix matching (case-insensitive) — same insertion-order iteration as before,
  // first match wins.
  for (const [lowerKey, canonical] of index.prefixCandidates) {
    if (lower.startsWith(lowerKey)) return canonical;
  }

  return null;
}

export function getModelSpec(modelId: string): ModelSpec | undefined {
  const canonical = getCanonicalModelSpecId(modelId);
  return canonical ? MODEL_SPECS[canonical] : undefined;
}

export function getAuthoritativeContextWindow(modelId: string | null | undefined): number | null {
  if (typeof modelId !== "string" || modelId.length === 0) return null;
  const normalized = modelId.toLowerCase();
  for (const canonical of AUTHORITATIVE_CONTEXT_WINDOW_MODEL_IDS) {
    if (canonical.toLowerCase() === normalized)
      return MODEL_SPECS[canonical]?.contextWindow ?? null;
  }
  return null;
}

export function getAuthoritativeProviderContextWindow(
  provider: string | null | undefined,
  modelId: string | null | undefined
): number | null {
  if (typeof provider !== "string" || typeof modelId !== "string") return null;
  const key = `${provider}/${modelId}`.toLowerCase();
  return AUTHORITATIVE_PROVIDER_CONTEXT_WINDOWS.get(key) ?? null;
}

/**
 * Normalize a request's `thinking` field against the (possibly combo-substituted) target model.
 *
 * A combo/route can swap the upstream model AFTER the client already chose its `thinking`
 * value. Claude Code sends `thinking:{type:"disabled"}` for internal title/name-generation
 * calls — valid for opus/sonnet, but claude-fable-5 defaults to adaptive thinking and rejects
 * `type:"disabled"` with an upstream 400. When the resolved target model is flagged
 * `rejectsThinkingDisabled`, drop the now-invalid `thinking` so the model uses its adaptive
 * default instead of hard-failing. Models that accept `disabled` are left untouched, and any
 * non-`disabled` thinking (enabled/adaptive) is always preserved. See issue #3554.
 */
export function normalizeThinkingForModel<T extends Record<string, unknown>>(
  body: T,
  modelId: string
): T {
  const thinking = body?.thinking as Record<string, unknown> | undefined;
  if (
    thinking &&
    typeof thinking === "object" &&
    thinking.type === "disabled" &&
    getModelSpec(modelId)?.rejectsThinkingDisabled
  ) {
    const { thinking: _omitted, ...rest } = body as Record<string, unknown>;
    return rest as T;
  }
  return body;
}

export function capMaxOutputTokens(modelId: string, requested?: number): number | undefined {
  const spec = getModelSpec(modelId);
  const cap = spec?.maxOutputTokens;
  const hasRequested = typeof requested === "number" && Number.isFinite(requested);
  if (typeof cap !== "number") return hasRequested ? requested : undefined;
  return hasRequested ? Math.min(requested, cap) : cap;
}

export function getDefaultThinkingBudget(modelId: string): number {
  return getModelSpec(modelId)?.defaultThinkingBudget ?? 0;
}

/**
 * True when the resolved model only supports adaptive thinking and rejects manual
 * extended thinking. For these models (Claude Opus 4.7+/Fable 5) a `thinking.type:"enabled"`
 * or any `thinking.budget_tokens` is a hard 400 — reasoning must be steered via
 * `output_config.effort`. Used by the request flow to collapse manual thinking to
 * `{type:"adaptive"}` before dispatch. Matches dated/Bedrock aliases via getModelSpec.
 */
export function isAdaptiveThinkingOnly(modelId: string | null | undefined): boolean {
  if (typeof modelId !== "string" || modelId.length === 0) return false;
  return getModelSpec(modelId)?.adaptiveThinkingOnly === true;
}

export function getMaxEffortWhenThinkingDisabled(
  modelId: string | null | undefined
): "high" | null {
  if (typeof modelId !== "string" || modelId.length === 0) return null;
  return getModelSpec(modelId)?.maxEffortWhenThinkingDisabled ?? null;
}

export function capThinkingBudget(modelId: string, budget: number): number {
  const cap = getModelSpec(modelId)?.thinkingBudgetCap ?? budget;
  return Math.min(budget, cap);
}

// #8697-adjacent: rescanned Object.entries(MODEL_SPECS) on every call, unconditionally
// once per model in a catalog rebuild — verified 1:1 call ratio (no early
// short-circuit). Case-sensitive exact match (Array.includes(), no .toLowerCase()) —
// deliberately NOT reusing the case-insensitive aliasCi index above, which would
// silently broaden matches and change behavior.
export function resolveModelAlias(modelId: string): string {
  const hit = getModelSpecIndex().aliasExact.get(modelId);
  return hit ?? modelId;
}
