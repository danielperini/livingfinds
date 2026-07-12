/**
 * auditCampaignStateSync
 *
 * Compara o estado das campanhas no banco local com o status real da Amazon Ads API.
 * Discrepâncias são corrigidas automaticamente no banco local (sem intervenção humana).
 *
 * Casos tratados:
 *   - state/status divergente (ex: banco diz ENABLED, Amazon diz PAUSED)
 *   - daily_budget divergente (tolerância R$0.01)
 *   - Campanhas no banco que não existem mais na Amazon (ARCHIVED/removidas)
 *
 * Correção: atualiza o banco local para refletir o estado real da Amazon.
 * Log: SyncExecutionLog com sumário de divergências e correções.
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
const TIME_LIMIT_MS = 85000;
const BATCH_SIZE = 50; // Amazon aceita até 100 por chamada, usamos 50 para margem

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function getAccessToken(refreshToken: string): Promise<string> {
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
  if (!res.ok) throw new Error(`Token error ${res.status}`);
  return (await res.json()).access_token;
}

async function listCampaignsBatch(token: string, profileId: string, campaignIds: string[]): Promise<any[]> {
  const endpoint = ENDPOINT_MAP[ADS_REGION] || ENDPOINT_MAP.na;
  const res = await fetch(`${endpoint}/sp/campaigns/list`, {
    method: 'POST',
    headers: {
      'Amazon-Advertising-API-ClientId': ADS_CLIENT_ID,
      'Amazon-Advertising-API-Scope': profileId,
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/vnd.spCampaign.v3+json',
      'Accept': 'application/vnd.spCampaign.v3+json',
    },
    body: JSON.stringify({
      campaignIdFilter: { include: campaignIds },
      maxResults: BATCH_SIZE,
      includeExtendedDataFields: false,
    }),
  });
  if (!res.ok) return [];
  const data = await res.json();
  return data?.campaigns || [];
}

// Normaliza estado para comparação
function normalizeState(s: string | undefined | null): string {
  return (s || '').toUpperCase().trim();
}

// Normaliza nome de campo state do banco local
function dbState(c: any): string {
  return normalizeState(c.state || c.status || '');
}

Deno.serve(async (req) => {
  const t0 = Date.now();
  const now = new Date().toISOString();

  try {
    const base44 = createClientFromRequest(req);
    const authenticated = await base44.auth.isAuthenticated().catch(() => false);
    const body = await req.json().catch(() => ({}));
    if (!authenticated && !body._service_role) {
      return Response.json({ ok: false, error: 'Não autorizado' }, { status: 401 });
    }

    // Resolver conta
    let account: any = null;
    if (body.amazon_account_id) {
      const accs = await base44.asServiceRole.entities.AmazonAccount.filter({ id: body.amazon_account_id }, null, 1);
      account = accs[0] || null;
    }
    if (!account) {
      const accs = await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' }, null, 1);
      account = accs[0] || null;
    }
    if (!account) return Response.json({ ok: false, error: 'Nenhuma conta conectada' });

    const aid = account.id;
    const profileId = account.ads_profile_id || Deno.env.get('ADS_PROFILE_ID') || '';
    const refreshToken = account.ads_refresh_token || Deno.env.get('ADS_REFRESH_TOKEN') || '';

    if (!profileId || !refreshToken) {
      return Response.json({ ok: false, error: 'Credenciais Ads ausentes' });
    }

    // Obter token
    let token: string;
    try {
      token = await getAccessToken(refreshToken);
    } catch (e: any) {
      return Response.json({ ok: false, error: `Token: ${e.message}` });
    }

    // Carregar todas as campanhas locais (excluindo archived)
    const localCampaigns = await base44.asServiceRole.entities.Campaign.filter(
      { amazon_account_id: aid }, null, 500
    ).catch(() => []);

    // Filtrar apenas campanhas com amazon campaign_id e não archived localmente
    const active = localCampaigns.filter((c: any) => {
      const s = dbState(c);
      return (c.campaign_id || c.amazon_campaign_id) && s !== 'ARCHIVED';
    });

    if (active.length === 0) {
      return Response.json({ ok: true, audited: 0, divergences: 0, corrections: 0, message: 'Nenhuma campanha ativa para auditar' });
    }

    // Índice por amazon campaign_id
    const localById = new Map<string, any>();
    for (const c of active) {
      const amazonId = String(c.campaign_id || c.amazon_campaign_id || '');
      if (amazonId) localById.set(amazonId, c);
    }

    const amazonIds = Array.from(localById.keys());

    // Buscar estado real da Amazon em batches
    const amazonById = new Map<string, any>();
    for (let i = 0; i < amazonIds.length; i += BATCH_SIZE) {
      if (Date.now() - t0 > TIME_LIMIT_MS * 0.6) break; // reservar tempo para correções
      const batch = amazonIds.slice(i, i + BATCH_SIZE);
      try {
        const results = await listCampaignsBatch(token, profileId, batch);
        for (const camp of results) {
          const id = String(camp.campaignId || '');
          if (id) amazonById.set(id, camp);
        }
      } catch { /* continua */ }
      if (i + BATCH_SIZE < amazonIds.length) await sleep(300);
    }

    // Comparar e coletar divergências
    const divergences: any[] = [];
    for (const [amazonId, localCamp] of localById.entries()) {
      const amazonCamp = amazonById.get(amazonId);

      if (!amazonCamp) {
        // Não encontrada na Amazon — pode estar archived ou removida
        if (dbState(localCamp) !== 'ARCHIVED') {
          divergences.push({
            type: 'not_found_on_amazon',
            local_id: localCamp.id,
            amazon_id: amazonId,
            local_state: dbState(localCamp),
            amazon_state: 'NOT_FOUND',
            fix: { state: 'archived', status: 'archived' },
          });
        }
        continue;
      }

      const amazonState = normalizeState(amazonCamp.state);
      const localState = dbState(localCamp);
      const amazonBudget = Number(amazonCamp.budget?.budget ?? amazonCamp.dailyBudget ?? 0);
      const localBudget = Number(localCamp.daily_budget || localCamp.budget || 0);

      const stateDivergent = amazonState && localState !== amazonState;
      const budgetDivergent = amazonBudget > 0 && localBudget > 0 && Math.abs(amazonBudget - localBudget) > 0.01;

      if (stateDivergent || budgetDivergent) {
        const fix: any = {};
        if (stateDivergent) {
          fix.state = amazonState.toLowerCase();
          fix.status = amazonState.toLowerCase();
        }
        if (budgetDivergent) {
          fix.daily_budget = amazonBudget;
          fix.budget = amazonBudget;
        }
        divergences.push({
          type: stateDivergent && budgetDivergent ? 'state_and_budget' : stateDivergent ? 'state' : 'budget',
          local_id: localCamp.id,
          amazon_id: amazonId,
          campaign_name: localCamp.campaign_name || localCamp.name || amazonId,
          local_state: localState,
          amazon_state: amazonState,
          local_budget: localBudget,
          amazon_budget: amazonBudget,
          fix,
        });
      }
    }

    // Aplicar correções automaticamente no banco local
    let corrections = 0;
    const correctionErrors: string[] = [];
    for (const div of divergences) {
      if (Date.now() - t0 > TIME_LIMIT_MS) break;
      try {
        await base44.asServiceRole.entities.Campaign.update(div.local_id, {
          ...div.fix,
          last_state_audit_at: now,
          last_state_audit_source: 'auditCampaignStateSync',
        });
        corrections++;
      } catch (e: any) {
        correctionErrors.push(`${div.amazon_id}: ${e.message}`);
      }
    }

    // Log de auditoria
    const summary = `auditadas=${localById.size} amazon_encontradas=${amazonById.size} divergencias=${divergences.length} correcoes=${corrections}`;
    await base44.asServiceRole.entities.SyncExecutionLog.create({
      amazon_account_id: aid,
      operation: 'audit_campaign_state_sync',
      trigger_type: body._service_role ? 'automatic' : 'manual',
      status: divergences.length === 0 ? 'success' : corrections === divergences.length ? 'success' : 'warning',
      execution_date: now.slice(0, 10),
      started_at: new Date(t0).toISOString(),
      completed_at: new Date().toISOString(),
      duration_ms: Date.now() - t0,
      records_processed: localById.size,
      result_summary: summary,
      error_message: correctionErrors.length > 0 ? correctionErrors.join('; ').slice(0, 500) : null,
    }).catch(() => {});

    return Response.json({
      ok: true,
      duration_ms: Date.now() - t0,
      audited: localById.size,
      amazon_found: amazonById.size,
      divergences: divergences.length,
      corrections,
      correction_errors: correctionErrors.length,
      divergence_breakdown: divergences.reduce((acc: any, d) => {
        acc[d.type] = (acc[d.type] || 0) + 1;
        return acc;
      }, {}),
      divergence_details: divergences.slice(0, 50), // primeiros 50 para log
    });

  } catch (error: any) {
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});