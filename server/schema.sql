-- Gerado por scripts/generate-schema.ts â€” schema do backend self-hosted do Living Finds.
-- Modelo: cada entidade Ã© uma tabela-documento; os campos ficam em `data` (jsonb).
-- O runtime tambÃ©m cria estas tabelas sob demanda; este arquivo serve p/ provisionar de uma vez.

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
--   resource_cap double precision
--   economic_daily_spend_cap double precision
--   pacing_daily_target double precision
--   protected_future_hours_budget double precision
--   ads_resource_share_cap_pct double precision
--   ads_resource_basis text
--   intraday_pacing_enabled boolean
--   min_intraday_data_confidence text
--   cap_calculation_source text
--   cap_calculation_period_days double precision
--   cap_calculation_confidence text
--   updated_by text
--   cap_updated_at timestamptz
--   confirmed_spend double precision
--   target_spend_by_now double precision
--   target_spend_next_checkpoint double precision
--   pacing_error_value double precision
--   pacing_error_pct double precision
--   intraday_source text
--   intraday_captured_at timestamptz
--   intraday_freshness_seconds double precision
--   data_confidence text
--   reserved_for_strong_hours double precision
--   spend_available_now double precision
--   max_spend_until_next_checkpoint double precision
--   projected_overspend double precision
--   projected_underspend double precision
--   last_rebalance_at timestamptz
--   next_rebalance_at timestamptz
--   pacing_engine_version text
--   historical_30d_spend double precision
--   historical_30d_sales double precision
--   historical_30d_orders double precision
--   closed_day_date date
--   closed_day_spend double precision
--   closed_day_sales double precision
--   closed_day_orders double precision
--   metric_windows_version text
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
--   today_schedule text
--   best_profit_window text
--   budget_mode text
--   elite_reserve double precision
--   affordable_active_hours double precision
--   pacing_curve text
--   global_kill_switch boolean
--   global_stop_event_id text
--   global_stop_snapshot text
--   kill_switch_activated_at timestamptz
--   kill_switch_reason text
--   projected_end_of_day_spend double precision
--   time_to_cap_hours double precision
--   future_value_reserve double precision
--   underpacing_alert boolean
--   overpacing_alert boolean
--   stop_type text
--   spend_velocity_per_hour double precision
--   safety_buffer double precision
--   budget_insufficient_for_8h boolean
--   estimated_budget_for_8h double precision
--   hour_value_scores text
--   last_pacing_engine_run_at timestamptz
--   last_kill_switch_check_at timestamptz
--   goal_alignment_status text
--   goal_alignment_checked_at timestamptz
--   recency_protection_active boolean
--   acos_14d_at_last_check double precision
--   trend_classification text
--   checkpoint_morning_at timestamptz
--   checkpoint_morning_spend double precision
--   checkpoint_afternoon_at timestamptz
--   checkpoint_afternoon_spend double precision
--   checkpoint_evening_at timestamptz
--   checkpoint_evening_spend double precision
--   checkpoint_night_at timestamptz
--   checkpoint_night_spend double precision
--   scheduled_pause_hour double precision
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
--   daypart_base_bid double precision
--   daypart_bid_floor double precision
--   daypart_bid_cap double precision
--   daypart_active boolean
--   daypart_multiplier double precision
--   daypart_last_slot text
--   daypart_last_adjusted_at timestamptz
--   daypart_last_restored_at timestamptz
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

