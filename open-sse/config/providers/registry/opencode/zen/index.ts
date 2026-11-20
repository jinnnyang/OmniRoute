import type { RegistryEntry } from "../../../shared.ts";
import { OPENCODE_ZEN_GO_SHARED_MODELS } from "../../../shared.ts";

export const opencode_zenProvider: RegistryEntry = {
  id: "opencode-zen",
  alias: "opencode-zen",
  format: "openai",
  executor: "opencode",
  baseUrl: "https://opencode.ai/zen/v1",
  modelsUrl: "https://opencode.ai/zen/v1/models",
  authType: "apikey",
  authHeader: "Authorization",
  authPrefix: "Bearer",
  defaultContextLength: 200000,
  // Sync with https://opencode.ai/zen/v1/models — this list is regenerated
  // from the live API response so new models work without a code deploy.
  passthroughModels: true,
  models: [
    // ── Chat / Coding ──────────────────────────────────────────
    // #2900: big-pickle's upstream runs DeepSeek thinking mode — declare the
    // interleaved reasoning_content contract so follow-up/tool-use turns replay
    // it (otherwise DeepSeek returns 400 "reasoning_content ... must be passed back").
    {
      id: "big-pickle",
      name: "Big Pickle",
      supportsReasoning: true,
      interleavedField: "reasoning_content",
    },

    ...OPENCODE_ZEN_GO_SHARED_MODELS,
    // models[0] (big-pickle) is the dashboard default; SHARED spread kept after it.

    { id: "gpt-5.6-sol", name: "GPT 5.6 Sol" },
    { id: "gpt-5.6-terra", name: "GPT 5.6 Terra" },
    { id: "gpt-5.6-luna", name: "GPT 5.6 Luna" },

    // ── Claude ─────────────────────────────────────────────────
    // 2026-11-20 generation cleanup: only Claude 5.5 is kept. The 5.5 wire ids
    // (claude-sonnet-5.5 / claude-opus-5.5 / claude-haiku-5-5) resolve their
    // 1M windows from the shared static specs once the upstream advertises them.
    // ── Gemini ─────────────────────────────────────────────────
    // 2026-11-20: 2.5/3.x retired; Gemini 4 (argon) resolves via shared specs.

    // ── Grok ───────────────────────────────────────────────────
    { id: "grok-build-0.1", name: "Grok Build 0.1" },
    { id: "grok-4.6", name: "Grok 4.6", contextLength: 500000 },

    // ── Muse ───────────────────────────────────────────────────
    // Muse Spark is served by OpenCode Zen only on the OpenAI Responses API
    // endpoint, not /chat/completions (see the opencode provider's own
    // muse-spark entries, #10874/#10867) — this provider is a separate
    // registry entry for the same upstream and never got the same
    // targetFormat declaration, so requests routed here still hit
    // /chat/completions with a mismatched or unanswerable body and the
    // upstream returns an empty message.
    {
      id: "muse-spark-1.2",
      name: "Muse Spark 1.2",
      supportsReasoning: true,
      targetFormat: "openai-responses",
    },
    // Explicit wire-format overlay of the base opencode provider's muse-spark entry
    // (targetFormat: openai-responses). Keep in sync with base on catalog syncs.
    {
      id: "muse-spark-1.2-contributor-free",
      name: "Muse Spark 1.2 Contributor Free",
      supportsReasoning: true,
      targetFormat: "openai-responses",
    },

    // ── DeepSeek ────────────────────────────────────────────────
    // #10788: same tier vocabulary as opencode-go's DeepSeek rows — the Zen
    // upstream accepts the identical effort set on these models.
    {
      id: "deepseek-v4.1-flash",
      name: "DeepSeek V4.1 Flash",
      contextLength: 1000000,
      supportsReasoning: true,
      supportedThinkingEfforts: ["none", "low", "high", "max"],
    },

    // ── GLM / Z.AI ─────────────────────────────────────────────
    {
      id: "glm-5.3",
      name: "GLM-5.3",
      contextLength: 1000000,
      supportsReasoning: true,
      supportedThinkingEfforts: ["high", "max"],
    },
    { id: "glm-5.3-flash", name: "GLM-5.3 Flash", contextLength: 1000000 },

    // ── MiniMax ────────────────────────────────────────────────
    // #3110: MiniMax M3.1 Flash — 1M context (M3 retired 2026-11-20)
    {
      id: "minimax-m3.1-flash",
      name: "MiniMax M3.1 Flash",
      contextLength: 1048576,
      supportsVision: true,
    },

    // ── Kimi / Moonshot ────────────────────────────────────────
    { id: "kimi-k3", name: "Kimi K3", supportsReasoning: true, supportedThinkingEfforts: ["max"] },

    // ── Qwen ───────────────────────────────────────────────────
    // Issue #2292: Qwen models return Claude-format SSE bodies even
    // when hitting /chat/completions. targetFormat: "claude" routes
    // through /messages and the Claude translator.
    // Issue #2822: These models are text-only — supportsVision: false
    // ensures combo routing skips them on image-bearing requests.
    // 2026-11-20: Qwen3.5/3.6/3.7 retired; Qwen3.8 ids are declared on the
    // opencode-go registry and resolve their windows from the shared specs.

    // ── Free Tier ──────────────────────────────────────────────
    // #6998 (2026-07-14): upstream free tier rotated — minimax-m2.5-free,
    // nemotron-3-super-free and qwen3.6-plus-free were delisted (401).
    // 2026-08-17 sync: north-mini-code-free delisted; nemotron-3.5-lightning-free
    // and laguna-s-2.1-free added.
    { id: "hy3-free", name: "HY3 Free", contextLength: 200000 },
    { id: "nemotron-3-ultra-free", name: "Nemotron 3 Ultra Free", contextLength: 1000000 },
    { id: "nemotron-3.5-lightning-free", name: "Nemotron 3.5 Lightning Free" },
    { id: "laguna-s-2.1-free", name: "Laguna S 2.1 Free" },
  ],
};
