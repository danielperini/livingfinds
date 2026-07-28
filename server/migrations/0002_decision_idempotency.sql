-- Impede decisões e execuções duplicadas no backend self-hosted.
-- A migração falha deliberadamente se já houver duplicidades: elas precisam ser
-- auditadas antes de criar a garantia, sem apagar histórico automaticamente.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM optimization_decision
    WHERE COALESCE(data->>'idempotency_key', '') <> ''
    GROUP BY data->>'amazon_account_id', data->>'idempotency_key'
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'OptimizationDecision possui idempotency_key duplicada';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM rule_execution
    WHERE COALESCE(data->>'idempotency_key', '') <> ''
    GROUP BY data->>'amazon_account_id', data->>'idempotency_key'
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'RuleExecution possui idempotency_key duplicada';
  END IF;
END $$;

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
