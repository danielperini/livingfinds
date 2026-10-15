-- MANUAL maintenance only. Verify a pg_dump backup first; never run from startup.
-- Preserve the last 30 days and every snapshot referenced by decisions or evidence.
BEGIN;
SELECT pg_advisory_xact_lock(hashtextextended('livingfinds:snapshot-retention',0));
CREATE TEMP TABLE retained_snapshot_references (id text PRIMARY KEY) ON COMMIT DROP;
DO $$
DECLARE entity_table text;
BEGIN
  FOREACH entity_table IN ARRAY ARRAY['optimization_decision','amazon_action_queue','hourly_metric','listing_enhancement_history','listing_enhancement_proposal','strategy_session'] LOOP
    IF to_regclass(entity_table) IS NOT NULL THEN
      EXECUTE format('INSERT INTO retained_snapshot_references SELECT data->>''snapshot_id'' FROM %I WHERE nullif(data->>''snapshot_id'','''') IS NOT NULL ON CONFLICT DO NOTHING', entity_table);
    END IF;
  END LOOP;
  IF to_regclass('v6_sia_evidence_link') IS NOT NULL THEN
    INSERT INTO retained_snapshot_references
      SELECT data->>'source_record_id' FROM v6_sia_evidence_link
      WHERE data->>'source_table'='RepricingSnapshot' AND nullif(data->>'source_record_id','') IS NOT NULL
      ON CONFLICT DO NOTHING;
  END IF;
END $$;
CREATE TABLE IF NOT EXISTS snapshot_retention_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  executed_at timestamptz NOT NULL DEFAULT now(), cutoff timestamptz NOT NULL,
  removed_count bigint NOT NULL, protected_references bigint NOT NULL,
  reason text NOT NULL
);
WITH removed AS (
  DELETE FROM repricing_snapshot AS s
  WHERE s.created_date < now()-interval '30 days'
    AND NOT EXISTS (SELECT 1 FROM retained_snapshot_references r WHERE r.id=s.id)
  RETURNING s.id
)
INSERT INTO snapshot_retention_audit(cutoff,removed_count,protected_references,reason)
SELECT now()-interval '30 days',count(*),(SELECT count(*) FROM retained_snapshot_references),
  'Owner authorized cleanup of expired unreferenced snapshots after verified backup; current reports and evidence retained'
FROM removed
RETURNING id,cutoff,removed_count,protected_references;
COMMIT;
