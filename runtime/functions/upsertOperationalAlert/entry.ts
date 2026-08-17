/**
 * upsertOperationalAlert — Serviço central de alertas LivingFinds
 *
 * REGRAS:
 * - Toda criação de alerta passa por aqui
 * - Deduplication_key canônica: account+type+entity_type+entity_id+context
 * - Se alerta ativo já existe: atualiza (incrementa occurrence_count, refresha métricas)
 * - Se não existe: cria com first_detected_at
 * - Resolução automática: chamada com resolved=true marca resolved + reason
 * - Cooldown: critical=1h, high=6h, medium=24h, low=72h
 * - rate_limit reservado exclusivamente a HTTP 429 / throttling
 * - spend_overpacing é alerta de budget, não rate_limit
 * - out_of_stock para available=0; low_stock para positivo < limite
 * - keyword com entity_id ~= ASIN pattern → entity_type = product_target
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const ASIN_PATTERN = /^[A-Z0-9]{10}$/;

const COOLDOWN_HOURS: Record<string, number> = {
  critical: 1, high: 6, medium: 24, low: 72, info: 168,
};

function buildDedupKey(params: {
  amazon_account_id: string;
  alert_type: string;
  entity_type: string;
  entity_id: string;
  context?: string;
}): string {
  const parts = [
    params.amazon_account_id,
    params.alert_type,
    params.entity_type,
    params.entity_id,
  ];
  if (params.context) parts.push(params.context);
  return parts.join('::').toLowerCase().replace(/\s+/g, '_');
}

function isCooldownActive(alert: any): boolean {
  if (!alert.cooldown_until) return false;
  return new Date(alert.cooldown_until) > new Date();
}

function computeCooldownUntil(severity: string): string {
  const hours = COOLDOWN_HOURS[severity] ?? 24;
  return new Date(Date.now() + hours * 3600000).toISOString();
}

/**
 * Corrige entity_type se o entity_id for um ASIN (produto target, não keyword textual).
 */
function normalizeEntityType(entity_type: string, entity_id: string): string {
  if (entity_type === 'keyword' && ASIN_PATTERN.test((entity_id || '').toUpperCase())) {
    return 'product_target';
  }
  return entity_type;
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    // aceitar chamadas automáticas (automações sem user)
    try { await base44.auth.me(); } catch { /* automação */ }

    const body = await req.json().catch(() => ({}));

    const {
      amazon_account_id,
      alert_type,
      alert_family,
      severity = 'medium',
      entity_type: rawEntityType = 'account',
      entity_id = '',
      title,
      message,
      details,
      asin,
      sku,
      campaign_id,
      ad_group_id,
      keyword_id,
      target_id,
      term,
      metric_name,
      metric_value,
      threshold_value,
      comparison,
      data_window,
      data_source,
      data_freshness = 'unknown',
      dedup_context = '',
      source_function = 'unknown',
      // resolução automática
      resolved = false,
      resolution_reason = '',
      // forçar criação mesmo se cooldown ativo
      force = false,
    } = body;

    if (!amazon_account_id || !alert_type || !title || !message) {
      return Response.json({ ok: false, error: 'amazon_account_id, alert_type, title, message são obrigatórios' }, { status: 400 });
    }

    // Corrigir entity_type se ASIN passado como keyword
    const entity_type = normalizeEntityType(rawEntityType, entity_id);

    const now = new Date().toISOString();
    const deduplication_key = buildDedupKey({ amazon_account_id, alert_type, entity_type, entity_id, context: dedup_context });

    // Buscar alerta existente pela dedup key
    const existing = await base44.asServiceRole.entities.Alert.filter(
      { amazon_account_id, deduplication_key },
      '-created_at', 1
    ).catch(() => []);

    const activeAlert = existing.find((a: any) => a.status === 'active' || a.status === 'acknowledged');

    // ── RESOLUÇÃO AUTOMÁTICA ──────────────────────────────────────────────
    if (resolved) {
      if (activeAlert) {
        await base44.asServiceRole.entities.Alert.update(activeAlert.id, {
          status: 'resolved',
          resolved_at: now,
          resolution_reason: resolution_reason || 'auto_resolved',
          updated_at: now,
        });
        return Response.json({ ok: true, action: 'resolved', id: activeAlert.id });
      }
      return Response.json({ ok: true, action: 'no_active_alert_to_resolve' });
    }

    // ── UPSERT ──────────────────────────────────────────────────────────
    if (activeAlert) {
      // Cooldown: não atualizar last_notified_at se ainda no período
      const inCooldown = !force && isCooldownActive(activeAlert);
      await base44.asServiceRole.entities.Alert.update(activeAlert.id, {
        occurrence_count: (activeAlert.occurrence_count || 1) + 1,
        last_detected_at: now,
        metric_value: metric_value ?? activeAlert.metric_value,
        threshold_value: threshold_value ?? activeAlert.threshold_value,
        severity, // pode ter mudado
        message,  // mensagem mais recente
        details: details ?? activeAlert.details,
        data_freshness,
        source_function,
        ...(!inCooldown ? {
          last_notified_at: now,
          cooldown_until: computeCooldownUntil(severity),
        } : {}),
        updated_at: now,
      });
      return Response.json({ ok: true, action: 'updated', id: activeAlert.id, in_cooldown: inCooldown });
    }

    // Criar novo
    const created = await base44.asServiceRole.entities.Alert.create({
      amazon_account_id,
      alert_type,
      alert_family: alert_family || inferFamily(alert_type),
      severity,
      status: 'active',
      entity_type,
      entity_id,
      asin, sku,
      campaign_id, ad_group_id,
      keyword_id: entity_type === 'keyword' ? (keyword_id || entity_id) : keyword_id,
      target_id: entity_type === 'product_target' ? (target_id || entity_id) : target_id,
      term,
      normalized_term: (term || '').toLowerCase().trim(),
      title,
      message,
      details,
      metric_name,
      metric_value,
      threshold_value,
      comparison,
      data_window,
      data_source,
      data_freshness,
      deduplication_key,
      occurrence_count: 1,
      first_detected_at: now,
      last_detected_at: now,
      last_notified_at: now,
      cooldown_until: computeCooldownUntil(severity),
      source_function,
      created_at: now,
      updated_at: now,
    });

    return Response.json({ ok: true, action: 'created', id: created.id });

  } catch (error: any) {
    console.error('[upsertOperationalAlert]', error.message);
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});

function inferFamily(alert_type: string): string {
  if (['out_of_stock', 'low_stock', 'critical_stock', 'inventory_data_stale'].includes(alert_type)) return 'inventory';
  if (['high_acos', 'low_roas', 'no_sales', 'no_impressions'].includes(alert_type)) return 'performance';
  if (['budget_exhausted', 'spend_overpacing', 'daily_cap_reached'].includes(alert_type)) return 'budget';
  if (['token_expired'].includes(alert_type)) return 'token';
  if (['sync_error'].includes(alert_type)) return 'sync';
  if (['no_impressions', 'high_cpc', 'bid_above_limit', 'competitor_brand_keyword_pending'].includes(alert_type)) return 'keyword';
  if (['campaign_paused'].includes(alert_type)) return 'campaign';
  return 'performance';
}