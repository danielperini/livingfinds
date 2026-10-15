-- Additive online indexes for the exact filters/sorts used by the snapshot consumers.
-- Execute each statement outside a transaction (psql -f). No rows are modified.
CREATE TABLE IF NOT EXISTS repricing_snapshot (
  id text PRIMARY KEY, created_date timestamptz NOT NULL DEFAULT now(),
  updated_date timestamptz NOT NULL DEFAULT now(), created_by text,
  data jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX CONCURRENTLY IF NOT EXISTS repricing_snapshot_account_captured
  ON repricing_snapshot ((data->>'amazon_account_id'), (data->'captured_at') DESC NULLS LAST);
CREATE INDEX CONCURRENTLY IF NOT EXISTS repricing_snapshot_account_window_created
  ON repricing_snapshot ((data->>'amazon_account_id'), (data->>'decision_window'), (data->'created_at') DESC NULLS LAST);
CREATE INDEX CONCURRENTLY IF NOT EXISTS repricing_snapshot_account_created
  ON repricing_snapshot ((data->>'amazon_account_id'), (data->'created_at') DESC NULLS LAST);
CREATE INDEX CONCURRENTLY IF NOT EXISTS repricing_snapshot_account_run_created
  ON repricing_snapshot ((data->>'amazon_account_id'), (data->>'run_id'), (data->'created_at') DESC NULLS LAST);
