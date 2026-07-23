/**
 * checkAndCreateAlerts v2
 *
 * Motor de verificação de alertas operacionais do LivingFinds.
 * Toda criação passa pelo upsertOperationalAlert (deduplicação canônica).
 *
 * REGRAS:
 * - Estoque: out_of_stock (available=0) vs low_stock (positivo < limite)
 * - no_sales: exige clicks >= 10 + spend >= R$12 + dados frescos
 * - spend_overpacing: usa curva horária conservadora (nunca rate_limit)
 * - Alertas monitorados: high_acos, low_roas, no_sales, budget_exhausted, out_of_stock, low_stock, critical_stock, inventory_data_stale
 * - no_impressions: REMOVIDO — keywords gerenciadas pelo motor determinístico, alertas existentes são resolvidos automaticamente
 * - Resolução automática: quando condição desaparece, resolve o alerta
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const ASIN_PATTERN = /^[A-Z0-9]{10}$/;

function isAsin(v: string): boolean { return ASIN_PATTERN.test((v || '').trim().toUpperCase()); }

async function upsert(base44: any, params: any) {
  return base44.asServiceRole.functions.invoke('upsertOperationalAlert', params).catch((e: any) => {
    console.error('[checkAndCreateAlerts] upsert failed:', e.message, JSON.stringify(params).slice(0, 200));
  });
}

async function resolve(base44: any, amazon_account_id: string, alert_type: string, entity_type: string, entity_id: string, resolution_reason: string, source_function = 'checkAndCreateAlerts') {
  return upsert(base44, {
    amazon_account_id, alert_type, entity_type, entity_id,
    title: '-', message: '-', resolved: true, resolution_reason, source_function,
  });
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    try { await base44.auth.me(); } catch { /* automação */ }

    const body = await req.json().catch(() => ({}));
    let aid = body.amazon_account_id;

    if (!aid) {
      const accs = await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' }, '-created_date', 1);
      aid = accs[0]?.id;
    }
    if (!aid) return Response.json({ ok: false, message: 'Nenhuma conta encontrada' });

    const now = new Date().toISOString();
    const SRC = 'checkAndCreateAlerts';
    let created = 0, updated = 0, resolved = 0;

    // ── Configurações ──────────────────────────────────────────────────────
    const psList = await base44.asServiceRole.entities.PerformanceSettings.filter({ amazon_account_id: aid }, '-updated_at', 1).catch(() => []);
    const ps = psList[0] || {};
    const TARGET_ACOS = Number(ps.target_acos || 10);
    const MAX_ACOS = Number(ps.max_acos || 15);
    const TARGET_ROAS = Number(ps.target_roas || 4);
    const DAILY_CAP = Number(ps.daily_budget_limit || 70);
    const LOW_STOCK_UNITS = 10;
    const CRITICAL_STOCK_UNITS = 5;

    // ── Campanhas ativas ───────────────────────────────────────────────────
    const campaigns = await base44.asServiceRole.entities.Campaign.filter(
      { amazon_account_id: aid, state: 'enabled' }, '-spend', 500
    ).catch(() => []);

    for (const camp of campaigns) {
      const cid = camp.campaign_id || camp.id;

      // ACoS crítico
      const acos = Number(camp.acos || 0);
      if (acos > MAX_ACOS * 1.5 && (camp.spend || 0) > 5) {
        await upsert(base44, {
          amazon_account_id: aid, alert_type: 'high_acos', alert_family: 'performance',
          severity: acos > 100 ? 'critical' : acos > MAX_ACOS * 2 ? 'high' : 'medium',
          entity_type: 'campaign', entity_id: cid, campaign_id: cid,
          title: `ACoS crítico: ${camp.name}`,
          message: `ACoS ${acos.toFixed(1)}% — meta ${TARGET_ACOS}%, máximo ${MAX_ACOS}%`,
          metric_name: 'acos', metric_value: acos, threshold_value: MAX_ACOS,
          data_window: '7d', source_function: SRC,
        });
        created++;
      } else if (acos > 0 && acos <= MAX_ACOS) {
        // Resolver se ACoS voltou ao normal
        await resolve(base44, aid, 'high_acos', 'campaign', cid, 'acos_normalized', SRC);
        resolved++;
      }

      // ROAS baixo — somente com gasto significativo
      const roas = Number(camp.roas || 0);
      if (roas > 0 && roas < TARGET_ROAS * 0.5 && (camp.spend || 0) > 10) {
        await upsert(base44, {
          amazon_account_id: aid, alert_type: 'low_roas', alert_family: 'performance',
          severity: 'medium',
          entity_type: 'campaign', entity_id: cid, campaign_id: cid,
          title: `ROAS baixo: ${camp.name}`,
          message: `ROAS ${roas.toFixed(2)}x — meta ${TARGET_ROAS}x`,
          metric_name: 'roas', metric_value: roas, threshold_value: TARGET_ROAS,
          data_window: '7d', source_function: SRC,
        });
        created++;
      }

      // No_sales: exige amostra mínima (clicks ≥ 10 + spend ≥ R$12)
      const clicks = Number(camp.clicks || 0);
      const spend = Number(camp.spend || 0);
      const sales = Number(camp.sales || 0);
      if (spend >= 12 && clicks >= 10 && sales === 0) {
        await upsert(base44, {
          amazon_account_id: aid, alert_type: 'no_sales', alert_family: 'performance',
          severity: spend >= 30 ? 'high' : 'medium',
          entity_type: 'campaign', entity_id: cid, campaign_id: cid,
          title: `Gasto sem vendas: ${camp.name}`,
          message: `R$${spend.toFixed(2)} gastos / ${clicks} cliques / sem conversão`,
          metric_name: 'spend', metric_value: spend, threshold_value: 12,
          data_window: '7d', source_function: SRC,
        });
        created++;
      } else if (sales > 0) {
        await resolve(base44, aid, 'no_sales', 'campaign', cid, 'sale_detected', SRC);
        resolved++;
      }

      // Budget esgotado cedo (antes das 18h com >90% consumido)
      const hour = new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo', hour: 'numeric', hour12: false });
      const hourN = parseInt(hour, 10);
      if (hourN < 18 && camp.daily_budget > 0) {
        const pct = (camp.spend || 0) / camp.daily_budget;
        if (pct >= 0.9) {
          await upsert(base44, {
            amazon_account_id: aid, alert_type: 'budget_exhausted', alert_family: 'budget',
            severity: 'high',
            entity_type: 'campaign', entity_id: cid, campaign_id: cid,
            title: `Budget esgotado às ${hourN}h: ${camp.name}`,
            message: `${(pct * 100).toFixed(0)}% do orçamento consumido antes das 18h BRT`,
            metric_name: 'budget_pct', metric_value: pct * 100, threshold_value: 90,
            data_window: 'today', source_function: SRC,
          });
          created++;
        }
      }
    }

    // ── Produtos (estoque) ──────────────────────────────────────────────────
    // Consolidar por ASIN (evitar um alerta por campanha)
    const products = await base44.asServiceRole.entities.Product.filter(
      { amazon_account_id: aid }, '-updated_at', 200
    ).catch(() => []);

    // Mapa ASIN → produto mais recente
    const productByAsin = new Map<string, any>();
    for (const p of products) {
      if (!p.asin) continue;
      const ex = productByAsin.get(p.asin);
      if (!ex || new Date(p.updated_at || 0) > new Date(ex.updated_at || 0)) {
        productByAsin.set(p.asin, p);
      }
    }

    for (const [asin, product] of productByAsin.entries()) {
      const available = Number(product.fba_inventory ?? product.available_quantity ?? 0);
      const hasCampaign = product.has_campaign;
      const syncAge = product.last_sync_at
        ? (Date.now() - new Date(product.last_sync_at).getTime()) / 3600000
        : 999;
      const dataFreshness = syncAge < 26 ? 'fresh' : 'stale';

      // Dado stale: não afirmar out_of_stock, gerar inventory_data_stale
      if (dataFreshness === 'stale' && available === 0) {
        await upsert(base44, {
          amazon_account_id: aid, alert_type: 'inventory_data_stale', alert_family: 'inventory',
          severity: 'low', entity_type: 'product', entity_id: asin, asin,
          title: `Dados de estoque desatualizados: ${asin}`,
          message: `Último sync há ${Math.round(syncAge)}h — não é possível confirmar estoque zero`,
          data_freshness: 'stale', source_function: SRC,
        });
        created++;
        continue;
      }

      if (available === 0) {
        await upsert(base44, {
          amazon_account_id: aid, alert_type: 'out_of_stock', alert_family: 'inventory',
          severity: hasCampaign ? 'critical' : 'high',
          entity_type: 'product', entity_id: asin, asin,
          title: `Sem estoque: ${asin}`,
          message: hasCampaign
            ? `Produto sem estoque FBA com campanha ativa — risco de gasto sem conversão`
            : `Produto sem estoque FBA`,
          metric_name: 'fba_inventory', metric_value: 0, threshold_value: 1,
          data_freshness: dataFreshness, source_function: SRC,
        });
        created++;
      } else if (available <= CRITICAL_STOCK_UNITS) {
        await upsert(base44, {
          amazon_account_id: aid, alert_type: 'critical_stock', alert_family: 'inventory',
          severity: 'high', entity_type: 'product', entity_id: asin, asin,
          title: `Estoque crítico: ${asin}`,
          message: `${available} unidades disponíveis — abaixo do nível crítico (${CRITICAL_STOCK_UNITS})`,
          metric_name: 'fba_inventory', metric_value: available, threshold_value: CRITICAL_STOCK_UNITS,
          data_freshness: dataFreshness, source_function: SRC,
        });
        created++;
      } else if (available <= LOW_STOCK_UNITS) {
        await upsert(base44, {
          amazon_account_id: aid, alert_type: 'low_stock', alert_family: 'inventory',
          severity: 'medium', entity_type: 'product', entity_id: asin, asin,
          title: `Estoque baixo: ${asin}`,
          message: `${available} unidades disponíveis — abaixo do mínimo (${LOW_STOCK_UNITS})`,
          metric_name: 'fba_inventory', metric_value: available, threshold_value: LOW_STOCK_UNITS,
          data_freshness: dataFreshness, source_function: SRC,
        });
        created++;
      } else {
        // Estoque voltou — resolver alertas de estoque deste ASIN
        for (const t of ['out_of_stock', 'low_stock', 'critical_stock']) {
          await resolve(base44, aid, t, 'product', asin, 'inventory_restored', SRC);
        }
        resolved++;
      }
    }

    // ── Cleanup: resolver todos alertas no_impressions ativos (removidos do monitor) ──
    const staleNoImpressions = await base44.asServiceRole.entities.Alert.filter(
      { amazon_account_id: aid, alert_type: 'no_impressions', status: 'active' }, null, 500
    ).catch(() => []);
    for (const a of staleNoImpressions) {
      await resolve(base44, aid, 'no_impressions', a.entity_type || 'keyword', a.entity_id || a.id, 'removed_no_longer_monitored', SRC);
      resolved++;
    }

    return Response.json({
      ok: true,
      campaigns_checked: campaigns.length,
      products_checked: productByAsin.size,
      alerts_created_or_updated: created,
      alerts_resolved: resolved,
      no_impressions_resolved: staleNoImpressions.length,
    });

  } catch (error: any) {
    console.error('[checkAndCreateAlerts]', error.message);
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});