import type { RegistryEntry } from "../../../shared.ts";
import { OPENCODE_ZEN_GO_SHARED_MODELS } from "../../../shared.ts";

export const opencode_goProvider: RegistryEntry = {
  id: "opencode-go",
  alias: "opencode-go",
  format: "openai",
  executor: "opencode",
  baseUrl: "https://opencode.ai/zen/go/v1",
  // (#532) Key validation must hit the main zen endpoint (same key works for both tiers)
  testKeyBaseUrl: "https://opencode.ai/zen/v1",
  authType: "apikey",
  authHeader: "Authorization",
  authPrefix: "Bearer",
  defaultContextLength: 200000,
  models: [
    // 2026-11-20 generation cleanup: only the current generation is kept
    // (GLM-5.3 / Kimi K3 / DeepSeek V4.1 / Claude 5.5 / MiniMax M3.1 / Qwen3.8).
    // GLM-5.3 — base model + effort-tier aliases (#6922).
    // #10788: the tier vocabulary is declared on the base row so the catalog's
    // variant synthesis (#9485) and the effort sanitizer share one source of
    // truth with OpencodeExecutor's EFFORT_TIERS.
    {
      id: "glm-5.3",
      name: "GLM-5.3",
      contextLength: 1000000,
      supportsReasoning: true,
      supportedThinkingEfforts: ["high", "max"],
    },
    {
      id: "glm-5.3-flash",
      name: "GLM-5.3 Flash",
      contextLength: 1000000,
      supportsReasoning: true,
      supportsVision: true,
    },

    ...OPENCODE_ZEN_GO_SHARED_MODELS,
    // models[0] (glm-5.3) is the dashboard default (LlmChatCard/ProviderTestSlideOver take models[0]).

    // #8353: Kimi K3 base + max-effort alias from the OpenCode Go registry.
    { id: "kimi-k3", name: "Kimi K3", supportsReasoning: true, supportedThinkingEfforts: ["max"] },
    { id: "kimi-k3-max", name: "Kimi K3 (max effort)", supportsReasoning: true },
    // MiMo V2.6 is the kept MiMo generation (V2.5 rows retired 2026-11-20).
    { id: "mimo-v2.6-flash", name: "MiMo V2.6 Flash", contextLength: 1048576 },
    { id: "mimo-v2.6-pro", name: "MiMo V2.6 Pro", contextLength: 1048576 },
    // #3110: MiniMax M3.1 Flash via OpenCode Go tier (M3 retired 2026-11-20)
    {
      id: "minimax-m3.1-flash",
      name: "MiniMax M3.1 Flash",
      targetFormat: "claude",
      contextLength: 1048576,
      supportsVision: true,
    },
    // Issue #2292: Qwen models on opencode-go reject oa-compat format
    // ("Model qwen3.x-* is not supported for format oa-compat") — same
    // upstream behavior already declared for opencode-zen. Route them
    // through /messages with the Claude translator.
    // Issue #2822: These models are text-only — mark supportsVision: false
    // so combo routing skips them when the request contains image blocks,
    // preventing image content from reaching a vision-incapable upstream.
    // 2026-11-20 generation cleanup: Qwen3.8 only (3.5/3.6/3.7 retired).
    {
      id: "qwen3.8-max",
      name: "Qwen3.8 Max",
      targetFormat: "claude",
      contextLength: 1000000,
      supportsVision: false,
      supportsReasoning: true,
      supportedThinkingEfforts: ["high", "max"],
    },
    {
      id: "qwen3.8-flash",
      name: "Qwen3.8 Flash",
      targetFormat: "claude",
      contextLength: 1000000,
      supportsVision: false,
      supportsReasoning: true,
    },
    // #8353: hy3 is the Go-tier base id (distinct from hy3-preview / hy3-free).
    {
      id: "hy3",
      name: "Hunyuan3",
      contextLength: 256000,
      supportsReasoning: true,
      supportedThinkingEfforts: ["none", "low", "high"],
    },
    {
      id: "hy3-none",
      name: "Hunyuan3 (none effort)",
      contextLength: 256000,
      supportsReasoning: true,
    },
    {
      id: "hy3-low",
      name: "Hunyuan3 (low effort)",
      contextLength: 256000,
      supportsReasoning: true,
    },
    {
      id: "hy3-high",
      name: "Hunyuan3 (high effort)",
      contextLength: 256000,
      supportsReasoning: true,
    },
    { id: "hy3-preview", name: "Hunyuan3 Preview" },
    // Muse Spark 1.2 Contributor — base + effort-tier aliases from the OpenCode Go
    // registry (`opencode models opencode-go --verbose`; exact suffix set:
    // minimal/low/medium/high/xhigh, no max).
    {
      id: "muse-spark-1.2-contributor",
      name: "Muse Spark 1.2 Contributor",
      contextLength: 1048576,
      maxOutputTokens: 131072,
      supportsReasoning: true,
      supportsVision: true,
      supportsAudio: true,
      supportsVideo: true,
      targetFormat: "openai-responses",
    },
    {
      id: "muse-spark-1.2-contributor-minimal",
      name: "Muse Spark 1.2 Contributor (minimal effort)",
      contextLength: 1048576,
      maxOutputTokens: 131072,
      supportsReasoning: true,
      supportsVision: true,
      supportsAudio: true,
      supportsVideo: true,
      targetFormat: "openai-responses",
    },
    {
      id: "muse-spark-1.2-contributor-low",
      name: "Muse Spark 1.2 Contributor (low effort)",
      contextLength: 1048576,
      maxOutputTokens: 131072,
      supportsReasoning: true,
      supportsVision: true,
      supportsAudio: true,
      supportsVideo: true,
      targetFormat: "openai-responses",
    },
    {
      id: "muse-spark-1.2-contributor-medium",
      name: "Muse Spark 1.2 Contributor (medium effort)",
      contextLength: 1048576,
      maxOutputTokens: 131072,
      supportsReasoning: true,
      supportsVision: true,
      supportsAudio: true,
      supportsVideo: true,
      targetFormat: "openai-responses",
    },
    {
      id: "muse-spark-1.2-contributor-high",
      name: "Muse Spark 1.2 Contributor (high effort)",
      contextLength: 1048576,
      maxOutputTokens: 131072,
      supportsReasoning: true,
      supportsVision: true,
      supportsAudio: true,
      supportsVideo: true,
      targetFormat: "openai-responses",
    },
    {
      id: "muse-spark-1.2-contributor-xhigh",
      name: "Muse Spark 1.2 Contributor (xhigh effort)",
      contextLength: 1048576,
      maxOutputTokens: 131072,
      supportsReasoning: true,
      supportsVision: true,
      supportsAudio: true,
      supportsVideo: true,
      targetFormat: "openai-responses",
    },
    // 2026-11-20: Grok 4.6 is the current tier (4.5 retired). 500K context.
    {
      id: "grok-4.6",
      name: "Grok 4.6",
      contextLength: 500000,
      supportsReasoning: true,
      supportedThinkingEfforts: ["low", "medium", "high"],
    },
    {
      id: "deepseek-v4.1-flash",
      name: "DeepSeek V4.1 Flash",
      contextLength: 1000000,
      supportsReasoning: true,
      supportedThinkingEfforts: ["none", "low", "high", "max"],
      targetFormat: "openai-responses",
    },
    // Claude 5.5 (the only Claude generation kept, 2026-11-20): the Go tier
    // serves the dashed wire id; the shared spec covers the dotted spelling.
    {
      id: "claude-haiku-5-5",
      name: "Claude Haiku 5.5",
      contextLength: 1000000,
      maxOutputTokens: 64000,
      supportsReasoning: true,
      supportsVision: true,
    },
    // Console Go free GLM-tier model (live-verified 2026-08-23): the upstream
    // rejects every reasoning_effort outside {low, high, max} whenever tools
    // are present — "[1210] This model always engages in thinking and cannot
    // be disabled; please use low, high, or max" — which broke clients that
    // default to reasoning_effort:"medium" (Hermes). Declaring the exact
    // vocabulary lets sanitizeReasoningEffortForProvider clamp off-vocabulary
    // requests to the nearest accepted tier instead of burning a 400.
    {
      id: "ox-alpha-free",
      name: "ox-alpha (free)",
      supportsReasoning: true,
      supportedThinkingEfforts: ["low", "high", "max"],
    },
  ],
};
