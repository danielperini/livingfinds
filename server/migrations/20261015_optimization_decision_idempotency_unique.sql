-- Apply only after reviewing the preflight archive. This migration intentionally
-- aborts while duplicate logical keys remain; it never chooses or deletes rows.
BEGIN;

CREATE TABLE IF NOT EXISTS optimization_decision (
  id text PRIMARY KEY,
  created_date timestamptz NOT NULL DEFAULT now(),
  updated_date timestamptz NOT NULL DEFAULT now(),
  created_by text,
  data jsonb NOT NULL DEFAULT '{}'::jsonb
);

DO $$
DECLARE
  duplicate_groups jsonb;
  duplicate_logical_groups jsonb;
  existing_definition text;
BEGIN
  SELECT jsonb_agg(jsonb_build_object(
    'account_id', grouped.account_id,
    'idempotency_key', grouped.logical_key,
    'row_count', grouped.row_count,
    'decision_ids', grouped.decision_ids
  )) INTO duplicate_groups
  FROM (
    SELECT data->>'amazon_account_id' AS account_id,
           data->>'idempotency_key' AS logical_key,
           count(*) AS row_count,
           array_agg(id ORDER BY created_date, id) AS decision_ids
    FROM optimization_decision
    WHERE coalesce(data->>'amazon_account_id','') <> ''
      AND coalesce(data->>'idempotency_key','') <> ''
    GROUP BY 1, 2
    HAVING count(*) > 1
    ORDER BY count(*) DESC
    LIMIT 25
  ) AS grouped;

  IF duplicate_groups IS NOT NULL THEN
    RAISE EXCEPTION 'Cannot install optimization_decision_idempotency_unique; review archived duplicates first: %', duplicate_groups;
  END IF;

  SELECT jsonb_agg(jsonb_build_object(
    'account_id', grouped.account_id,
    'logical_key', grouped.logical_key,
    'row_count', grouped.row_count,
    'decision_ids', grouped.decision_ids
  )) INTO duplicate_logical_groups
  FROM (
    SELECT data->>'amazon_account_id' AS account_id,
           data->>'logical_key' AS logical_key,
           count(*) AS row_count,
           array_agg(id ORDER BY created_date, id) AS decision_ids
    FROM optimization_decision
    WHERE coalesce(data->>'amazon_account_id','') <> ''
      AND coalesce(data->>'logical_key','') <> ''
    GROUP BY 1, 2
    HAVING count(*) > 1
    ORDER BY count(*) DESC
    LIMIT 25
  ) AS grouped;

  IF duplicate_logical_groups IS NOT NULL THEN
    RAISE EXCEPTION 'Cannot install optimization_decision_logical_key_unique; review archived logical-key duplicates first: %', duplicate_logical_groups;
  END IF;

  SELECT pg_get_indexdef(index_class.oid) INTO existing_definition
  FROM pg_class AS index_class
  WHERE index_class.relname = 'optimization_decision_idempotency_unique'
    AND index_class.relnamespace = current_schema()::regnamespace;

  IF existing_definition IS NOT NULL THEN
    IF position('amazon_account_id' in existing_definition) = 0
       OR position('idempotency_key' in existing_definition) = 0 THEN
      RAISE EXCEPTION 'Existing optimization_decision_idempotency_unique has an unexpected definition: %', existing_definition;
    END IF;
  ELSE
    CREATE UNIQUE INDEX optimization_decision_idempotency_unique
      ON optimization_decision ((data->>'amazon_account_id'), (data->>'idempotency_key'))
      WHERE coalesce(data->>'amazon_account_id','') <> ''
        AND coalesce(data->>'idempotency_key','') <> '';
  END IF;

  CREATE UNIQUE INDEX IF NOT EXISTS optimization_decision_logical_key_unique
    ON optimization_decision ((data->>'amazon_account_id'), (data->>'logical_key'))
    WHERE coalesce(data->>'amazon_account_id','') <> ''
      AND coalesce(data->>'logical_key','') <> '';
END $$;

COMMIT;
