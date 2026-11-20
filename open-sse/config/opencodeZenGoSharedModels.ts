/**
 * Models declared identically in both the `opencode-zen` and `opencode-go` provider
 * registries (same upstream family, opencode.ai/zen/*). Mirrors the GLM_SHARED_MODELS
 * pattern in glmProvider.ts: one array, spread into each sibling RegistryEntry, so a
 * metadata fix (targetFormat, supportsReasoning, ...) only has to land in one file
 * instead of drifting out of sync across registries.
 *
 * Only entries that are byte-identical across both registries belong here — a model
 * with tier-specific flags (e.g. go's effort variants, or a flag only one tier needs)
 * stays local to that registry's own `models` array.
 */
export const OPENCODE_ZEN_GO_SHARED_MODELS = Object.freeze([] as Array<{ id: string }>);
// 2026-11-20 generation cleanup: the previous entries (kimi-k2.7-code,
// qwen3.5-plus, qwen3.6-plus) targeted retired generations and were removed.
// Keep this array for ids that must stay byte-identical across zen and go;
// tier-specific rows belong to each registry's own models array.
