-- 164_rename_volcengine_plan_providers.sql
-- Rename the Volcano Ark plan provider ids: volcengine-agent-plan -> volcengine-agent,
-- volcengine-coding-plan -> volcengine-coding (dashboard/providers URLs shorten too).
-- Mirrors the 151_windsurf_to_devin_desktop.sql rename pattern. Historical request,
-- usage, and call-log records are intentionally preserved under the provider
-- identity that existed when they were written.

UPDATE provider_connections
SET provider = 'volcengine-agent',
    default_model = CASE
      WHEN default_model LIKE 'volcengine-agent-plan/%'
        THEN 'volcengine-agent/' || substr(default_model, length('volcengine-agent-plan/') + 1)
      ELSE default_model
    END
WHERE provider = 'volcengine-agent-plan';

UPDATE provider_connections
SET provider = 'volcengine-coding',
    default_model = CASE
      WHEN default_model LIKE 'volcengine-coding-plan/%'
        THEN 'volcengine-coding/' || substr(default_model, length('volcengine-coding-plan/') + 1)
      ELSE default_model
    END
WHERE provider = 'volcengine-coding-plan';

UPDATE registered_keys
SET provider = 'volcengine-agent'
WHERE provider = 'volcengine-agent-plan';

UPDATE registered_keys
SET provider = 'volcengine-coding'
WHERE provider = 'volcengine-coding-plan';

-- provider_key_limits: move rows, merging into an existing destination if present.
INSERT OR IGNORE INTO provider_key_limits (
  provider,
  max_active_keys,
  daily_issue_limit,
  hourly_issue_limit,
  daily_issued,
  hourly_issued,
  last_reset_day,
  last_reset_hour,
  updated_at
)
SELECT
  'volcengine-agent',
  max_active_keys,
  daily_issue_limit,
  hourly_issue_limit,
  daily_issued,
  hourly_issued,
  last_reset_day,
  last_reset_hour,
  updated_at
FROM provider_key_limits
WHERE provider = 'volcengine-agent-plan';

DELETE FROM provider_key_limits WHERE provider = 'volcengine-agent-plan';

INSERT OR IGNORE INTO provider_key_limits (
  provider,
  max_active_keys,
  daily_issue_limit,
  hourly_issue_limit,
  daily_issued,
  hourly_issued,
  last_reset_day,
  last_reset_hour,
  updated_at
)
SELECT
  'volcengine-coding',
  max_active_keys,
  daily_issue_limit,
  hourly_issue_limit,
  daily_issued,
  hourly_issued,
  last_reset_day,
  last_reset_hour,
  updated_at
FROM provider_key_limits
WHERE provider = 'volcengine-coding-plan';

DELETE FROM provider_key_limits WHERE provider = 'volcengine-coding-plan';

-- key_value namespaces keyed by provider id (customModels / modelCompatOverrides /
-- providerAliases) and by "provider:" prefixed keys (syncedAvailableModels).
INSERT OR IGNORE INTO key_value (namespace, key, value)
SELECT namespace, 'volcengine-agent', value
FROM key_value
WHERE key = 'volcengine-agent-plan'
  AND namespace IN ('customModels', 'modelCompatOverrides', 'providerAliases');

DELETE FROM key_value
WHERE key = 'volcengine-agent-plan'
  AND namespace IN ('customModels', 'modelCompatOverrides', 'providerAliases');

INSERT OR IGNORE INTO key_value (namespace, key, value)
SELECT namespace, 'volcengine-coding', value
FROM key_value
WHERE key = 'volcengine-coding-plan'
  AND namespace IN ('customModels', 'modelCompatOverrides', 'providerAliases');

DELETE FROM key_value
WHERE key = 'volcengine-coding-plan'
  AND namespace IN ('customModels', 'modelCompatOverrides', 'providerAliases');

INSERT OR IGNORE INTO key_value (namespace, key, value)
SELECT
  namespace,
  'volcengine-agent:' || substr(key, length('volcengine-agent-plan:') + 1),
  value
FROM key_value
WHERE namespace = 'syncedAvailableModels'
  AND substr(key, 1, length('volcengine-agent-plan:')) = 'volcengine-agent-plan:';

DELETE FROM key_value
WHERE namespace = 'syncedAvailableModels'
  AND substr(key, 1, length('volcengine-agent-plan:')) = 'volcengine-agent-plan:';

INSERT OR IGNORE INTO key_value (namespace, key, value)
SELECT
  namespace,
  'volcengine-coding:' || substr(key, length('volcengine-coding-plan:') + 1),
  value
FROM key_value
WHERE namespace = 'syncedAvailableModels'
  AND substr(key, 1, length('volcengine-coding-plan:')) = 'volcengine-coding-plan:';