-- ===== AdGroupMetricsDaily =====
--   amazon_account_id text NOT NULL
--   campaign_id text
--   ad_group_id text
--   ad_group_name text
--   date date NOT NULL
--   impressions double precision
--   clicks double precision
--   spend double precision
--   sales double precision
--   orders double precision
--   acos double precision
--   roas double precision
--   cpc double precision
--   ctr double precision
--   synced_at timestamptz
--   report_id text
--   data_status text
--   unique_key text NOT NULL
CREATE TABLE IF NOT EXISTS "ad_group_metrics_daily" (
  id           text PRIMARY KEY,
  created_date timestamptz NOT NULL DEFAULT now(),
  updated_date timestamptz NOT NULL DEFAULT now(),
  created_by   text,
  data         jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS "ad_group_metrics_daily_data_gin" ON "ad_group_metrics_daily" USING gin (data);
CREATE INDEX IF NOT EXISTS "ad_group_metrics_daily_created_date" ON "ad_group_metrics_daily" (created_date DESC);

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
--   entity_type text
--   entity_id text
--   keyword_id text
--   keyword text
--   keyword_text text
--   target_id text
--   asin text
--   old_bid double precision
--   new_bid double precision
--   bid_before double precision
--   bid_after double precision
--   change_amount double precision
--   change_percent double precision
--   change_pct double precision
--   direction text
--   action text
--   reason text
--   evidence text
--   classification text
--   account_daily_spend double precision
--   remaining_account_budget double precision
--   campaign_virtual_budget double precision
--   campaign_spend_share double precision
--   campaign_target_share double precision
--   spend_share_deviation double precision
--   impressions double precision
--   clicks double precision
--   orders double precision
--   sales double precision
--   spend double precision
--   cpc double precision
--   acos double precision
--   profit_after_ads double precision
--   margin_percent double precision
--   maximum_economic_cpc double precision
--   max_spend_without_sale double precision
--   stock_qty double precision
--   stock_coverage_days double precision
--   next_evaluation_at timestamptz
--   block_name text
--   stop_type text
--   source text
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
-- ë^=òÚ$z{-®éÜj×öç2F÷V&ÆR&V6—6–öà¢ÒÒ6Æ–6·2F÷V&ÆR&V6—6–öà¢ÒÒ7VæBF÷V&ÆR&V6—6–öà¢ÒÒ6ÆW2F÷V&ÆR&V6—6–öà¢ÒÒ÷&FW'2F÷V&ÆR&V6—6–öà¢ÒÒ6ÖU÷6·Uö÷&FW'2F÷V&ÆR&V6—6–öà¢ÒÒ6ÖU÷6·U÷6ÆW2F÷V&ÆR&V6—6–öà¢ÒÒ†Æõö÷&FW'2F÷V&ÆR&V6—6–öà¢ÒÒ†Æõ÷6ÆW2F÷V&ÆR&V6—6–öà¢ÒÒ6ÖU÷6·UöGG&–'WF–öå÷fW&–f–VB&ööÆVà¢ÒÒ6÷W&6Uö6×–våö–G2§6öæ ¢ÒÒ6÷W&6UöEöw&÷Wö–G2§6öæ ¢ÒÒÆ7EöWf–FVæ6UöFFRFFP¢ÒÒ6÷2F÷V&ÆR&V6—6–öà¢ÒÒ&ö2F÷V&ÆR&V6—6–öà¢ÒÒ72F÷V&ÆR&V6—6–öà¢ÒÒ7G"F÷V&ÆR&V6—6–öà¢ÒÒ7g"F÷V&ÆR&V6—6–öà¢ÒÒ6öçfW'6–öå÷&FRF÷V&ÆR&V6—6–öà¢ÒÒ&–Eö–æ—F–ÂF÷V&ÆR&V6—6–öà¢ÒÒ&–Eö7W'&VçBF÷V&ÆR&V6—6–öà¢ÒÒW&f÷&Öæ6U÷66÷&RF÷V&ÆR&V6—6–öà¢ÒÒ6Æ76–f–6F–öâFW‡@¢ÒÒ6ö×F–&ÆUö6–ç2§6öæ ¢ÒÒ6ö×F–&–Æ—G•öæ÷FW2FW‡@¢ÒÒf—'7E÷6VVåöBF–ÖW7F×G ¢ÒÒÆ7E÷6VVåöBF–ÖW7F×G ¢ÒÒÆ7E÷W&f÷&Öæ6U÷WFFRF–ÖW7F×G ¢ÒÒ7&VFVEöBF–ÖW7F×G ¢ÒÒWFFVEöBF–ÖW7F×G ¤5$TDRD$ÄR”bäõBU„•5E2'FW&Õö&æ²"€¢–BFW‡B$”Ô%’´U’À¢7&VFVEöFFRF–ÖW7F×G¢äõBåTÄÂDTdTÅBæ÷r‚’À¢WFFVEöFFRF–ÖW7F×G¢äõBåTÄÂDTdTÅBæ÷r‚’À¢7&VFVEö'’FW‡BÀ¢FF§6öæ"äõBåTÄÂDTdTÅBw·Òs£¦§6öæ ¢“°¤5$TDR”äDU‚”bäõBU„•5E2'FW&Õö&æµöFFöv–â"ôâ'FW&Õö&æ²"U4”ärv–â†FF“°¤5$TDR”äDU‚”bäõBU„•5E2'FW&Õö&æµö7&VFVEöFFR"ôâ'FW&Õö&æ²"†7&VFVEöFFRDU42“° ¢ÒÒÓÓÓÓÒVæ–f–VDG4ÖWG&–74F–Ç’ÓÓÓÓĞ¢ÒÒÖ¦öåö66÷VçEö–BFW‡BäõBåTÄÀ¢ÒÒ&öf–ÆUö–BFW‡@¢ÒÒFFRFFRäõBåTÄÀ¢ÒÒE÷&öGV7BFW‡@¢ÒÒ6×–våö–BFW‡BäõBåTÄÀ¢ÒÒ6×–våöæÖRFW‡@¢ÒÒ6×–vå÷7FGW2FW‡@¢ÒÒ6×–våö'VFvWBF÷V&ÆR&V6—6–öà¢ÒÒ6×–våö'VFvWE÷G—RFW‡@¢ÒÒEöw&÷Wö–BFW‡@¢ÒÒEöw&÷WöæÖRFW‡@¢ÒÒEöw&÷W÷7FGW2FW‡@¢ÒÒGfW'F—6VE÷&öGV7Eö–BFW‡@¢ÒÒGfW'F—6VE÷6·RFW‡@¢ÒÒ6öçfW'FVE÷&öGV7Eö–BFW‡@¢ÒÒ6öçfW'FVE÷&öGV7EöæÖRFW‡@¢ÒÒ&öGV7E÷&VÆWfæ6RFW‡@¢ÒÒF&vWF–ærFW‡@¢ÒÒF&vWF–æu÷G—RFW‡@¢ÒÒÖF6…÷G—RFW‡@¢ÒÒ6V&6…÷FW&ÒFW‡@¢ÒÒÆ6VÖVçBFW‡@¢ÒÒ6†ææVÂFW‡@¢ÒÒ7W'&Væ7’FW‡@¢ÒÒ–×&W76–öç2F÷V&ÆR&V6—6–öà¢ÒÒw&÷75ö–×&W76–öç2F÷V&ÆR&V6—6–öà¢ÒÒ–çfÆ–Eö–×&W76–öç2F÷V&ÆR&V6—6–öà¢ÒÒ–çfÆ–Eö–×&W76–öå÷&FRF÷V&ÆR&V6—6–öà¢ÒÒ6Æ–6·2F÷V&ÆR&V6—6–öà¢ÒÒw&÷75ö6Æ–6·2F÷V&ÆR&V6—6–öà¢ÒÒ–çfÆ–Eö6Æ–6·2F÷V&ÆR&V6—6–öà¢ÒÒ–çfÆ–Eö6Æ–6µ÷&FRF÷V&ÆR&V6—6–öà¢ÒÒ7G"F÷V&ÆR&V6—6–öà¢ÒÒ72F÷V&ÆR&V6—6–öà¢ÒÒ7ÒF÷V&ÆR&V6—6–öà¢ÒÒ6÷7BF÷V&ÆR&V6—6–öà¢ÒÒf–Wv&ÆUö–×&W76–öç2F÷V&ÆR&V6—6–öà¢ÒÒÖV7W&&ÆUö–×&W76–öç2F÷V&ÆR&V6—6–öà¢ÒÒÖV7W&&ÆU÷&FRF÷V&ÆR&V6—6–öà¢ÒÒf–Wv&–Æ—G•÷&FRF÷V&ÆR&V6—6–öà¢ÒÒW&6†6W2F÷V&ÆR&V6—6–öà¢ÒÒ6ÆW2F÷V&ÆR&V6—6–öà¢ÒÒVæ—G5÷6öÆBF÷V&ÆR&V6—6–öà¢ÒÒW&6†6U÷&FRF÷V&ÆR&V6—6–öà¢ÒÒ6Æ–6µ÷W&6†6U÷&FRF÷V&ÆR&V6—6–öà¢ÒÒ6÷7E÷W%÷W&6†6RF÷V&ÆR&V6—6–öà¢ÒÒ&ö2F÷V&ÆR&V6—6–öà¢ÒÒ&öÖ÷FVE÷W&6†6W2F÷V&ÆR&V6—6–öà¢ÒÒ&öÖ÷FVE÷6ÆW2F÷V&ÆR&V6—6–öà¢ÒÒ&öÖ÷FVE÷Væ—G5÷6öÆBF÷V&ÆR&V6—6–öà¢ÒÒ&öÖ÷FVE÷&ö2F÷V&ÆR&V6—6–öà¢ÒÒ&öÖ÷FVEö6÷2F÷V&ÆR&V6—6–öà¢ÒÒ†Æõ÷W&6†6W2F÷V&ÆR&V6—6–öà¢ÒÒ†Æõ÷6ÆW2F÷V&ÆR&V6—6–öà¢ÒÒ†Æõ÷Væ—G5÷6öÆBF÷V&ÆR&V6—6–öà¢ÒÒ6Æ–6µ÷W&6†6W2F÷V&ÆR&V6—6–öà¢ÒÒ6Æ–6µ÷6ÆW2F÷V&ÆR&V6—6–öà¢ÒÒ6Æ–6µ÷&ö2F÷V&ÆR&V6—6–öà¢ÒÒf–Wu÷W&6†6W2F÷V&ÆR&V6—6–öà¢ÒÒf–Wu÷6ÆW2F÷V&ÆR&V6—6–öà¢ÒÒf–Wu÷&ö2F÷V&ÆR&V6—6–öà¢ÒÒ–×&W76–öå÷6†&RF÷V&ÆR&V6—6–öà¢ÒÒ–×&W76–öå÷6†&U÷&æ²F÷V&ÆR&V6—6–öà¢ÒÒF÷ööe÷6V&6…ö–×&W76–öå÷6†&RF÷V&ÆR&V6—6–öà¢ÒÒ6×–vå÷6–æu÷&FRF÷V&ÆR&V6—6–öà¢ÒÒEöw&÷W÷6–æu÷&FRF÷V&ÆR&V6—6–öà¢ÒÒ'VFvWEöE÷&—6²&ööÆVà¢ÒÒ&ö¦V7FVE÷7VæBF÷V&ÆR&V6—6–öà¢ÒÒ&WV—&VEöF–Ç•÷7VæBF÷V&ÆR&V6—6–öà¢ÒÒ6÷W&6RFW‡@¢ÒÒ7–æ6VEöBF–ÖW7F×G ¤5$TDRD$ÄR”bäõBU„•5E2'Væ–f–VEöG5öÖWG&–75öF–Ç’"€¢–BFW‡B$”Ô%’´U’À¢7&VFVEöFFRF–ÖW7F×G¢äõBåTÄÂDTdTÅBæ÷r‚’À¢WFFVEöFFRF–ÖW7F×G¢äõBåTÄÂDTdTÅBæ÷r‚’À¢7&VFVEö'’FW‡BÀ¢FF§6öæ"äõBåTÄÂDTdTÅBw·Òs£¦§6öæ ¢“°¤5$TDR”äDU‚”bäõBU„•5E2'Væ–f–VEöG5öÖWG&–75öF–Ç•öFFöv–â"ôâ'Væ–f–VEöG5öÖWG&–75öF–Ç’"U4”ärv–â†FF“°¤5$TDR”äDU‚”bäõBU„•5E2'Væ–f–VEöG5öÖWG&–75öF–Ç•ö7&VFVEöFFR"ôâ'Væ–f–VEöG5öÖWG&–75öF–Ç’"†7&VFVEöFFRDU42“° ¢ÒÒÓÓÓÓÒVæ–f–VDG4ÖWG&–74†÷W&Ç’ÓÓÓÓĞ¢ÒÒÖ¦öåö66÷VçEö–BFW‡BäõBåTÄÀ¢ÒÒFFRFFRäõBåTÄÀ¢ÒÒ†÷W"F÷V&ÆR&V6—6–öâäõBåTÄÀ¢ÒÒE÷&öGV7BFW‡@¢ÒÒ6×–våö–BFW‡BäõBåTÄÀ¢ÒÒ6×–våöæÖRFW‡@¢ÒÒEöw&÷Wö–BFW‡@¢ÒÒEöw&÷WöæÖRFW‡@¢ÒÒGfW'F—6VE÷6·RFW‡@¢ÒÒGfW'F—6VEö6–âFW‡@¢ÒÒF&vWF–ærFW‡@¢ÒÒ6†ææVÂFW‡@¢ÒÒ7W'&Væ7’FW‡@¢ÒÒ–×&W76–öç2F÷V&ÆR&V6—6–öà¢ÒÒw&÷75ö–×&W76–öç2F÷V&ÆR&V6—6–öà¢ÒÒ–çfÆ–Eö–×&W76–öç2F÷V&ÆR&V6—6–öà¢ÒÒ–çfÆ–Eö–×&W76–öå÷&FRF÷V&ÆR&V6—6–öà¢ÒÒ6Æ–6·2F÷V&ÆR&V6—6–öà¢ÒÒw&÷75ö6Æ–6·2F÷V&ÆR&V6—6–öà¢ÒÒ–çfÆ–Eö6Æ–6·2F÷V&ÆR&V6—6–öà¢ÒÒ–çfÆ–Eö6Æ–6µ÷&FRF÷V&ÆR&V6—6–öà¢ÒÒ7G"F÷V&ÆR&V6—6–öà¢ÒÒ72F÷V&ÆR&V6—6–öà¢ÒÒ6÷7BF÷V&ÆR&V6—6–öà¢ÒÒW&6†6W2F÷V&ÆR&V6—6–öà¢ÒÒ6ÆW2F÷V&ÆR&V6—6–öà¢ÒÒ&öÖ÷FVE÷W&6†6W2F÷V&ÆR&V6—6–öà¢ÒÒ&öÖ÷FVE÷6ÆW2F÷V&ÆR&V6—6–öà¢ÒÒ†Æõ÷W&6†6W2F÷V&ÆR&V6—6–öà¢ÒÒ†Æõ÷6ÆW2F÷V&ÆR&V6—6–öà¢ÒÒ–×&W76–öå÷6†&RF÷V&ÆR&V6—6–öà¢ÒÒF÷ööe÷6V&6…ö–×&W76–öå÷6†&RF÷V&ÆR&V6—6–öà¢ÒÒ6×–vå÷6–æu÷&FRF÷V&ÆR&V6—6–öà¢ÒÒ6÷W&6RFW‡@¢ÒÒ7–æ6VEöBF–ÖW7F×G ¤5$TDRD$ÄR”bäõBU„•5E2'Væ–f–VEöG5öÖWG&–75ö†÷W&Ç’"€¢–BFW‡B$”Ô%’´U’À¢7&VFVEöFFRF–ÖW7F×G¢äõBåTÄÂDTdTÅBæ÷r‚’À¢WFFVEöFFRF–ÖW7F×G¢äõBåTÄÂDTdTÅBæ÷r‚’À¢7&VFVEö'’FW‡BÀ¢FF§6öæ"äõBåTÄÂDTdTÅBw·Òs£¦§6öæ ¢“°¤5$TDR”äDU‚”bäõBU„•5E2'Væ–f–VEöG5öÖWG&–75ö†÷W&Ç•öFFöv–â"ôâ'Væ–f–VEöG5öÖWG&–75ö†÷W&Ç’"U4”ärv–â†FF“°¤5$TDR”äDU‚”bäõBU„•5E2'Væ–f–VEöG5öÖWG&–75ö†÷W&Ç•ö7&VFVEöFFR"ôâ'Væ–f–VEöG5öÖWG&–75ö†÷W&Ç’"†7&VFVEöFFRDU42“° ¢ÒÒÓÓÓÓÒVæ–f–VDG56–ætÖWG&–72ÓÓÓÓĞ¢ÒÒÖ¦öåö66÷VçEö–BFW‡BäõBåTÄÀ¢ÒÒFFRFFRäõBåTÄÀ¢ÒÒ6×–våö–BFW‡BäõBåTÄÀ¢ÒÒ6×–våöæÖRFW‡@¢ÒÒEöw&÷Wö–BFW‡@¢ÒÒEöw&÷WöæÖRFW‡@¢ÒÒ'VFvWE÷F÷FÂF÷V&ÆR&V6—6–öà¢ÒÒ'VFvWE÷7VçBF÷V&ÆR&V6—6–öà¢ÒÒ'VFvWEöE÷&—6²&ööÆVà¢ÒÒ&ö¦V7FVE÷7VæBF÷V&ÆR&V6—6–öà¢ÒÒ&WV—&VEöF–Ç•÷7VæBF÷V&ÆR&V6—6–öà¢ÒÒ6×–vå÷6–æu÷&FRF÷V&ÆR&V6—6–öà¢ÒÒEöw&÷W÷6–æu÷&FRF÷V&ÆR&V6—6–öà¢ÒÒ6÷W&6RFW‡@¢ÒÒ7–æ6VEöBF–ÖW7F×G ¤5$TDRD$ÄR”bäõBU„•5E2'Væ–f–VEöG5÷6–æuöÖWG&–72"€¢–BFW‡B$”Ô%’´U’À¢7&VFVEöFFRF–ÖW7F×G¢äõBåTÄÂDTdTÅBæ÷r‚’À¢WFFVEöFFRF–ÖW7F×G¢äõBåTÄÂDTdTÅBæ÷r‚’À¢7&VFVEö'’FW‡BÀ¢FF§6öæ"äõBåTÄÂDTdTÅBw·Òs£¦§6öæ ¢“°¤5$TDR”äDU‚”bäõBU„•5E2'Væ–f–VEöG5÷6–æuöÖWG&–75öFFöv–â"ôâ'Væ–f–VEöG5÷6–æuöÖWG&–72"U4”ärv–â†FF“°¤5$TDR”äDU‚”bäõBU„•5E2'Væ–f–VEöG5÷6–æuöÖWG&–75ö7&VFVEöFFR"ôâ'Væ–f–VEöG5÷6–æuöÖWG&–72"†7&VFVEöFFRDU42“° ¢ÒÒÓÓÓÓÒVæ–f–VDÖWG&–75&V6öæ6–Æ–F–öâÓÓÓÓĞ¢ÒÒÖ¦öåö66÷VçEö–BFW‡BäõBåTÄÀ¢ÒÒFFRFFRäõBåTÄÀ¢ÒÒ6×–våö–BFW‡BäõBåTÄÀ¢ÒÒÆVv7•÷7VæBF÷V&ÆR&V6—6–öà¢ÒÒVæ–f–VE÷7VæBF÷V&ÆR&V6—6–öà¢ÒÒ7VæEöF–fbF÷V&ÆR&V6—6–öà¢ÒÒÆVv7•÷6ÆW2F÷V&ÆR&V6—6–öà¢ÒÒVæ–f–VE÷6ÆW2F÷V&ÆR&V6—6–öà¢ÒÒ6ÆW5öF–fbF÷V&ÆR&V6—6–öà¢ÒÒÆVv7•ö÷&FW'2F÷V&ÆR&V6—6–öà¢ÒÒVæ–f–VE÷W&6†6W2F÷V&ÆR&V6—6–öà¢ÒÒ÷&FW'5öF–fbF÷V&ÆR&V6—6–öà¢ÒÒÆVv7•ö6Æ–6·2F÷V&ÆR&V6—6–öà¢ÒÒVæ–f–VEö6Æ–6·2F÷V&ÆR&V6—6–öà¢ÒÒ6Æ–6·5öF–fbF÷V&ÆR&V6—6–öà¢ÒÒÆVv7•ö–×&W76–öç2F÷V&ÆR&V6—6–öà¢ÒÒVæ–f–VEö–×&W76–öç2F÷V&ÆR&V6—6–öà¢ÒÒ–×&W76–öç5öF–fbF÷V&ÆR&V6—6–öà¢ÒÒF–ffW&Væ6U÷W&6VçBF÷V&ÆR&V6—6–öà¢ÒÒ7FGW2FW‡@¢ÒÒ7&VFVEöBF–ÖW7F×G ¤5$TDRD$ÄR”bäõBU„•5E2'Væ–f–VEöÖWG&–75÷&V6öæ6–Æ–F–öâ"€¢–BFW‡B$”Ô%’´U’À¢7&VFVEöFFRF–ÖW7F×G¢äõBåTÄÂDTdTÅBæ÷r‚’À¢WFFVEöFFRF–ÖW7F×G¢äõBåTÄÂDTdTÅBæ÷r‚’À¢7&VFVEö'’FW‡BÀ¢FF§6öæ"äõBåTÄÂDTdTÅBw·Òs£¦§6öæ ¢“°¤5$TDR”äDU‚”bäõBU„•5E2'Væ–f–VEöÖWG&–75÷&V6öæ6–Æ–F–öåöFFöv–â"ôâ'Væ–f–VEöÖWG&–75÷&V6öæ6–Æ–F–öâ"U4”ärv–â†FF“°¤5$TDR”äDU‚”bäõBU„•5E2'Væ–f–VEöÖWG&–75÷&V6öæ6–Æ–F–öåö7&VFVEöFFR"ôâ'Væ–f–VEöÖWG&–75÷&V6öæ6–Æ–F–öâ"†7&VFVEöFFRDU42“° ¢ÒÒÓÓÓÓÒW6W"ÓÓÓÓĞ¢ÒÒ&öÆRFW‡BäõBåTÄÀ¤5$TDRD$ÄR”bäõBU„•5E2'W6W""€¢–BFW‡B$”Ô%’´U’À¢7&VFVEöFFRF–ÖW7F×G¢äõBåTÄÂDTdTÅBæ÷r‚’À¢WFFVEöFFRF–ÖW7F×G¢äõBåTÄÂDTdTÅBæ÷r‚’À¢7&VFVEö'’FW‡BÀ¢FF§6öæ"äõBåTÄÂDTdTÅBw·Òs£¦§6öæ ¢“°¤5$TDR”äDU‚”bäõBU„•5E2'W6W%öFFöv–â"ôâ'W6W""U4”ärv–â†FF“°¤5$TDR”äDU‚”bäõBU„•5E2'W6W%ö7&VFVEöFFR"ôâ'W6W""†7&VFVEöFFRDU42“° ¢ÒÒÓÓÓÓÒvVV¶Ç”G5W&f÷&Öæ6U&W÷'BÓÓÓÓĞ¢ÒÒÖ¦öåö66÷VçEö–BFW‡BäõBåTÄÀ¢ÒÒÖ&¶WGÆ6Uö–BFW‡@¢ÒÒvVVµ÷7F'BFFRäõBåTÄÀ¢ÒÒvVVµöVæBFFRäõBåTÄÀ¢ÒÒ&W÷'E÷7FGW2FW‡@¢ÒÒFFö6÷fW&vU÷W&6VçBF÷V&ÆR&V6—6–öà¢ÒÒF—5ö6ö×ÆWFRF÷V&ÆR&V6—6–öà¢ÒÒF—5÷'F–ÂF÷V&ÆR&V6—6–öà¢ÒÒF÷FÅ÷7VæBF÷V&ÆR&V6—6–öà¢ÒÒF÷FÅöG5÷6ÆW2F÷V&ÆR&V6—6–öà¢ÒÒF÷FÅ÷&VÅ÷6ÆW2F÷V&ÆR&V6—6–öà¢ÒÒF÷FÅö÷&FW'2F÷V&ÆR&V6—6–öà¢ÒÒF÷FÅ÷Væ—G2F÷V&ÆR&V6—6–öà¢ÒÒ66÷VçEö6÷2F÷V&ÆR&V6—6–öà¢ÒÒ66÷VçE÷&ö2F÷V&ÆR&V6—6–öà¢ÒÒ66÷VçE÷F6÷2F÷V&ÆR&V6—6–öà¢ÒÒF÷FÅ÷&öf—Eö&Vf÷&UöG2F÷V&ÆR&V6—6–öà¢ÒÒF÷FÅ÷&öf—EögFW%öG2F÷V&ÆR&V6—6–öà¢ÒÒ&öGV7G5÷&öf—F&ÆRF÷V&ÆR&V6—6–öà¢ÒÒ&öGV7G5÷Vç&öf—F&ÆRF÷V&ÆR&V6—6–öà¢ÒÒ&öGV7G5öæõ÷6ÆW5÷v—F…÷7VæBF÷V&ÆR&V6—6–öà¢ÒÒ6×–vç5öF§W7FVBF÷V&ÆR&V6—6–öà¢ÒÒ¶W—v÷&G5öF§W7FVBF÷V&ÆR&V6—6–öà¢ÒÒF&vWG5öF§W7FVBF÷V&ÆR&V6—6–öà¢ÒÒFV6—6–öç5ö7&VFVBF÷V&ÆR&V6—6–öà¢ÒÒFV6—6–öç5öW†V7WFVBF÷V&ÆR&V6—6–öà¢ÒÒFV6—6–öç5öf–ÆVBF÷V&ÆR&V6—6–öà¢ÒÒFV6—6–öç5÷VæF–æuö6öæf—&ÖF–öâF÷V&ÆR&V6—6–öà¢ÒÒW†V7WF—fU÷7VÖÖ'’FW‡@¢ÒÒ–FV×÷FVæ7•ö¶W’FW‡@¢ÒÒ7&VFVEöBF–ÖW7F×G ¢ÒÒWFFVEöBF–ÖW7F×G ¤5$TDRD$ÄR”bäõBU„•5E2'vVV¶Ç•öG5÷W&f÷&Öæ6U÷&W÷'B"€¢–BFW‡B$”Ô%’´U’À¢7&VFVEöFFRF–ÖW7F×G¢äõBåTÄÂDTdTÅBæ÷r‚’À¢WFFVEöFFRF–ÖW7F×G¢äõBåTÄÂDTdTÅBæ÷r‚’À¢7&VFVEö'’FW‡BÀ¢FF§6öæ"äõBåTÄÂDTdTÅBw·Òs£¦§6öæ ¢“°¤5$TDR”äDU‚”bäõBU„•5E2'vVV¶Ç•öG5÷W&f÷&Öæ6U÷&W÷'EöFFöv–â"ôâ'vVV¶Ç•öG5÷W&f÷&Öæ6U÷&W÷'B"U4”ärv–â†FF“°¤5$TDR”äDU‚”bäõBU„•5E2'vVV¶Ç•öG5÷W&f÷&Öæ6U÷&W÷'Eö7&VFVEöFFR"ôâ'vVV¶Ç•öG5÷W&f÷&Öæ6U÷&W÷'B"†7&VFVEöFFRDU42“° ¢ÒÒÓÓÓÓÒvVV¶Ç”Ö÷F÷%&VÆV7F–öâÓÓÓÓĞ¢ÒÒÖ¦öåö66÷VçEö–BFW‡BäõBåTÄÀ¢ÒÒvVVµ÷7F'BFFRäõBåTÄÀ¢ÒÒvVVµöVæBFFRäõBåTÄÀ¢ÒÒ7F'FVEöBF–ÖW7F×G ¢ÒÒ6ö×ÆWFVEöBF–ÖW7F×G ¢ÒÒ7FGW2FW‡@¢ÒÒÖöFVÅ÷W6VBFW‡@¢ÒÒF&vWEö6÷2F÷V&ÆR&V6—6–öà¢ÒÒÖ…ö6÷2F÷V&ÆR&V6—6–öà¢ÒÒF&vWE÷&ö2F÷V&ÆR&V6—6–öà¢ÒÒF&vWE÷F6÷2F÷V&ÆR&V6—6–öà¢ÒÒÖ…÷F6÷2F÷V&ÆR&V6—6–öà¢ÒÒF–Ç•ö'VFvWEö6F÷V&ÆR&V6—6–öà¢ÒÒ7VÖÖ'’FW‡@¢ÒÒW†V7WF—fU÷7VÖÖ'’FW‡@¢ÒÒF÷FÅ÷7VæBF÷V&ÆR&V6—6–öà¢ÒÒF÷FÅ÷6ÆW2F÷V&ÆR&V6—6–öà¢ÒÒF÷FÅö÷&FW'2F÷V&ÆR&V6—6–öà¢ÒÒ6÷2F÷V&ÆR&V6—6–öà¢ÒÒ&ö2F÷V&ÆR&V6—6–öà¢ÒÒF6÷2F÷V&ÆR&V6—6–öà¢ÒÒfuö72F÷V&ÆR&V6—6–öà¢ÒÒ6×–vç5öæÇ—¦VBF÷V&ÆR&V6—6–öà¢ÒÒ&öGV7G5öæÇ—¦VBF÷V&ÆR&V6—6–öà¢ÒÒ¶W—v÷&G5öæÇ—¦VBF÷V&ÆR&V6—6–öà¢ÒÒv–ææ–æu÷FW&×5ö6÷VçBF÷V&ÆR&V6—6–öà¢ÒÒÆ÷6–æu÷FW&×5ö6÷VçBF÷V&ÆR&V6—6–öà¢ÒÒæWuöÖçVÅö6×–vç5÷&V6öÖÖVæFVBF÷V&ÆR&V6—6–öà¢ÒÒæWuöÖçVÅö6×–vç5ö7&VFVBF÷V&ÆR&V6—6–öà¢ÒÒ6×–vç5÷Fõ÷W6RF÷V&ÆR&V6—6–öà¢ÒÒ6×–vç5÷Fõö&6†—fRF÷V&ÆR&V6—6–öà¢ÒÒ'VÆW5÷&Wf–WvVBF÷V&ÆR&V6—6–öà¢ÒÒ'VÆW5ö6†ævVBF÷V&ÆR&V6—6–öà¢ÒÒ6öæf–FVæ6RF÷V&ÆR&V6—6–öà¢ÒÒ&WV—&W5öÖçVÅ÷&Wf–Wr&ööÆVà¢ÒÒvöÅ÷7FGW2§6öæ ¢ÒÒv–ææ–æu÷FW&×2§6öæ ¢ÒÒÆ÷6–æuö6×–vç2§6öæ ¢ÒÒÖçVÅö6×–vç5ö7&VFVB§6öæ ¢ÒÒ&uö•÷&W7öç6RFW‡@¢ÒÒ7&VFVEöBF–ÖW7F×G ¤5$TDRD$ÄR”bäõBU„•5E2'vVV¶Ç•öÖ÷F÷%÷&VÆV7F–öâ"€¢–BFW‡B$”Ô%’´U’À¢7&VFVEöFFRF–ÖW7F×G¢äõBåTÄÂDTdTÅBæ÷r‚’À¢WFFVEöFFRF–ÖW7F×G¢äõBåTÄÂDTdTÅBæ÷r‚’À¢7&VFVEö'’FW‡BÀ¢FF§6öæ"äõBåTÄÂDTdTÅBw·Òs£¦§6öæ ¢“°¤5$TDR”äDU‚”bäõBU„•5E2'vVV¶Ç•öÖ÷F÷%÷&VÆV7F–öåöFFöv–â"ôâ'vVV¶Ç•öÖ÷F÷%÷&VÆV7F–öâ"U4”ärv–â†FF“°¤5$TDR”äDU‚”bäõBU„•5E2'vVV¶Ç•öÖ÷F÷%÷&VÆV7F–öåö7&VFVEöFFR"ôâ'vVV¶Ç•öÖ÷F÷%÷&VÆV7F–öâ"†7&VFVEöFFRDU42“° ¢ÒÒÓÓÓÓÒvVV¶Ç•&öGV7EW&f÷&Öæ6RÓÓÓÓĞ¢ÒÒÖ¦öåö66÷VçEö–BFW‡BäõBåTÄÀ¢ÒÒvVV¶Ç•÷&W÷'Eö–BFW‡BäõBåTÄÀ¢ÒÒvVVµ÷7F'BFFP¢ÒÒvVVµöVæBFFP¢ÒÒ&öGV7Eö–BFW‡@¢ÒÒ6–âFW‡BäõBåTÄÀ¢ÒÒ6·RFW‡@¢ÒÒ&öGV7EöæÖRFW‡@¢ÒÒ7VæEóvBF÷V&ÆR&V6—6–öà¢ÒÒG5÷6ÆW5óvBF÷V&ÆR&V6—6–öà¢ÒÒ&VÅ÷6ÆW5óvBF÷V&ÆR&V6—6–öà¢ÒÒ÷&FW'5óvBF÷V&ÆR&V6—6–öà¢ÒÒVæ—G5óvBF÷V&ÆR&V6—6–öà¢ÒÒ–×&W76–öç5óvBF÷V&ÆR&V6—6–öà¢ÒÒ6Æ–6·5óvBF÷V&ÆR&V6—6–öà¢ÒÒ6÷5óvBF÷V&ÆR&V6—6–öà¢ÒÒ&ö5óvBF÷V&ÆR&V6—6–öà¢ÒÒF6÷5óvBF÷V&ÆR&V6—6–öà¢ÒÒ&öf—Eö&Vf÷&UöG5óvBF÷V&ÆR&V6—6–öà¢ÒÒ&öf—EögFW%öG5óvBF÷V&ÆR&V6—6–öà¢ÒÒF&vWEö6÷2F÷V&ÆR&V6—6–öà¢ÒÒ'&VµöWfVåö6÷2F÷V&ÆR&V6—6–öà¢ÒÒÖ†–×VÕ÷&öf—F&ÆUö7F÷V&ÆR&V6—6–öà¢ÒÒ7FGW2FW‡@¢ÒÒÖ–å÷&ö&ÆVÒFW‡@¢ÒÒ&V6öÖÖVæFVEö7F–öâFW‡@¢ÒÒ7F–öç5öW†V7WFVBF÷V&ÆR&V6—6–öà¢ÒÒæW‡E÷&Wf–WuöBF–ÖW7F×G ¢ÒÒ–FV×÷FVæ7•ö¶W’FW‡@¢ÒÒ7&VFVEöBF–ÖW7F×G ¢ÒÒWFFVEöBF–ÖW7F×G ¤5$TDRD$ÄR”bäõBU„•5E2'vVV¶Ç•÷&öGV7E÷W&f÷&Öæ6R"€¢–BFW‡B$”Ô%’´U’À¢7&VFVEöFFRF–ÖW7F×G¢äõBåTÄÂDTdTÅBæ÷r‚’À¢WFFVEöFFRF–ÖW7F×G¢äõBåTÄÂDTdTÅBæ÷r‚’À¢7&VFVEö'’FW‡BÀ¢FF§6öæ"äõBåTÄÂDTdTÅBw·Òs£¦§6öæ ¢“°¤5$TDR”äDU‚”bäõBU„•5E2'vVV¶Ç•÷&öGV7E÷W&f÷&Öæ6UöFFöv–â"ôâ'vVV¶Ç•÷&öGV7E÷W&f÷&Öæ6R"U4”ärv–â†FF“°¤5$TDR”äDU‚”bäõBU„•5E2'vVV¶Ç•÷&öGV7E÷W&f÷&Öæ6Uö7&VFVEöFFR"ôâ'vVV¶Ç•÷&öGV7E÷W&f÷&Öæ6R"†7&VFVEöFFRDU42“° ¢ÒÒÓÓÓÓÒvVV¶Ç•'VÆU&Wf–WrÓÓÓÓĞ¢ÒÒÖ¦öåö66÷VçEö–BFW‡BäõBåTÄÀ¢ÒÒ&Wf–Wuö–BFW‡BäõBåTÄÀ¢ÒÒÖöFVÂFW‡@¢ÒÒ&ö×E÷fW'6–öâFW‡@¢ÒÒFFö†6‚FW‡@¢ÒÒ7FGW2FW‡@¢ÒÒ7F'FVEöBF–ÖW7F×G ¢ÒÒ6ö×ÆWFVEöBF–ÖW7F×G ¢ÒÒGW&F–öåö×2F÷V&ÆR&V6—6–öà¢ÒÒæÇ—6—5÷W&–öE÷7F'BFFP¢ÒÒæÇ—6—5÷W&–öEöVæBFFP¢ÒÒ&V6÷&G5öæÇ—¦VBF÷V&ÆR&V6—6–öà¢ÒÒFö¶Vç5÷W6VBF÷V&ÆR&V6—6–öà¢ÒÒ6÷7EöW7F–ÖFU÷W6BF÷V&ÆR&V6—6–öà¢ÒÒFF÷VÆ—G•÷66÷&RF÷V&ÆR&V6—6–öà¢ÒÒFF÷v&æ–æw2§6öæ ¢ÒÒ'VÆW5÷&÷÷6VBF÷V&ÆR&V6—6–öà¢ÒÒ'VÆW5ö&÷fVBF÷V&ÆR&V6—6–öà¢ÒÒ'VÆW5÷&V¦V7FVBF÷V&ÆR&V6—6–öà¢ÒÒ'VÆW5÷Væ6†ævVBF÷V&ÆR&V6—6–öà¢ÒÒfW'6–öåö–BFW‡@¢ÒÒfW'6–öåö7F—fFVB&ööÆVà¢ÒÒW'&÷%öÖW76vRFW‡@¢ÒÒvÆö&Åöö'6W'fF–öç2§6öæ ¢ÒÒ6ÆVFU÷&u÷&W7öç6RFW‡@¢ÒÒæW‡E÷66†VGVÆVEöBF–ÖW7F×G ¤5$TDRD$ÄR”bäõBU„•5E2'vVV¶Ç•÷'VÆU÷&Wf–Wr"€¢–BFW‡B$”Ô%’´U’À¢7&VFVEöFFRF–ÖW7F×G¢äõBåTÄÂDTdTÅBæ÷r‚’À¢WFFVEöFFRF–ÖW7F×G¢äõBåTÄÂDTdTÅBæ÷r‚’À¢7&VFVEö'’FW‡BÀ¢FF§6öæ"äõBåTÄÂDTdTÅBw·Òs£¦§6öæ ¢“°¤5$TDR”äDU‚”bäõBU„•5E2'vVV¶Ç•÷'VÆU÷&Wf–WuöFFöv–â"ôâ'vVV¶Ç•÷'VÆU÷&Wf–Wr"U4”ärv–â†FF“°¤5$TDR”äDU‚”bäõBU„•5E2'vVV¶Ç•÷'VÆU÷&Wf–Wuö7&VFVEöFFR"ôâ'vVV¶Ç•÷'VÆU÷&Wf–Wr"†7&VFVEöFFRDU42“° 