-- Impede decisões e execuções duplicadas no backend self-hosted.
-- Duplicidades legadas são preservadas, mas recebem uma chave técnica única.
-- O primeiro registro cronológico mantém a chave original para que retries antigos
-- continuem encontrando a decisão canônica. Nenhuma linha ou métrica é apagada.
WITH ranked AS (
  SELECT
    id,
    row_number() OVER (
      PARTITION BY data->>'amazon_account_id', data->>'idempotency_key'
      ORDER BY created_date, id
    ) AS occurrence
  FROM optimization_decision
  WHERE COALESCE(data->>'idempotency_key', '') <> ''
)
UPDATE optimization_decision AS decision
SET
  data = jsonb_set(
    decision.data,
    '{idempotency_key}',
    to_jsonb((decision.data->>'idempotency_key') || ':legacy-duplicate:' || decision.id),
    true
  ),
  updated_date = now()
FROM ranked
WHERE ranked.id = decision.id
  AND ranked.occurrence > 1;

WITH ranked AS (
  SELECT
    id,
    row_number() OVER (
      PARTITION BY data->>'amazon_account_id', data->>'idempotency_key'
      ORDER BY created_date, id
    ) AS occurrence
  FROM rule_execution
  WHERE COALESCE(data->>'idempotency_key', '') <> ''
)
UPDATE rule_execution AS execution
SET
  data = jsonb_set(
    execution.data,
    '{idempotency_key}',
    to_jsonb((execution.data->>'idempotency_key') || ':legacy-duplicate:' || execution.id),
    true
  ),
  updated_date = now()
FROM ranked
WHERE ranked.id = execution.id
  AND ranked.occurrence > 1;

CREATE UNIQUE INDEX IF NOT EXISTS optimization_decision_idempotency_unique
  ON optimization_decision (
    (data->>'amazon_account_id'),
    (data->>'idempotency_key')
  )
  WHERE COALESCE(data->>'idempotency_key', '') <> '';

CREATE UNIQUE INDEX IF NOT EXISTS rule_execution_idempotency_unique
  ON rule_execution (
    (data->>'amazon_account_id'),
    (data->>'idempotency_key')
  )
  WHERE COALESCE(data->>'idempotency_key', '') <> '';
