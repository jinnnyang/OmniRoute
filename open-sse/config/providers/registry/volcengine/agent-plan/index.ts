import type { RegistryEntry, RegistryModel } from "../../../shared.ts";

/**
 * Volcano Ark Agent Plan models.
 *
 * The Agent Plan subscription (console.volcengine.com/ark/subscription/agent-plan)
 * is served by the Plan API endpoint — `/api/plan/v3` — which differs from both the
 * standard pay-per-use API (`/api/v3`) and the Coding Plan API (`/api/coding/v3`).
 * The Plan API has NO `/models` listing endpoint (returns 404); key validation falls
 * back to a chat probe against the first model. Model IDs verified live against
 * /api/plan/v3/chat/completions (2026-09-03 operator-supplied catalog). The Plan
 * API also accepts unversioned family IDs, so the previous date-suffixed IDs
 * (e.g. `doubao-seed-2-0-lite-260215`, `glm-5-2-260617`) were replaced by the
 * current unversioned aliases; retired entries (minimax-m2.7, kimi-k2.6,
 * glm-5-2-260617) were dropped.
 */
export const VOLCENGINE_AGENT_PLAN_MODELS: RegistryModel[] = [
  {
    id: "doubao-seed-2.0-lite",
    name: "Doubao Seed 2.0 Lite (Agent Plan)",
    contextLength: 262144,
    toolCalling: true,
    supportsVision: true,
    supportsReasoning: true,
  },
  {
    id: "doubao-seed-2.0-mini",
    name: "Doubao Seed 2.0 Mini (Agent Plan)",
    contextLength: 262144,
    toolCalling: true,
    supportsVision: true,
    supportsReasoning: true,
  },
  {
    id: "kimi-k2.7-code",
    name: "Kimi K2.7 Code (Agent Plan)",
    contextLength: 1048576,
    toolCalling: true,
    supportsVision: true,
    supportsReasoning: true,
  },
  {
    id: "minimax-m3",
    name: "MiniMax M3 (Agent Plan)",
    contextLength: 1048576,
    toolCalling: true,
    supportsVision: true,
    supportsReasoning: true,
  },
  {
    id: "doubao-seed-evolving",
    name: "Doubao Seed Evolving (Agent Plan)",
    contextLength: 1048576,
    toolCalling: true,
    supportsVision: true,
    supportsReasoning: true,
  },
  {
    id: "kimi-k3",
    name: "Kimi K3 (Agent Plan)",
    contextLength: 1048576,
    toolCalling: true,
    supportsVision: true,
    supportsReasoning: true,
  },
  {
    id: "doubao-seed-2.1-turbo",
    name: "Doubao Seed 2.1 Turbo (Agent Plan)",
    contextLength: 262144,
    toolCalling: true,
    supportsVision: true,
    supportsReasoning: true,
  },
  {
    id: "deepseek-v4-flash",
    name: "DeepSeek V4 Flash (Agent Plan)",
    contextLength: 1048576,
    toolCalling: true,
    supportsReasoning: true,
  },
  {
    id: "glm-5.3",
    name: "GLM 5.3 (Agent Plan)",
    contextLength: 1048576,
    toolCalling: true,
    // Live-verified on the sibling coding-plan endpoint (2026-08-31): upstream
    // rejects images — keep the explicit false so name heuristics never
    // advertise vision for it.
    supportsVision: false,
    supportsReasoning: true,
  },
  {
    id: "deepseek-v4-pro",
    name: "DeepSeek V4 Pro (Agent Plan)",
    contextLength: 1048576,
    toolCalling: true,
    supportsReasoning: true,
  },
  {
    id: "glm-5.3-flash",
    name: "GLM 5.3 Flash (Agent Plan)",
    contextLength: 1048576,
    toolCalling: true,
    supportsVision: true,
    supportsReasoning: true,
  },
];

export const volcengine_agent_planProvider: RegistryEntry = {
  id: "volcengine-agent-plan",
  format: "openai",
  executor: "default",
  baseUrl: "https://ark.cn-beijing.volces.com/api/plan/v3/chat/completions",
  authType: "apikey",
  authHeader: "bearer",
  models: VOLCENGINE_AGENT_PLAN_MODELS,
};
