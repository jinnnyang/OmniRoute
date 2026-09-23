# OmniRoute Context

OmniRoute is a self-hosted unified AI proxy/router: one OpenAI-compatible endpoint in front of hundreds of LLM providers, with automatic provider fallback, token compression, and model routing. This context covers the routing/fallback domain and the resilience vocabulary the codebase and its debugging docs share.

## Language

### Routing & models

**Provider**: an upstream LLM service that OmniRoute can proxy to (e.g. openai, anthropic, glm, volcengine).
_Avoid_: vendor, upstream, supplier

**Connection**: one credential slot (API key or OAuth session) into a provider, distinct from the provider itself; breakers and cooldowns operate at both levels.
_Avoid_: account, key (when meaning the credential slot)

**Model**: a concrete model identifier exposed through the endpoint, possibly as an alias or a combo target.

**Model alias**: a name that resolves to one or more models.
_Avoid_: model name (when meaning an alias)

**Combo**: routing one request across multiple models/strategies to improve the answer or availability.

**Combo strategy**: one of the named routing algorithms (priority, weighted, round-robin, cost-optimized, fusion, …).
_Avoid_: routing mode, mode

**Auto-Combo**: the strategy that scores providers on 16 factors and picks the best one per request.
_Avoid_: smart routing (marketing term)

**Combo target**: one resolved model within a combo execution.

**Fusion**: the combo strategy that fans out to a panel of models in parallel, then a judge model synthesizes the final answer.

**Fallback**: redirecting a request to another provider/model when the primary path fails.
_Avoid_: failover, auto-switch

### Resilience

**Resilience**: the umbrella term for the three independent temporary-failure mechanisms below; do not conflate them when debugging.

**Provider circuit breaker**: stops traffic to an entire provider after repeated service-level failures; states CLOSED / OPEN / HALF_OPEN.
_Avoid_: breaker (when meaning connection-level)

**Connection cooldown**: pauses a single connection after failures, without affecting other connections of the same provider.

**Rate-limit queue**: bounds the queue depth and per-request wait of requests held under upstream rate limiting (maxWaitMs / maxQueueDepth).

**Lockout**: blocking a provider or connection for credential/usage-class errors (401/403/429), distinct from the circuit breaker.
_Avoid_: ban, block

### Compression

**RTK / Caveman**: the two token-compression engines that shrink request context (15–95% token savings).

### Protocol surfaces

**Translator**: the component that converts request/response formats between provider dialects (OpenAI ↔ Claude ↔ Gemini).
_Avoid_: adapter, converter

**Executor**: the component that performs the provider-specific HTTP dispatch.

**Handler**: the pipeline stage that processes one request type (chat, embeddings, …).

**MCP server**: the Model Context Protocol server exposing tools to clients (scopes, transports).
_Avoid_: MCP (when the topic is the protocol, not this server)

**A2A**: the agent-to-agent JSON-RPC 2.0 server.

**API key**: the credential a client uses to call OmniRoute, distinct from a provider's own credentials.
