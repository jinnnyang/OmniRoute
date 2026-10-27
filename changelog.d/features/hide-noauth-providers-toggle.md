# hideNoauthProviders setting

Opt-in catalog filter that hides all no-auth provider models from `/v1/models`.

No-auth providers (duckduckgo-web, cloudflare-playground, opencode, etc.) are
injected into the catalog unconditionally because they need no DB connection —
but many are unreachable from this deployment's region and produce dead entries
in the model list. When enabled, only providers with an explicit DB connection
appear. Routing still works for hidden ids sent explicitly.
