from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]


def replace_once(text: str, old: str, new: str, label: str) -> str:
    if old not in text:
        raise RuntimeError(f"missing anchor: {label}")
    return text.replace(old, new, 1)


def patch_core() -> None:
    path = ROOT / "base44/functions/runCanonicalDaypartingEngine/entry.ts"
    text = path.read_text()
    text = replace_once(text,
        "const ENGINE_VERSION = 'canonical-dayparting-v3-reviewed';",
        "const ENGINE_VERSION = 'canonical-dayparting-v4-economy-first';",
        "engine version")

    anchor = """function isCanonicalAudit(row: any) {\n  return String(row?.rule_id || '') === 'canonical_bid_envelope_050_150' ||\n    String(row?.rule_version || '').startsWith('canonical-dayparting');\n}\n"""
    helper = anchor + """\nfunction isDayAggregatePattern(row: any) {\n  const granularity = String(row?.granularity || row?.metric_granularity || '').toUpperCase();\n  const label = String(row?.slot_label || '').toLowerCase();\n  if (granularity === 'DAY' || label.endsWith('_dia')) return true;\n  // Compatibilidade com os 7 agregados históricos *_dia que foram gravados\n  // como hour=0 sem ASIN/campaign_id. Eles são contexto diário, não 00:00.\n  return Number(row?.hour) === 0 && !row?.asin && !row?.campaign_id && Number(row?.occurrences || 0) > 24;\n}\n"""
    text = replace_once(text, anchor, helper, "daily aggregate helper")

    old_filter = ".filter((row) => Number(row.day_of_week) === dayOfWeek && Number(row.hour) === hour)"
    new_filter = ".filter((row) => Number(row.day_of_week) === dayOfWeek && Number(row.hour) === hour && !isDayAggregatePattern(row))"
    text = replace_once(text, old_filter, new_filter, "hourly pattern filter")

    start = text.index("function chooseMultiplier(params:")
    end = text.index("async function logBid", start)
    new_choose = r'''function chooseMultiplier(params: {
  slot: ReturnType<typeof resolveSlot>;
  nativeCovered: boolean;
  nativeCompensationMultiplier: number | null;
  pacing: string;
  winner: boolean;
  sampleMature: boolean;
  orders: number;
  acos: number | null;
  targetAcos: number;
  economicRisk: boolean;
  hour: number;
  explorationEligible: boolean;
  maxIncreasePct: number;
  maxDecreasePct: number;
}) {
  const { slot, nativeCovered, nativeCompensationMultiplier, pacing, winner, sampleMature, orders, acos, targetAcos, economicRisk, hour, explorationEligible, maxIncreasePct, maxDecreasePct } = params;
  const maxUpMultiplier = Math.min(1.20, 1 + Math.max(0, Math.min(50, maxIncreasePct)) / 100);
  const minDownMultiplier = Math.max(0.50, 1 - Math.max(0, Math.min(50, maxDecreasePct)) / 100);
  const profitable = sampleMature && orders > 0 && acos !== null && acos <= targetAcos;
  const exceptional = sampleMature && orders >= 2 && acos !== null && acos <= targetAcos * 0.80;

  // Economy first: sem maturidade, nenhum PEAK estatístico autoriza escala.
  if (!slot.mature || slot.classification === 'COLLECTING_DATA') {
    if (pacing === 'morning_reserve' && !winner) return { multiplier: 0.90, reason: 'Pacing matinal com evidência horária insuficiente: contenção leve e reversível.' };
    if (isDemandProbeWindow(hour) && explorationEligible && !economicRisk && !nativeCovered) {
      const probe = winner ? 1.05 : 1.02;
      return { multiplier: Math.min(probe, maxUpMultiplier), reason: `Exploração econômica controlada de ${Math.round((Math.min(probe, maxUpMultiplier) - 1) * 100)}% em janela de demanda, sem tratar peak_score como autorização.` };
    }
    return { multiplier: 1, reason: 'Dados horários insuficientes; manter bid-base.' };
  }

  if (slot.classification === 'ELITE_TIME' || slot.classification === 'STRONG_TIME') {
    if (nativeCompensationMultiplier !== null) return { multiplier: Math.max(minDownMultiplier, Math.min(1, nativeCompensationMultiplier)), reason: 'Compensação local: regra Amazon não pôde ser pausada diante de guardrail.' };
    if (pacing === 'overpacing' || pacing === 'morning_reserve' || economicRisk) return { multiplier: 1, reason: 'Peak estatístico sem autorização econômica: aumento bloqueado por pacing/proteção de lucro.' };
    if (nativeCovered) return { multiplier: 1, reason: 'Regra Amazon aplicável cobre a janela; manter/restaurar bid-base local.' };
    if (!sampleMature || !profitable) return { multiplier: 1, reason: `${slot.classification} é apenas sinal de oportunidade; sem evidência econômica madura, manter baseline.` };

    const desired = slot.classification === 'ELITE_TIME'
      ? exceptional ? 1.20 : 1.10
      : exceptional ? 1.15 : 1.10;
    const multiplier = Math.min(desired, maxUpMultiplier);
    return { multiplier, reason: `${slot.classification} + economia madura: SCALE controlado em +${r2((multiplier - 1) * 100)}%.` };
  }

  if (slot.classification === 'NORMAL_TIME') {
    if (pacing === 'morning_reserve' && !winner) return { multiplier: 0.90, reason: 'NORMAL matinal: contenção leve para preservar verba posterior.' };
    if (isDemandProbeWindow(hour) && explorationEligible && !economicRisk && !nativeCovered) {
      const probe = winner ? 1.05 : 1.02;
      return { multiplier: Math.min(probe, maxUpMultiplier), reason: `NORMAL com exploração econômica de ${Math.round((Math.min(probe, maxUpMultiplier) - 1) * 100)}%.` };
    }
    return { multiplier: 1, reason: 'NORMAL: manter/restaurar bid-base.' };
  }

  if (winner) return { multiplier: 1, reason: 'Entidade vencedora protegida contra redução horária.' };
  if (!sampleMature) return { multiplier: 1, reason: 'Redução bloqueada por amostra insuficiente.' };

  if (slot.classification === 'WEAK_TIME') {
    const materiallyAboveTarget = acos !== null && acos > targetAcos * 1.20;
    const desired = economicRisk ? 0.85 : (orders === 0 || materiallyAboveTarget || pacing === 'overpacing' || pacing === 'morning_reserve') ? 0.90 : 1;
    return { multiplier: Math.max(desired, minDownMultiplier), reason: desired < 1 ? 'WEAK com evidência madura: contenção leve/moderada, sem corte cego.' : 'WEAK com economia protegida.' };
  }

  if (slot.classification === 'LOSS_TIME') {
    const severeLoss = economicRisk && orders === 0;
    const aboveTarget = acos !== null && acos > targetAcos;
    const desired = severeLoss ? 0.75 : aboveTarget || orders === 0 ? 0.85 : 1;
    return { multiplier: Math.max(desired, minDownMultiplier), reason: desired === 0.75 ? 'LOSS + risco econômico maduro: contenção forte.' : desired === 0.85 ? 'LOSS maduro: redução moderada e reversível.' : 'LOSS estatístico, mas economia/conversão protegida.' };
  }

  return { multiplier: 1, reason: 'Sem ajuste aplicável.' };
}

'''
    text = text[:start] + new_choose + text[end:]

    text = replace_once(text,
        "change_pct: data.base_bid > 0 ? r2(((data.bid_after - data.base_bid) / data.base_bid) * 100) : 0,",
        "change_pct: data.bid_before > 0 ? r2(((data.bid_after - data.bid_before) / data.bid_before) * 100) : 0,",
        "operational change pct")

    text = replace_once(text,
        "bid_change_pct: baseBid > 0 ? r2(((targetBid - baseBid) / baseBid) * 100) : 0,",
        "bid_change_pct: currentBid > 0 ? r2(((targetBid - currentBid) / currentBid) * 100) : 0,\n            bid_change_vs_baseline_pct: baseBid > 0 ? r2(((targetBid - baseBid) / baseBid) * 100) : 0,",
        "decision audit pct")
    path.write_text(text)


