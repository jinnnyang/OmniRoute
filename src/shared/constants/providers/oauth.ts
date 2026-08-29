/**
 * OAuth provider catalog — removed in trim-core (D block).
 *
 * The gateway now serves API-key providers only. `OAUTH_PROVIDERS` is kept as
 * an empty object so downstream consumers (dashboard catalog, auth services,
 * OAuth machinery that is itself pending removal) keep compiling during the
 * migration window; the provider definitions that lived here have been deleted.
 * When the OAuth machinery (lib/oauth, api/oauth, auth.ts refresh path) is
 * removed in a follow-up, this file and the `OAUTH_PROVIDERS` export go too.
 */
export const OAUTH_PROVIDERS: Record<string, never> = {};
