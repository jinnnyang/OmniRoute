import type { RegistryEntry } from "../../shared.ts";
import { getClaudeCliHeaders, resolvePublicCred } from "../../shared.ts";

export const claudeProvider: RegistryEntry = {
  id: "claude",
  alias: "cc",
  format: "claude",
  executor: "default",
  baseUrl: "https://api.anthropic.com/v1/messages",
  urlSuffix: "?beta=true",
  authType: "oauth",
  authHeader: "x-api-key",
  defaultContextLength: 200000,
  headers: getClaudeCliHeaders(),
  oauth: {
    clientIdEnv: "CLAUDE_OAUTH_CLIENT_ID",
    clientIdDefault: resolvePublicCred("claude_id"),
    tokenUrl: "https://api.anthropic.com/v1/oauth/token",
  },
  models: [
    // 2026-11-20 generation cleanup: only the 5.5 generation is kept.
    {
      id: "claude-opus-5.5",
      name: "Claude Opus 5.5",
      contextLength: 1000000,
      maxOutputTokens: 128000,
      supportsXHighEffort: true,
      // Opus 5.5 rejects non-default temperature/top_p/top_k with a 400 (sampling is
      // fixed; reasoning is steered by output_config.effort). Strip before dispatch.
      unsupportedParams: ["temperature", "top_p", "top_k"],
    },
    {
      id: "claude-sonnet-5.5",
      name: "Claude Sonnet 5.5",
      contextLength: 1000000,
      maxOutputTokens: 128000,
      supportsXHighEffort: true,
      unsupportedParams: ["temperature", "top_p", "top_k"],
    },
    {
      id: "claude-haiku-5.5",
      name: "Claude Haiku 5.5",
      supportsXHighEffort: false,
      contextLength: 1000000,
      maxOutputTokens: 64000,
    },
  ],
};