def patch_scheduled_rules() -> None:
    path = ROOT / "base44/functions/syncDaypartingConfiguration/entry.ts"
    text = path.read_text()
    text, n = re.subn(r"const CANONICAL_RULES = \[.*?\n\];", "const CANONICAL_RULES = [];", text, count=1, flags=re.S)
    if n != 1:
        raise RuntimeError("could not retire fixed canonical rules")

    marker = "\nDeno.serve(async (request) => {"
    archive_fn = r'''
async function archiveFixedScheduledDaypartRules(base44: any, rules: any[]) {
  const candidates = rules.filter((rule: any) => {
    if (['archived', 'failed'].includes(String(rule.status || ''))) return false;
    const engine = String(rule.engine_version || '');
    const name = String(rule.rule_name || '');
    return engine === 'canonical-daypart-bootstrap-v2-bid-only' ||
      engine === 'canonical-daypart-bootstrap-v1' ||
      name.startsWith('Dias úteis ·') || rule.weekend_holiday_group === true;
  });
  for (const rule of candidates) {
    await base44.asServiceRole.entities.AmazonScheduledRule.update(rule.id, {
      status: 'archived',
      association_status: 'retired_by_canonical_economy_first',
      last_error: 'Regra horária fixa aposentada: dayparting passa a ser decidido por economia + evidência + pacing no motor canônico.',
      updated_at: new Date().toISOString(),
    }).catch(() => {});
    rule.status = 'archived';
  }
  return candidates.length;
}
'''
    if "archiveFixedScheduledDaypartRules" not in text:
        text = replace_once(text, marker, archive_fn + marker, "archive fixed rules function")

    anchor = "let rules = await base44.asServiceRole.entities.AmazonScheduledRule.filter({ amazon_account_id: account.id }, '-updated_at', 500).catch(() => []);"
    replacement = anchor + "\n      const fixedScheduledRulesArchived = await archiveFixedScheduledDaypartRules(base44, rules);"
    if "fixedScheduledRulesArchived" not in text:
        text = replace_once(text, anchor, replacement, "archive fixed rules call")

    text = text.replace("legacy_canonical_rules_archived: legacyPauseRulesArchived,", "legacy_canonical_rules_archived: legacyPauseRulesArchived,\n        fixed_scheduled_rules_archived: fixedScheduledRulesArchived,")
    text = text.replace("`${active.length} regras sincronizadas; ${bootstrapped.length} regras canônicas materializadas; ${legacyPauseRulesArchived} regras canônicas legadas aposentadas`", "`${active.length} regras sincronizadas; ${fixedScheduledRulesArchived} regras horárias fixas aposentadas; motor economy-first é a autoridade de bid`", 1)
    path.write_text(text)


