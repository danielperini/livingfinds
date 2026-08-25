from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    p = Path(path)
    s = p.read_text()
    if old not in s:
        raise SystemExit(f"missing expected fragment in {path}: {old[:100]!r}")
    p.write_text(s.replace(old, new, 1))


p = "base44/functions/runUnifiedDecisionEngine/entry.ts"
replace_once(
    p,
    "const servingGrowth = body.skip_serving_campaign_growth === true || (!lifecycleWindow && !growthRecommendedByToday)\n      ? { ok: true, skipped: true }\n      : await invoke(base44, 'runServingCampaignGrowthObjective', {",
    "const servingGrowth = body.skip_serving_campaign_growth === true\n      ? { ok: true, skipped: true }\n      : await invoke(base44, 'runServingCampaignGrowthObjective', {",
)
replace_once(p, "max_auto_budget_expansions: body.max_auto_budget_expansions ?? 2,", "max_auto_budget_expansions: body.max_auto_budget_expansions ?? 6,")
replace_once(p, "max_new_exact_per_run: body.max_new_exact_per_run ?? 2,", "max_new_exact_per_run: body.max_new_exact_per_run ?? 6,")
replace_once(p, "max_structure_repairs_per_run: body.max_structure_repairs_per_run ?? 3,", "max_structure_repairs_per_run: body.max_structure_repairs_per_run ?? 5,")
replace_once(p, "max_bid_recoveries_per_run: body.max_bid_recoveries_per_run ?? 3,", "max_bid_recoveries_per_run: body.max_bid_recoveries_per_run ?? 8,")

p = "base44/functions/runServingCampaignGrowthObjective/entry.ts"
replace_once(p, "const POLICY_VERSION = 'serving-growth-v18';", "const POLICY_VERSION = 'serving-growth-v19-sales-first';")
replace_once(p, "const maxAutoBudgetExpansions = clamp(Math.floor(finite(body.max_auto_budget_expansions, 2)), 0, 10);", "const maxAutoBudgetExpansions = clamp(Math.floor(finite(body.max_auto_budget_expansions, 6)), 0, 10);")
replace_once(p, "const maxNewExactPerRun = clamp(Math.floor(finite(body.max_new_exact_per_run, 2)), 0, 10);", "const maxNewExactPerRun = clamp(Math.floor(finite(body.max_new_exact_per_run, 6)), 0, 10);")
# Make existing economic rows explicit for strict deno check; no logic change.
replace_once(p, "        const econ = economicsByAsin.get(asin);", "        const econ: any = economicsByAsin.get(asin);")
replace_once(p, "        const econ = economicsByAsin.get(row.asin);", "        const econ: any = economicsByAsin.get(row.asin);")
replace_once(
    p,
    "const promotionCapacity = Math.max(0, Math.min(\n        maxNewExactPerRun,\n        goal.growth_gap,\n        goal.growth_gap - inFlightManuals.length,\n      ));",
    "const promotionCapacity = Math.max(0, Math.min(\n        maxNewExactPerRun,\n        Math.max(goal.growth_gap, 2),\n      ));",
)
replace_once(
    p,
    "          exclude_asins: matureZeroAsins,\n          trigger_type: 'serving_growth_v18_auto_first',",
    "          exclude_asins: [],\n          trigger_type: 'serving_growth_v19_auto_first',",
)
marker = "      const autoExactPromotions = dryRun ? 0 : promotedCount(autoHarvest);\n"
addition = """      const autoExactPromotions = dryRun ? 0 : promotedCount(autoHarvest);
      const remainingManualCapacity = Math.max(0, promotionCapacity - autoExactPromotions);
      let manualHarvest: any = { ok: true, skipped: true };
      if (remainingManualCapacity > 0) {
        manualHarvest = await base44.asServiceRole.functions.invoke('runImmediateSameSkuSearchTermHarvest', {
          amazon_account_id: accountId,
          _service_role: true,
          dry_run: dryRun,
          lookback_days: 65,
          max_promotions: remainingManualCapacity,
          source_campaign_type: 'MANUAL',
          exclude_asins: [],
          trigger_type: 'serving_growth_v19_manual_converted_terms',
        }).then((result: any) => result?.data || result || { ok: true })
          .catch((error: any) => ({ ok: false, error: error?.message || String(error) }));
      }
      const manualExactPromotions = dryRun ? 0 : promotedCount(manualHarvest);
      const exactPromotions = autoExactPromotions + manualExactPromotions;
"""
replace_once(p, marker, addition)
replace_once(p, "        : budgetDecisions.length || autoExactPromotions > 0", "        : budgetDecisions.length || exactPromotions > 0")
replace_once(p, "        auto_exact_promotions: autoExactPromotions,", "        auto_exact_promotions: autoExactPromotions,\n        manual_exact_promotions: manualExactPromotions,\n        exact_promotions_total: exactPromotions,")
replace_once(p, "          exact_source_priority: 'AUTO same-SKU converted Search Terms',", "          exact_source_priority: 'same-SKU converted Search Terms: AUTO first, then MANUAL variations',")
replace_once(p, "          auto_harvest: autoHarvest?.reports || autoHarvest,", "          auto_harvest: autoHarvest?.reports || autoHarvest,\n          manual_harvest: manualHarvest?.reports || manualHarvest,")
replace_once(p, "          records_imported: budgetDecisions.filter((row) => !row.reused).length + autoExactPromotions,", "          records_imported: budgetDecisions.filter((row) => !row.reused).length + exactPromotions,")
replace_once(p, "            auto_exact_promotions: autoExactPromotions,", "            auto_exact_promotions: autoExactPromotions,\n            manual_exact_promotions: manualExactPromotions,\n            exact_promotions_total: exactPromotions,")
replace_once(p, "      ok: reports.every((report) => report?.details?.term_bank?.ok !== false && report?.details?.auto_harvest?.ok !== false),", "      ok: reports.every((report) => report?.details?.term_bank?.ok !== false && report?.details?.auto_harvest?.ok !== false && report?.details?.manual_harvest?.ok !== false),")

print("sales growth patch applied")
