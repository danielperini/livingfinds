/**
 * applyAdsScopeAuthorization
 *
 * Aplica a lista canônica de SKUs autorizados para Ads.
 * - Marca authorized / not_authorized em todos os produtos da conta
 * - Calcula ads_eligibility_status com base em estoque, listing e oferta
 * - Pausa campanhas de SKUs não autorizados via Amazon Ads API (batch PAUSED)
 * - Cancela decisões pendentes de SKUs não autorizados
 * - Remove itens inelegíveis da fila de kickoff
 * - Emite alertas operacionais (sem duplicar)
 *
 * Normalização de SKU: trim, case-sensitive (FBA-0087 ≠ FBA-0087c)
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const ADS_CLIENT_ID = Deno.env.get('ADS_CLIENT_ID') || '';
const ADS_CLIENT_SECRET = Deno.env.get('ADS_CLIENT_SECRET') || '';
const ADS_REGION = Deno.env.get('ADS_REGION') || 'na';
const ENDPOINT_MAP: Record<string, string> = {
  na: 'https://advertising-api.amazon.com',
  eu: 'https://advertising-api-eu.amazon.com',
  fe: 'https://advertising-api-fe.amazon.com',
};

// ── Lista canônica de SKUs autorizados ─────────────────────────────────────────
// Comparação EXATA e case-sensitive. Alterar aqui para incluir/remover.
const AUTHORIZED_SKUS: string[] = [
  'FBA-0087c',
  'FBA-0076C',
  'FBA-0010',
  'FBA-0100',
  'SKU-002314A',
  'SKU-002314V',
  'FBA-0076A',
  'FBA-0008V',
  'FBA-0008P',
  'FBA-0087',
  'FBA-0047b',
  'FBA-0088a',
  'FBA-0065PR',
  'FBA-0024b',
];

// Mapeamento esperado SKU → ASIN (para detecção de conflito)
const SKU_ASIN_MAPPING: Record<string, string> = {
  'FBA-0087c':    'B0H59FPPKS',
  'FBA-0076C':    'B0GHP612B8',
  'FBA-0010':     'B0DJ3RGHK6',
  'FBA-0100':     'B0GR6GXS1B',
  'SKU-002314A':  'B0GNY7NYRN',
  'SKU-002314V':  'B0GNW1Q6V3',
  'FBA-0076A':    'B0GHP68123',
  'FBA-0008V':    'B0GHP958MV',
  'FBA-0008P':    'B0GHP9PPWN',
  'FBA-0087':     'B0GFQ7SY5W',
  'FBA-0047b':    'B0FVW1TV6Y',
  'FBA-0088a':    'B0FRVMB7BW',
  'FBA-0065PR':   'B0FCYR3VBD',
  'FBA-0024b':    'B0F45JG27L',
};

// SKUs com estado inicial de elegibilidade específico (conforme spec)
const INITIAL_ELIGIBILITY: Record<string, string> = {
  'FBA-0008P':  'listing_suppressed',  // oferta suprimida
  'FBA-0047b':  'out_of_stock',         // estoque zero confirmado
};

// Pausas que o sistema pode retomar (seção 9 da spec)
const SYSTEM_PAUSE_REASONS = new Set([
  'out_of_stock', 'listing_suppressed', 'offer_inactive',
  'temporary_ads_ineligibility', 'sku_not_in_current_ads_scope',
]);

// Pausas que o sistema NÃO pode retomar
const NO_RESUME_REASONS = new Set([
  'manual_pause', 'poor_performance', 'user_daily_cap',
  'policy_violation', 'economic_loss', 'campaign_archived',
  'account_disabled',
]);

function normSku(s: string): string {
  return (s || '').trim(); // preserva maiúsculas/minúsculas originais
}

const AUTHORIZED_SET = new Set(AUTHORIZED_SKUS.map(normSku));

async function getAdsAccessToken(refreshToken: string): Promise<string> {
  const res = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: ADS_CLIENT_ID,
      client_secret: ADS_CLIENT_SECRET,
    }).toString(),
  });
  if (!res.ok) throw new Error(`Ads token: ${res.status} ${await res.text()}`);
  return (await res.json()).access_token;
}

async function batchSetCampaignState(
  accessToken: string, profileId: string,
  campaignIds: string[], state: 'ENABLED' | 'PAUSED'
): Promise<{ success: string[]; failed: string[] }> {
  const endpoint = ENDPOINT_MAP[ADS_REGION] || ENDPOINT_MAP.na;
  const allSuccess: string[] = [], allFailed: string[] = [];
  for (let i = 0; i < campaignIds.length; i += 10) {
    const batch = campaignIds.slice(i, i + 10);
    try {
      const res = await fetch(`${endpoint}/sp/campaigns`, {
        method: 'PUT',
        headers: {
          'Amazon-Advertising-API-ClientId': ADS_CLIENT_ID,
          'Amazon-Advertising-API-Scope': profileId,
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/vnd.spCampaign.v3+json',
          'Accept': 'application/vnd.spCampaign.v3+json',
        },
        body: JSON.stringify({ campaigns: batch.map(id => ({ campaignId: id, state })) }),
      });
      if (res.ok) {
        const data = await res.json();
        allSuccess.push(...(data?.campaigns?.success || []).map((s: any) => s.campaignId));
        allFailed.push(...(data?.campaigns?.error || []).map((e: any) => e.campaignId));
      } else {
        allFailed.push(...batch);
      }
    } catch { allFailed.push(...batch); }
  }
  return { success: allSuccess, failed: allFailed };
}

// Calcular elegibilidade com base nos campos do produto
function calcEligibility(product: any, authorized: boolean): {
  eligibility_status: string;
  ineligibility_reason: string;
} {
  if (!authorized) return { eligibility_status: 'not_authorized', ineligibility_reason: 'SKU fora da lista de escopo autorizado' };

  const sku = normSku(product.sku || '');

  // Estado inicial fixo para SKUs específicos (spec seção 5)
  if (INITIAL_ELIGIBILITY[sku]) {
    return {
      eligibility_status: INITIAL_ELIGIBILITY[sku],
      ineligibility_reason: sku === 'FBA-0008P'
        ? 'Oferta suprimida — aguardando confirmação SP-API'
        : 'Estoque zero confirmado — campanhas pausadas preventivamente',
    };
  }

  const available = Number(product.available_quantity ?? product.fba_inventory ?? 0);
  // Estoque inbound não conta (spec seção 11)
  if (available <= 0) return { eligibility_status: 'out_of_stock', ineligibility_reason: `Estoque disponível zero (available=${available})` };

  if (product.listing_suppressed === true) return { eligibility_status: 'listing_suppressed', ineligibility_reason: 'Listing suprimido pela Amazon' };
  if (product.offer_active === false) return { eligibility_status: 'offer_inactive', ineligibility_reason: 'Oferta inativa no marketplace' };
  if (product.listing_buyable === false) return { eligibility_status: 'not_buyable', ineligibility_reason: 'Produto não comprável' };

  const inventoryStatus = product.inventory_status;
  if (inventoryStatus === 'low_stock') return { eligibility_status: 'low_stock', ineligibility_reason: `Estoque baixo (${available} unidades)` };

  return { eligibility_status: 'eligible', ineligibility_reason: '' };
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
    if (user.role !== 'admin') return Response.json({ error: 'Admin only' }, { status: 403 });

    const body = await req.json().catch(() => ({}));
    const { amazon_account_id, dry_run = false } = body;
    if (!amazon_account_id) return Response.json({ error: 'amazon_account_id obrigatório' }, { status: 400 });

    const accounts = await base44.asServiceRole.entities.AmazonAccount.filter({ id: amazon_account_id });
    const account = accounts[0];
    if (!account) return Response.json({ error: 'Conta não encontrada' }, { status: 404 });

    const now = new Date().toISOString();

    // 1. Carregar todos os produtos da conta
    const products = await base44.asServiceRole.entities.Product.filter({ amazon_account_id }, null, 500);

    // 2. Carregar campanhas operacionais
    const campaigns = await base44.asServiceRole.entities.Campaign.filter({ amazon_account_id }, null, 500);
    const operationalCampaigns = campaigns.filter((c: any) =>
      !['archived', 'ARCHIVED'].includes(c.state || c.status || '')
    );

    // 3. Obter token Ads
    let accessToken: string | null = null;
    try {
      const refreshToken = account.ads_refresh_token || Deno.env.get('ADS_REFRESH_TOKEN') || '';
      if (refreshToken) accessToken = await getAdsAccessToken(refreshToken);
    } catch (e: any) {
      console.warn('[applyAdsScopeAuthorization] Token Ads não disponível:', e.message);
    }
    const profileId = account.ads_profile_id || Deno.env.get('ADS_PROFILE_ID') || '';

    const report: any = {
      dry_run,
      authorized_products: [],
      not_authorized_products: [],
      mapping_conflicts: [],
      temporarily_ineligible: [],
      campaigns_to_pause: [],
      campaigns_paused_on_amazon: 0,
      campaigns_pause_failed: 0,
      decisions_cancelled: 0,
      kickoff_removed: 0,
      alerts_created: 0,
    };

    const productUpdates: any[] = [];

    // 4. Classificar cada produto
    for (const product of products as any[]) {
      const sku = normSku(product.sku || '');
      if (!sku) continue;

      const isAuthorized = AUTHORIZED_SET.has(sku);
      const expectedAsin = SKU_ASIN_MAPPING[sku];

      // Detecção de conflito de mapeamento
      let hasMappingConflict = false;
      let conflictAsin = '';
      if (isAuthorized && expectedAsin && product.asin && product.asin !== expectedAsin) {
        hasMappingConflict = true;
        conflictAsin = product.asin;
        report.mapping_conflicts.push({ sku, expected_asin: expectedAsin, actual_asin: product.asin });
      }

      const { eligibility_status, ineligibility_reason } = hasMappingConflict
        ? { eligibility_status: 'mapping_conflict', ineligibility_reason: `ASIN esperado ${expectedAsin}, encontrado ${product.asin}` }
        : calcEligibility(product, isAuthorized);

      const scopeStatus = hasMappingConflict ? 'mapping_conflict'
        : !isAuthorized ? 'not_authorized'
        : 'authorized';

      const update: any = {
        id: product.id,
        ads_scope_status: scopeStatus,
        ads_authorized_by_user: isAuthorized,
        ads_eligibility_status: eligibility_status,
        ads_ineligibility_reason: ineligibility_reason,
        ads_last_eligibility_check_at: now,
        ads_scope_updated_at: now,
        ads_scope_updated_by: 'applyAdsScopeAuthorization',
      };
      if (isAuthorized && !product.ads_authorized_at) {
        update.ads_authorized_at = now;
        update.ads_authorized_by = 'system_initial_migration';
      }
      if (hasMappingConflict) {
        update.ads_mapping_conflict_asin = conflictAsin;
        update.ads_mapping_conflict_sku = sku;
      }

      productUpdates.push(update);

      if (isAuthorized) {
        if (eligibility_status === 'eligible') {
          report.authorized_products.push({ sku, asin: product.asin, eligibility_status });
        } else {
          report.temporarily_ineligible.push({ sku, asin: product.asin, eligibility_status, reason: ineligibility_reason });
        }
      } else {
        report.not_authorized_products.push({ sku, asin: product.asin });
      }
    }

    // 5. Identificar campanhas de SKUs não autorizados (enabled → pausar)
    const notAuthorizedAsins = new Set(
      (products as any[])
        .filter((p: any) => !AUTHORIZED_SET.has(normSku(p.sku || '')))
        .map((p: any) => p.asin)
        .filter(Boolean)
    );

    // Também campanhas de produtos temporariamente inelegíveis (out_of_stock, listing_suppressed)
    const tempIneligibleAsins = new Set(
      (products as any[])
        .filter((p: any) => {
          const sku = normSku(p.sku || '');
          if (!AUTHORIZED_SET.has(sku)) return false;
          const { eligibility_status } = calcEligibility(p, true);
          return ['out_of_stock', 'listing_suppressed', 'offer_inactive'].includes(eligibility_status);
        })
        .map((p: any) => p.asin)
        .filter(Boolean)
    );

    // Campanhas enabled que devem ser pausadas
    const campaignsToPause = operationalCampaigns.filter((c: any) => {
      const cAsin = c.asin || null;
      if (!cAsin) return false;
      const isEnabled = ['enabled', 'ENABLED'].includes(c.state || c.status || '');
      if (!isEnabled) return false;
      return notAuthorizedAsins.has(cAsin) || tempIneligibleAsins.has(cAsin);
    });

    report.campaigns_to_pause = campaignsToPause.map((c: any) => ({
      campaign_id: c.campaign_id || c.amazon_campaign_id,
      name: c.name || c.campaign_name,
      asin: c.asin,
      reason: notAuthorizedAsins.has(c.asin) ? 'sku_not_in_current_ads_scope' : 'temporary_ads_ineligibility',
    }));

    if (!dry_run) {
      // 6. Pausar na Amazon + atualizar localmente
      const idsToSend = campaignsToPause
        .map((c: any) => c.campaign_id || c.amazon_campaign_id)
        .filter(Boolean);

      if (accessToken && profileId && idsToSend.length > 0) {
        const result = await batchSetCampaignState(accessToken, profileId, idsToSend, 'PAUSED');
        report.campaigns_paused_on_amazon = result.success.length;
        report.campaigns_pause_failed = result.failed.length;
      }

      // Atualizar estado local das campanhas pausadas
      for (const c of campaignsToPause as any[]) {
        const pauseReason = notAuthorizedAsins.has(c.asin)
          ? 'sku_not_in_current_ads_scope'
          : 'temporary_ads_ineligibility';
        await base44.asServiceRole.entities.Campaign.update(c.id, {
          state: 'paused', status: 'paused',
          updated_at: now,
        }).catch(() => {});

        // Marcar produto como ads_resume_pending se for inelegível temporariamente
        if (tempIneligibleAsins.has(c.asin)) {
          const prod = (products as any[]).find((p: any) => p.asin === c.asin);
          if (prod?.id) {
            const idx = productUpdates.findIndex((u: any) => u.id === prod.id);
            if (idx >= 0) {
              productUpdates[idx].ads_resume_pending = true;
              productUpdates[idx].ads_previous_campaign_state = 'enabled';
              productUpdates[idx].ads_pause_reason = pauseReason;
              productUpdates[idx].ads_paused_at = now;
            }
          }
        }
      }

      // 7. Cancelar decisões pendentes de ASINs não autorizados
      const notAuthAsinList = Array.from(notAuthorizedAsins);
      let decisionsCancelled = 0;
      for (const asin of notAuthAsinList) {
        const pending = await base44.asServiceRole.entities.OptimizationDecision.filter({
          amazon_account_id,
          asin,
          status: 'pending',
        }, null, 100).catch(() => []);
        const scheduled = await base44.asServiceRole.entities.OptimizationDecision.filter({
          amazon_account_id,
          asin,
          status: 'approved',
        }, null, 100).catch(() => []);
        const toCancel = [...pending, ...scheduled].filter((d: any) =>
          !['executed', 'failed', 'rolled_back'].includes(d.status || '')
        );
        for (const d of toCancel as any[]) {
          await base44.asServiceRole.entities.OptimizationDecision.update(d.id, {
            status: 'cancelled',
            rationale: (d.rationale || '') + ' [CANCELADO: product_not_ads_eligible — SKU fora do escopo autorizado]',
            updated_at: now,
          }).catch(() => {});
          decisionsCancelled++;
        }
      }
      report.decisions_cancelled = decisionsCancelled;

      // 8. Remover da fila de kickoff (não apagar — mudar para cancelled/waiting)
      let kickoffRemoved = 0;
      for (const asin of notAuthAsinList) {
        const queued = await base44.asServiceRole.entities.ProductKickoffQueue.filter({
          amazon_account_id,
          asin,
          status: 'scheduled',
        }, null, 50).catch(() => []);
        for (const q of queued as any[]) {
          await base44.asServiceRole.entities.ProductKickoffQueue.update(q.id, {
            status: 'cancelled',
            last_error: 'SKU fora do escopo autorizado para Ads — kickoff suspenso',
            completed_at: now,
          }).catch(() => {});
          kickoffRemoved++;
        }
      }
      report.kickoff_removed = kickoffRemoved;

      // 9. Gravar updates dos produtos em lotes
      for (let i = 0; i < productUpdates.length; i += 50) {
        await base44.asServiceRole.entities.Product.bulkUpdate(productUpdates.slice(i, i + 50)).catch(() => {});
      }

      // 10. Emitir alertas (sem duplicar — upsert por chave)
      let alertsCreated = 0;
      const alertsToCreate = [];

      // Alertas de SKU não autorizado com campanha ativa
      for (const c of campaignsToPause as any[]) {
        if (notAuthorizedAsins.has(c.asin)) {
          alertsToCreate.push({
            amazon_account_id,
            alert_type: 'campaign_paused',
            alert_family: 'campaign',
            severity: 'medium',
            status: 'active',
            entity_type: 'campaign',
            entity_id: c.campaign_id || c.amazon_campaign_id || c.id,
            asin: c.asin,
            title: `SKU não autorizado com campanha ativa`,
            message: `Campanha "${c.name || c.campaign_name}" pausada: SKU fora do escopo autorizado`,
            deduplication_key: `${amazon_account_id}|${c.asin}|unauthorized_sku_campaign_active`,
            first_detected_at: now,
            last_detected_at: now,
            source_function: 'applyAdsScopeAuthorization',
            created_at: now,
          });
        }
      }

      // Alertas de autorizado sem estoque
      for (const item of report.temporarily_ineligible) {
        if (item.eligibility_status === 'out_of_stock') {
          alertsToCreate.push({
            amazon_account_id,
            alert_type: 'out_of_stock',
            alert_family: 'inventory',
            severity: 'medium',
            status: 'active',
            entity_type: 'product',
            asin: item.asin,
            title: `Produto autorizado sem estoque`,
            message: `${item.sku} (${item.asin}) está sem estoque disponível. Ads pausados.`,
            deduplication_key: `${amazon_account_id}|${item.sku}|authorized_product_out_of_stock`,
            first_detected_at: now,
            last_detected_at: now,
            source_function: 'applyAdsScopeAuthorization',
            created_at: now,
          });
        }
        if (item.eligibility_status === 'listing_suppressed') {
          alertsToCreate.push({
            amazon_account_id,
            alert_type: 'sync_error',
            alert_family: 'campaign',
            severity: 'high',
            status: 'active',
            entity_type: 'product',
            asin: item.asin,
            title: `Produto autorizado com listing suprimido`,
            message: `${item.sku} (${item.asin}): listing suprimido. Ads bloqueados até confirmação SP-API.`,
            deduplication_key: `${amazon_account_id}|${item.sku}|authorized_product_listing_suppressed`,
            first_detected_at: now,
            last_detected_at: now,
            source_function: 'applyAdsScopeAuthorization',
            created_at: now,
          });
        }
      }

      // Upsert de alertas (dedup pela chave)
      for (const alert of alertsToCreate) {
        try {
          const existing = await base44.asServiceRole.entities.Alert.filter({
            amazon_account_id,
            deduplication_key: alert.deduplication_key,
            status: 'active',
          }, null, 1);
          if (existing.length === 0) {
            await base44.asServiceRole.entities.Alert.create(alert);
            alertsCreated++;
          } else {
            await base44.asServiceRole.entities.Alert.update(existing[0].id, { last_detected_at: now });
          }
        } catch {}
      }
      report.alerts_created = alertsCreated;

    } else {
      // dry_run: apenas simular updates sem gravar
      report.would_update_products = productUpdates.length;
    }

    return Response.json({ ok: true, ...report });

  } catch (error: any) {
    console.error('[applyAdsScopeAuthorization]', error.message);
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});