def patch_weekend_learning() -> None:
    path = ROOT / "base44/functions/runWeekendHolidayDaypartLearning/entry.ts"
    text = path.read_text()
    anchor = """function isWeekendDate(value: string) {\n  const d = new Date(`${value}T12:00:00-03:00`);\n  const dow = d.getUTCDay();\n  return dow === 0 || dow === 6;\n}\n"""
    helper = anchor + """\nasync function fetchBrazilHolidays(year: number): Promise<string[]> {\n  const response = await fetch(`https://brasilapi.com.br/api/feriados/v1/${year}`, { signal: AbortSignal.timeout(12000) });\n  if (!response.ok) return [];\n  const rows = await response.json().catch(() => []);\n  return [...new Set((Array.isArray(rows) ? rows : []).map((row: any) => String(row.date || '')).filter(Boolean))];\n}\n"""
    if "async function fetchBrazilHolidays" not in text:
        text = replace_once(text, anchor, helper, "holiday fetch helper")

    old = """const holidayDates = new Set<string>();\n    for (const rule of rules) for (const date of Array.isArray(rule.holiday_dates) ? rule.holiday_dates : []) holidayDates.add(String(date));"""
    new = """const holidayDates = new Set<string>();\n    for (const rule of rules) for (const date of Array.isArray(rule.holiday_dates) ? rule.holiday_dates : []) holidayDates.add(String(date));\n    for (const date of await fetchBrazilHolidays(Number(clock.date.slice(0, 4)))) holidayDates.add(date);"""
    text = replace_once(text, old, new, "direct holiday source")

    text = replace_once(text,
        "const targetAcos = Number(perf.target_acos || 15);",
        "const targetAcos = Number(perf.target_acos || 0);\n    if (!(targetAcos > 0)) return Response.json({ ok: true, skipped: true, reason: 'missing_target_acos_source_of_truth' });",
        "target acos source")
    path.write_text(text)


if __name__ == "__main__":
    patch_core()
    patch_scheduled_rules()
    patch_weekend_learning()
    print("dayparting economy-first patch applied")
