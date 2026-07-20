-- Gerado por scripts/generate-schema.ts — schema do backend self-hosted do Living Finds.
-- Modelo: cada entidade é uma tabela-documento; os campos ficam em `data` (jsonb).
-- O runtime também cria estas tabelas sob demanda; este arquivo serve p/ provisionar de uma vez.

-- ===== AIAnalysisCache =====
--   amazon_account_id text NOT NULL
--   entity_type text NOT NULL
--   entity_id text
--   analysis_type text NOT NULL
--   input_hash text NOT NULL
--   input_version text
--   result_json text
--   confidence double precision
--   decision text
--   reason text
--   model text
--   tokens_used double precision
--   cost_estimate double precision
--   expires_at timestamptz
--   last_reused_at timestamptz
--   reuse_count double precision
--   status text
CREATE TABLE IF NOT EXISTS "ai_analysis_cache" (
  id           text PRIMARY KEY,
  created_date timestamptz NOT NULL DEFAULT now(),
  updated_date timestamptz NOT NULL DEFAULT now(),
  created_by   text,
  data         jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS "ai_analysis_cache_data_gin" ON "ai_analysis_cache" USING gin (data);
CREATE INDEX IF NOT EXISTS "ai_analysis_cache_created_date" ON "ai_analysis_cache" (created_date DESC);

-- ===== AIUsageLog =====
--   amazon_account_id text NOT NULL
--   log_date date NOT NULL
--   calls_made double precision
--   calls_limit double precision
--   tokens_used double precision
--   tokens_limit double precision
--   cost_estimate double precision
--   cost_limit double precision
--   calls_avoided_cache double precision
--   calls_avoided_rules double precision
--   api_calls_amazon double precision
--   api_calls_sp double precision
--   api_calls_ads double precision
--   api_calls_avoided_cache double precision
--   api_calls_grouped double precision
--   local_calculations double precision
--   decisions_reused double precision
--   queue_actions double precision
--   budget_resets_at timestamptz
CREATE TABLE IF NOT EXISTS "ai_usage_log" (
  id           text PRIMARY KEY,
  created_date timestamptz NOT NULL DEFAULT now(),
  updated_date timestamptz NOT NULL DEFAULT now(),
  created_by   text,
  data         jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS "ai_usage_log_data_gin" ON "ai_usage_log" USING gin (data);
CREATE INDEX IF NOT EXISTS "ai_usage_log_created_date" ON "ai_usage_log" (created_date DESC);

-- ===== AccountDailySpendController =====
--   amazon_account_id text NOT NULL
--   marketplace_id text
--   spend_date date NOT NULL
--   timezone text
--   user_daily_spend_cap double precision
--   ai_suggested_daily_spend_cap double precision
--   ai_suggestion_reason text
--   ai_suggestion_confidence double precision
--   ai_suggestion_generated_at timestamptz
--   effective_daily_spend_cap double precision
--   updated_by text
--   cap_updated_at timestamptz
--   confirmed_spend double precision
--   estimated_pending_spend double precision
--   reserved_spend double precision
--   projected_total_spend double precision
--   remaining_spend double precision
--   cap_status text
--   spend_pacing text
--   pacing_ratio double precision
--   current_hour_brt double precision
--   campaigns_paused_today jsonb
--   campaigns_paused_count double precision
--   pause_started_at timestamptz
--   resume_scheduled_at timestamptz
--   last_pause_reason text
--   total_campaign_budget_nominal double precision
--   campaigns_budget_limited_count double precision
--   last_ads_sync_at timestamptz
--   last_action_at timestamptz
--   last_pacing_check_at timestamptz
--   created_at timestamptz
--   updated_at timestamptz
CREATE TABLE IF NOT EXISTS "account_daily_spend_controller" (
  id           text PRIMARY KEY,
  created_date timestamptz NOT NULL DEFAULT now(),
  updated_date timestamptz NOT NULL DEFAULT now(),
  created_by   text,
  data         jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS "account_daily_spend_controller_data_gin" ON "account_daily_spend_controller" USING gin (data);
CREATE INDEX IF NOT EXISTS "account_daily_spend_controller_created_date" ON "account_daily_spend_controller" (created_date DESC);

-- ===== AdGroup =====
--   amazon_account_id text NOT NULL
--   campaign_id text NOT NULL
--   ad_group_id text NOT NULL
--   ad_group_name text
--   name text
--   state text
--   status text
--   default_bid double precision
--   impressions double precision
--   clicks double precision
--   spend double precision
--   sales double precision
--   acos double precision
--   synced_at timestamptz
--   group_type text
--   primary_asin text
--   primary_sku text
--   product_category text
--   strategy_phase text
--   bidding_strategy text
--   placement_top_search double precision
--   placement_rest_search double precision
--   placement_product_pages double precision
--   is_variation_group boolean
--   variation_asins jsonb
--   created_by_app boolean
--   naming_standard boolean
CREATE TABLE IF NOT EXISTS "ad_group" (
  id           text PRIMARY KEY,
  created_date timestamptz NOT NULL DEFAULT now(),
  updated_date timestamptz NOT NULL DEFAULT now(),
  created_by   text,
  data         jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS "ad_group_data_gin" ON "ad_group" USING gin (data);
CREATE INDEX IF NOT EXISTS "ad_group_created_date" ON "ad_group" (created_date DESC);

-- ===== AdsAiDecisio =====
--   amazon_account_id text NOT NULL
--   run_id text
--   date date
--   entity_type text
--   entity_id text
--   asin text
--   campaign_id text
--   ad_group_id text
--   keyword_id text
--   keyword text
--   action text NOT NULL
--   current_value double precision
--   recommended_value double precision
--   delta double precision
--   delta_percent double precision
--   reason text
--   evidence text
--   risk_level text
--   confidence_score double precision
--   requires_approval boolean
--   status text NOT NULL
--   scheduled_execution_at timestamptz
--   executed_at timestamptz
--   amazon_response text
--   error text
--   simulated boolean
--   evidence_report text
--   rule_applied text
--   model_used text
--   approved_by text
--   approved_at timestamptz
CREATE TABLE IF NOT EXISTS "ads_ai_decisio" (
  id           text PRIMARY KEY,
  created_date timestamptz NOT NULL DEFAULT now(),
  updated_date timestamptz NOT NULL DEFAULT now(),
  created_by   text,
  data         jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS "ads_ai_decisio_data_gin" ON "ads_ai_decisio" USING gin (data);
CREATE INDEX IF NOT EXISTS "ads_ai_decisio_created_date" ON "ads_ai_decisio" (created_date DESC);

-- ===== AdsBidChangeL =====
--   amazon_account_id text NOT NULL
--   date date
--   execution_run_id text
--   campaign_id text
--   campaign_name text
--   ad_group_id text
--   keyword_id text NOT NULL
--   keyword text
--   asin text
--   old_bid double precision
--   new_bid double precision
--   change_amount double precision
--   change_percent double precision
--   direction text NOT NULL
--   reason text
--   evidence text
--   ai_confidence double precision
--   risk_level text
--   status text
--   amazon_response text
--   decision_id text
--   created_at timestamptz
CREATE TABLE IF NOT EXISTS "ads_bid_change_l" (
  id           text PRIMARY KEY,
  created_date timestamptz NOT NULL DEFAULT now(),
  updated_date timestamptz NOT NULL DEFAULT now(),
  created_by   text,
  data         jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS "ads_bid_change_l_data_gin" ON "ads_bid_change_l" USING gin (data);
CREATE INDEX IF NOT EXISTS "ads_bid_change_l_created_date" ON "ads_bid_change_l" (created_date DESC);

-- ===== AdsBidChangeLog =====
--   amazon_account_id text NOT NULL
--   date date
--   execution_run_id text
--   campaign_id text
--   campaign_name text
--   ad_group_id text
--   keyword_id text NOT NULL
--   keyword text
--   asin text
--   old_bid double precision
--   new_bid double precision
--   change_amount double precision
--   change_percent double precision
--   direction text NOT NULL
--   reason text
--   evidence text
--   ai_confidence double precision
--   risk_level text
--   status text
--   amazon_response text
--   decision_id text
--   created_at timestamptz
CREATE TABLE IF NOT EXISTS "ads_bid_change_log" (
  id           text PRIMARY KEY,
  created_date timestamptz NOT NULL DEFAULT now(),
  updated_date timestamptz NOT NULL DEFAULT now(),
  created_by   text,
  data         jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS "ads_bid_change_log_data_gin" ON "ads_bid_change_log" USING gin (data);
CREATE INDEX IF NOT EXISTS "ads_bid_change_log_created_date" ON "ads_bid_change_log" (created_date DESC);

-- ===== AdsLearningO =====
--   amazon_account_id text NOT NULL
--   decision_id text NOT NULL
--   entity_type text NOT NULL
--   entity_id text NOT NULL
--   asin text
--   keyword text
--   action text
--   before_metrics jsonb
--   after_1d_metrics jsonb
--   after_3d_metrics jsonb
--   after_7d_metrics jsonb
--   after_14d_metrics jsonb
--   result text
--   lesson text
--   confidence_delta double precision
--   trend text
--   created_at timestamptz
CREATE TABLE IF NOT EXISTS "ads_learning_o" (
  id           text PRIMARY KEY,
  created_date timestamptz NOT NULL DEFAULT now(),
  updated_date timestamptz NOT NULL DEFAULT now(),
  created_by   text,
  data         jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS "ads_learning_o_data_gin" ON "ads_learning_o" USING gin (data);
CREATE INDEX IF NOT EXISTS "ads_learning_o_created_date" ON "ads_learning_o" (created_date DESC);

-- ===== AdsMetricsHistory =====
--   amazon_account_id text NOT NULL
--   date date NOT NULL
--   campaign_id text
--   campaign_name text
--   ad_group_id text
--   ad_group_name text
--   keyword_id text
--   keyword_text text
--   search_term text
--   match_type text
--   advertised_asin text
--   advertised_sku text
--   report_type text NOT NULL
--   impressions double precision
--   clicks double precision
--   spend double precision
--   orders_1d double precision
--   orders_7d double precision
--   orders_14d double precision
--   orders_30d double precision
--   sales_1d double precision
--   sales_7d double precision
--   sales_14d double precision
--   sales_30d double precision
--   acos_14d double precision
--   roas_14d double precision
--   unique_key text NOT NULL
--   synced_at timestamptz
CREATE TABLE IF NOT EXISTS "ads_metrics_history" (
  id           text PRIMARY KEY,
  created_date timestamptz NOT NULL DEFAULT now(),
  updated_date timestamptz NOT NULL DEFAULT now(),
  created_by   text,
  data         jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS "ads_metrics_history_data_gin" ON "ads_metrics_history" USING gin (data);
CREATE INDEX IF NOT EXISTS "ads_metrics_history_created_date" ON "ads_metrics_history" (created_date DESC);

-- ===== AdsReportRaw =====
--   amazon_account_id text NOT NULL
--   report_type text NOT NULL
--   report_id text NOT NULL
--   report_date date NOT NULL
--   period_start date
--   period_end date
--   raw_data jsonb
--   processed boolean
--   synced_at timestamptz
CREATE TABLE IF NOT EXISTS "ads_report_raw" (
  id           text PRIMARY KEY,
  created_date timestamptz NOT NULL DEFAULT now(),
  updated_date timestamptz NOT NULL DEFAULT now(),
  created_by   text,
  data         jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS "ads_report_raw_data_gin" ON "ads_report_raw" USING gin (data);
CREATE INDEX IF NOT EXISTS "ads_report_raw_created_date" ON "ads_report_raw" (created_date DESC);

-- ===== AdsReportReques =====
--   amazon_account_id text NOT NULL
--   profile_id text
--   report_id text NOT NULL
--   report_type text NOT NULL
--   configuration_hash text
--   date_start date
--   date_end date
--   time_unit text
--   format text
--   status text
--   document_url text
--   requested_at timestamptz
--   last_polled_at timestamptz
--   completed_at timestamptz
--   downloaded_at timestamptz
--   processed_at timestamptz
--   retry_count double precision
--   last_error text
CREATE TABLE IF NOT EXISTS "ads_report_reques" (
  id           text PRIMARY KEY,
  created_date timestamptz NOT NULL DEFAULT now(),
  updated_date timestamptz NOT NULL DEFAULT now(),
  created_by   text,
  data         jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS "ads_report_reques_data_gin" ON "ads_report_reques" USING gin (data);
CREATE INDEX IF NOT EXISTS "ads_report_reques_created_date" ON "ads_report_reques" (created_date DESC);

-- ===== AgentAction =====
--   amazon_account_id text NOT NULL
--   action text NOT NULL
--   asin text
--   campaign_id text
--   ad_group_id text
--   keyword_id text
--   keyword text
--   current_value double precision
--   new_value double precision
--   reason text
--   evidence text
--   risk_level text
--   requires_approval boolean
--   status text
--   reviewed_by text
--   reviewed_at timestamptz
--   executed_at timestamptz
--   execution_response text
CREATE TABLE IF NOT EXISTS "agent_action" (
  id           text PRIMARY KEY,
  created_date timestamptz NOT NULL DEFAULT now(),
  updated_date timestamptz NOT NULL DEFAULT now(),
  created_by   text,
  data         jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS "agent_action_data_gin" ON "agent_action" USING gin (data);
CREATE INDEX IF NOT EXISTS "agent_action_created_date" ON "agent_action" (created_date DESC);

-- ===== Alert =====
--   amazon_account_id text NOT NULL
--   marketplace_id text
--   profile_id text
--   alert_type text NOT NULL
--   alert_family text
--   severity text
--   status text
--   entity_type text
--   entity_id text
--   product_id text
--   asin text
--   sku text
--   campaign_id text
--   ad_group_id text
--   keyword_id text
--   target_id text
--   term text
--   normalized_term text
--   title text NOT NULL
--   message text NOT NULL
--   details text
--   metric_name text
--   metric_value double precision
--   threshold_value double precision
--   comparison text
--   data_window text
--   data_source text
--   data_freshness text
--   deduplication_key text
--   occurrence_count double precision
--   first_detected_at timestamptz
--   last_detected_at timestamptz
--   last_notified_at timestamptz
--   cooldown_until timestamptz
--   resolved_at timestamptz
--   resolution_reason text
--   acknowledged_by text
--   acknowledged_at timestamptz
--   resolved_by text
--   source_function text
--   created_at timestamptz
--   updated_at timestamptz
CREATE TABLE IF NOT EXISTS "alert" (
  id           text PRIMARY KEY,
  created_date timestamptz NOT NULL DEFAULT now(),
  updated_date timestamptz NOT NULL DEFAULT now(),
  created_by   text,
  data         jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS "alert_data_gin" ON "alert" USING gin (data);
CREATE INDEX IF NOT EXISTS "alert_created_date" ON "alert" (created_date DESC);

-- ===== AmazonAccount =====
--   user_id text NOT NULL
--   seller_name text
--   seller_id text
--   marketplace_id text
--   ads_profile_id text
--   ads_refresh_token text
--   ads_access_token text
--   ads_access_token_expires_at timestamptz
--   ads_last_token_refresh_at timestamptz
--   ads_last_verified_at timestamptz
--   ads_refresh_token_created_at timestamptz
--   ads_refresh_token_expires_at timestamptz
--   ads_refresh_token_updated_at timestamptz
--   ads_token_generation text
--   ads_token_status text
--   ads_token_last_error text
--   ads_token_refresh_in_progress boolean
--   ads_token_refresh_started_at timestamptz
--   ads_requires_reauth boolean
--   ads_credentials_error boolean
--   ads_last_lwa_error_code text
--   ads_last_lwa_status_code double precision
--   ads_active_token_source text
--   ads_env_token_present boolean
--   ads_token_source_conflict boolean
--   region text
--   status text
--   country_code text
--   currency_code text
--   currency_symbol text
--   locale text
--   profile_validated_at timestamptz
--   profile_validation_status text
--   ai_auto_optimization boolean
--   max_daily_budget_limit double precision
--   max_bid_change_pct double precision
--   last_sync_at timestamptz
--   ads_metrics_last_sync_at timestamptz
--   ads_data_fresh_at timestamptz
--   sp_data_last_sync_at timestamptz
--   error_message text
--   unified_reports_access boolean
--   unified_reports_last_test_at timestamptz
--   unified_reports_last_error text
CREATE TABLE IF NOT EXISTS "amazon_account" (
  id           text PRIMARY KEY,
  created_date timestamptz NOT NULL DEFAULT now(),
  updated_date timestamptz NOT NULL DEFAULT now(),
  created_by   text,
  data         jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS "amazon_account_data_gin" ON "amazon_account" USING gin (data);
CREATE INDEX IF NOT EXISTS "amazon_account_created_date" ON "amazon_account" (created_date DESC);

-- ===== AmazonActionQueue =====
--   amazon_account_id text NOT NULL
--   operation text NOT NULL
--   entity_type text NOT NULL
--   entity_id text
--   payload jsonb
--   idempotency_key text NOT NULL
--   priority text
--   status text
--   scheduled_at timestamptz
--   started_at timestamptz
--   completed_at timestamptz
--   attempt_count double precision
--   max_attempts double precision
--   last_error text
--   result text
--   source text
--   requires_ai boolean
--   ai_completed boolean
CREATE TABLE IF NOT EXISTS "amazon_action_queue" (
  id           text PRIMARY KEY,
  created_date timestamptz NOT NULL DEFAULT now(),
  updated_date timestamptz NOT NULL DEFAULT now(),
  created_by   text,
  data         jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS "amazon_action_queue_data_gin" ON "amazon_action_queue" USING gin (data);
CREATE INDEX IF NOT EXISTS "amazon_action_queue_created_date" ON "amazon_action_queue" (created_date DESC);

-- ===== AmazonAdsReportCapability =====
--   amazon_account_id text NOT NULL
--   profile_id text
--   marketplace_id text
--   region text
--   report_type_id text NOT NULL
--   ad_product text
--   group_by jsonb
--   status text
--   http_status double precision
--   amazon_error_code text
--   amazon_error_message text
--   tested_payload text
--   tested_at timestamptz
--   last_success_at timestamptz
--   last_failure_at timestamptz
--   fallback_report_type text
--   notes text
CREATE TABLE IF NOT EXISTS "amazon_ads_report_capability" (
  id           text PRIMARY KEY,
  created_date timestamptz NOT NULL DEFAULT now(),
  updated_date timestamptz NOT NULL DEFAULT now(),
  created_by   text,
  data         jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS "amazon_ads_report_capability_data_gin" ON "amazon_ads_report_capability" USING gin (data);
CREATE INDEX IF NOT EXISTS "amazon_ads_report_capability_created_date" ON "amazon_ads_report_capability" (created_date DESC);

-- ===== AmazonAdsReportJob =====
--   amazon_account_id text NOT NULL
--   profile_id text
--   ads_account_id text
--   region text
--   report_id text
--   report_name text
--   report_type_id text NOT NULL
--   ad_product text
--   time_unit text
--   format text
--   group_by jsonb
--   columns jsonb
--   filters text
--   start_date text NOT NULL
--   end_date text NOT NULL
--   idempotency_key text
--   status text NOT NULL
--   amazon_status text
--   failure_reason text
--   url text
--   url_expires_at timestamptz
--   file_size double precision
--   created_at_amazon timestamptz
--   generated_at_amazon timestamptz
--   requested_at timestamptz
--   last_polled_at timestamptz
--   next_poll_at timestamptz
--   poll_attempts double precision
--   poll_in_progress boolean
--   poll_started_at timestamptz
--   downloaded_at timestamptz
--   processed_at timestamptz
--   records_processed double precision
--   source_function text
--   error_message text
--   retry_after_seconds double precision
--   cooldown_until timestamptz
--   created_at timestamptz
--   updated_at timestamptz
CREATE TABLE IF NOT EXISTS "amazon_ads_report_job" (
  id           text PRIMARY KEY,
  created_date timestamptz NOT NULL DEFAULT now(),
  updated_date timestamptz NOT NULL DEFAULT now(),
  created_by   text,
  data         jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS "amazon_ads_report_job_data_gin" ON "amazon_ads_report_job" USING gin (data);
CREATE INDEX IF NOT EXISTS "amazon_ads_report_job_created_date" ON "amazon_ads_report_job" (created_date DESC);

-- ===== AmazonApiRequestLog =====
--   amazon_account_id text NOT NULL
--   api_family text
--   operation text NOT NULL
--   method text NOT NULL
--   endpoint text
--   http_status double precision NOT NULL
--   success boolean
--   request_id text
--   rate_limit_observed text
--   retry_after double precision
--   duration_ms double precision
--   attempt_number double precision
--   error_type text
--   error_code text
--   error_message text
--   created_at timestamptz
CREATE TABLE IF NOT EXISTS "amazon_api_request_log" (
  id           text PRIMARY KEY,
  created_date timestamptz NOT NULL DEFAULT now(),
  updated_date timestamptz NOT NULL DEFAULT now(),
  created_by   text,
  data         jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS "amazon_api_request_log_data_gin" ON "amazon_api_request_log" USING gin (data);
CREATE INDEX IF NOT EXISTS "amazon_api_request_log_created_date" ON "amazon_api_request_log" (created_date DESC);

-- ===== AmazonDataAuditSnapshot =====
--   amazon_account_id text NOT NULL
--   status text
--   checked_at timestamptz NOT NULL
--   last_ads_report_at timestamptz
--   last_products_report_at timestamptz
--   last_metrics_at timestamptz
--   last_hourly_metrics_at timestamptz
--   campaigns_total double precision
--   campaigns_active double precision
--   campaigns_paused double precision
--   campaigns_archived double precision
--   products_total double precision
--   products_with_campaign double precision
--   metrics_rows_30d double precision
--   metrics_unique_30d double precision
--   metrics_duplicates_30d double precision
--   hourly_rows_30d double precision
--   ml_rows_30d double precision
--   issues jsonb
--   summary_json text
CREATE TABLE IF NOT EXISTS "amazon_data_audit_snapshot" (
  id           text PRIMARY KEY,
  created_date timestamptz NOT NULL DEFAULT now(),
  updated_date timestamptz NOT NULL DEFAULT now(),
  created_by   text,
  data         jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS "amazon_data_audit_snapshot_data_gin" ON "amazon_data_audit_snapshot" USING gin (data);
CREATE INDEX IF NOT EXISTS "amazon_data_audit_snapshot_created_date" ON "amazon_data_audit_snapshot" (created_date DESC);

-- ===== AmazonDeferredCommand =====
--   amazon_account_id text
--   function_name text NOT NULL
--   payload_json text NOT NULL
--   status text NOT NULL
--   queue_hour double precision NOT NULL
--   queue_window text NOT NULL
--   priority text
--   attempt_count double precision
--   max_attempts double precision
--   scheduled_at timestamptz
--   started_at timestamptz
--   completed_at timestamptz
--   last_error text
--   source text
CREATE TABLE IF NOT EXISTS "amazon_deferred_command" (
  id           text PRIMARY KEY,
  created_date timestamptz NOT NULL DEFAULT now(),
  updated_date timestamptz NOT NULL DEFAULT now(),
  created_by   text,
  data         jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS "amazon_deferred_command_data_gin" ON "amazon_deferred_command" USING gin (data);
CREATE INDEX IF NOT EXISTS "amazon_deferred_command_created_date" ON "amazon_deferred_command" (created_date DESC);

-- ===== AmazonReportCatalog =====
--   amazon_account_id text NOT NULL
--   report_key text NOT NULL
--   report_type_id text
--   api_family text
--   ad_product text
--   group_by jsonb
--   time_unit text
--   columns jsonb
--   source_function text
--   destination_entities jsonb
--   freshness_hours double precision
--   decision_uses jsonb
--   implemented boolean
--   required boolean
--   duplicate_of text
--   primary_source boolean
--   notes text
--   last_requested_at timestamptz
--   last_processed_at timestamptz
--   last_status text
--   last_error text
--   record_count_last double precision
CREATE TABLE IF NOT EXISTS "amazon_report_catalog" (
  id           text PRIMARY KEY,
  created_date timestamptz NOT NULL DEFAULT now(),
  updated_date timestamptz NOT NULL DEFAULT now(),
  created_by   text,
  data         jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS "amazon_report_catalog_data_gin" ON "amazon_report_catalog" USING gin (data);
CREATE INDEX IF NOT EXISTS "amazon_report_catalog_created_date" ON "amazon_report_catalog" (created_date DESC);

-- ===== AmazonSchedulerLock =====
--   amazon_account_id text NOT NULL
--   lock_key text NOT NULL
--   owner_id text NOT NULL
--   status text NOT NULL
--   acquired_at timestamptz
--   expires_at timestamptz NOT NULL
--   released_at timestamptz
--   heartbeat_at timestamptz
CREATE TABLE IF NOT EXISTS "amazon_scheduler_lock" (
  id           text PRIMARY KEY,
  created_date timestamptz NOT NULL DEFAULT now(),
  updated_date timestamptz NOT NULL DEFAULT now(),
  created_by   text,
  data         jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS "amazon_scheduler_lock_data_gin" ON "amazon_scheduler_lock" USING gin (data);
CREATE INDEX IF NOT EXISTS "amazon_scheduler_lock_created_date" ON "amazon_scheduler_lock" (created_date DESC);

-- ===== ApiCallCache =====
--   amazon_account_id text NOT NULL
--   operation text NOT NULL
--   endpoint text
--   request_hash text NOT NULL
--   response_json text
--   status text
--   expires_at timestamptz
--   last_used_at timestamptz
--   reuse_count double precision
CREATE TABLE IF NOT EXISTS "api_call_cache" (
  id           text PRIMARY KEY,
  created_date timestamptz NOT NULL DEFAULT now(),
  updated_date timestamptz NOT NULL DEFAULT now(),
  created_by   text,
  data         jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS "api_call_cache_data_gin" ON "api_call_cache" USING gin (data);
CREATE INDEX IF NOT EXISTS "api_call_cache_created_date" ON "api_call_cache" (created_date DESC);

-- ===== AppOptimizationConfig =====
--   amazon_account_id text NOT NULL
--   primary_goal text
--   target_acos double precision
--   target_tacos double precision
--   target_roas double precision
--   target_daily_sales double precision
--   target_daily_orders double precision
--   min_auto_bid double precision
--   max_auto_bid double precision
--   min_manual_bid double precision
--   max_manual_bid double precision
--   bid_step double precision
--   max_daily_budget_limit double precision
--   max_budget_per_campaign double precision
--   max_spend_without_sale double precision
--   minimum_data_hours double precision
--   minimum_change_interval_hours double precision
--   minimum_confidence double precision
--   automation_mode text
--   updated_at timestamptz
CREATE TABLE IF NOT EXISTS "app_optimization_config" (
  id           text PRIMARY KEY,
  created_date timestamptz NOT NULL DEFAULT now(),
  updated_date timestamptz NOT NULL DEFAULT now(),
  created_by   text,
  data         jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS "app_optimization_config_data_gin" ON "app_optimization_config" USING gin (data);
CREATE INDEX IF NOT EXISTS "app_optimization_config_created_date" ON "app_optimization_config" (created_date DESC);

-- ===== AutoCampaignLearning =====
--   amazon_account_id text NOT NULL
--   campaign_id text NOT NULL
--   ad_group_id text
--   asin text
--   campaign_name text
--   learning_state text
--   current_bid double precision
--   bid_floor_operational double precision
--   bid_ceiling double precision
--   last_bid_with_delivery double precision
--   last_bid_without_delivery double precision
--   stable_bid double precision
--   confirmed_at timestamptz
--   first_analysis_due_at timestamptz
--   last_analysis_at timestamptz
--   last_bid_change_at timestamptz
--   next_review_at timestamptz
--   bid_increase_count double precision
--   bid_reduction_count double precision
--   total_impressions double precision
--   total_clicks double precision
--   total_spend double precision
--   total_orders double precision
--   total_sales double precision
--   avg_cpc double precision
--   avg_acos double precision
--   block_reason text
--   terms_promoted double precision
--   terms_pending_promotion double precision
--   notes text
CREATE TABLE IF NOT EXISTS "auto_campaign_learning" (
  id           text PRIMARY KEY,
  created_date timestamptz NOT NULL DEFAULT now(),
  updated_date timestamptz NOT NULL DEFAULT now(),
  created_by   text,
  data         jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS "auto_campaign_learning_data_gin" ON "auto_campaign_learning" USING gin (data);
CREATE INDEX IF NOT EXISTS "auto_campaign_learning_created_date" ON "auto_campaign_learning" (created_date DESC);

-- ===== AutoCampaignRepairQueue =====
--   amazon_account_id text NOT NULL
--   asin text NOT NULL
--   campaign_id text
--   campaign_name text
--   status text NOT NULL
--   queue_hour double precision NOT NULL
--   queue_window text NOT NULL
--   scheduled_at timestamptz NOT NULL
--   attempt_count double precision
--   max_attempts double precision
--   last_error text
--   started_at timestamptz
--   completed_at timestamptz
CREATE TABLE IF NOT EXISTS "auto_campaign_repair_queue" (
  id           text PRIMARY KEY,
  created_date timestamptz NOT NULL DEFAULT now(),
  updated_date timestamptz NOT NULL DEFAULT now(),
  created_by   text,
  data         jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS "auto_campaign_repair_queue_data_gin" ON "auto_campaign_repair_queue" USING gin (data);
CREATE INDEX IF NOT EXISTS "auto_campaign_repair_queue_created_date" ON "auto_campaign_repair_queue" (created_date DESC);

-- ===== AutopilotAlert =====
--   amazon_account_id text NOT NULL
--   run_id text
--   alert_type text NOT NULL
--   severity text
--   entity_type text
--   entity_id text
--   entity_name text
--   message text NOT NULL
--   value double precision
--   threshold double precision
--   is_read boolean
--   resolved_at timestamptz
CREATE TABLE IF NOT EXISTS "autopilot_alert" (
  id           text PRIMARY KEY,
  created_date timestamptz NOT NULL DEFAULT now(),
  updated_date timestamptz NOT NULL DEFAULT now(),
  created_by   text,
  data         jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS "autopilot_alert_data_gin" ON "autopilot_alert" USING gin (data);
CREATE INDEX IF NOT EXISTS "autopilot_alert_created_date" ON "autopilot_alert" (created_date DESC);

-- ===== AutopilotConfig =====
--   amazon_account_id text NOT NULL
--   enabled boolean
--   autonomy_level double precision
--   objective text
--   target_acos double precision
--   acos_target double precision
--   maximum_acos double precision
--   target_roas double precision
--   roas_target double precision
--   maximum_tacos double precision
--   target_tacos double precision
--   target_cpc double precision
--   maximum_cpc double precision
--   cpc_enforcement boolean
--   daily_budget_target double precision
--   daily_budget_locked boolean
--   daily_budget_source text
--   total_daily_budget double precision
--   daily_budget_limit double precision
--   maximum_campaign_budget double precision
--   ai_budget_priority_mode text
--   ai_daily_budget_target double precision
--   ai_budget_enforcement boolean
--   max_bid_increase_pct double precision
--   max_bid_decrease_pct double precision
--   max_budget_increase_pct double precision
--   max_budget_decrease_pct double precision
--   min_bid double precision
--   max_bid double precision
--   target_daily_impressions double precision
--   min_daily_impressions double precision
--   impressions_goal_enabled boolean
--   min_clicks_for_decision double precision
--   min_spend_for_decision double precision
--   min_orders_for_scale double precision
--   min_days_for_dayparting double precision
--   min_clicks_per_time_block double precision
--   min_orders_per_time_block double precision
--   cooldown_hours double precision
--   cooldown_increase_hours double precision
--   cooldown_structural_days double precision
--   attribution_safety_hours double precision
--   minimum_complete_data_days double precision
--   harvest_enabled boolean
--   harvest_after_orders double precision
--   aggressive_harvesting boolean
--   negative_after_manual_delivery boolean
--   auto_pause_zero_stock boolean
--   auto_reduce_low_stock boolean
--   minimum_stock_units double precision
--   minimum_stock_days double precision
--   placement_optimization_enabled boolean
--   dayparting_enabled boolean
--   budget_optimization_enabled boolean
--   search_term_optimization_enabled boolean
--   bid_optimization_enabled boolean
--   auto_create_manual_exact boolean
--   auto_apply_low_risk boolean
--   require_approval_medium_risk boolean
--   require_approval_high_risk boolean
--   auto_apply_enabled boolean
--   approval_required boolean
--   emergency_pause_enabled boolean
--   learning_enabled boolean
--   ai_auto_optimization boolean
--   top_of_search_limit double precision
--   rest_of_search_limit double precision
--   product_page_limit double precision
--   marketplace_timezone text
--   currency_code text
--   currency_symbol text
--   ai_suggested_daily_budget double precision
--   ai_budget_reasoning text
--   ai_budget_confidence double precision
--   ai_budget_generated_at timestamptz
--   ai_budget_breakdown text
CREATE TABLE IF NOT EXISTS "autopilot_config" (
  id           text PRIMARY KEY,
  created_date timestamptz NOT NULL DEFAULT now(),
  updated_date timestamptz NOT NULL DEFAULT now(),
  created_by   text,
  data         jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS "autopilot_config_data_gin" ON "autopilot_config" USING gin (data);
CREATE INDEX IF NOT EXISTS "autopilot_config_created_date" ON "autopilot_config" (created_date DESC);

-- ===== AutopilotDecision =====
--   amazon_account_id text NOT NULL
--   run_id text
--   action text NOT NULL
--   entity_type text NOT NULL
--   entity_id text
--   entity_name text
--   current_value double precision
--   new_value double precision
--   change_pct double precision
--   reason text
--   evidence text
--   risk_level text
--   requires_approval boolean
--   status text NOT NULL
--   executed_at timestamptz
--   execution_response text
--   impact_1d double precision
--   impact_3d double precision
--   impact_7d double precision
--   acos_before double precision
--   acos_after double precision
--   spend_before double precision
--   spend_after double precision
CREATE TABLE IF NOT EXISTS "autopilot_decision" (
  id           text PRIMARY KEY,
  created_date timestamptz NOT NULL DEFAULT now(),
  updated_date timestamptz NOT NULL DEFAULT now(),
  created_by   text,
  data         jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS "autopilot_decision_data_gin" ON "autopilot_decision" USING gin (data);
CREATE INDEX IF NOT EXISTS "autopilot_decision_created_date" ON "autopilot_decision" (created_date DESC);

-- ===== AutopilotRun =====
--   amazon_account_id text NOT NULL
--   status text NOT NULL
--   trigger text
--   campaigns_analyzed double precision
--   keywords_analyzed double precision
--   decisions_generated double precision
--   decisions_auto_applied double precision
--   total_spend_analyzed double precision
--   avg_acos double precision
--   alerts_generated double precision
--   error_message text
--   started_at timestamptz
--   completed_at timestamptz
CREATE TABLE IF NOT EXISTS "autopilot_run" (
  id           text PRIMARY KEY,
  created_date timestamptz NOT NULL DEFAULT now(),
  updated_date timestamptz NOT NULL DEFAULT now(),
  created_by   text,
  data         jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS "autopilot_run_data_gin" ON "autopilot_run" USING gin (data);
CREATE INDEX IF NOT EXISTS "autopilot_run_created_date" ON "autopilot_run" (created_date DESC);

-- ===== BackupAuditLog =====
--   backup_id text
--   operation text NOT NULL
--   backup_type text
--   status text NOT NULL
--   started_at timestamptz NOT NULL
--   completed_at timestamptz
--   performed_by text
--   drive_folder_id text
--   drive_backup_name text
--   records_processed double precision
--   files_processed double precision
--   total_size_bytes double precision
--   entities_included jsonb
--   ads_api_data_through text
--   sp_api_data_through text
--   date_gap_days double precision
--   data_consistency_status text
--   protected boolean
--   requires_attention boolean
--   parent_backup_id text
--   warnings jsonb
--   errors jsonb
--   manifest_url text
--   checksum_verified boolean
--   retention_expires_at timestamptz
CREATE TABLE IF NOT EXISTS "backup_audit_log" (
  id           text PRIMARY KEY,
  created_date timestamptz NOT NULL DEFAULT now(),
  updated_date timestamptz NOT NULL DEFAULT now(),
  created_by   text,
  data         jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS "backup_audit_log_data_gin" ON "backup_audit_log" USING gin (data);
CREATE INDEX IF NOT EXISTS "backup_audit_log_created_date" ON "backup_audit_log" (created_date DESC);

-- ===== BidHistory =====
--   amazon_account_id text NOT NULL
--   entity_type text NOT NULL
--   entity_id text NOT NULL
--   entity_name text
--   asin text
--   keyword text
--   old_bid double precision
--   new_bid double precision
--   budget_before double precision
--   budget_after double precision
--   change_pct double precision
--   reason text
--   status text
--   applied_by text
--   decision_id text
--   amazon_response text
--   acos_at_change double precision
--   spend_at_change double precision
--   sales_at_change double precision
--   created_at timestamptz
--   executed_at timestamptz
CREATE TABLE IF NOT EXISTS "bid_history" (
  id           text PRIMARY KEY,
  created_date timestamptz NOT NULL DEFAULT now(),
  updated_date timestamptz NOT NULL DEFAULT now(),
  created_by   text,
  data         jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS "bid_history_data_gin" ON "bid_history" USING gin (data);
CREATE INDEX IF NOT EXISTS "bid_history_created_date" ON "bid_history" (created_date DESC);

-- ===== BiddingRule =====
--   amazon_account_id text NOT NULL
--   name text NOT NULL
--   is_active boolean
--   scope text
--   campaign_type_filter text
--   campaign_id_filter text
--   acos_min double precision
--   acos_max double precision
--   action text NOT NULL
--   bid_change_pct double precision
--   min_impressions double precision
--   min_clicks double precision
--   confidence_threshold double precision
--   last_applied_at timestamptz
--   applied_count double precision
CREATE TABLE IF NOT EXISTS "bidding_rule" (
  id           text PRIMARY KEY,
  created_date timestamptz NOT NULL DEFAULT now(),
  updated_date timestamptz NOT NULL DEFAULT now(),
  created_by   text,
  data         jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS "bidding_rule_data_gin" ON "bidding_rule" USING gin (data);
CREATE INDEX IF NOT EXISTS "bidding_rule_created_date" ON "bidding_rule" (created_date DESC);

-- ===== BudgetConfiguration =====
--   amazon_account_id text NOT NULL
--   daily_budget_floor double precision
--   daily_budget_ceiling double precision
--   calculated_daily_budget double precision
--   weekly_campaign_capacity double precision
--   eligible_campaign_count double precision
--   target_coverage_hours double precision
--   campaign_weight double precision
--   hours_weight double precision
--   campaign_factor double precision
--   hours_factor double precision
--   utilization_score double precision
--   primary_goal text
--   target_acos double precision
--   target_tacos double precision
--   target_roas double precision
--   target_cpc double precision
--   target_cost_per_order double precision
--   minimum_campaign_budget double precision
--   campaign_budget_increment double precision
--   last_weekly_recalculation timestamptz
--   next_weekly_recalculation timestamptz
--   updated_at timestamptz
--   calculation_log text
CREATE TABLE IF NOT EXISTS "budget_configuration" (
  id           text PRIMARY KEY,
  created_date timestamptz NOT NULL DEFAULT now(),
  updated_date timestamptz NOT NULL DEFAULT now(),
  created_by   text,
  data         jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS "budget_configuration_data_gin" ON "budget_configuration" USING gin (data);
CREATE INDEX IF NOT EXISTS "budget_configuration_created_date" ON "budget_configuration" (created_date DESC);

-- ===== BudgetRule =====
--   amazon_account_id text NOT NULL
--   total_daily_budget double precision
--   max_budget_per_campaign double precision
--   max_budget_per_asin double precision
--   min_auto_campaign_bid double precision
--   max_bid double precision
--   min_bid double precision
--   bid_increase_step double precision
--   bid_decrease_step double precision
--   target_acos double precision
--   target_roas double precision
--   auto_apply_bid_reduction boolean
--   auto_apply_budget_redistribution boolean
--   auto_pause_no_conversion_enabled boolean
--   auto_pause_no_conversion_days double precision
--   auto_pause_no_conversion_min_clicks double precision
--   auto_pause_no_conversion_min_spend double precision
--   approval_required_pause boolean
--   approval_required_negative boolean
--   approval_required_budget_increase boolean
CREATE TABLE IF NOT EXISTS "budget_rule" (
  id           text PRIMARY KEY,
  created_date timestamptz NOT NULL DEFAULT now(),
  updated_date timestamptz NOT NULL DEFAULT now(),
  created_by   text,
  data         jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS "budget_rule_data_gin" ON "budget_rule" USING gin (data);
CREATE INDEX IF NOT EXISTS "budget_rule_created_date" ON "budget_rule" (created_date DESC);

-- ===== Campaign =====
--   amazon_account_id text NOT NULL
--   ads_profile_id text
--   marketplace text
--   campaign_id text NOT NULL
--   amazon_campaign_id text
--   asin text
--   name text
--   campaign_name text
--   campaign_type text
--   targeting_type text
--   state text
--   status text
--   amazon_status text
--   is_operational boolean
--   requires_attention boolean
--   api_missing boolean
--   source text
--   reconciliation_status text
--   reconciliation_notes text
--   metrics_status text
--   daily_budget double precision
--   currency_code text
--   currency_symbol text
--   current_spend double precision
--   spend double precision
--   sales double precision
--   acos double precision
--   roas double precision
--   impressions double precision
--   clicks double precision
--   orders double precision
--   ctr double precision
--   cpc double precision
--   start_date text
--   end_date text
--   bidding_strategy text
--   portfolio_id text
--   top_of_search_adjustment double precision
--   rest_of_search_adjustment double precision
--   product_pages_adjustment double precision
--   placement_last_updated_at timestamptz
--   created_by_app boolean
--   launch_phase text
--   days_running double precision
--   created_at timestamptz
--   last_sync_at timestamptz
--   last_api_sync_at timestamptz
--   last_csv_import_at timestamptz
--   synced_at timestamptz
--   archived boolean
--   archived_at timestamptz
--   archive_reason text
--   original_state text
--   last_activity_at timestamptz
--   learning_eligible boolean
--   excluded_from_dashboard boolean
CREATE TABLE IF NOT EXISTS "campaign" (
  id           text PRIMARY KEY,
  created_date timestamptz NOT NULL DEFAULT now(),
  updated_date timestamptz NOT NULL DEFAULT now(),
  created_by   text,
  data         jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS "campaign_data_gin" ON "campaign" USING gin (data);
CREATE INDEX IF NOT EXISTS "campaign_created_date" ON "campaign" (created_date DESC);

-- ===== CampaignAcosViolation =====
--   amazon_account_id text NOT NULL
--   campaign_id text NOT NULL
--   campaign_name text
--   campaign_type text
--   asin text
--   consecutive_violations double precision
--   acos_cycle_1 double precision
--   acos_cycle_2 double precision
--   acos_cycle_3 double precision
--   spend_cycle_1 double precision
--   spend_cycle_2 double precision
--   spend_cycle_3 double precision
--   target_acos double precision
--   maximum_acos double precision
--   last_violation_at timestamptz
--   first_violation_at timestamptz
--   paused_at timestamptz
--   pause_reason text
--   status text
--   reset_at timestamptz
--   notes text
CREATE TABLE IF NOT EXISTS "campaign_acos_violation" (
  id           text PRIMARY KEY,
  created_date timestamptz NOT NULL DEFAULT now(),
  updated_date timestamptz NOT NULL DEFAULT now(),
  created_by   text,
  data         jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS "campaign_acos_violation_data_gin" ON "campaign_acos_violation" USING gin (data);
CREATE INDEX IF NOT EXISTS "campaign_acos_violation_created_date" ON "campaign_acos_violation" (created_date DESC);

-- ===== CampaignBidHistory =====
--   amazon_account_id text NOT NULL
--   campaign_id text NOT NULL
--   ad_group_id text
--   asin text
--   previous_bid double precision
--   new_bid double precision
--   change_type text NOT NULL
--   reason text
--   impressions_before double precision
--   clicks_before double precision
--   spend_before double precision
--   orders_before double precision
--   sales_before double precision
--   average_cpc_before double precision
--   acos_before double precision
--   roas_before double precision
--   created_at timestamptz
--   next_review_at timestamptz
--   execution_id text
CREATE TABLE IF NOT EXISTS "campaign_bid_history" (
  id           text PRIMARY KEY,
  created_date timestamptz NOT NULL DEFAULT now(),
  updated_date timestamptz NOT NULL DEFAULT now(),
  created_by   text,
  data         jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS "campaign_bid_history_data_gin" ON "campaign_bid_history" USING gin (data);
CREATE INDEX IF NOT EXISTS "campaign_bid_history_created_date" ON "campaign_bid_history" (created_date DESC);

-- ===== CampaignChangeHistory =====
--   amazon_account_id text NOT NULL
--   campaign_id text NOT NULL
--   amazon_campaign_id text
--   ad_group_id text
--   keyword_id text
--   target_id text
--   search_term_id text
--   change_type text NOT NULL
--   entity_type text NOT NULL
--   entity_id text
--   field_name text
--   old_value text
--   new_value text
--   source text
--   source_function text
--   decision_id text
--   rule_id text
--   reason text
--   metrics_before text
--   metrics_after text
--   amazon_request text
--   amazon_response text
--   amazon_request_id text
--   status text
--   error text
--   changed_by text
--   changed_at timestamptz
--   evaluation_due_at timestamptz
--   evaluated_at timestamptz
--   outcome text
--   rollback_available boolean
--   rollback_status text
--   campaign_objective text
--   campaign_maturity text
--   pause_reason text
CREATE TABLE IF NOT EXISTS "campaign_change_history" (
  id           text PRIMARY KEY,
  created_date timestamptz NOT NULL DEFAULT now(),
  updated_date timestamptz NOT NULL DEFAULT now(),
  created_by   text,
  data         jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS "campaign_change_history_data_gin" ON "campaign_change_history" USING gin (data);
CREATE INDEX IF NOT EXISTS "campaign_change_history_created_date" ON "campaign_change_history" (created_date DESC);

-- ===== CampaignCreationLog =====
--   amazon_account_id text NOT NULL
--   user_id text NOT NULL
--   operation_type text NOT NULL
--   entity_type text NOT NULL
--   entity_id text
--   campaign_id text
--   ad_group_id text
--   keyword_id text
--   asin text
--   sku text
--   keyword_text text
--   match_type text
--   old_bid double precision
--   new_bid double precision
--   old_placement_top double precision
--   new_placement_top double precision
--   old_placement_rest double precision
--   new_placement_rest double precision
--   old_placement_product double precision
--   new_placement_product double precision
--   rule_applied text
--   rationale text
--   amazon_response text
--   status text NOT NULL
--   error_message text
--   request_id text
--   created_at timestamptz
CREATE TABLE IF NOT EXISTS "campaign_creation_log" (
  id           text PRIMARY KEY,
  created_date timestamptz NOT NULL DEFAULT now(),
  updated_date timestamptz NOT NULL DEFAULT now(),
  created_by   text,
  data         jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS "campaign_creation_log_data_gin" ON "campaign_creation_log" USING gin (data);
CREATE INDEX IF NOT EXISTS "campaign_creation_log_created_date" ON "campaign_creation_log" (created_date DESC);

-- ===== CampaignLearningEvaluation =====
--   amazon_account_id text NOT NULL
--   campaign_id text NOT NULL
--   asin text
--   product_id text
--   learning_stage_before text NOT NULL
--   learning_stage_after text
--   evaluation_window_start timestamptz
--   evaluation_window_end timestamptz
--   impressions double precision
--   clicks double precision
--   spend double precision
--   orders double precision
--   sales double precision
--   current_bid double precision
--   recommended_bid double precision
--   decision text
--   reason text
--   terms_found double precision
--   terms_promoted double precision
--   keywords_paused double precision
--   keywords_replaced double precision
--   next_evaluation_at timestamptz
--   source_function text
--   created_at timestamptz
CREATE TABLE IF NOT EXISTS "campaign_learning_evaluation" (
  id           text PRIMARY KEY,
  created_date timestamptz NOT NULL DEFAULT now(),
  updated_date timestamptz NOT NULL DEFAULT now(),
  created_by   text,
  data         jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS "campaign_learning_evaluation_data_gin" ON "campaign_learning_evaluation" USING gin (data);
CREATE INDEX IF NOT EXISTS "campaign_learning_evaluation_created_date" ON "campaign_learning_evaluation" (created_date DESC);

-- ===== CampaignLearningState =====
--   amazon_account_id text NOT NULL
--   profile_id text
--   marketplace_id text
--   product_id text
--   asin text
--   sku text
--   campaign_id text NOT NULL
--   campaign_name text
--   campaign_type text
--   strategy_type text
--   learning_stage text NOT NULL
--   campaign_maturity_stage text
--   profitability_status text
--   maturity_stage_started_at timestamptz
--   maturity_stage_ends_at timestamptz
--   next_maturity_evaluation_at timestamptz
--   last_maturity_evaluation_at timestamptz
--   maturity_cycle_number double precision
--   maturity_score double precision
--   profitability_risk_score double precision
--   last_conversion_at timestamptz
--   last_profitable_at timestamptz
--   hours_since_last_conversion double precision
--   spend_since_last_conversion double precision
--   clicks_since_last_conversion double precision
--   impressions_since_last_conversion double precision
--   historical_orders double precision
--   historical_sales double precision
--   historical_profit double precision
--   estimated_profit_per_order double precision
--   break_even_acos double precision
--   max_allowed_spend_without_order double precision
--   learning_stage_started_at timestamptz
--   learning_stage_ends_at timestamptz
--   next_evaluation_at timestamptz
--   last_evaluation_at timestamptz
--   cycle_number double precision
--   initial_bid double precision
--   current_bid double precision
--   bid_ceiling double precision
--   bid_floor double precision
--   daily_budget double precision
--   bid_increment_count double precision
--   impressions double precision
--   clicks double precision
--   spend double precision
--   orders double precision
--   units double precision
--   sales double precision
--   acos double precision
--   roas double precision
--   conversion_rate double precision
--   terms_collected double precision
--   terms_promoted double precision
--   keywords_replaced double precision
--   initial_manual_campaign boolean
--   harvested_manual_campaign boolean
--   status text
--   blocked_reason text
--   last_decision_id text
--   idempotency_key text
--   created_at timestamptz
--   updated_at timestamptz
CREATE TABLE IF NOT EXISTS "campaign_learning_state" (
  id           text PRIMARY KEY,
  created_date timestamptz NOT NULL DEFAULT now(),
  updated_date timestamptz NOT NULL DEFAULT now(),
  created_by   text,
  data         jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS "campaign_learning_state_data_gin" ON "campaign_learning_state" USING gin (data);
CREATE INDEX IF NOT EXISTS "campaign_learning_state_created_date" ON "campaign_learning_state" (created_date DESC);

-- ===== CampaignMaturityEvaluation =====
--   amazon_account_id text NOT NULL
--   profile_id text
--   marketplace_id text
--   product_id text
--   asin text
--   sku text
--   campaign_id text NOT NULL
--   campaign_maturity_stage_before text NOT NULL
--   campaign_maturity_stage_after text
--   profitability_status_before text
--   profitability_status_after text
--   evaluation_window_start timestamptz
--   evaluation_window_end timestamptz
--   impressions double precision
--   clicks double precision
--   spend double precision
--   orders double precision
--   sales double precision
--   impressions_72h double precision
--   clicks_72h double precision
--   spend_72h double precision
--   orders_72h double precision
--   sales_72h double precision
--   last_conversion_at timestamptz
--   hours_since_last_conversion double precision
--   spend_since_last_conversion double precision
--   clicks_since_last_conversion double precision
--   historical_orders double precision
--   historical_sales double precision
--   estimated_profit_per_order double precision
--   break_even_acos double precision
--   max_allowed_spend_without_order double precision
--   profitability_risk_score double precision
--   maturity_score double precision
--   terms_audited double precision
--   terms_promoted double precision
--   terms_pending_promotion double precision
--   manual_campaigns_found double precision
--   manual_campaigns_created double precision
--   negative_coverage_ratio double precision
--   attribution_data_complete boolean
--   search_terms_sync_complete boolean
--   term_audit_complete boolean
--   economic_loss_threshold_reached boolean
--   severe_loss_detected boolean
--   structural_issue_detected boolean
--   pending_manual_promotions double precision
--   data_through text
--   decision text
--   reason text
--   ai_assessment text
--   deterministic_validation text
--   final_decision text
--   pause_reason text
--   replacement_status text
--   structural_blocks text
--   risk_multiplier_used double precision
--   next_evaluation_at timestamptz
--   idempotency_key text
--   source_function text
--   created_at timestamptz
CREATE TABLE IF NOT EXISTS "campaign_maturity_evaluation" (
  id           text PRIMARY KEY,
  created_date timestamptz NOT NULL DEFAULT now(),
  updated_date timestamptz NOT NULL DEFAULT now(),
  created_by   text,
  data         jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS "campaign_maturity_evaluation_data_gin" ON "campaign_maturity_evaluation" USING gin (data);
CREATE INDEX IF NOT EXISTS "campaign_maturity_evaluation_created_date" ON "campaign_maturity_evaluation" (created_date DESC);

-- ===== CampaignMetricsDaily =====
--   amazon_account_id text NOT NULL
--   campaign_id text NOT NULL
--   date date NOT NULL
--   impressions double precision
--   clicks double precision
--   spend double precision
--   sales double precision
--   orders double precision
--   acos double precision
--   roas double precision
--   ctr double precision
--   cpc double precision
CREATE TABLE IF NOT EXISTS "campaign_metrics_daily" (
  id           text PRIMARY KEY,
  created_date timestamptz NOT NULL DEFAULT now(),
  updated_date timestamptz NOT NULL DEFAULT now(),
  created_by   text,
  data         jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS "campaign_metrics_daily_data_gin" ON "campaign_metrics_daily" USING gin (data);
CREATE INDEX IF NOT EXISTS "campaign_metrics_daily_created_date" ON "campaign_metrics_daily" (created_date DESC);

-- ===== CompetitorAsinMap =====
--   amazon_account_id text NOT NULL
--   asin text NOT NULL
--   competitor_asin text NOT NULL
--   source text
--   status text
--   notes text
--   created_at timestamptz
--   updated_at timestamptz
CREATE TABLE IF NOT EXISTS "competitor_asin_map" (
  id           text PRIMARY KEY,
  created_date timestamptz NOT NULL DEFAULT now(),
  updated_date timestamptz NOT NULL DEFAULT now(),
  created_by   text,
  data         jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS "competitor_asin_map_data_gin" ON "competitor_asin_map" USING gin (data);
CREATE INDEX IF NOT EXISTS "competitor_asin_map_created_date" ON "competitor_asin_map" (created_date DESC);

-- ===== DailyProductAdsAssessment =====
--   amazon_account_id text NOT NULL
--   marketplace_id text
--   assessment_date date NOT NULL
--   product_id text
--   asin text NOT NULL
--   sku text
--   spend double precision
--   ads_sales double precision
--   real_sales double precision
--   orders_ads double precision
--   units_real double precision
--   impressions double precision
--   clicks double precision
--   ctr double precision
--   cpc double precision
--   cvr double precision
--   acos double precision
--   acos_status text
--   roas double precision
--   tacos double precision
--   tacos_data_partial boolean
--   average_order_value double precision
--   revenue_per_click double precision
--   cost_per_order double precision
--   product_cost double precision
--   amazon_fees double precision
--   estimated_taxes double precision
--   logistics_cost double precision
--   other_variable_costs double precision
--   contribution_profit_before_ads double precision
--   profit_after_ads double precision
--   break_even_acos double precision
--   target_acos double precision
--   maximum_profitable_cpa double precision
--   safe_max_cpc double precision
--   economic_status text
--   performance_status text
--   data_status text
--   confidence double precision
--   recommended_action text
--   decision_id text
--   idempotency_key text
--   created_at timestamptz
--   updated_at timestamptz
CREATE TABLE IF NOT EXISTS "daily_product_ads_assessment" (
  id           text PRIMARY KEY,
  created_date timestamptz NOT NULL DEFAULT now(),
  updated_date timestamptz NOT NULL DEFAULT now(),
  created_by   text,
  data         jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS "daily_product_ads_assessment_data_gin" ON "daily_product_ads_assessment" USING gin (data);
CREATE INDEX IF NOT EXISTS "daily_product_ads_assessment_created_date" ON "daily_product_ads_assessment" (created_date DESC);

-- ===== DashboardDataAudit =====
--   amazon_account_id text NOT NULL
--   period_start date
--   period_end date
--   benchmark_id text
--   overall_status text
--   critical_count double precision
--   attention_count double precision
--   ok_count double precision
--   comparisons_json text
--   identified_confusions jsonb
--   recommendations jsonb
--   ran_at timestamptz
--   created_at timestamptz
CREATE TABLE IF NOT EXISTS "dashboard_data_audit" (
  id           text PRIMARY KEY,
  created_date timestamptz NOT NULL DEFAULT now(),
  updated_date timestamptz NOT NULL DEFAULT now(),
  created_by   text,
  data         jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS "dashboard_data_audit_data_gin" ON "dashboard_data_audit" USING gin (data);
CREATE INDEX IF NOT EXISTS "dashboard_data_audit_created_date" ON "dashboard_data_audit" (created_date DESC);

-- ===== DaypartScheduleAction =====
--   amazon_account_id text NOT NULL
--   campaign_id text
--   ad_group_id text
--   keyword_id text
--   target_id text
--   asin text
--   hour_block text
--   start_hour double precision
--   end_hour double precision
--   timezone text
--   action_type text NOT NULL
--   base_bid double precision
--   scheduled_bid double precision
--   bid_multiplier double precision
--   reason text
--   confidence double precision
--   status text
--   last_executed_at timestamptz
--   next_execution_at timestamptz
--   created_at timestamptz
--   updated_at timestamptz
CREATE TABLE IF NOT EXISTS "daypart_schedule_action" (
  id           text PRIMARY KEY,
  created_date timestamptz NOT NULL DEFAULT now(),
  updated_date timestamptz NOT NULL DEFAULT now(),
  created_by   text,
  data         jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS "daypart_schedule_action_data_gin" ON "daypart_schedule_action" USING gin (data);
CREATE INDEX IF NOT EXISTS "daypart_schedule_action_created_date" ON "daypart_schedule_action" (created_date DESC);

-- ===== DaypartingRule =====
--   amazon_account_id text NOT NULL
--   campaign_id text
--   campaign_name text
--   asin text
--   rule_type text NOT NULL
--   days_of_week jsonb NOT NULL
--   start_hour bigint NOT NULL
--   end_hour bigint NOT NULL
--   adjustment_type text
--   adjustment_value double precision NOT NULL
--   bid_base_before double precision
--   bid_floor double precision
--   recommended_bid double precision
--   classification text
--   roas_at_creation double precision
--   sales_freq_index double precision
--   roas_index double precision
--   placement_top_before double precision
--   placement_rest_before double precision
--   placement_product_before double precision
--   budget_before double precision
--   status text
--   amazon_rule_id text
--   confidence double precision
--   sample_days bigint
--   sample_clicks bigint
--   sample_orders bigint
--   avg_roas double precision
--   avg_acos double precision
--   avg_conversion double precision
--   rationale text
--   created_by text
--   approved_by text
--   approved_at timestamptz
--   executed_at timestamptz
--   expires_at timestamptz
--   last_applied_at timestamptz
--   apply_count bigint
--   created_at timestamptz
--   updated_at timestamptz
CREATE TABLE IF NOT EXISTS "dayparting_rule" (
  id           text PRIMARY KEY,
  created_date timestamptz NOT NULL DEFAULT now(),
  updated_date timestamptz NOT NULL DEFAULT now(),
  created_by   text,
  data         jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS "dayparting_rule_data_gin" ON "dayparting_rule" USING gin (data);
CREATE INDEX IF NOT EXISTS "dayparting_rule_created_date" ON "dayparting_rule" (created_date DESC);

-- ===== Decision =====
--   amazon_account_id text NOT NULL
--   decision_type text NOT NULL
--   entity_type text
--   entity_id text
--   entity_name text
--   asin text
--   campaign_id text
--   ad_group_id text
--   keyword_id text
--   search_term text
--   rationale text
--   formula text
--   metrics_used text
--   current_value double precision
--   proposed_value double precision
--   calculation_value double precision
--   change_pct double precision
--   confidence double precision
--   priority text
--   data_maturity text
--   objective text
--   expected_impact text
--   risk text
--   approval_required boolean
--   reversible boolean
--   status text NOT NULL
--   reviewed_by text
--   reviewed_at timestamptz
--   executed_at timestamptz
--   next_review_at timestamptz
--   error_message text
--   amazon_response text
CREATE TABLE IF NOT EXISTS "decision" (
  id           text PRIMARY KEY,
  created_date timestamptz NOT NULL DEFAULT now(),
  updated_date timestamptz NOT NULL DEFAULT now(),
  created_by   text,
  data         jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS "decision_data_gin" ON "decision" USING gin (data);
CREATE INDEX IF NOT EXISTS "decision_created_date" ON "decision" (created_date DESC);

-- ===== DecisionOutcome =====
--   amazon_account_id text NOT NULL
--   decision_id text
--   execution_id text
--   entity_type text
--   entity_id text
--   campaign_id text
--   ad_group_id text
--   keyword_id text
--   target_id text
--   asin text
--   sku text
--   decision_type text NOT NULL
--   metric_trigger text
--   old_value double precision
--   new_value double precision
--   expected_impact text
--   expected_metric text
--   expected_direction text
--   confidence_before double precision
--   confidence_after double precision
--   decision_created_at timestamptz
--   executed_at timestamptz
--   evaluation_due_at timestamptz
--   evaluation_window_hours double precision
--   before_period_start date
--   before_period_end date
--   after_period_start date
--   after_period_end date
--   before_metrics_json text
--   after_metrics_json text
--   result_status text
--   impact_score double precision
--   success boolean
--   failure_reason text
--   rule_key text
--   source_function text
--   created_at timestamptz
--   updated_at timestamptz
CREATE TABLE IF NOT EXISTS "decision_outcome" (
  id           text PRIMARY KEY,
  created_date timestamptz NOT NULL DEFAULT now(),
  updated_date timestamptz NOT NULL DEFAULT now(),
  created_by   text,
  data         jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS "decision_outcome_data_gin" ON "decision_outcome" USING gin (data);
CREATE INDEX IF NOT EXISTS "decision_outcome_created_date" ON "decision_outcome" (created_date DESC);

-- ===== DecisionRule =====
--   amazon_account_id text NOT NULL
--   rule_key text NOT NULL
--   name text NOT NULL
--   description text
--   scope text NOT NULL
--   priority double precision
--   conditions jsonb
--   action jsonb NOT NULL
--   minimum_evidence jsonb
--   cooldown_hours double precision
--   max_changes_per_week double precision
--   expected_result jsonb
--   confidence double precision
--   reason text
--   source_metrics jsonb
--   rollback_condition jsonb
--   expires_at timestamptz
--   status text
--   is_protected boolean
--   version double precision
--   version_id text
--   effective_from timestamptz
--   effective_until timestamptz
--   times_triggered double precision
--   times_succeeded double precision
--   times_rolled_back double precision
--   last_triggered_at timestamptz
--   review_id text
--   source text
--   created_by text
CREATE TABLE IF NOT EXISTS "decision_rule" (
  id           text PRIMARY KEY,
  created_date timestamptz NOT NULL DEFAULT now(),
  updated_date timestamptz NOT NULL DEFAULT now(),
  created_by   text,
  data         jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS "decision_rule_data_gin" ON "decision_rule" USING gin (data);
CREATE INDEX IF NOT EXISTS "decision_rule_created_date" ON "decision_rule" (created_date DESC);

-- ===== DecisionRulePerformance =====
--   amazon_account_id text NOT NULL
--   rule_id text
--   rule_name text
--   rule_key text NOT NULL
--   decision_type text
--   times_used double precision
--   success_count double precision
--   failure_count double precision
--   neutral_count double precision
--   avg_impact_score double precision
--   last_success_at timestamptz
--   last_failure_at timestamptz
--   confidence_adjustment double precision
--   enabled boolean
--   auto_disabled_at timestamptz
--   auto_disabled_reason text
--   updated_at timestamptz
CREATE TABLE IF NOT EXISTS "decision_rule_performance" (
  id           text PRIMARY KEY,
  created_date timestamptz NOT NULL DEFAULT now(),
  updated_date timestamptz NOT NULL DEFAULT now(),
  created_by   text,
  data         jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS "decision_rule_performance_data_gin" ON "decision_rule_performance" USING gin (data);
CREATE INDEX IF NOT EXISTS "decision_rule_performance_created_date" ON "decision_rule_performance" (created_date DESC);

-- ===== DecisionRuleVersion =====
--   amazon_account_id text NOT NULL
--   version_number double precision NOT NULL
--   review_id text
--   model text
--   prompt_version text
--   data_hash text
--   status text
--   activated_at timestamptz
--   superseded_at timestamptz
--   previous_version_id text
--   rules_created jsonb
--   rules_updated jsonb
--   rules_disabled jsonb
--   rules_unchanged jsonb
--   backtest_result jsonb
--   expected_impact jsonb
--   rollback_available boolean
--   justification text
--   responsible text
CREATE TABLE IF NOT EXISTS "decision_rule_version" (
  id           text PRIMARY KEY,
  created_date timestamptz NOT NULL DEFAULT now(),
  updated_date timestamptz NOT NULL DEFAULT now(),
  created_by   text,
  data         jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS "decision_rule_version_data_gin" ON "decision_rule_version" USING gin (data);
CREATE INDEX IF NOT EXISTS "decision_rule_version_created_date" ON "decision_rule_version" (created_date DESC);

-- ===== FeatureFlag =====
--   key text NOT NULL
--   enabled boolean
--   environment text
--   scope text
--   updated_at timestamptz
--   updated_by text
--   reason text
CREATE TABLE IF NOT EXISTS "feature_flag" (
  id           text PRIMARY KEY,
  created_date timestamptz NOT NULL DEFAULT now(),
  updated_date timestamptz NOT NULL DEFAULT now(),
  created_by   text,
  data         jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS "feature_flag_data_gin" ON "feature_flag" USING gin (data);
CREATE INDEX IF NOT EXISTS "feature_flag_created_date" ON "feature_flag" (created_date DESC);

-- ===== FullOptimizationRunReport =====
--   amazon_account_id text NOT NULL
--   started_at timestamptz
--   finished_at timestamptz
--   duration_ms double precision
--   trigger text
--   campaigns_reviewed double precision
--   campaigns_repaired double precision
--   campaigns_archived double precision
--   campaigns_created_auto double precision
--   campaigns_created_manual double precision
--   keywords_reviewed double precision
--   keywords_repaired double precision
--   keywords_paused double precision
--   keywords_created double precision
--   targets_reviewed double precision
--   targets_repaired double precision
--   product_ads_paused_no_stock double precision
--   bids_reduced double precision
--   bids_increased double precision
--   budgets_changed double precision
--   negatives_created double precision
--   errors double precision
--   skipped_low_confidence double precision
--   expected_savings_total double precision
--   expected_sales_impact double precision
--   data_quality_score double precision
--   reports_used jsonb
--   warnings jsonb
--   summary text
--   status text
--   economy_first_applied boolean
--   actions_enqueued double precision
CREATE TABLE IF NOT EXISTS "full_optimization_run_report" (
  id           text PRIMARY KEY,
  created_date timestamptz NOT NULL DEFAULT now(),
  updated_date timestamptz NOT NULL DEFAULT now(),
  created_by   text,
  data         jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS "full_optimization_run_report_data_gin" ON "full_optimization_run_report" USING gin (data);
CREATE INDEX IF NOT EXISTS "full_optimization_run_report_created_date" ON "full_optimization_run_report" (created_date DESC);

-- ===== HourlyMetric =====
--   amazon_account_id text NOT NULL
--   marketplace_id text
--   campaign_id text
--   ad_group_id text
--   keyword_id text
--   asin text
--   date date NOT NULL
--   hour bigint NOT NULL
--   day_of_week bigint
--   impressions double precision
--   clicks double precision
--   spend double precision
--   sales double precision
--   orders double precision
--   units double precision
--   ctr double precision
--   cpc double precision
--   acos double precision
--   roas double precision
--   conversion_rate double precision
--   placement_top double precision
--   placement_rest double precision
--   placement_product double precision
--   budget_consumed_pct double precision
--   organic_sales double precision
--   total_sales double precision
--   tacos double precision
--   profit_estimate double precision
--   margin_pct double precision
--   data_maturity text
--   sample_size text
--   classification text
--   synced_at timestamptz
CREATE TABLE IF NOT EXISTS "hourly_metric" (
  id           text PRIMARY KEY,
  created_date timestamptz NOT NULL DEFAULT now(),
  updated_date timestamptz NOT NULL DEFAULT now(),
  created_by   text,
  data         jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS "hourly_metric_data_gin" ON "hourly_metric" USING gin (data);
CREATE INDEX IF NOT EXISTS "hourly_metric_created_date" ON "hourly_metric" (created_date DESC);

-- ===== Keyword =====
--   amazon_account_id text NOT NULL
--   campaign_id text
--   ad_group_id text
--   keyword_id text NOT NULL
--   asin text
--   keyword text
--   keyword_text text
--   match_type text
--   state text
--   status text
--   current_bid double precision
--   bid double precision
--   suggested_bid double precision
--   impressions double precision
--   clicks double precision
--   spend double precision
--   sales double precision
--   orders double precision
--   acos double precision
--   roas double precision
--   cpc double precision
--   ctr double precision
--   conversion_rate double precision
--   source text
--   first_seen_at timestamptz
--   last_seen_at timestamptz
--   synced_at timestamptz
--   best_hour_start bigint
--   best_hour_end bigint
--   best_hour_roas double precision
--   best_hour_sales double precision
--   best_hour_confidence double precision
--   worst_hour_start bigint
--   worst_hour_end bigint
--   worst_hour_spend double precision
--   worst_hour_sales double precision
--   hourly_action_suggestion text
--   hourly_data_mature boolean
CREATE TABLE IF NOT EXISTS "keyword" (
  id           text PRIMARY KEY,
  created_date timestamptz NOT NULL DEFAULT now(),
  updated_date timestamptz NOT NULL DEFAULT now(),
  created_by   text,
  data         jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS "keyword_data_gin" ON "keyword" USING gin (data);
CREATE INDEX IF NOT EXISTS "keyword_created_date" ON "keyword" (created_date DESC);

-- ===== KeywordBidOptimizationCycle =====
--   amazon_account_id text NOT NULL
--   marketplace_id text
--   campaign_id text
--   ad_group_id text
--   keyword_id text NOT NULL
--   keyword_text text
--   match_type text
--   asin text
--   sku text
--   target_acos double precision
--   target_acos_source text
--   initial_acos double precision
--   current_acos double precision
--   acos_gap double precision
--   acos_status text
--   initial_bid double precision
--   current_bid double precision
--   amazon_suggested_bid double precision
--   amazon_suggested_bid_lower double precision
--   amazon_suggested_bid_upper double precision
--   amazon_suggestion_used boolean
--   amazon_suggestion_limited boolean
--   first_reduction_pct double precision
--   second_reduction_pct double precision
--   total_reduction_pct double precision
--   cycle_number double precision
--   cycle_status text NOT NULL
--   executed_at timestamptz
--   evaluation_due_at timestamptz
--   stabilized_at timestamptz
--   stop_reason text
--   pre_change_impressions double precision
--   post_change_impressions double precision
--   pre_change_acos double precision
--   post_change_acos double precision
--   pre_change_cpc double precision
--   post_change_cpc double precision
--   pre_change_orders double precision
--   post_change_orders double precision
--   impression_change_pct double precision
--   acos_change_pct double precision
--   visibility_drop_detected boolean
--   amazon_response_status double precision
--   amazon_request_id text
--   amazon_response_bid double precision
--   optimization_decision_id text
--   idempotency_key text
--   requires_human_approval boolean
--   approval_reason text
--   created_at timestamptz
--   updated_at timestamptz
CREATE TABLE IF NOT EXISTS "keyword_bid_optimization_cycle" (
  id           text PRIMARY KEY,
  created_date timestamptz NOT NULL DEFAULT now(),
  updated_date timestamptz NOT NULL DEFAULT now(),
  created_by   text,
  data         jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS "keyword_bid_optimization_cycle_data_gin" ON "keyword_bid_optimization_cycle" USING gin (data);
CREATE INDEX IF NOT EXISTS "keyword_bid_optimization_cycle_created_date" ON "keyword_bid_optimization_cycle" (created_date DESC);

-- ===== KeywordLifecycle =====
--   amazon_account_id text NOT NULL
--   asin text NOT NULL
--   sku text
--   campaign_id text
--   ad_group_id text
--   keyword_id text
--   keyword_text text NOT NULL
--   normalized_keyword text
--   match_type text
--   source text
--   status text
--   enabled_at timestamptz
--   evaluation_due_at timestamptz
--   evaluation_done_at timestamptz
--   impressions double precision
--   clicks double precision
--   spend double precision
--   orders double precision
--   sales double precision
--   cpc double precision
--   ctr double precision
--   acos double precision
--   roas double precision
--   replacement_keyword_id text
--   replacement_campaign_id text
--   pause_reason text
--   paused_at timestamptz
--   source_search_term text
--   source_auto_campaign_id text
--   destination_manual_campaign_id text
--   negative_created boolean
--   created_at timestamptz
--   updated_at timestamptz
CREATE TABLE IF NOT EXISTS "keyword_lifecycle" (
  id           text PRIMARY KEY,
  created_date timestamptz NOT NULL DEFAULT now(),
  updated_date timestamptz NOT NULL DEFAULT now(),
  created_by   text,
  data         jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS "keyword_lifecycle_data_gin" ON "keyword_lifecycle" USING gin (data);
CREATE INDEX IF NOT EXISTS "keyword_lifecycle_created_date" ON "keyword_lifecycle" (created_date DESC);

-- ===== KeywordPrediction =====
--   amazon_account_id text NOT NULL
--   asin text NOT NULL
--   sku text
--   keyword text NOT NULL
--   normalized_keyword text
--   match_type text
--   source text
--   model_version text
--   tail_type text
--   word_count double precision
--   relevance_score double precision
--   conversion_probability double precision
--   keyword_quality_score double precision
--   expected_clicks double precision
--   expected_orders double precision
--   expected_conversion_rate double precision
--   expected_cpc double precision
--   expected_spend double precision
--   expected_sales double precision
--   expected_acos double precision
--   expected_roas double precision
--   expected_profit double precision
--   confidence double precision
--   data_confidence double precision
--   recommended_bid double precision
--   reason text
--   recommended_action text
--   status text
--   features_json text
--   historical_impressions double precision
--   historical_clicks double precision
--   historical_spend double precision
--   historical_orders double precision
--   historical_sales double precision
--   historical_ctr double precision
--   historical_cpc double precision
--   historical_conversion_rate double precision
--   historical_acos double precision
--   historical_roas double precision
--   negative_keyword_conflict boolean
--   duplicate_keyword boolean
--   policy_valid boolean
--   approved_at timestamptz
--   created_keyword_id text
--   expires_at timestamptz
--   actual_orders double precision
--   actual_sales double precision
--   actual_conversion_rate double precision
--   actual_acos double precision
--   actual_roas double precision
--   actual_profit double precision
--   prediction_error double precision
--   outcome_status text
--   created_at timestamptz
CREATE TABLE IF NOT EXISTS "keyword_prediction" (
  id           text PRIMARY KEY,
  created_date timestamptz NOT NULL DEFAULT now(),
  updated_date timestamptz NOT NULL DEFAULT now(),
  created_by   text,
  data         jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS "keyword_prediction_data_gin" ON "keyword_prediction" USING gin (data);
CREATE INDEX IF NOT EXISTS "keyword_prediction_created_date" ON "keyword_prediction" (created_date DESC);

-- ===== KeywordProtectionLog =====
--   amazon_account_id text NOT NULL
--   keyword_id text NOT NULL
--   keyword_text text NOT NULL
--   search_term text
--   campaign_id text
--   ad_group_id text
--   asin text
--   match_type text
--   spend_accumulated double precision
--   clicks_accumulated double precision
--   sales_accumulated double precision
--   orders_accumulated double precision
--   acos double precision
--   roas double precision
--   profit_before_ads double precision
--   economic_limit double precision
--   tolerance_factor double precision
--   limit_reached_pct double precision
--   risk_level text NOT NULL
--   action_taken text NOT NULL
--   bid_before double precision
--   bid_after double precision
--   placement_before double precision
--   placement_after double precision
--   rationale text
--   relevance_score double precision
--   days_analyzed double precision
--   data_maturity text
--   can_reactivate boolean
--   reactivation_requirements jsonb
--   created_at timestamptz
CREATE TABLE IF NOT EXISTS "keyword_protection_log" (
  id           text PRIMARY KEY,
  created_date timestamptz NOT NULL DEFAULT now(),
  updated_date timestamptz NOT NULL DEFAULT now(),
  created_by   text,
  data         jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS "keyword_protection_log_data_gin" ON "keyword_protection_log" USING gin (data);
CREATE INDEX IF NOT EXISTS "keyword_protection_log_created_date" ON "keyword_protection_log" (created_date DESC);

-- ===== KeywordRepairQueue =====
--   amazon_account_id text
--   asin text
--   campaign_id text
--   ad_group_id text
--   status text
--   queue_hour double precision
--   queue_window text
--   scheduled_at text
--   attempt_count double precision
--   last_error text
CREATE TABLE IF NOT EXISTS "keyword_repair_queue" (
  id           text PRIMARY KEY,
  created_date timestamptz NOT NULL DEFAULT now(),
  updated_date timestamptz NOT NULL DEFAULT now(),
  created_by   text,
  data         jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS "keyword_repair_queue_data_gin" ON "keyword_repair_queue" USING gin (data);
CREATE INDEX IF NOT EXISTS "keyword_repair_queue_created_date" ON "keyword_repair_queue" (created_date DESC);

-- ===== KeywordReplacementLog =====
--   amazon_account_id text NOT NULL
--   asin text
--   sku text
--   product_name text
--   campaign_id text NOT NULL
--   ad_group_id text
--   old_keyword text NOT NULL
--   old_keyword_id text
--   old_keyword_impressions double precision
--   old_keyword_clicks double precision
--   old_keyword_spend double precision
--   old_keyword_orders double precision
--   new_keyword text
--   new_keyword_id text
--   new_keyword_source text
--   new_keyword_confidence double precision
--   replacement_reason text NOT NULL
--   replacement_count double precision
--   replacement_status text
--   autopilot_decision_id text
--   next_evaluation_at timestamptz
--   created_at timestamptz
--   updated_at timestamptz
CREATE TABLE IF NOT EXISTS "keyword_replacement_log" (
  id           text PRIMARY KEY,
  created_date timestamptz NOT NULL DEFAULT now(),
  updated_date timestamptz NOT NULL DEFAULT now(),
  created_by   text,
  data         jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS "keyword_replacement_log_data_gin" ON "keyword_replacement_log" USING gin (data);
CREATE INDEX IF NOT EXISTS "keyword_replacement_log_created_date" ON "keyword_replacement_log" (created_date DESC);

-- ===== KeywordResearch =====
--   amazon_account_id text NOT NULL
--   asin text NOT NULL
--   sku text
--   product_name text
--   keyword text NOT NULL
--   keyword_type text
--   match_type text
--   source text NOT NULL
--   relevance_score bigint NOT NULL
--   search_intent text
--   estimated_volume text
--   competition text
--   suggested_bid double precision
--   status text
--   campaign_id text
--   keyword_id text
--   notes text
--   reviewed_by text
--   reviewed_at timestamptz
--   created_at timestamptz
CREATE TABLE IF NOT EXISTS "keyword_research" (
  id           text PRIMARY KEY,
  created_date timestamptz NOT NULL DEFAULT now(),
  updated_date timestamptz NOT NULL DEFAULT now(),
  created_by   text,
  data         jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS "keyword_research_data_gin" ON "keyword_research" USING gin (data);
CREATE INDEX IF NOT EXISTS "keyword_research_created_date" ON "keyword_research" (created_date DESC);

-- ===== KeywordStrategySignal =====
--   amazon_account_id text NOT NULL
--   asin text NOT NULL
--   campaign_id text
--   ad_group_id text
--   keyword_id text
--   term text NOT NULL
--   normalized_term text NOT NULL
--   source text
--   match_type text
--   word_count double precision
--   title_overlap double precision
--   buyer_intent_score double precision
--   relevance_score double precision
--   engagement_score double precision
--   conversion_score double precision
--   profitability_score double precision
--   opportunity_score double precision
--   impressions double precision
--   clicks double precision
--   orders double precision
--   spend double precision
--   sales double precision
--   ctr double precision
--   cvr double precision
--   acos double precision
--   roas double precision
--   recommended_action text
--   recommended_match_type text
--   recommended_bid double precision
--   confidence double precision
--   reason text
--   data_cutoff_at timestamptz
--   evaluated_at timestamptz NOT NULL
CREATE TABLE IF NOT EXISTS "keyword_strategy_signal" (
  id           text PRIMARY KEY,
  created_date timestamptz NOT NULL DEFAULT now(),
  updated_date timestamptz NOT NULL DEFAULT now(),
  created_by   text,
  data         jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS "keyword_strategy_signal_data_gin" ON "keyword_strategy_signal" USING gin (data);
CREATE INDEX IF NOT EXISTS "keyword_strategy_signal_created_date" ON "keyword_strategy_signal" (created_date DESC);

-- ===== KeywordSuggestion =====
--   amazon_account_id text NOT NULL
--   product_id text
--   asin text NOT NULL
--   sku text
--   keyword text NOT NULL
--   normalized_keyword text
--   match_type text
--   source text NOT NULL
--   source_asin text
--   source_asin_type text
--   target_type text
--   target_asin text
--   amazon_suggested_bid double precision
--   amazon_suggested_bid_min double precision
--   amazon_suggested_bid_max double precision
--   amazon_relevance_score double precision
--   amazon_impression_estimate double precision
--   amazon_click_estimate double precision
--   amazon_order_estimate double precision
--   amazon_raw_payload text
--   ai_rank double precision
--   ai_confidence double precision
--   ai_reason text
--   confidence double precision
--   relevance_score double precision
--   reason text
--   risk_level text
--   implementation_priority text
--   should_create_campaign boolean
--   recommended_bid double precision
--   recommended_budget double precision
--   recommended_match_type text
--   status text
--   archive_reason text
--   reactivation_blocked boolean
--   already_exists boolean
--   duplicate_of text
--   source_search_term_id text
--   source_campaign_id text
--   created_campaign_id text
--   created_keyword_id text
--   amazon_campaign_id text
--   block_reason text
--   historical_spend double precision
--   historical_sales double precision
--   historical_orders double precision
--   historical_acos double precision
--   historical_cpc double precision
--   historical_ctr double precision
--   historical_cvr double precision
--   was_negated boolean
--   synced_at timestamptz
--   created_at timestamptz
--   approved_at timestamptz
--   executed_at timestamptz
--   error text
CREATE TABLE IF NOT EXISTS "keyword_suggestion" (
  id           text PRIMARY KEY,
  created_date timestamptz NOT NULL DEFAULT now(),
  updated_date timestamptz NOT NULL DEFAULT now(),
  created_by   text,
  data         jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS "keyword_suggestion_data_gin" ON "keyword_suggestion" USING gin (data);
CREATE INDEX IF NOT EXISTS "keyword_suggestion_created_date" ON "keyword_suggestion" (created_date DESC);

-- ===== LearningEvent =====
--   amazon_account_id text NOT NULL
--   event_type text NOT NULL
--   entity_type text
--   entity_id text
--   observation text
--   metric_before double precision
--   metric_after double precision
--   decision_id text
--   outcome text
--   confidence_delta double precision
--   recorded_at timestamptz
CREATE TABLE IF NOT EXISTS "learning_event" (
  id           text PRIMARY KEY,
  created_date timestamptz NOT NULL DEFAULT now(),
  updated_date timestamptz NOT NULL DEFAULT now(),
  created_by   text,
  data         jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS "learning_event_data_gin" ON "learning_event" USING gin (data);
CREATE INDEX IF NOT EXISTS "learning_event_created_date" ON "learning_event" (created_date DESC);

-- ===== ListingEnhancementHistory =====
--   amazon_account_id text NOT NULL
--   marketplace_id text
--   product_id text
--   asin text NOT NULL
--   sku text
--   field_name text NOT NULL
--   value_before text
--   value_after text
--   proposal_id text
--   snapshot_id text
--   submitted_by text
--   submitted_at timestamptz
--   amazon_status text
--   amazon_issues text
--   confirmed_at timestamptz
--   rollback_status text
--   created_at timestamptz
CREATE TABLE IF NOT EXISTS "listing_enhancement_history" (
  id           text PRIMARY KEY,
  created_date timestamptz NOT NULL DEFAULT now(),
  updated_date timestamptz NOT NULL DEFAULT now(),
  created_by   text,
  data         jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS "listing_enhancement_history_data_gin" ON "listing_enhancement_history" USING gin (data);
CREATE INDEX IF NOT EXISTS "listing_enhancement_history_created_date" ON "listing_enhancement_history" (created_date DESC);

-- ===== ListingEnhancementProposal =====
--   amazon_account_id text NOT NULL
--   marketplace_id text
--   product_id text
--   asin text NOT NULL
--   sku text
--   product_type text
--   proposal_type text NOT NULL
--   field_name text
--   current_value text
--   proposed_value text
--   diff text
--   source text
--   rationale text
--   data_sources text
--   confidence double precision
--   risk text
--   brand_safety_status text
--   attribute_validation_status text
--   schema_validation_status text
--   approval_status text
--   submission_status text
--   amazon_submission_id text
--   amazon_issues text
--   snapshot_id text
--   approved_at timestamptz
--   approved_by text
--   rejected_at timestamptz
--   rejected_by text
--   rejection_reason text
--   submitted_at timestamptz
--   confirmed_at timestamptz
--   external_change_detected boolean
--   created_at timestamptz
--   updated_at timestamptz
CREATE TABLE IF NOT EXISTS "listing_enhancement_proposal" (
  id           text PRIMARY KEY,
  created_date timestamptz NOT NULL DEFAULT now(),
  updated_date timestamptz NOT NULL DEFAULT now(),
  created_by   text,
  data         jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS "listing_enhancement_proposal_data_gin" ON "listing_enhancement_proposal" USING gin (data);
CREATE INDEX IF NOT EXISTS "listing_enhancement_proposal_created_date" ON "listing_enhancement_proposal" (created_date DESC);

-- ===== ListingSnapshot =====
--   amazon_account_id text NOT NULL
--   marketplace_id text
--   product_id text
--   asin text NOT NULL
--   sku text
--   product_type text
--   title text
--   bullets text
--   description text
--   organic_terms text
--   attributes text
--   images text
--   price double precision
--   offer_data text
--   schema_fields text
--   required_fields text
--   missing_fields text
--   amazon_issues text
--   a_plus_content_reference text
--   sync_source text
--   sync_status text
--   sync_error text
--   synced_at timestamptz
--   created_at timestamptz
CREATE TABLE IF NOT EXISTS "listing_snapshot" (
  id           text PRIMARY KEY,
  created_date timestamptz NOT NULL DEFAULT now(),
  updated_date timestamptz NOT NULL DEFAULT now(),
  created_by   text,
  data         jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS "listing_snapshot_data_gin" ON "listing_snapshot" USING gin (data);
CREATE INDEX IF NOT EXISTS "listing_snapshot_created_date" ON "listing_snapshot" (created_date DESC);

-- ===== MLModel =====
--   amazon_account_id text NOT NULL
--   model_version double precision
--   trained_at timestamptz
--   training_samples double precision
--   confidence_score double precision
--   target_acos double precision
--   max_acos double precision
--   target_roas double precision
--   min_bid double precision
--   max_bid double precision
--   max_bid_increase_pct double precision
--   max_bid_decrease_pct double precision
--   max_budget_increase_pct double precision
--   max_budget_decrease_pct double precision
--   min_clicks_for_decision double precision
--   min_spend_for_decision double precision
--   min_orders_for_scale double precision
--   cooldown_hours double precision
--   cooldown_increase_hours double precision
--   harvest_after_orders double precision
--   bid_winner_increase_pct double precision
--   bid_strong_winner_increase_pct double precision
--   bid_wasting_reduce_pct double precision
--   bid_high_acos_formula_weight double precision
--   budget_utilization_threshold double precision
--   param_changes_applied double precision
--   last_param_update_at timestamptz
--   last_param_update_reason text
--   avg_positive_outcome_rate double precision
--   avg_bid_increase_roi double precision
--   avg_bid_decrease_roi double precision
--   avg_harvest_conversion_rate double precision
--   avg_negative_keyword_savings double precision
--   medium_tail_min_words double precision
--   medium_tail_max_words double precision
--   long_tail_min_words double precision
--   long_tail_confidence_boost double precision
--   feature_importances text
--   training_log text
CREATE TABLE IF NOT EXISTS "ml_model" (
  id           text PRIMARY KEY,
  created_date timestamptz NOT NULL DEFAULT now(),
  updated_date timestamptz NOT NULL DEFAULT now(),
  created_by   text,
  data         jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS "ml_model_data_gin" ON "ml_model" USING gin (data);
CREATE INDEX IF NOT EXISTS "ml_model_created_date" ON "ml_model" (created_date DESC);

-- ===== MLModelVersion =====
--   amazon_account_id text NOT NULL
--   version text NOT NULL
--   status text
--   readiness_score double precision
--   training_date timestamptz
--   total_candidates double precision
--   total_approved double precision
--   total_created double precision
--   total_with_sales double precision
--   precision double precision
--   recall double precision
--   conversion_prediction_accuracy double precision
--   acos_prediction_error double precision
--   roas_prediction_error double precision
--   false_positive_rate double precision
--   profit_generated double precision
--   cost_saved double precision
--   weights_json text
--   thresholds_json text
--   training_records double precision
--   training_products double precision
--   training_campaigns double precision
--   training_search_terms double precision
--   notes text
--   previous_version_id text
--   rollback_available boolean
CREATE TABLE IF NOT EXISTS "ml_model_version" (
  id           text PRIMARY KEY,
  created_date timestamptz NOT NULL DEFAULT now(),
  updated_date timestamptz NOT NULL DEFAULT now(),
  created_by   text,
  data         jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS "ml_model_version_data_gin" ON "ml_model_version" USING gin (data);
CREATE INDEX IF NOT EXISTS "ml_model_version_created_date" ON "ml_model_version" (created_date DESC);

-- ===== ManualCampaignBidLifecycle =====
--   amazon_account_id text NOT NULL
--   marketplace_id text
--   campaign_id text NOT NULL
--   ad_group_id text NOT NULL
--   keyword_id text NOT NULL
--   asin text
--   sku text
--   keyword_text text
--   match_type text
--   campaign_name text
--   ad_group_name text
--   campaign_created_at timestamptz
--   initial_bid double precision
--   ad_group_initial_bid double precision
--   keyword_initial_bid double precision
--   amazon_suggested_bid double precision
--   amazon_suggested_bid_lower double precision
--   amazon_suggested_bid_upper double precision
--   amazon_suggestion_fetched_at timestamptz
--   amazon_suggestion_valid boolean
--   post_48h_bid double precision
--   post_48h_bid_source text
--   amazon_suggestion_limited_by_guardrail boolean
--   current_ad_group_default_bid double precision
--   current_keyword_bid double precision
--   amazon_confirmed_ad_group_bid double precision
--   amazon_confirmed_keyword_bid double precision
--   amazon_confirmed_at timestamptz
--   amazon_request_id text
--   ad_group_keywords_count double precision
--   keyword_has_individual_bid boolean
--   management_source text
--   status text NOT NULL
--   first_48h_ends_at timestamptz
--   post_48h_adjusted_at timestamptz
--   review_72h_at timestamptz
--   next_review_at timestamptz
--   cooldown_until timestamptz
--   target_acos double precision
--   target_acos_source text
--   current_acos double precision
--   current_spend double precision
--   current_sales double precision
--   current_orders double precision
--   impressions double precision
--   clicks double precision
--   last_action text
--   last_action_at timestamptz
--   last_action_result text
--   emergency_triggered boolean
--   emergency_reason text
--   idempotency_key text
--   created_at timestamptz
--   updated_at timestamptz
CREATE TABLE IF NOT EXISTS "manual_campaign_bid_lifecycle" (
  id           text PRIMARY KEY,
  created_date timestamptz NOT NULL DEFAULT now(),
  updated_date timestamptz NOT NULL DEFAULT now(),
  created_by   text,
  data         jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS "manual_campaign_bid_lifecycle_data_gin" ON "manual_campaign_bid_lifecycle" USING gin (data);
CREATE INDEX IF NOT EXISTS "manual_campaign_bid_lifecycle_created_date" ON "manual_campaign_bid_lifecycle" (created_date DESC);

-- ===== MotorRuleChangeProposal =====
--   amazon_account_id text NOT NULL
--   weekly_prelection_id text
--   rule_name text NOT NULL
--   current_rule text
--   proposed_rule text
--   reason text
--   evidence text
--   affected_metric text
--   expected_impact text
--   confidence double precision
--   risk_level text
--   status text
--   requires_manual_approval boolean
--   created_at timestamptz
--   implemented_at timestamptz
--   result_after_7d jsonb
--   result_after_14d jsonb
CREATE TABLE IF NOT EXISTS "motor_rule_change_proposal" (
  id           text PRIMARY KEY,
  created_date timestamptz NOT NULL DEFAULT now(),
  updated_date timestamptz NOT NULL DEFAULT now(),
  created_by   text,
  data         jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS "motor_rule_change_proposal_data_gin" ON "motor_rule_change_proposal" USING gin (data);
CREATE INDEX IF NOT EXISTS "motor_rule_change_proposal_created_date" ON "motor_rule_change_proposal" (created_date DESC);

-- ===== NegativeKeywordSuggestion =====
--   amazon_account_id text NOT NULL
--   campaign_id text
--   campaign_name text
--   ad_group_id text
--   keyword_text text NOT NULL
--   match_type text
--   clicks double precision
--   spend double precision
--   sales double precision
--   acos double precision
--   reason text
--   status text
--   applied_at timestamptz
CREATE TABLE IF NOT EXISTS "negative_keyword_suggestion" (
  id           text PRIMARY KEY,
  created_date timestamptz NOT NULL DEFAULT now(),
  updated_date timestamptz NOT NULL DEFAULT now(),
  created_by   text,
  data         jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS "negative_keyword_suggestion_data_gin" ON "negative_keyword_suggestion" USING gin (data);
CREATE INDEX IF NOT EXISTS "negative_keyword_suggestion_created_date" ON "negative_keyword_suggestion" (created_date DESC);

-- ===== NewProductTermBankRun =====
--   amazon_account_id text NOT NULL
--   started_at timestamptz
--   finished_at timestamptz
--   trigger text
--   products_scanned double precision
--   new_products_found double precision
--   restocked_products_found double precision
--   products_processed double precision
--   terms_generated double precision
--   terms_created double precision
--   terms_updated double precision
--   terms_rejected double precision
--   ai_calls_used double precision
--   fallback_used double precision
--   products_skipped double precision
--   errors jsonb
--   status text
CREATE TABLE IF NOT EXISTS "new_product_term_bank_run" (
  id           text PRIMARY KEY,
  created_date timestamptz NOT NULL DEFAULT now(),
  updated_date timestamptz NOT NULL DEFAULT now(),
  created_by   text,
  data         jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS "new_product_term_bank_run_data_gin" ON "new_product_term_bank_run" USING gin (data);
CREATE INDEX IF NOT EXISTS "new_product_term_bank_run_created_date" ON "new_product_term_bank_run" (created_date DESC);

-- ===== OptimizationDecision =====
--   amazon_account_id text NOT NULL
--   run_id text
--   decision_type text NOT NULL
--   entity_type text
--   entity_id text
--   campaign_id text
--   ad_group_id text
--   keyword_id text
--   keyword_text text
--   asin text
--   profile_id text
--   marketplace_id text
--   country_code text
--   currency_code text
--   currency_symbol text
--   action text NOT NULL
--   value_before double precision
--   value_after double precision
--   change_pct double precision
--   objective text
--   rationale text
--   data_used text
--   period_analyzed text
--   sample_size text
--   confidence double precision
--   risk text
--   expected_impact text
--   reversible boolean
--   requires_approval boolean
--   status text NOT NULL
--   queue_status text
--   queue_hour double precision
--   queue_window text
--   queued_at timestamptz
--   queue_processed_at timestamptz
--   scheduled_for timestamptz
--   next_retry_at timestamptz
--   executed_at timestamptz
--   review_date timestamptz
--   amazon_response text
--   error_message text
--   created_at timestamptz
--   updated_at timestamptz
--   legacy_source text
--   legacy_id text
--   idempotency_key text
--   trigger text
--   metrics_before text
--   metrics_after text
--   evaluation_due_at timestamptz
--   evaluated_at timestamptz
--   outcome text
--   rollback_payload text
--   rollback_status text
--   source_search_term_id text
--   source_campaign_id text
--   source_keyword_id text
--   source_function text
--   amazon_request_id text
--   attempt_count double precision
--   last_attempt_at timestamptz
CREATE TABLE IF NOT EXISTS "optimization_decision" (
  id           text PRIMARY KEY,
  created_date timestamptz NOT NULL DEFAULT now(),
  updated_date timestamptz NOT NULL DEFAULT now(),
  created_by   text,
  data         jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS "optimization_decision_data_gin" ON "optimization_decision" USING gin (data);
CREATE INDEX IF NOT EXISTS "optimization_decision_created_date" ON "optimization_decision" (created_date DESC);

-- ===== PacingLog =====
--   amazon_account_id text NOT NULL
--   campaign_id text NOT NULL
--   date date NOT NULL
--   hour bigint NOT NULL
--   daily_budget double precision NOT NULL
--   spent_to_date double precision NOT NULL
--   spent_pct double precision
--   expected_pct double precision
--   pacing_ratio double precision
--   pacing_status text
--   burn_rate_hourly double precision
--   exhaustion_forecast timestamptz
--   exhaustion_risk text
--   next_peak_window text
--   reserved_budget double precision
--   action_taken text
--   action_rationale text
--   created_at timestamptz
CREATE TABLE IF NOT EXISTS "pacing_log" (
  id           text PRIMARY KEY,
  created_date timestamptz NOT NULL DEFAULT now(),
  updated_date timestamptz NOT NULL DEFAULT now(),
  created_by   text,
  data         jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS "pacing_log_data_gin" ON "pacing_log" USING gin (data);
CREATE INDEX IF NOT EXISTS "pacing_log_created_date" ON "pacing_log" (created_date DESC);

-- ===== PerformanceSettings =====
--   amazon_account_id text NOT NULL
--   primary_goal text
--   target_acos double precision
--   max_acos double precision
--   target_roas double precision
--   target_tacos double precision
--   max_tacos double precision
--   daily_budget_limit double precision
--   suggested_daily_budget double precision
--   calculated_daily_budget double precision
--   target_cpc double precision
--   max_cpc double precision
--   min_bid double precision
--   max_bid double precision
--   max_bid_increase_pct double precision
--   max_bid_decrease_pct double precision
--   target_daily_impressions double precision
--   min_daily_impressions double precision
--   max_daily_impressions double precision
--   impressions_goal_enabled boolean
--   target_coverage_hours double precision
--   pacing_enabled boolean
--   dayparting_enabled boolean
--   placement_optimization_enabled boolean
--   first_page_exposure_enabled boolean
--   top_of_search_limit double precision
--   rest_of_search_limit double precision
--   product_page_limit double precision
--   minimum_campaign_budget double precision
--   campaign_budget_increment double precision
--   weekly_campaign_capacity double precision
--   budget_formula_version text
--   last_budget_recalculation timestamptz
--   next_budget_recalculation timestamptz
--   objective text
--   ai_auto_optimization boolean
--   updated_at timestamptz
CREATE TABLE IF NOT EXISTS "performance_settings" (
  id           text PRIMARY KEY,
  created_date timestamptz NOT NULL DEFAULT now(),
  updated_date timestamptz NOT NULL DEFAULT now(),
  created_by   text,
  data         jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS "performance_settings_data_gin" ON "performance_settings" USING gin (data);
CREATE INDEX IF NOT EXISTS "performance_settings_created_date" ON "performance_settings" (created_date DESC);

-- ===== PerformanceSettingsHistory =====
--   amazon_account_id text NOT NULL
--   changed_by_id text
--   changed_by_name text
--   changed_by_email text
--   snapshot jsonb
--   changed_fields jsonb
--   changed_at timestamptz NOT NULL
CREATE TABLE IF NOT EXISTS "performance_settings_history" (
  id           text PRIMARY KEY,
  created_date timestamptz NOT NULL DEFAULT now(),
  updated_date timestamptz NOT NULL DEFAULT now(),
  created_by   text,
  data         jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS "performance_settings_history_data_gin" ON "performance_settings_history" USING gin (data);
CREATE INDEX IF NOT EXISTS "performance_settings_history_created_date" ON "performance_settings_history" (created_date DESC);

-- ===== Product =====
--   amazon_account_id text NOT NULL
--   asin text NOT NULL
--   sku text
--   product_name text
--   display_name text
--   product_image_url text
--   brand text
--   status text
--   inventory_status text
--   previous_inventory_status text
--   previous_fba_inventory double precision
--   fba_inventory double precision
--   reserved_inventory double precision
--   inbound_inventory double precision
--   available_quantity double precision
--   total_quantity double precision
--   price double precision
--   first_available_date date
--   is_new_asin boolean
--   has_campaign boolean
--   campaign_status text
--   should_activate_campaign boolean
--   linked_campaign_id text
--   linked_campaign_name text
--   linked_campaign_count double precision
--   linked_campaign_ids jsonb
--   campaign_link_updated_at timestamptz
--   auto_campaign_created_at timestamptz
--   manual_campaign_created_at timestamptz
--   days_since_launch double precision
--   total_spend_30d double precision
--   total_sales_30d double precision
--   total_units_30d double precision
--   acos double precision
--   roas double precision
--   category text
--   catalog_sync_status text
--   catalog_sync_error text
--   catalog_sync_attempts double precision
--   last_catalog_sync_at timestamptz
--   last_sync_at timestamptz
--   synced_at timestamptz
--   product_cost double precision
--   extra_cost double precision
--   cost_confirmed boolean
--   cost_confirmation_required boolean
--   cost_source text
--   cost_confirmed_at timestamptz
--   cost_confirmed_by text
--   maximum_ad_spend_per_order double precision
--   break_even_acos_pct double precision
--   available_profit_per_sale double precision
--   auto_campaign_eligible boolean
--   keyword_confidence_threshold double precision
--   cost_dialog_seen_at timestamptz
--   amazon_fees double precision
--   contribution_margin double precision
--   profit_margin_pct double precision
--   buy_box_status text
--   buy_box_price double precision
--   stock_days double precision
--   minimum_stock double precision
--   organic_sales_30d double precision
--   ad_sales_30d double precision
--   tacos double precision
--   profit_after_ads double precision
--   sessions_30d double precision
--   conversion_rate_30d double precision
--   ads_scope_status text
--   ads_authorized_by_user boolean
--   ads_authorized_at timestamptz
--   ads_authorized_by text
--   ads_eligibility_status text
--   ads_ineligibility_reason text
--   ads_last_eligibility_check_at timestamptz
--   ads_resume_pending boolean
--   ads_previous_campaign_state text
--   ads_pause_reason text
--   ads_paused_at timestamptz
--   ads_mapping_conflict_asin text
--   ads_mapping_conflict_sku text
--   ads_scope_updated_at timestamptz
--   ads_scope_updated_by text
--   listing_buyable boolean
--   offer_active boolean
--   listing_suppressed boolean
CREATE TABLE IF NOT EXISTS "product" (
  id           text PRIMARY KEY,
  created_date timestamptz NOT NULL DEFAULT now(),
  updated_date timestamptz NOT NULL DEFAULT now(),
  created_by   text,
  data         jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS "product_data_gin" ON "product" USING gin (data);
CREATE INDEX IF NOT EXISTS "product_created_date" ON "product" (created_date DESC);

-- ===== ProductAd =====
--   amazon_account_id text NOT NULL
--   product_ad_id text NOT NULL
--   campaign_id text
--   ad_group_id text
--   asin text
--   sku text
--   state text
--   status text
--   bid double precision
--   impressions double precision
--   clicks double precision
--   spend double precision
--   sales double precision
--   orders double precision
--   acos double precision
--   roas double precision
--   synced_at timestamptz
CREATE TABLE IF NOT EXISTS "product_ad" (
  id           text PRIMARY KEY,
  created_date timestamptz NOT NULL DEFAULT now(),
  updated_date timestamptz NOT NULL DEFAULT now(),
  created_by   text,
  data         jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS "product_ad_data_gin" ON "product_ad" USING gin (data);
CREATE INDEX IF NOT EXISTS "product_ad_created_date" ON "product_ad" (created_date DESC);

-- ===== ProductEconomics =====
--   amazon_account_id text NOT NULL
--   marketplace_id text
--   product_id text
--   asin text
--   sku text NOT NULL
--   normalized_sku text
--   product_name text
--   unit_cost double precision
--   inbound_freight_per_unit double precision
--   tax_per_unit double precision
--   logistics_cost_per_unit double precision
--   packaging_cost_per_unit double precision
--   other_variable_cost_per_unit double precision
--   other_cost_description text
--   total_variable_cost_per_unit double precision
--   current_price double precision
--   average_sale_price double precision
--   amazon_fee_amount double precision
--   amazon_fee_percent double precision
--   contribution_margin_amount double precision
--   contribution_margin_percent double precision
--   break_even_acos double precision
--   target_acos double precision
--   target_roas double precision
--   safe_max_cpc double precision
--   maximum_profitable_ad_spend double precision
--   profit_before_ads double precision
--   profit_after_ads double precision
--   profit_after_ads_percent double precision
--   profit_after_ads_14d double precision
--   profit_after_ads_7d double precision
--   profit_after_ads_3d double precision
--   profit_erosion_velocity double precision
--   profit_erosion_alert boolean
--   ad_spend_per_order_14d double precision
--   ad_spend_per_order_3d double precision
--   profit_protection_mode text
--   profit_protection_triggered_at timestamptz
--   profit_protection_reason text
--   economic_classification text
--   cost_source text
--   price_source text
--   fees_source text
--   economics_status text
--   product_link_status text
--   cost_confidence double precision
--   price_confidence double precision
--   fees_confidence double precision
--   final_economic_confidence double precision
--   import_batch_id text
--   imported_by text
--   imported_at timestamptz
--   effective_from date
--   effective_to date
--   last_calculated_at timestamptz
--   last_prompted_at timestamptz
--   prompt_dismissed_at timestamptz
--   created_at timestamptz
--   updated_at timestamptz
CREATE TABLE IF NOT EXISTS "product_economics" (
  id           text PRIMARY KEY,
  created_date timestamptz NOT NULL DEFAULT now(),
  updated_date timestamptz NOT NULL DEFAULT now(),
  created_by   text,
  data         jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS "product_economics_data_gin" ON "product_economics" USING gin (data);
CREATE INDEX IF NOT EXISTS "product_economics_created_date" ON "product_economics" (created_date DESC);

-- ===== ProductEconomicsHistory =====
--   amazon_account_id text NOT NULL
--   product_id text
--   asin text
--   sku text NOT NULL
--   normalized_sku text
--   unit_cost_before double precision
--   unit_cost_after double precision
--   additional_cost_before double precision
--   additional_cost_after double precision
--   price_before double precision
--   price_after double precision
--   fee_before double precision
--   fee_after double precision
--   margin_before double precision
--   margin_after double precision
--   break_even_before double precision
--   break_even_after double precision
--   source text
--   reason text
--   import_batch_id text
--   effective_from date
--   changed_by text
--   changed_at timestamptz NOT NULL
CREATE TABLE IF NOT EXISTS "product_economics_history" (
  id           text PRIMARY KEY,
  created_date timestamptz NOT NULL DEFAULT now(),
  updated_date timestamptz NOT NULL DEFAULT now(),
  created_by   text,
  data         jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS "product_economics_history_data_gin" ON "product_economics_history" USING gin (data);
CREATE INDEX IF NOT EXISTS "product_economics_history_created_date" ON "product_economics_history" (created_date DESC);

-- ===== ProductKickoffQueue =====
--   amazon_account_id text NOT NULL
--   asin text NOT NULL
--   sku text
--   product_name text
--   mode text NOT NULL
--   keyword text
--   status text NOT NULL
--   queue_hour double precision NOT NULL
--   queue_window text NOT NULL
--   scheduled_at timestamptz NOT NULL
--   attempt_count double precision
--   max_attempts double precision
--   started_at timestamptz
--   completed_at timestamptz
--   last_error text
CREATE TABLE IF NOT EXISTS "product_kickoff_queue" (
  id           text PRIMARY KEY,
  created_date timestamptz NOT NULL DEFAULT now(),
  updated_date timestamptz NOT NULL DEFAULT now(),
  created_by   text,
  data         jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS "product_kickoff_queue_data_gin" ON "product_kickoff_queue" USING gin (data);
CREATE INDEX IF NOT EXISTS "product_kickoff_queue_created_date" ON "product_kickoff_queue" (created_date DESC);

-- ===== ProductProfitabilityLearning =====
--   amazon_account_id text NOT NULL
--   period_start date
--   period_end date
--   asin text
--   sku text NOT NULL
--   product_name text
--   average_price double precision
--   average_unit_cost double precision
--   units_sold double precision
--   gross_revenue double precision
--   revenue_share_pct double precision
--   gross_profit double precision
--   gross_margin_pct double precision
--   ads_cost double precision
--   profit_after_ads double precision
--   mpa_pct double precision
--   tacos_pct double precision
--   profitability_status text
--   performance_class text
--   decision_recommendation text
--   learning_note text
--   ads_blocked boolean
--   bid_increase_blocked boolean
--   budget_increase_blocked boolean
--   top_of_search_blocked boolean
--   source text
--   created_at timestamptz
--   updated_at timestamptz
CREATE TABLE IF NOT EXISTS "product_profitability_learning" (
  id           text PRIMARY KEY,
  created_date timestamptz NOT NULL DEFAULT now(),
  updated_date timestamptz NOT NULL DEFAULT now(),
  created_by   text,
  data         jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS "product_profitability_learning_data_gin" ON "product_profitability_learning" USING gin (data);
CREATE INDEX IF NOT EXISTS "product_profitability_learning_created_date" ON "product_profitability_learning" (created_date DESC);

-- ===== ProductTarget =====
--   amazon_account_id text NOT NULL
--   campaign_id text NOT NULL
--   ad_group_id text NOT NULL
--   target_id text
--   target_type text NOT NULL
--   target_value text NOT NULL
--   bid double precision
--   state text
--   status text
--   is_negative boolean
--   impressions double precision
--   clicks double precision
--   spend double precision
--   sales double precision
--   acos double precision
--   roas double precision
--   synced_at timestamptz
CREATE TABLE IF NOT EXISTS "product_target" (
  id           text PRIMARY KEY,
  created_date timestamptz NOT NULL DEFAULT now(),
  updated_date timestamptz NOT NULL DEFAULT now(),
  created_by   text,
  data         jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS "product_target_data_gin" ON "product_target" USING gin (data);
CREATE INDEX IF NOT EXISTS "product_target_created_date" ON "product_target" (created_date DESC);

-- ===== ProductTitleTermCache =====
--   amazon_account_id text NOT NULL
--   asin text NOT NULL
--   sku text
--   title_hash text NOT NULL
--   product_title text
--   terms_json text
--   terms_count double precision
--   min_confidence double precision
--   source text
--   created_at timestamptz
--   expires_at timestamptz
CREATE TABLE IF NOT EXISTS "product_title_term_cache" (
  id           text PRIMARY KEY,
  created_date timestamptz NOT NULL DEFAULT now(),
  updated_date timestamptz NOT NULL DEFAULT now(),
  created_by   text,
  data         jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS "product_title_term_cache_data_gin" ON "product_title_term_cache" USING gin (data);
CREATE INDEX IF NOT EXISTS "product_title_term_cache_created_date" ON "product_title_term_cache" (created_date DESC);

-- ===== RuleApproval =====
--   amazon_account_id text NOT NULL
--   rule_key text NOT NULL
--   review_id text
--   action text NOT NULL
--   approved_by text
--   reason text
--   approved_at timestamptz
--   requires_manual_approval boolean
CREATE TABLE IF NOT EXISTS "rule_approval" (
  id           text PRIMARY KEY,
  created_date timestamptz NOT NULL DEFAULT now(),
  updated_date timestamptz NOT NULL DEFAULT now(),
  created_by   text,
  data         jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS "rule_approval_data_gin" ON "rule_approval" USING gin (data);
CREATE INDEX IF NOT EXISTS "rule_approval_created_date" ON "rule_approval" (created_date DESC);

-- ===== RuleBacktest =====
--   amazon_account_id text NOT NULL
--   review_id text
--   rule_key text NOT NULL
--   rule_version double precision
--   period_days double precision
--   records_tested double precision
--   actions_simulated double precision
--   spend_real double precision
--   spend_simulated double precision
--   sales_real double precision
--   sales_simulated double precision
--   profit_real double precision
--   profit_simulated double precision
--   acos_real double precision
--   acos_simulated double precision
--   tacos_real double precision
--   tacos_simulated double precision
--   passed boolean
--   rejection_reasons jsonb
--   risk_level text
CREATE TABLE IF NOT EXISTS "rule_backtest" (
  id           text PRIMARY KEY,
  created_date timestamptz NOT NULL DEFAULT now(),
  updated_date timestamptz NOT NULL DEFAULT now(),
  created_by   text,
  data         jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS "rule_backtest_data_gin" ON "rule_backtest" USING gin (data);
CREATE INDEX IF NOT EXISTS "rule_backtest_created_date" ON "rule_backtest" (created_date DESC);

-- ===== RuleConflict =====
--   amazon_account_id text NOT NULL
--   correlation_id text
--   rule_key_a text NOT NULL
--   rule_key_b text NOT NULL
--   conflict_type text
--   entity_id text
--   resolution text
--   rule_executed text
--   rule_skipped text
--   resolved_at timestamptz
CREATE TABLE IF NOT EXISTS "rule_conflict" (
  id           text PRIMARY KEY,
  created_date timestamptz NOT NULL DEFAULT now(),
  updated_date timestamptz NOT NULL DEFAULT now(),
  created_by   text,
  data         jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS "rule_conflict_data_gin" ON "rule_conflict" USING gin (data);
CREATE INDEX IF NOT EXISTS "rule_conflict_created_date" ON "rule_conflict" (created_date DESC);

-- ===== RuleExecution =====
--   amazon_account_id text NOT NULL
--   correlation_id text
--   rule_key text NOT NULL
--   rule_version double precision
--   entity_type text
--   entity_id text
--   campaign_id text
--   keyword_id text
--   asin text
--   action_type text
--   value_before double precision
--   value_after double precision
--   idempotency_key text NOT NULL
--   status text
--   executed_at timestamptz
--   error_message text
--   amazon_response text
--   metrics_before text
--   metrics_after text
--   outcome text
--   rollback_available boolean
--   rolled_back_at timestamptz
CREATE TABLE IF NOT EXISTS "rule_execution" (
  id           text PRIMARY KEY,
  created_date timestamptz NOT NULL DEFAULT now(),
  updated_date timestamptz NOT NULL DEFAULT now(),
  created_by   text,
  data         jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS "rule_execution_data_gin" ON "rule_execution" USING gin (data);
CREATE INDEX IF NOT EXISTS "rule_execution_created_date" ON "rule_execution" (created_date DESC);

-- ===== RuleRollback =====
--   amazon_account_id text NOT NULL
--   rule_key text NOT NULL
--   rule_version double precision
--   version_id text
--   trigger text
--   reason text
--   rolled_back_at timestamptz
--   previous_version_restored text
--   actions_cancelled double precision
--   reactivation_blocked_until timestamptz
--   metrics_at_rollback text
CREATE TABLE IF NOT EXISTS "rule_rollback" (
  id           text PRIMARY KEY,
  created_date timestamptz NOT NULL DEFAULT now(),
  updated_date timestamptz NOT NULL DEFAULT now(),
  created_by   text,
  data         jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS "rule_rollback_data_gin" ON "rule_rollback" USING gin (data);
CREATE INDEX IF NOT EXISTS "rule_rollback_created_date" ON "rule_rollback" (created_date DESC);

-- ===== SalesDaily =====
--   amazon_account_id text NOT NULL
--   asin text
--   date date NOT NULL
--   units_ordered double precision
--   ordered_product_sales double precision
--   sessions double precision
--   page_views double precision
--   buy_box_pct double precision
--   conversion_rate double precision
CREATE TABLE IF NOT EXISTS "sales_daily" (
  id           text PRIMARY KEY,
  created_date timestamptz NOT NULL DEFAULT now(),
  updated_date timestamptz NOT NULL DEFAULT now(),
  created_by   text,
  data         jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS "sales_daily_data_gin" ON "sales_daily" USING gin (data);
CREATE INDEX IF NOT EXISTS "sales_daily_created_date" ON "sales_daily" (created_date DESC);

-- ===== SearchTerm =====
--   amazon_account_id text NOT NULL
--   date date NOT NULL
--   campaign_id text
--   campaign_name text
--   ad_group_id text
--   ad_group_name text
--   keyword_id text
--   keyword_text text
--   keyword_type text
--   match_type text
--   search_term text
--   advertised_asin text
--   advertised_sku text
--   impressions double precision
--   clicks double precision
--   ctr double precision
--   cpc double precision
--   spend double precision
--   orders_1d double precision
--   orders_7d double precision
--   orders_14d double precision
--   orders_30d double precision
--   units_1d double precision
--   units_7d double precision
--   units_14d double precision
--   units_30d double precision
--   sales_1d double precision
--   sales_7d double precision
--   sales_14d double precision
--   sales_30d double precision
--   acos_7d double precision
--   acos_14d double precision
--   roas_7d double precision
--   roas_14d double precision
--   conversion_rate double precision
--   unique_key text NOT NULL
--   synced_at timestamptz
--   classification text
--   relevance_status text
--   decision_status text
--   first_sale_at timestamptz
--   last_sale_at timestamptz
--   first_seen_at timestamptz
--   last_seen_at timestamptz
--   promoted_to_manual boolean
--   promoted_at timestamptz
--   manual_campaign_id text
--   manual_ad_group_id text
--   manual_keyword_id text
--   manual_keyword_state text
--   negated_in_source boolean
--   negated_at timestamptz
--   source_campaign_type text
--   source_target_type text
--   source_target_id text
--   evaluation_count double precision
--   last_evaluated_at timestamptz
--   last_action text
--   last_action_at timestamptz
--   performance_window text
--   profit_estimate double precision
--   target_acos double precision
--   recommended_bid double precision
--   maximum_profitable_cpc double precision
CREATE TABLE IF NOT EXISTS "search_term" (
  id           text PRIMARY KEY,
  created_date timestamptz NOT NULL DEFAULT now(),
  updated_date timestamptz NOT NULL DEFAULT now(),
  created_by   text,
  data         jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS "search_term_data_gin" ON "search_term" USING gin (data);
CREATE INDEX IF NOT EXISTS "search_term_created_date" ON "search_term" (created_date DESC);

-- ===== SearchTermPromotion =====
--   amazon_account_id text NOT NULL
--   asin text NOT NULL
--   sku text
--   source_campaign_id text NOT NULL
--   source_ad_group_id text
--   source_search_term text NOT NULL
--   normalized_search_term text
--   orders double precision
--   units_sold double precision
--   sales double precision
--   spend double precision
--   clicks double precision
--   average_cpc double precision
--   acos double precision
--   roas double precision
--   target_bid double precision
--   destination_campaign_id text
--   destination_campaign_name text
--   destination_ad_group_id text
--   destination_ad_id text
--   destination_keyword_id text
--   negative_keyword_id text
--   promotion_status text
--   completion_status text
--   idempotency_key text
--   last_error text
--   retry_count double precision
--   ai_validated boolean
--   ai_relevance_check text
--   created_at timestamptz
--   updated_at timestamptz
--   completed_at timestamptz
--   next_retry_at timestamptz
CREATE TABLE IF NOT EXISTS "search_term_promotion" (
  id           text PRIMARY KEY,
  created_date timestamptz NOT NULL DEFAULT now(),
  updated_date timestamptz NOT NULL DEFAULT now(),
  created_by   text,
  data         jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS "search_term_promotion_data_gin" ON "search_term_promotion" USING gin (data);
CREATE INDEX IF NOT EXISTS "search_term_promotion_created_date" ON "search_term_promotion" (created_date DESC);

-- ===== SeasonalityCalendar =====
--   amazon_account_id text
--   name text NOT NULL
--   event_type text NOT NULL
--   country text
--   marketplace text
--   start_date date NOT NULL
--   end_date date NOT NULL
--   peak_date date
--   pre_event_days double precision
--   post_event_days double precision
--   expected_demand_level text
--   expected_cpc_pressure text
--   budget_multiplier_limit double precision
--   bid_multiplier_limit double precision
--   priority_categories jsonb
--   notes text
--   enabled boolean
--   is_recurring_annual boolean
--   created_at timestamptz
--   updated_at timestamptz
CREATE TABLE IF NOT EXISTS "seasonality_calendar" (
  id           text PRIMARY KEY,
  created_date timestamptz NOT NULL DEFAULT now(),
  updated_date timestamptz NOT NULL DEFAULT now(),
  created_by   text,
  data         jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS "seasonality_calendar_data_gin" ON "seasonality_calendar" USING gin (data);
CREATE INDEX IF NOT EXISTS "seasonality_calendar_created_date" ON "seasonality_calendar" (created_date DESC);

-- ===== SellerPerformanceBenchmark =====
--   amazon_account_id text NOT NULL
--   period_start date NOT NULL
--   period_end date NOT NULL
--   source text
--   label text
--   gross_revenue double precision
--   marketplace_net_revenue double precision
--   gross_profit double precision
--   gross_margin_pct double precision
--   sales_count double precision
--   units_sold double precision
--   average_ticket double precision
--   roi_pct double precision
--   ads_spend double precision
--   tacos_pct double precision
--   gross_profit_after_ads double precision
--   mpa_pct double precision
--   notes text
--   created_at timestamptz
--   updated_at timestamptz
CREATE TABLE IF NOT EXISTS "seller_performance_benchmark" (
  id           text PRIMARY KEY,
  created_date timestamptz NOT NULL DEFAULT now(),
  updated_date timestamptz NOT NULL DEFAULT now(),
  created_by   text,
  data         jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS "seller_performance_benchmark_data_gin" ON "seller_performance_benchmark" USING gin (data);
CREATE INDEX IF NOT EXISTS "seller_performance_benchmark_created_date" ON "seller_performance_benchmark" (created_date DESC);

-- ===== StrategyExecutionLog =====
--   strategy_id text NOT NULL
--   amazon_account_id text NOT NULL
--   campaign_id text
--   campaign_name text
--   ad_group_id text
--   keyword_id text
--   keyword_text text
--   asin text
--   action_type text NOT NULL
--   before_metrics jsonb
--   action_taken jsonb
--   after_metrics_24h jsonb
--   after_metrics_48h jsonb
--   after_metrics_7d jsonb
--   maturation_until timestamptz
--   maturation_hours double precision
--   evaluated_at timestamptz
--   success boolean
--   failure_reason text
--   next_recommendation text
--   risk_level text
--   status text
--   created_at timestamptz
--   updated_at timestamptz
CREATE TABLE IF NOT EXISTS "strategy_execution_log" (
  id           text PRIMARY KEY,
  created_date timestamptz NOT NULL DEFAULT now(),
  updated_date timestamptz NOT NULL DEFAULT now(),
  created_by   text,
  data         jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS "strategy_execution_log_data_gin" ON "strategy_execution_log" USING gin (data);
CREATE INDEX IF NOT EXISTS "strategy_execution_log_created_date" ON "strategy_execution_log" (created_date DESC);

-- ===== StrategyPlaybook =====
--   strategy_id text NOT NULL
--   strategy_name text NOT NULL
--   goal_targeted text
--   trigger_conditions jsonb
--   required_metrics jsonb
--   action_type text NOT NULL
--   action_payload jsonb
--   maturation_hours double precision
--   success_criteria jsonb
--   failure_criteria jsonb
--   next_action_if_success text
--   next_action_if_failure text
--   risk_level text
--   use_ai boolean
--   use_rule_engine boolean
--   integration_required boolean
--   estimated_cost double precision
--   enabled boolean
--   priority double precision
--   created_at timestamptz
--   updated_at timestamptz
CREATE TABLE IF NOT EXISTS "strategy_playbook" (
  id           text PRIMARY KEY,
  created_date timestamptz NOT NULL DEFAULT now(),
  updated_date timestamptz NOT NULL DEFAULT now(),
  created_by   text,
  data         jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS "strategy_playbook_data_gin" ON "strategy_playbook" USING gin (data);
CREATE INDEX IF NOT EXISTS "strategy_playbook_created_date" ON "strategy_playbook" (created_date DESC);

-- ===== StrategySession =====
--   amazon_account_id text NOT NULL
--   profile_id text
--   marketplace_id text
--   product_id text
--   asin text NOT NULL
--   sku text
--   campaign_ids jsonb
--   mode text NOT NULL
--   status text NOT NULL
--   started_at timestamptz
--   ends_at timestamptz
--   completed_at timestamptz
--   rollback_started_at timestamptz
--   rollback_completed_at timestamptz
--   triggered_by text
--   autopilot_authorized boolean
--   original_state_snapshot_id text
--   strategy_plan text
--   applied_changes text
--   created_campaign_ids jsonb
--   created_keyword_ids jsonb
--   created_target_ids jsonb
--   created_negative_ids jsonb
--   decisions_count double precision
--   decisions_executed double precision
--   decisions_failed double precision
--   bids_affected double precision
--   budgets_affected double precision
--   campaigns_created double precision
--   keywords_created double precision
--   sessions_spend double precision
--   sessions_sales double precision
--   sessions_orders double precision
--   sessions_acos double precision
--   last_evaluation_at timestamptz
--   next_evaluation_at timestamptz
--   error_message text
--   idempotency_key text
--   created_at timestamptz
--   updated_at timestamptz
CREATE TABLE IF NOT EXISTS "strategy_session" (
  id           text PRIMARY KEY,
  created_date timestamptz NOT NULL DEFAULT now(),
  updated_date timestamptz NOT NULL DEFAULT now(),
  created_by   text,
  data         jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS "strategy_session_data_gin" ON "strategy_session" USING gin (data);
CREATE INDEX IF NOT EXISTS "strategy_session_created_date" ON "strategy_session" (created_date DESC);

-- ===== StrategyStateSnapshot =====
--   amazon_account_id text NOT NULL
--   strategy_session_id text
--   asin text NOT NULL
--   sku text
--   mode text NOT NULL
--   campaigns_snapshot text
--   keywords_snapshot text
--   targets_snapshot text
--   performance_settings_snapshot text
--   autopilot_config_snapshot text
--   maturity_snapshot text
--   economic_snapshot text
--   snapshot_valid boolean
--   snapshot_campaigns_count double precision
--   snapshot_keywords_count double precision
--   created_at timestamptz
CREATE TABLE IF NOT EXISTS "strategy_state_snapshot" (
  id           text PRIMARY KEY,
  created_date timestamptz NOT NULL DEFAULT now(),
  updated_date timestamptz NOT NULL DEFAULT now(),
  created_by   text,
  data         jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS "strategy_state_snapshot_data_gin" ON "strategy_state_snapshot" USING gin (data);
CREATE INDEX IF NOT EXISTS "strategy_state_snapshot_created_date" ON "strategy_state_snapshot" (created_date DESC);

-- ===== SyncExecutionLog =====
--   amazon_account_id text NOT NULL
--   operation text NOT NULL
--   trigger_type text
--   status text NOT NULL
--   execution_date date
--   started_at timestamptz
--   completed_at timestamptz
--   duration_ms double precision
--   records_processed double precision
--   records_received double precision
--   records_imported double precision
--   endpoint text
--   http_status double precision
--   amazon_request_id text
--   result_summary text
--   error_message text
--   daily_count_at_execution double precision
CREATE TABLE IF NOT EXISTS "sync_execution_log" (
  id           text PRIMARY KEY,
  created_date timestamptz NOT NULL DEFAULT now(),
  updated_date timestamptz NOT NULL DEFAULT now(),
  created_by   text,
  data         jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS "sync_execution_log_data_gin" ON "sync_execution_log" USING gin (data);
CREATE INDEX IF NOT EXISTS "sync_execution_log_created_date" ON "sync_execution_log" (created_date DESC);

-- ===== SyncRun =====
--   amazon_account_id text NOT NULL
--   operation text NOT NULL
--   status text NOT NULL
--   records_received double precision
--   records_upserted double precision
--   duration_ms double precision
--   error_code text
--   error_message text
--   started_at timestamptz
--   completed_at timestamptz
CREATE TABLE IF NOT EXISTS "sync_run" (
  id           text PRIMARY KEY,
  created_date timestamptz NOT NULL DEFAULT now(),
  updated_date timestamptz NOT NULL DEFAULT now(),
  created_by   text,
  data         jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS "sync_run_data_gin" ON "sync_run" USING gin (data);
CREATE INDEX IF NOT EXISTS "sync_run_created_date" ON "sync_run" (created_date DESC);

-- ===== TaskQueue =====
--   amazon_account_id text NOT NULL
--   task_name text NOT NULL
--   function_name text NOT NULL
--   payload jsonb
--   priority double precision
--   status text
--   scheduled_date date NOT NULL
--   started_at timestamptz
--   completed_at timestamptz
--   duration_ms double precision
--   result_summary text
--   error_message text
--   attempt_count double precision
--   max_attempts double precision
CREATE TABLE IF NOT EXISTS "task_queue" (
  id           text PRIMARY KEY,
  created_date timestamptz NOT NULL DEFAULT now(),
  updated_date timestamptz NOT NULL DEFAULT now(),
  created_by   text,
  data         jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS "task_queue_data_gin" ON "task_queue" USING gin (data);
CREATE INDEX IF NOT EXISTS "task_queue_created_date" ON "task_queue" (created_date DESC);

-- ===== TermBank =====
--   amazon_account_id text NOT NULL
--   term text NOT NULL
--   term_normalized text
--   asin text NOT NULL
--   sku text
--   product_name text
--   product_title text
--   match_type text
--   recommended_match_type text
--   source text
--   source_detail text
--   created_from text
--   term_type text
--   status text
--   promotion_status text
--   confidence double precision
--   campaign_id text
--   amazon_campaign_id text
--   keyword_id text
--   impressions double precision
--   clicks double precision
--   spend double precision
--   sales double precision
--   orders double precision
--   acos double precision
--   roas double precision
--   cpc double precision
--   ctr double precision
--   cvr double precision
--   conversion_rate double precision
--   bid_initial double precision
--   bid_current double precision
--   performance_score double precision
--   classification text
--   compatible_asins jsonb
--   compatibility_notes text
--   first_seen_at timestamptz
--   last_seen_at timestamptz
--   last_performance_update timestamptz
--   created_at timestamptz
--   updated_at timestamptz
CREATE TABLE IF NOT EXISTS "term_bank" (
  id           text PRIMARY KEY,
  created_date timestamptz NOT NULL DEFAULT now(),
  updated_date timestamptz NOT NULL DEFAULT now(),
  created_by   text,
  data         jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS "term_bank_data_gin" ON "term_bank" USING gin (data);
CREATE INDEX IF NOT EXISTS "term_bank_created_date" ON "term_bank" (created_date DESC);

-- ===== UnifiedAdsMetricsDaily =====
--   amazon_account_id text NOT NULL
--   profile_id text
--   date date NOT NULL
--   ad_product text
--   campaign_id text NOT NULL
--   campaign_name text
--   campaign_status text
--   campaign_budget double precision
--   campaign_budget_type text
--   ad_group_id text
--   ad_group_name text
--   ad_group_status text
--   advertised_product_id text
--   advertised_sku text
--   converted_product_id text
--   converted_product_name text
--   product_relevance text
--   targeting text
--   targeting_type text
--   match_type text
--   search_term text
--   placement text
--   channel text
--   currency text
--   impressions double precision
--   gross_impressions double precision
--   invalid_impressions double precision
--   invalid_impression_rate double precision
--   clicks double precision
--   gross_clicks double precision
--   invalid_clicks double precision
--   invalid_click_rate double precision
--   ctr double precision
--   cpc double precision
--   cpm double precision
--   cost double precision
--   viewable_impressions double precision
--   measurable_impressions double precision
--   measurable_rate double precision
--   viewability_rate double precision
--   purchases double precision
--   sales double precision
--   units_sold double precision
--   purchase_rate double precision
--   click_purchase_rate double precision
--   cost_per_purchase double precision
--   roas double precision
--   promoted_purchases double precision
--   promoted_sales double precision
--   promoted_units_sold double precision
--   promoted_roas double precision
--   promoted_acos double precision
--   halo_purchases double precision
--   halo_sales double precision
--   halo_units_sold double precision
--   click_purchases double precision
--   click_sales double precision
--   click_roas double precision
--   view_purchases double precision
--   view_sales double precision
--   view_roas double precision
--   impression_share double precision
--   impression_share_rank double precision
--   top_of_search_impression_share double precision
--   campaign_pacing_rate double precision
--   ad_group_pacing_rate double precision
--   budget_at_risk boolean
--   projected_spend double precision
--   required_daily_spend double precision
--   source text
--   synced_at timestamptz
CREATE TABLE IF NOT EXISTS "unified_ads_metrics_daily" (
  id           text PRIMARY KEY,
  created_date timestamptz NOT NULL DEFAULT now(),
  updated_date timestamptz NOT NULL DEFAULT now(),
  created_by   text,
  data         jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS "unified_ads_metrics_daily_data_gin" ON "unified_ads_metrics_daily" USING gin (data);
CREATE INDEX IF NOT EXISTS "unified_ads_metrics_daily_created_date" ON "unified_ads_metrics_daily" (created_date DESC);

-- ===== UnifiedAdsMetricsHourly =====
--   amazon_account_id text NOT NULL
--   date date NOT NULL
--   hour double precision NOT NULL
--   ad_product text
--   campaign_id text NOT NULL
--   campaign_name text
--   ad_group_id text
--   ad_group_name text
--   advertised_sku text
--   targeting text
--   channel text
--   currency text
--   impressions double precision
--   gross_impressions double precision
--   invalid_impressions double precision
--   invalid_impression_rate double precision
--   clicks double precision
--   gross_clicks double precision
--   invalid_clicks double precision
--   invalid_click_rate double precision
--   ctr double precision
--   cpc double precision
--   cost double precision
--   purchases double precision
--   sales double precision
--   promoted_purchases double precision
--   promoted_sales double precision
--   halo_purchases double precision
--   halo_sales double precision
--   impression_share double precision
--   top_of_search_impression_share double precision
--   campaign_pacing_rate double precision
--   source text
--   synced_at timestamptz
CREATE TABLE IF NOT EXISTS "unified_ads_metrics_hourly" (
  id           text PRIMARY KEY,
  created_date timestamptz NOT NULL DEFAULT now(),
  updated_date timestamptz NOT NULL DEFAULT now(),
  created_by   text,
  data         jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS "unified_ads_metrics_hourly_data_gin" ON "unified_ads_metrics_hourly" USING gin (data);
CREATE INDEX IF NOT EXISTS "unified_ads_metrics_hourly_created_date" ON "unified_ads_metrics_hourly" (created_date DESC);

-- ===== UnifiedAdsPacingMetrics =====
--   amazon_account_id text NOT NULL
--   date date NOT NULL
--   campaign_id text NOT NULL
--   campaign_name text
--   ad_group_id text
--   ad_group_name text
--   budget_total double precision
--   budget_spent double precision
--   budget_at_risk boolean
--   projected_spend double precision
--   required_daily_spend double precision
--   campaign_pacing_rate double precision
--   ad_group_pacing_rate double precision
--   source text
--   synced_at timestamptz
CREATE TABLE IF NOT EXISTS "unified_ads_pacing_metrics" (
  id           text PRIMARY KEY,
  created_date timestamptz NOT NULL DEFAULT now(),
  updated_date timestamptz NOT NULL DEFAULT now(),
  created_by   text,
  data         jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS "unified_ads_pacing_metrics_data_gin" ON "unified_ads_pacing_metrics" USING gin (data);
CREATE INDEX IF NOT EXISTS "unified_ads_pacing_metrics_created_date" ON "unified_ads_pacing_metrics" (created_date DESC);

-- ===== UnifiedMetricsReconciliation =====
--   amazon_account_id text NOT NULL
--   date date NOT NULL
--   campaign_id text NOT NULL
--   legacy_spend double precision
--   unified_spend double precision
--   spend_diff double precision
--   legacy_sales double precision
--   unified_sales double precision
--   sales_diff double precision
--   legacy_orders double precision
--   unified_purchases double precision
--   orders_diff double precision
--   legacy_clicks double precision
--   unified_clicks double precision
--   clicks_diff double precision
--   legacy_impressions double precision
--   unified_impressions double precision
--   impressions_diff double precision
--   difference_percent double precision
--   status text
--   created_at timestamptz
CREATE TABLE IF NOT EXISTS "unified_metrics_reconciliation" (
  id           text PRIMARY KEY,
  created_date timestamptz NOT NULL DEFAULT now(),
  updated_date timestamptz NOT NULL DEFAULT now(),
  created_by   text,
  data         jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS "unified_metrics_reconciliation_data_gin" ON "unified_metrics_reconciliation" USING gin (data);
CREATE INDEX IF NOT EXISTS "unified_metrics_reconciliation_created_date" ON "unified_metrics_reconciliation" (created_date DESC);

-- ===== User =====
--   role text NOT NULL
CREATE TABLE IF NOT EXISTS "user" (
  id           text PRIMARY KEY,
  created_date timestamptz NOT NULL DEFAULT now(),
  updated_date timestamptz NOT NULL DEFAULT now(),
  created_by   text,
  data         jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS "user_data_gin" ON "user" USING gin (data);
CREATE INDEX IF NOT EXISTS "user_created_date" ON "user" (created_date DESC);

-- ===== WeeklyAdsPerformanceReport =====
--   amazon_account_id text NOT NULL
--   marketplace_id text
--   week_start date NOT NULL
--   week_end date NOT NULL
--   report_status text
--   data_coverage_percent double precision
--   days_complete double precision
--   days_partial double precision
--   total_spend double precision
--   total_ads_sales double precision
--   total_real_sales double precision
--   total_orders double precision
--   total_units double precision
--   account_acos double precision
--   account_roas double precision
--   account_tacos double precision
--   total_profit_before_ads double precision
--   total_profit_after_ads double precision
--   products_profitable double precision
--   products_unprofitable double precision
--   products_no_sales_with_spend double precision
--   campaigns_adjusted double precision
--   keywords_adjusted double precision
--   targets_adjusted double precision
--   decisions_created double precision
--   decisions_executed double precision
--   decisions_failed double precision
--   decisions_pending_confirmation double precision
--   executive_summary text
--   idempotency_key text
--   created_at timestamptz
--   updated_at timestamptz
CREATE TABLE IF NOT EXISTS "weekly_ads_performance_report" (
  id           text PRIMARY KEY,
  created_date timestamptz NOT NULL DEFAULT now(),
  updated_date timestamptz NOT NULL DEFAULT now(),
  created_by   text,
  data         jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS "weekly_ads_performance_report_data_gin" ON "weekly_ads_performance_report" USING gin (data);
CREATE INDEX IF NOT EXISTS "weekly_ads_performance_report_created_date" ON "weekly_ads_performance_report" (created_date DESC);

-- ===== WeeklyMotorPrelection =====
--   amazon_account_id text NOT NULL
--   week_start date NOT NULL
--   week_end date NOT NULL
--   started_at timestamptz
--   completed_at timestamptz
--   status text
--   model_used text
--   target_acos double precision
--   max_acos double precision
--   target_roas double precision
--   target_tacos double precision
--   max_tacos double precision
--   daily_budget_cap double precision
--   summary text
--   executive_summary text
--   total_spend double precision
--   total_sales double precision
--   total_orders double precision
--   acos double precision
--   roas double precision
--   tacos double precision
--   avg_cpc double precision
--   campaigns_analyzed double precision
--   products_analyzed double precision
--   keywords_analyzed double precision
--   winning_terms_count double precision
--   losing_terms_count double precision
--   new_manual_campaigns_recommended double precision
--   new_manual_campaigns_created double precision
--   campaigns_to_pause double precision
--   campaigns_to_archive double precision
--   rules_reviewed double precision
--   rules_changed double precision
--   confidence double precision
--   requires_manual_review boolean
--   goal_status jsonb
--   winning_terms jsonb
--   losing_campaigns jsonb
--   manual_campaigns_created jsonb
--   raw_ai_response text
--   created_at timestamptz
CREATE TABLE IF NOT EXISTS "weekly_motor_prelection" (
  id           text PRIMARY KEY,
  created_date timestamptz NOT NULL DEFAULT now(),
  updated_date timestamptz NOT NULL DEFAULT now(),
  created_by   text,
  data         jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS "weekly_motor_prelection_data_gin" ON "weekly_motor_prelection" USING gin (data);
CREATE INDEX IF NOT EXISTS "weekly_motor_prelection_created_date" ON "weekly_motor_prelection" (created_date DESC);

-- ===== WeeklyProductPerformance =====
--   amazon_account_id text NOT NULL
--   weekly_report_id text NOT NULL
--   week_start date
--   week_end date
--   product_id text
--   asin text NOT NULL
--   sku text
--   product_name text
--   spend_7d double precision
--   ads_sales_7d double precision
--   real_sales_7d double precision
--   orders_7d double precision
--   units_7d double precision
--   impressions_7d double precision
--   clicks_7d double precision
--   acos_7d double precision
--   roas_7d double precision
--   tacos_7d double precision
--   profit_before_ads_7d double precision
--   profit_after_ads_7d double precision
--   target_acos double precision
--   break_even_acos double precision
--   maximum_profitable_cpa double precision
--   status text
--   main_problem text
--   recommended_action text
--   actions_executed double precision
--   next_review_at timestamptz
--   idempotency_key text
--   created_at timestamptz
--   updated_at timestamptz
CREATE TABLE IF NOT EXISTS "weekly_product_performance" (
  id           text PRIMARY KEY,
  created_date timestamptz NOT NULL DEFAULT now(),
  updated_date timestamptz NOT NULL DEFAULT now(),
  created_by   text,
  data         jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS "weekly_product_performance_data_gin" ON "weekly_product_performance" USING gin (data);
CREATE INDEX IF NOT EXISTS "weekly_product_performance_created_date" ON "weekly_product_performance" (created_date DESC);

-- ===== WeeklyRuleReview =====
--   amazon_account_id text NOT NULL
--   review_id text NOT NULL
--   model text
--   prompt_version text
--   data_hash text
--   status text
--   started_at timestamptz
--   completed_at timestamptz
--   duration_ms double precision
--   analysis_period_start date
--   analysis_period_end date
--   records_analyzed double precision
--   tokens_used double precision
--   cost_estimate_usd double precision
--   data_quality_score double precision
--   data_warnings jsonb
--   rules_proposed double precision
--   rules_approved double precision
--   rules_rejected double precision
--   rules_unchanged double precision
--   version_id text
--   version_activated boolean
--   error_message text
--   global_observations jsonb
--   claude_raw_response text
--   next_scheduled_at timestamptz
CREATE TABLE IF NOT EXISTS "weekly_rule_review" (
  id           text PRIMARY KEY,
  created_date timestamptz NOT NULL DEFAULT now(),
  updated_date timestamptz NOT NULL DEFAULT now(),
  created_by   text,
  data         jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS "weekly_rule_review_data_gin" ON "weekly_rule_review" USING gin (data);
CREATE INDEX IF NOT EXISTS "weekly_rule_review_created_date" ON "weekly_rule_review" (created_date DESC);
