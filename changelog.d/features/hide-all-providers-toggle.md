# hideAllProviders setting

Opt-in catalog filter that hides ALL upstream provider models from `/v1/models`.

Only combos (user-defined + built-in `auto/*`) are exposed. Routing still works
for hidden ids sent explicitly. Useful when the operator wants to present only
curated combo endpoints to end users, without exposing the full upstream model
catalog.
