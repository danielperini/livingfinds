/**
 * reconcileSponsoredProductsCampaigns
 *
 * Concilia o estado das campanhas SP entre:
 *   1. Amazon Ads API (fonte principal do estado atual)
 *   2. CSV importado (fonte de auditoria e recuperação)
 *   3. Banco local (preserva relações internas, histórico e IA)
 *
 * Regras:
 *  - Amazon API = fonte de verdade para estado atual
 *  - CSV = auditoria, histórico, recuperação de campanhas ausentes
 *  - Banco = relações internas (IA, decisões, learning)
 *  - Nunca apagar campanhas
 *  - Nunca reativar campanhas automaticamente
 *  - Nunca alterar budget durante sync
 *  - Arquivadas aparecem no histórico, NÃO no operacional
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const tokenCache = {};

async function getToken() {
  const cached = tokenCache['recon'];
  if (cached && cached.expires_at > Date.now()) return cached.access_token;
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: Deno.env.get('ADS_REFRESH_TOKEN'),
    client_id: Deno.env.get('ADS_CLIENT_ID'),
    client_secret: Deno.env.get('ADS_CLIENT_SECRET'),
  });
  const res = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error_description || 'Token failed');
  tokenCache['recon'] = { access_token: data.access_token, expires_at: Date.now() + (data.expires_in - 60) * 1000 };
  return data.access_token;
}

function baseUrl() {
  const r = (Deno.env.get('ADS_REGION') || 'NA').toUpperCase();
  if (r.includes('EU')) return 'https://advertising-api-eu.amazon.com';
  if (r.includes('FE')) return 'https://advertising-api-fe.amazon.com';
  return 'https://advertising-api.amazon.com';
}

async function adsCall(method, path, body, ct = 'application/json') {
  const token = await getToken();
  const res = await fetch(`${baseUrl()}${path}`, {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Amazon-Advertising-API-ClientId': Deno.env.get('ADS_CLIENT_ID'),
      'Amazon-Advertising-API-Scope': String(Deno.env.get('ADS_PROFILE_ID')),
      'Content-Type': ct,
      'Accept': ct,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  return { ok: res.ok, status: res.status, data };
}

// ── Buscar TODAS as campanhas SP via API com paginação ────────────────────────
async function fetchAllSPCampaignsFromAPI() {
  const all = [];
  let nextToken = undefined;
  let page = 0;
  do {
    page++;
    const body = {
      stateFilter: { include: ['ENABLED', 'PAUSED', 'ARCHIVED'] },
      maxResults: 500,
    };
    if (nextToken) body['nextToken'] = nextToken;
    const result = await adsCall('POST', '/sp/campaigns/list', body, 'application/vnd.spCampaign.v3+json');
    if (!result.ok) {
      console.warn(`[reconcile] API page ${page} failed: ${JSON.stringify(result.data).slice(0, 200)}`);
      break;
    }
    const list = result.data?.campaigns || [];
    all.push(...list);
    nextToken = result.data?.nextToken;
    console.log(`[reconcile] API page ${page}: ${list.length} campanhas, total ${all.length}`);
  } while (nextToken);
  return all;
}

// ── Normalizar estado do CSV (português → internal) ───────────────────────────
function normalizeCsvState(s = '') {
  const v = s.trim().toUpperCase();
  if (v === 'ATIVADO' || v === 'ENABLED') return 'enabled';
  if (v === 'PAUSADO' || v === 'PAUSED') return 'paused';
  if (v === 'ARQUIVADO' || v === 'ARCHIVED') return 'archived';
  return 'archived'; // fallback conservador
}

// ── Normalizar status da API Amazon ──────────────────────────────────────────
function normalizeApiStatus(s = '') {
  const v = s.trim().toUpperCase();
  if (v === 'CAMPAIGN_STATUS_ENABLED' || v === 'ENABLED') return 'enabled';
  if (v === 'CAMPAIGN_PAUSED' || v === 'PAUSED') return 'paused';
  if (v === 'CAMPAIGN_ARCHIVED' || v === 'ARCHIVED') return 'archived';
  if (v === 'CAMPAIGN_INCOMPLETE' || v === 'INCOMPLETE') return 'incomplete';
  return v.toLowerCase();
}

function normalizeApiState(s = '') {
  const v = s.trim().toUpperCase();
  if (v === 'ENABLED') return 'enabled';
  if (v === 'PAUSED') return 'paused';
  if (v === 'ARCHIVED') return 'archived';
  return v.toLowerCase();
}

// ── Normalizar segmentação ─────────────────────────────────────────────────
function normalizeTargeting(s = '') {
  const v = s.trim().toUpperCase();
  if (v === 'AUTOMATIC' || v === 'AUTO') return 'AUTO';
  if (v === 'MANUAL') return 'MANUAL';
  return v || 'MANUAL';
}

// ── Converter valor monetário BRL → float ─────────────────────────────────
function parseBRL(s = '') {
  if (!s) return 0;
  // Remove: "R$", espaços (common + non-breaking \u00a0), pontos de milhar; troca vírgula por ponto
  const clean = s
    .replace(/R\$/, '')
    .replace(/[\u00a0\s]/g, '')
    .replace(/\./g, '')
    .replace(',', '.');
  const n = parseFloat(clean);
  return isNaN(n) ? 0 : n;
}

// ── Converter data dd/MM/yyyy → yyyy-MM-dd ────────────────────────────────
function parseDate(s = '') {
  if (!s) return null;
  // já no formato ISO
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  return null;
}

// ── Parser de CSV robusto (linhas encapsuladas por aspas externas) ─────────
function parseCSVLine(line) {
  // Remove aspas externas se toda a linha estiver entre aspas
  let raw = line.trim();
  if (raw.startsWith('"') && raw.endsWith('"')) {
    raw = raw.slice(1, -1);
  }
  // Converte aspas duplas internas ("")  → aspas simples temporárias
  raw = raw.replace(/""/g, '\x00QUOTE\x00');

  const fields = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === '"') {
      inQ = !inQ;
    } else if (ch === ',' && !inQ) {
      fields.push(cur.replace(/\x00QUOTE\x00/g, '"').trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  fields.push(cur.replace(/\x00QUOTE\x00/g, '"').trim());
  return fields;
}

// ── Parse CSV completo ────────────────────────────────────────────────────
function parseCSV(csvText) {
  const lines = csvText.split('\n').map(l => l.trimEnd()).filter(l => l.length > 0);
  if (lines.length < 2) return [];

  // Encontrar linha de cabeçalho (ignora linhas de metadados iniciais)
  let headerIdx = 0;
  for (let i = 0; i < Math.min(lines.length, 10); i++) {
    const low = lines[i].toLowerCase();
    if (low.includes('estado') || low.includes('nome da campanha') || low.includes('campaign name')) {
      headerIdx = i;
      break;
    }
  }

  const headers = parseCSVLine(lines[headerIdx]).map(h => h.toLowerCase().trim());
  const rows = [];

  for (let i = headerIdx + 1; i < lines.length; i++) {
    const fields = parseCSVLine(lines[i]);
    if (fields.length < 3) continue;
    const row = {};
    headers.forEach((h, idx) => { row[h] = fields[idx] || ''; });
    rows.push(row);
  }
  return rows;
}

// ── Mapear linha CSV → campos normalizados ────────────────────────────────
function mapCsvRow(row) {
  // Suportar tanto cabeçalhos em pt quanto en
  const name = row['nome da campanha'] || row['campaign name'] || row['name'] || '';
  const estado = row['estado'] || row['state'] || '';
  const status = row['status'] || '';
  const tipo = row['tipo'] || row['type'] || '';
  const targeting = row['segmentação'] || row['segmentacao'] || row['targeting type'] || row['targeting'] || '';
  const startDate = row['data de início da campanha'] || row['data de inicio da campanha'] || row['start date'] || row['campaign start date'] || '';
  const endDate = row['data de término da campanha'] || row['data de termino da campanha'] || row['end date'] || row['campaign end date'] || '';
  const budgetRaw = row['valor do orçamento da campanha'] || row['valor do orcamento da campanha'] || row['campaign budget amount'] || row['budget'] || '';

  const csvState = normalizeCsvState(estado || status);
  const normalizedTargeting = normalizeTargeting(targeting);
  const campaignType = (tipo.toUpperCase().includes('SP') || tipo.toLowerCase().includes('sponsored product')) ? 'SP' : tipo.toUpperCase().slice(0, 2) || 'SP';

  return {
    name: name.trim(),
    csv_state: csvState,
    campaign_type: campaignType,
    targeting_type: normalizedTargeting,
    start_date: parseDate(startDate),
    end_date: parseDate(endDate),
    daily_budget: parseBRL(budgetRaw),
    clicks: parseInt(row['cliques'] || row['clicks'] || '0') || 0,
    ctr: parseBRL(row['ctr'] || '0'),
    spend: parseBRL(row['custo total'] || row['total cost'] || row['custo total convertido'] || '0'),
    cpc: parseBRL(row['cpc'] || row['cpc convertido'] || '0'),
    orders: parseInt(row['compras'] || row['purchases'] || row['orders'] || '0') || 0,
    sales: parseBRL(row['vendas'] || row['sales'] || row['vendas convertido'] || '0'),
    roas: parseBRL(row['roas'] || '0'),
    impressions: parseInt(row['parcela de impressões no topo da pesquisa'] || '0') || 0,
    top_of_search_adjustment: parseBRL(row['ajuste de lance para o topo da pesquisa'] || '0'),
  };
}

// ── Upsert de campanha no banco ───────────────────────────────────────────
async function upsertCampaign(base44, amazonAccountId, record) {
  const existing = await base44.asServiceRole.entities.Campaign.filter({
    amazon_account_id: amazonAccountId,
    campaign_id: record.campaign_id,
  }, null, 5);

  if (existing.length > 0) {
    // Preservar campos internos críticos — não sobrescrever relações de IA
    const current = existing[0];
    const safeUpdate = { ...record };
    // Preservar vínculos internos
    if (current.asin) safeUpdate.asin = safeUpdate.asin || current.asin;
    if (current.learning_eligible !== undefined) safeUpdate.learning_eligible = current.learning_eligible;
    if (current.created_by_app) safeUpdate.created_by_app = current.created_by_app;

    await base44.asServiceRole.entities.Campaign.update(existing[0].id, safeUpdate);
    // Marcar duplicatas para revisão
    for (let i = 1; i < existing.length; i++) {
      await base44.asServiceRole.entities.Campaign.update(existing[i].id, {
        reconciliation_status: 'ambiguous',
        reconciliation_notes: 'Duplicata detectada na conciliação — verificar',
      });
    }
    return { action: 'updated', id: existing[0].id };
  } else {
    const created = await base44.asServiceRole.entities.Campaign.create(record);
    return { action: 'created', id: created.id };
  }
}

// ── Registrar divergência no CampaignChangeHistory ───────────────────────
async function logDivergence(base44, amazonAccountId, campaignId, field, csvVal, localVal, apiVal, selectedVal, reason) {
  await base44.asServiceRole.entities.CampaignChangeHistory.create({
    amazon_account_id: amazonAccountId,
    campaign_id: campaignId,
    change_type: 'SYNC_CORRECTION',
    entity_type: 'campaign',
    field_name: field,
    old_value: String(localVal ?? ''),
    new_value: String(selectedVal ?? ''),
    source: 'SYNC',
    source_function: 'reconcileSponsoredProductsCampaigns',
    reason: `[Conciliação] ${reason}. CSV: ${csvVal} | Local: ${localVal} | API: ${apiVal} → Aplicado: ${selectedVal}`,
    status: 'executed',
    changed_at: new Date().toISOString(),
  });
}

// ═══════════════════════════════════════════════════════════════════════════
Deno.serve(async (req) => {
  const startTime = Date.now();
  const now = new Date().toISOString();

  try {
    const base44 = createClientFromRequest(req);
    let isAuthorized = false;
    try { const u = await base44.auth.me(); if (u) isAuthorized = true; } catch {}
    if (!isAuthorized) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const amazonAccountId = body.amazon_account_id;
    const csvText = body.csv_text || null; // CSV como string (opcional)
    const forceApiRefresh = body.force_api_refresh !== false;

    if (!amazonAccountId) return Response.json({ error: 'amazon_account_id required' }, { status: 400 });

    // Verificar conta
    const accs = await base44.asServiceRole.entities.AmazonAccount.filter({ id: amazonAccountId });
    const account = accs[0];
    if (!account) return Response.json({ error: 'Conta não encontrada.' }, { status: 404 });

    const report = {
      csv_rows: 0,
      csv_active: 0, csv_paused: 0, csv_archived: 0, csv_incomplete: 0,
      api_campaigns_found: 0,
      matched: 0, created: 0, updated: 0, archived: 0, incomplete: 0,
      api_missing: 0, ambiguous: 0, duplicates_blocked: 0,
      errors: [],
    };

    // ── 1. Buscar campanhas via Amazon Ads API ────────────────────────────
    let apiCampaigns = [];
    if (forceApiRefresh) {
      try {
        apiCampaigns = await fetchAllSPCampaignsFromAPI();
        report.api_campaigns_found = apiCampaigns.length;
        console.log(`[reconcile] API retornou ${apiCampaigns.length} campanhas SP`);
      } catch (e) {
        report.errors.push(`API fetch error: ${e.message}`);
        console.error('[reconcile] API error:', e.message);
      }
    }

    // ── 2. Buscar campanhas locais ────────────────────────────────────────
    const localCampaigns = await base44.asServiceRole.entities.Campaign.filter(
      { amazon_account_id: amazonAccountId, campaign_type: 'SP' }, null, 2000
    );
    const localByCampaignId = new Map(localCampaigns.map(c => [String(c.campaign_id), c]));
    const localByName = new Map(localCampaigns.map(c => [String(c.name || c.campaign_name || '').trim(), c]));

    // ── 3. Parse do CSV (se enviado) ──────────────────────────────────────
    const csvRows = csvText ? parseCSV(csvText) : [];
    report.csv_rows = csvRows.length;

    const csvMapped = csvRows.map(r => mapCsvRow(r));
    csvMapped.forEach(r => {
      if (r.csv_state === 'enabled') report.csv_active++;
      else if (r.csv_state === 'paused') report.csv_paused++;
      else if (r.csv_state === 'archived') report.csv_archived++;
      else if (r.csv_state === 'incomplete') report.csv_incomplete++;
      else report.csv_archived++; // fallback conservador
    });

    // ── 4. Conciliar campanhas da API com banco ───────────────────────────
    const apiCampaignIds = new Set();

    for (const apiCamp of apiCampaigns) {
      const campaignId = String(apiCamp.campaignId || apiCamp.campaign_id || '');
      if (!campaignId) continue;
      apiCampaignIds.add(campaignId);

      const apiState = normalizeApiState(apiCamp.state || 'ENABLED');
      const apiStatus = normalizeApiStatus(apiCamp.status || apiCamp.state || '');
      const isArchived = apiState === 'archived';
      const isIncomplete = apiStatus === 'incomplete' || apiCamp.status?.toUpperCase() === 'CAMPAIGN_INCOMPLETE';
      const isOperational = !isArchived && !isIncomplete;

      const record = {
        amazon_account_id: amazonAccountId,
        ads_profile_id: account.ads_profile_id || Deno.env.get('ADS_PROFILE_ID') || '',
        campaign_id: campaignId,
        amazon_campaign_id: campaignId,
        name: apiCamp.name || '',
        campaign_name: apiCamp.name || '',
        campaign_type: 'SP',
        targeting_type: normalizeTargeting(apiCamp.targetingType || ''),
        state: isIncomplete ? 'incomplete' : apiState,
        status: isIncomplete ? 'incomplete' : apiState,
        amazon_status: apiCamp.status || apiCamp.state || '',
        is_operational: isOperational,
        requires_attention: isIncomplete,
        api_missing: false,
        source: 'api',
        daily_budget: apiCamp.budget?.budget ?? apiCamp.dailyBudget ?? 0,
        currency_code: 'BRL',
        currency_symbol: 'R$',
        start_date: apiCamp.startDate ? parseDate(apiCamp.startDate) : null,
        end_date: apiCamp.endDate ? parseDate(apiCamp.endDate) : null,
        bidding_strategy: apiCamp.dynamicBidding?.strategy || apiCamp.bidding?.strategy || null,
        portfolio_id: apiCamp.portfolioId ? String(apiCamp.portfolioId) : null,
        top_of_search_adjustment: 0,
        rest_of_search_adjustment: 0,
        product_pages_adjustment: 0,
        archived: isArchived,
        archived_at: isArchived ? now : null,
        archive_reason: isArchived ? 'archived_by_amazon' : null,
        learning_eligible: isOperational,
        excluded_from_dashboard: isArchived,
        reconciliation_status: 'ok',
        reconciliation_notes: null,
        last_api_sync_at: now,
        synced_at: now,
        last_sync_at: now,
      };

      // Enriquecer com ajustes de placement se disponíveis
      if (apiCamp.placementAdjustments) {
        for (const pa of apiCamp.placementAdjustments) {
          if (pa.placement === 'PLACEMENT_TOP') record.top_of_search_adjustment = pa.percentage ?? 0;
          else if (pa.placement === 'PLACEMENT_REST_OF_SEARCH') record.rest_of_search_adjustment = pa.percentage ?? 0;
          else if (pa.placement === 'PLACEMENT_PRODUCT_PAGE') record.product_pages_adjustment = pa.percentage ?? 0;
        }
      }

      const localCamp = localByCampaignId.get(campaignId);

      // Detectar divergências de estado entre local e API
      if (localCamp && localCamp.state !== record.state) {
        await logDivergence(
          base44, amazonAccountId, campaignId, 'state',
          null, localCamp.state, record.state, record.state,
          'Estado divergente entre banco e API — API prevalece'
        ).catch(() => {});
      }

      const result = await upsertCampaign(base44, amazonAccountId, record);
      if (result.action === 'created') report.created++;
      else report.updated++;

      if (isArchived) report.archived++;
      if (isIncomplete) {
        report.incomplete++;
        // Gerar alerta para campanha incompleta
        await base44.asServiceRole.entities.Alert.create({
          amazon_account_id: amazonAccountId,
          alert_type: 'campaign_paused',
          severity: 'high',
          title: `Campanha incompleta: ${apiCamp.name}`,
          message: `Campanha ${campaignId} está CAMPAIGN_INCOMPLETE. Não será otimizada. Verificar na Amazon.`,
          entity_type: 'campaign',
          entity_id: campaignId,
          campaign_id: campaignId,
          status: 'active',
          created_at: now,
        }).catch(() => {});
      }
    }

    // ── 5. Processar CSV: recuperar campanhas ausentes da API ─────────────
    if (csvRows.length > 0) {
      for (const csvRow of csvMapped) {
        if (!csvRow.name) continue;

        // Tentar associar por nome exato ao banco local
        const localByNameMatch = localByName.get(csvRow.name);
        const campaignId = localByNameMatch?.campaign_id || null;

        if (!campaignId || !apiCampaignIds.has(String(campaignId))) {
          // CSV tem campanha não encontrada na API
          if (localByNameMatch) {
            // Existe no banco, marcar como api_missing para revisão
            await base44.asServiceRole.entities.Campaign.update(localByNameMatch.id, {
              api_missing: true,
              reconciliation_status: 'missing_in_api',
              reconciliation_notes: `Presente no CSV (estado CSV: ${csvRow.csv_state}) mas ausente na API. Requer revisão.`,
              last_csv_import_at: now,
            });
            report.api_missing++;
          } else if (csvRow.csv_state === 'archived') {
            // Campanha arquivada no CSV sem correspondência local → criar como histórico
            const tempId = `csv_${csvRow.name.replace(/[^a-z0-9]/gi, '_').slice(0, 40)}_${Date.now()}`;
            await upsertCampaign(base44, amazonAccountId, {
              amazon_account_id: amazonAccountId,
              campaign_id: tempId,
              name: csvRow.name,
              campaign_name: csvRow.name,
              campaign_type: csvRow.campaign_type || 'SP',
              targeting_type: csvRow.targeting_type || 'MANUAL',
              state: 'archived',
              status: 'archived',
              amazon_status: 'CAMPAIGN_ARCHIVED',
              is_operational: false,
              archived: true,
              archived_at: now,
              archive_reason: 'imported_from_csv',
              daily_budget: csvRow.daily_budget || 0,
              start_date: csvRow.start_date,
              end_date: csvRow.end_date,
              clicks: csvRow.clicks || 0,
              spend: csvRow.spend || 0,
              sales: csvRow.sales || 0,
              orders: csvRow.orders || 0,
              ctr: csvRow.ctr || 0,
              cpc: csvRow.cpc || 0,
              roas: csvRow.roas || 0,
              currency_code: 'BRL',
              currency_symbol: 'R$',
              source: 'csv',
              excluded_from_dashboard: true,
              learning_eligible: false,
              reconciliation_status: 'missing_in_api',
              reconciliation_notes: 'Importado do CSV — sem correspondência na API',
              last_csv_import_at: now,
              metrics_status: 'partial',
            });
            report.created++;
          }
        } else {
          // Campanha no CSV e na API — verificar divergências de estado
          const localCamp = localByCampaignId.get(String(campaignId));
          if (localCamp && localCamp.state !== csvRow.csv_state) {
            // API prevalece, apenas registrar divergência
            await logDivergence(
              base44, amazonAccountId, String(campaignId), 'state',
              csvRow.csv_state, localCamp.state, localCamp.state, localCamp.state,
              'Divergência de estado CSV vs API — API prevalece'
            ).catch(() => {});
          }
          // Atualizar data da última importação CSV
          if (localCamp) {
            await base44.asServiceRole.entities.Campaign.update(localCamp.id, {
              last_csv_import_at: now,
              metrics_status: csvRow.spend > 0 ? 'partial' : 'missing',
            });
          }
        }
        report.matched++;
      }
    }

    // ── 6. Marcar campanhas locais não encontradas na API ─────────────────
    for (const [localCampId, localCamp] of localByCampaignId) {
      if (!apiCampaignIds.has(localCampId) && localCamp.source !== 'csv' && !localCamp.api_missing) {
        // Existe no banco mas não veio da API (apenas se API foi consultada)
        if (forceApiRefresh && apiCampaigns.length > 0) {
          await base44.asServiceRole.entities.Campaign.update(localCamp.id, {
            api_missing: true,
            reconciliation_status: 'review_required',
            reconciliation_notes: 'Campanha presente no banco mas não retornada pela API. Pode ter sido arquivada na Amazon.',
          });
          report.api_missing++;
        }
      }
    }

    const duration = Date.now() - startTime;
    console.log(`[reconcile] Concluído em ${duration}ms. Criadas: ${report.created}, Atualizadas: ${report.updated}, API ausentes: ${report.api_missing}`);

    return Response.json({
      ok: true,
      ...report,
      reconciled_at: now,
      duration_ms: duration,
    });

  } catch (error) {
    console.error('[reconcile] Erro fatal:', error.message);
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});