DELETE FROM key_value
WHERE namespace = 'syncedAvailableModels'
  AND substr(key, 1, length('volcengine-coding-plan:')) = 'volcengine-coding-plan:';

UPDATE key_value
SET value = '"volcengine-agent/' || substr(value, length('"volcengine-agent-plan/') + 1)
WHERE namespace = 'modelAliases'
  AND substr(value, 1, length('"volcengine-agent-plan/')) = '"volcengine-agent-plan/';

UPDATE key_value
SET value = '"volcengine-coding/' || substr(value, length('"volcengine-coding-plan/') + 1)
WHERE namespace = 'modelAliases'
  AND substr(value, 1, length('"volcengine-coding-plan/')) = '"volcengine-coding-plan/';

-- combos store provider refs inside JSON blobs (provider / providerId / model prefix).
UPDATE combos
SET data = replace(
  replace(
    replace(
      replace(
        replace(data, '"provider":"volcengine-agent-plan"', '"provider":"volcengine-agent"'),
        '"provider": "volcengine-agent-plan"',
        '"provider": "volcengine-agent"'
      ),
      '"providerId":"volcengine-agent-plan"',
      '"providerId":"volcengine-agent"'
    ),
    '"providerId": "volcengine-agent-plan"',
    '"providerId": "volcengine-agent"'
  ),
  '"volcengine-agent-plan/',
  '"volcengine-agent/'
)
WHERE data LIKE '%volcengine-agent-plan%';

UPDATE combos
SET data = replace(
  replace(
    replace(
      replace(
        replace(data, '"provider":"volcengine-coding-plan"', '"provider":"volcengine-coding"'),
        '"provider": "volcengine-coding-plan"',
        '"provider": "volcengine-coding"'
      ),
      '"providerId":"volcengine-coding-plan"',
      '"providerId":"volcengine-coding"'
    ),
    '"providerId": "volcengine-coding-plan"',
    '"providerId": "volcengine-coding"'
  ),
  '"volcengine-coding-plan/',
  '"volcengine-coding/'
)
WHERE data LIKE '%volcengine-coding-plan%';

-- combo_adaptation_state / tier_assignments / provider_plans /
-- model_context_overrides / model_capability_overrides / session_account_affinity /
-- group_model_permissions: move rows, dropping duplicates in favor of an existing
-- destination row.
INSERT OR IGNORE INTO combo_adaptation_state (
  combo_id,
  provider_id,
  learned_score,
  request_count,
  success_count,
  avg_latency_ms,
  last_failure_at,
  excluded_until,
  updated_at
)
SELECT
  combo_id,
  'volcengine-agent',
  learned_score,
  request_count,
  success_count,
  avg_latency_ms,
  last_failure_at,
  excluded_until,
  updated_at
FROM combo_adaptation_state
WHERE provider_id = 'volcengine-agent-plan';

DELETE FROM combo_adaptation_state WHERE provider_id = 'volcengine-agent-plan';

INSERT OR IGNORE INTO combo_adaptation_state (
  combo_id,
  provider_id,
  learned_score,
  request_count,
  success_count,
  avg_latency_ms,
  last_failure_at,
  excluded_until,
  updated_at
)
SELECT
  combo_id,
  'volcengine-coding',
  learned_score,
  request_count,
  success_count,
  avg_latency_ms,
  last_failure_at,
  excluded_until,
  updated_at
FROM combo_adaptation_state
WHERE provider_id = 'volcengine-coding-plan';

DELETE FROM combo_adaptation_state WHERE provider_id = 'volcengine-coding-plan';

INSERT OR IGNORE INTO tier_assignments (
  provider,
  model,
  tier,
  cost_per_1m_input,
  cost_per_1m_output,
  has_free_tier,
  free_quota_limit,
  reason,
  updated_at
)
SELECT
  'volcengine-agent',
  model,
  tier,
  cost_per_1m_input,
  cost_per_1m_output,
  has_free_tier,
  free_quota_limit,
  reason,
  updated_at
FROM tier_assignments
WHERE provider = 'volcengine-agent-plan';

DELETE FROM tier_assignments WHERE provider = 'volcengine-agent-plan';

INSERT OR IGNORE INTO tier_assignments (
  provider,
  model,
  tier,
  cost_per_1m_input,
  cost_per_1m_output,
  has_free_tier,
  free_quota_limit,
  reason,
  updated_at
)
SELECT
  'volcengine-coding',
  model,
  tier,
  cost_per_1m_input,
  cost_per_1m_output,
  has_free_tier,
  free_quota_limit,
  reason,
  updated_at
FROM tier_assignments
WHERE provider = 'volcengine-coding-plan';

