-- READ / ARCHIVE ONLY. Run this only against an explicitly selected database.
-- It snapshots every duplicate group before an operator reviews its history.
-- It does not delete, merge, or alter OptimizationDecision rows.
BEGIN;

-- Entity tables are lazy-created by the repository. Ensure this additive
-- migration also works on an account that has not written a decision yet.
CREATE TABLE IF NOT EXISTS optimization_decision (
  id text PRIMARY KEY,
  created_date timestamptz NOT NULL DEFAULT now(),
  updated_date timestamptz NOT NULL DEFAULT now(),
  created_by text,
  data jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS optimization_decision_idempotency_archive (
  original_id text PRIMARY KEY,
  amazon_account_id text,
  idempotency_key text,
  logical_key text,
  original_data jsonb NOT NULL,
  original_created_date timestamptz,
  original_updated_date timestamptz,
  archived_at timestamptz NOT NULL DEFAULT now(),
  resolution_note text
);

ALTER TABLE optimization_decision_idempotency_archive
  ADD COLUMN IF NOT EXISTS logical_key text;

INSERT INTO optimization_decision_idempotency_archive
  (original_id, amazon_account_id, idempotency_key, logical_key, original_data, original_created_date, original_updated_date)
SELECT d.id, d.data->>'amazon_account_id', d.data->>'idempotency_key', d.data->>'logical_key', d.data, d.created_date, d.updated_date
FROM optimization_decision AS d
JOIN (
  SELECT data->>'amazon_account_id' AS account_id, data->>'idempotency_key' AS logical_key
  FROM optimization_decision
  WHERE coalesce(data->>'amazon_account_id','') <> ''
    AND coalesce(data->>'idempotency_key','') <> ''
  GROUP BY 1, 2
  HAVING count(*) > 1
) AS duplicates
  ON d.data->>'amazon_account_id' = duplicates.account_id
 AND d.data->>'idempotency_key' = duplicates.logical_key
ON CONFLICT (original_id) DO NOTHING;

INSERT INTO optimization_decision_idempotency_archive
  (original_id, amazon_account_id, idempotency_key, logical_key, original_data, original_created_date, original_updated_date)
SELECT d.id, d.data->>'amazon_account_id', d.data->>'idempotency_key', d.data->>'logical_key', d.data, d.created_date, d.updated_date
FROM optimization_decision AS d
JOIN (
  SELECT data->>'amazon_account_id' AS account_id, data->>'logical_key' AS logical_key
  FROM optimization_decision
  WHERE coalesce(data->>'amazon_account_id','') <> ''
    AND coalesce(data->>'logical_key','') <> ''
  GROUP BY 1, 2
  HAVING count(*) > 1
) AS duplicates
  ON d.data->>'amazon_account_id' = duplicates.account_id
 AND d.data->>'logical_key' = duplicates.logical_key
ON CONFLICT (original_id) DO NOTHING;

COMMIT;

-- Review the archived full snapshots and explicitly resolve each group before
-- applying the unique index. No row is silently selected or discarded here.
SELECT amazon_account_id, idempotency_key, logical_key, count(*) AS rows_in_group,
       array_agg(original_id ORDER BY original_created_date, original_id) AS decision_ids,
       array_agg(original_data->>'status' ORDER BY original_created_date, original_id) AS statuses,
       array_agg(original_data->>'confirmation_status' ORDER BY original_created_date, original_id) AS confirmations
FROM optimization_decision_idempotency_archive
GROUP BY amazon_account_id, idempotency_key, logical_key
ORDER BY rows_in_group DESC, amazon_account_id, idempotency_key;
