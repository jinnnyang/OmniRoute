import type { RegistryEntry, RegistryModel } from "../../../shared.ts";

/**
 * Volcano Ark Coding Plan models.
 *
 * The Coding Plan subscription (console.volcengine.com/ark/subscription/coding-plan)
 * is served by a DEDICATED endpoint — `/api/coding/v3` — which differs from both the
 * standard pay-per-use API (`/api/v3`) and the Agent Plan API (`/api/plan/v3`). Using
 * the wrong base URL returns HTTP 401 "The API key or AK/SK ... is missing or invalid"
 * even with a valid Coding Plan key. Model IDs below verified live against
 * /api/coding/v3/chat/completions (all return 200).
 */
export const VOLCENGINE_CODING_PLAN_MODELS: RegistryModel[] = [
  {
    id: "doubao-seed-2-1-turbo",
    name: "Doubao Seed 2.1 Turbo (Coding Plan)",
    // User-facing dotted spelling resolves to the same static model.
    aliases: ["doubao-seed-2.1-turbo"],
    contextLength: 262144,
    toolCalling: true,
    supportsVision: true,
    supportsReasoning: true,
  },
  {
    id: "doubao-seed-2.0-lite",
    name: "Doubao Seed 2.0 Lite (Coding Plan)",
    contextLength: 262144,
    toolCalling: true,
    supportsVision: true,
    supportsReasoning: true,
  },
  {
    id: "deepseek-v4-flash",
    name: "DeepSeek V4 Flash (Coding Plan)",
    contextLength: 1048576,
    toolCalling: true,
    supportsReasoning: true,
  },
  {
    id: "glm-5.2",
    name: "GLM 5.2 (Coding Plan)",
    contextLength: 1048576,
    toolCalling: true,
    supportsReasoning: true,
  },
  {
    id: "kimi-k2.7-code",
    name: "Kimi K2.7 Code (Coding Plan)",
    contextLength: 1048576,
    toolCalling: true,
    supportsVision: true,
    supportsReasoning: true,
  },
  {
    id: "minimax-m3",
    name: "MiniMax M3 (Coding Plan)",
    contextLength: 1048576,
    toolCalling: true,
    supportsReasoning: true,
    supportsVision: true,
  },
  {
    id: "deepseek-v4-pro",
    name: "DeepSeek V4 Pro (Coding Plan)",
    contextLength: 1048576,
    toolCalling: true,
    supportsReasoning: true,
  },
  {
    id: "minimax-m2.7",
    name: "MiniMax M2.7 (Coding Plan)",
    contextLength: 1048576,
    toolCalling: true,
    supportsReasoning: true,
  },
  {
    // Live-verified 2026-08-31 (chat/completions 200 text-only); explicit
    // supportsVision:false — upstream rejects images (8-30 image request 400
    // "Model only support text input"). The explicit false prevents the
    // glm-4v-style name heuristic from ever advertising vision for it.
    id: "glm-5.3",
    name: "GLM 5.3 (Coding Plan)",
    contextLength: 1048576,
    toolCalling: true,
    supportsReasoning: true,
    supportsVision: false,
  },
  {
    id: "glm-5.3-flash",
    name: "GLM 5.3 Flash (Coding Plan)",
    contextLength: 1048576,
    toolCalling: true,
    supportsReasoning: true,
    supportsVision: true,
  },
  {
    id: "doubao-seed-evolving",
    name: "Doubao Seed Evolving (Coding Plan)",
    contextLength: 262144,
    toolCalling: true,
    supportsReasoning: true,
    supportsVision: true,
  },
  {
    id: "kimi-k2.6",
    name: "Kimi K2.6 (Coding Plan)",
    contextLength: 1048576,
    toolCalling: true,
    supportsReasoning: true,
  },
];

export const volcengine_coding_planProvider: RegistryEntry = {
  id: "volcengine-coding-plan",
  alias: "vecp",
  format: "openai",
  executor: "default",
  baseUrl: "https://ark.cn-beijing.volces.com/api/coding/v3/chat/completions",
  // #volcengine-coding-plan-builtin: the same coding endpoint also serves the
  // native Responses API (both protocols live-verified 200 on 2026-08-31).
  // buildUrl("volcengine-coding-plan") switches here when
  // resolveExecutionCredentials flags the model with
  // _omnirouteForceResponsesUpstream (registry marks AND #2905 DB overrides).
  responsesBaseUrl: "https://ark.cn-beijing.volces.com/api/coding/v3/responses",
  authType: "apikey",
  authHeader: "bearer",
  models: VOLCENGINE_CODING_PLAN_MODELS,
  modelsUrl: "/models",
  // GET /models returns a noisy shutdown-era catalog (stale version ids,
  // missing glm-5.3 / kimi-k2.7-code / minimax-m3). Never let it veto the
  // curated static ids below.
  liveCatalogAuthoritative: false,
};