DELETE FROM tier_assignments WHERE provider = 'volcengine-coding-plan';

UPDATE provider_plans SET provider = 'volcengine-agent' WHERE provider = 'volcengine-agent-plan';
UPDATE provider_plans SET provider = 'volcengine-coding' WHERE provider = 'volcengine-coding-plan';

INSERT OR IGNORE INTO model_context_overrides (
  provider,
  model_id,
  real_context,
  source,
  refreshed_at
)
SELECT 'volcengine-agent', model_id, real_context, source, refreshed_at
FROM model_context_overrides
WHERE provider = 'volcengine-agent-plan';

DELETE FROM model_context_overrides WHERE provider = 'volcengine-agent-plan';

INSERT OR IGNORE INTO model_context_overrides (
  provider,
  model_id,
  real_context,
  source,
  refreshed_at
)
SELECT 'volcengine-coding', model_id, real_context, source, refreshed_at
FROM model_context_overrides
WHERE provider = 'volcengine-coding-plan';

DELETE FROM model_context_overrides WHERE provider = 'volcengine-coding-plan';

INSERT OR IGNORE INTO model_capability_overrides (
  provider,
  model_id,
  override_key,
  override_value,
  refreshed_at
)
SELECT 'volcengine-agent', model_id, override_key, override_value, refreshed_at
FROM model_capability_overrides
WHERE provider = 'volcengine-agent-plan';

DELETE FROM model_capability_overrides WHERE provider = 'volcengine-agent-plan';

INSERT OR IGNORE INTO model_capability_overrides (
  provider,
  model_id,
  override_key,
  override_value,
  refreshed_at
)
SELECT 'volcengine-coding', model_id, override_key, override_value, refreshed_at
FROM model_capability_overrides
WHERE provider = 'volcengine-coding-plan';

DELETE FROM model_capability_overrides WHERE provider = 'volcengine-coding-plan';

INSERT OR IGNORE INTO session_account_affinity (
  session_key,
  provider,
  connection_id,
  created_at,
  last_seen_at
)
SELECT session_key, 'volcengine-agent', connection_id, created_at, last_seen_at
FROM session_account_affinity
WHERE provider = 'volcengine-agent-plan';

DELETE FROM session_account_affinity WHERE provider = 'volcengine-agent-plan';

INSERT OR IGNORE INTO session_account_affinity (
  session_key,
  provider,
  connection_id,
  created_at,
  last_seen_at
)
SELECT session_key, 'volcengine-coding', connection_id, created_at, last_seen_at
FROM session_account_affinity
WHERE provider = 'volcengine-coding-plan';

DELETE FROM session_account_affinity WHERE provider = 'volcengine-coding-plan';

UPDATE group_model_permissions
SET provider = 'volcengine-agent'
WHERE provider = 'volcengine-agent-plan';

UPDATE group_model_permissions
SET provider = 'volcengine-coding'
WHERE provider = 'volcengine-coding-plan';

-- upstream_proxy_config / discovery_results: drop a duplicate destination row
-- before updating, same as 151.
DELETE FROM upstream_proxy_config
WHERE provider_id = 'volcengine-agent'
  AND EXISTS (
    SELECT 1
    FROM upstream_proxy_config AS destination
    WHERE destination.provider_id = 'volcengine-agent'
  );

UPDATE upstream_proxy_config
SET provider_id = 'volcengine-agent'
WHERE provider_id = 'volcengine-agent-plan';

DELETE FROM upstream_proxy_config
WHERE provider_id = 'volcengine-coding'
  AND EXISTS (
    SELECT 1
    FROM upstream_proxy_config AS destination
    WHERE destination.provider_id = 'volcengine-coding'
  );

UPDATE upstream_proxy_config
SET provider_id = 'volcengine-coding'
WHERE provider_id = 'volcengine-coding-plan';

DELETE FROM discovery_results
WHERE provider_id = 'volcengine-agent'
  AND EXISTS (
    SELECT 1
    FROM discovery_results AS destination
    WHERE destination.provider_id = 'volcengine-agent'
      AND destination.method = discovery_results.method
      AND destination.endpoint IS discovery_results.endpoint
  );

UPDATE discovery_results
SET provider_id = 'volcengine-agent'
WHERE provider_id = 'volcengine-agent-plan';

DELETE FROM discovery_results
WHERE provider_id = 'volcengine-coding'
  AND EXISTS (
    SELECT 1
    FROM discovery_results AS destination
    WHERE destination.provider_id = 'volcengine-coding'
      AND destination.method = discovery_results.method
      AND destination.endpoint IS discovery_results.endpoint
  );

UPDATE discovery_results
SET provider_id = 'volcengine-coding'
WHERE provider_id = 'volcengine-coding-plan';
