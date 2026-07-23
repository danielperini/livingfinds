/**
 * expandCoverageForAsin
 *
 * Orquestra expansão máxima de cobertura de campanhas manuais EXACT para um ASIN.
 * Fases:
 *  1. Reativar campanha AUTO pausada (se existir)
 *  2. Coletar termos: lista hardcoded + KeywordBank + sugestões Amazon API
 *  3. Criar campanhas canônicas 1:1 para cada termo único não duplicado
 *
 * Idempotente: re-execução não cria duplicatas.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';

const DEFAULT_BID = 0.50;
const DEFAULT_BUDGET = 9.00;
const AUTO_BUDGET = 15.00;
const DELAY_MS = 3500;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function normTerm(text) {
  return String(text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function getAdsBaseUrl(region) {
  const r = (region || 'NA').toUpperCase();
  if (r.includes('EU')) return 'https://advertising-api-eu.amazon.com';
  if (r.includes('FE')) return 'https://advertising-api-fe.amazon.com';
  return 'https://advertising-api.amazon.com';
}

// Hardcoded priority terms for lixeira bebê
const PRIORITY_TERMS = [
  'lixeira bebe',
  'lixeira automatica bebe',
  'lixeira bebe sensor',
  'lixeira bebe com tampa',
  'lixeira bebe quarto',
  'lixeira bebe banheiro',
  'lixeira bebe 12 litros',
  'lixeira bebe antiodor',
  'lixeira infantil',
  'lixeira com pedal bebe',
  'lixeira plastica bebe',
  'lixeira higienica bebe',
  'lixeira descartavel bebe',
  'lixeira para fraldas',
  'lixeira fraldas bebe',
  'lixeira de banheiro com sensor',
  'lixeira 12 litros',
  'lixeira automatica',
  'lixeira sensor automatica',
  'lixeira tampa automatica',
  'lixeira com sensor bebe',
  'lixeira pequena bebe',
  'lixeira quarto bebe',
  'lixeira antiodor para fraldas',
  'lixeira com sensor de movimento',
  'lixeira banheiro bebe',
  'lixeira para quarto bebe',
  'cesto lixo bebe',
  'lixeira sensor 12l',
  'lixeira automatica quarto',
];

Deno.serve(async (req) => {
  const startedAt = new Date().toISOString();
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));

    // Auth: usuário ou service_role
    if (!body._service_role) {
      const user = await base44.auth.me().catch(() => null);
      if (!user) return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
    }

    const { amazon_account_id, asin, max_campaigns = 30, auto_campaign_id } = body;
    if (!amazon_account_id || !asin) {
      return Response.json({ ok: false, error: 'amazon_account_id e asin são obrigatórios' }, { status: 400 });
    }

    const report = {
      ok: true,
      asin,
      auto_reactivated: false,
      auto_reactivation_error: null,
      terms_found: 0,
      terms_evaluated: 0,
      campaigns_created: 0,
      campaigns_skipped_duplicate: 0,
      campaigns_failed: 0,
      created_campaigns: [],
      skipped_terms: [],
      errors: [],
      started_at: startedAt,
    };

    // ── Resolver conta ────────────────────────────────────────────────────
    const accounts = await base44.asServiceRole.entities.AmazonAccount.filter(
      { id: amazon_account_id }, null, 1
    ).catch(() => []);
    const account = accounts[0];
    if (!account) return Response.json({ ok: false, error: 'Conta não encontrada' }, { status: 404 });

    const profileId = String(account.ads_profile_id || Deno.env.get('ADS_PROFILE_ID') || '');
    const clientId = Deno.env.get('ADS_CLIENT_ID') || '';
    const baseUrl = getAdsBaseUrl(account.region || 'NA');

    // ── Obter token ───────────────────────────────────────────────────────
    let accessToken = '';
    try {
      const tokenRes = await base44.asServiceRole.functions.invoke('amazonAdsTokenManager', {
        amazon_account_id,
        _service_role: true,
      });
      const td = tokenRes?.data || tokenRes;
      if (!td?.ok || !td?.access_token) throw new Error(td?.message || 'Token inválido');
      accessToken = td.access_token;
    } catch (e) {
      return Response.json({ ok: false, error: `Falha ao obter token: ${e.message}` }, { status: 503 });
    }

    const adsHeaders = {
      'Authorization': `Bearer ${accessToken}`,
      'Amazon-Advertising-API-ClientId': clientId,
      'Amazon-Advertising-API-Scope': profileId,
      'Content-Type': 'application/vnd.spCampaign.v3+json',
      'Accept': 'application/vnd.spCampaign.v3+json',
    };

    // ── FASE 1: Reativar campanha AUTO pausada ────────────────────────────
    const autoCampaignId = auto_campaign_id || '39072622762134';
    try {
      const reactivateRes = await fetch(`${baseUrl}/sp/campaigns`, {
        method: 'PUT',
        headers: adsHeaders,
        body: JSON.stringify({
          campaigns: [{
            campaignId: autoCampaignId,
            state: 'ENABLED',
            dailyBudget: AUTO_BUDGET,
          }],
        }),
      });
      const reactivateData = await reactivateRes.json().catch(() => ({}));
      const success = reactivateData?.campaigns?.success?.length > 0;
      if (success) {
        report.auto_reactivated = true;
        // Atualizar banco local
        const autoCamps = await base44.asServiceRole.entities.Campaign.filter(
          { amazon_account_id, campaign_id: autoCampaignId }, null, 1
        ).catch(() => []);
        if (autoCamps[0]) {
          await base44.asServiceRole.entities.Campaign.update(autoCamps[0].id, {
            state: 'enabled',
            status: 'enabled',
            daily_budget: AUTO_BUDGET,
          }).catch(() => {});
        }
      } else {
        report.auto_reactivation_error = JSON.stringify(reactivateData?.campaigns?.error?.[0] || reactivateData).slice(0, 200);
      }
    } catch (e) {
      report.auto_reactivation_error = e.message;
    }

    await sleep(1000);

    // ── FASE 2: Coletar termos ────────────────────────────────────────────
    const allTermsSet = new Set();

    // Termos hardcoded prioritários
    for (const t of PRIORITY_TERMS) {
      allTermsSet.add(normTerm(t));
    }

    // KeywordBank existente para o ASIN
    try {
      const bankTerms = await base44.asServiceRole.entities.KeywordBank.filter(
        { amazon_account_id, asin: asin.toUpperCase() }, null, 200
      );
      for (const kb of bankTerms) {
        const t = kb.normalized_keyword || normTerm(kb.keyword || '');
        if (t) allTermsSet.add(t);
      }
    } catch {}

    // Sugestões da Amazon API (KeywordSuggestion entity)
    try {
      const suggestions = await base44.asServiceRole.entities.KeywordSuggestion.filter(
        { amazon_account_id, asin: asin.toUpperCase() }, null, 100
      ).catch(() => []);
      for (const s of suggestions) {
        const t = normTerm(s.keyword_text || s.keyword || '');
        if (t) allTermsSet.add(t);
      }
    } catch {}

    // Tentar buscar sugestões da Amazon API diretamente
    try {
      await base44.asServiceRole.functions.invoke('syncAmazonKeywordSuggestionsByAsin', {
        amazon_account_id,
        asin: asin.toUpperCase(),
        _service_role: true,
      });
      await sleep(2000);
      // Re-ler após sync
      const freshSuggestions = await base44.asServiceRole.entities.KeywordSuggestion.filter(
        { amazon_account_id, asin: asin.toUpperCase() }, null, 100
      ).catch(() => []);
      for (const s of freshSuggestions) {
        const t = normTerm(s.keyword_text || s.keyword || '');
        if (t) allTermsSet.add(t);
      }
    } catch {}

    report.terms_found = allTermsSet.size;

    // ── FASE 3: Verificar campanhas já existentes para este ASIN ──────────
    const existingCampaigns = await base44.asServiceRole.entities.Campaign.filter(
      { amazon_account_id, asin: asin.toUpperCase(), targeting_type: 'MANUAL' }, null, 500
    ).catch(() => []);

    const existingKeywords = await base44.asServiceRole.entities.Keyword.filter(
      { amazon_account_id, asin: asin.toUpperCase() }, null, 1000
    ).catch(() => []);

    const existingTermsSet = new Set();
    for (const kw of existingKeywords) {
      const t = normTerm(kw.keyword_text || kw.keyword || '');
      if (t) existingTermsSet.add(t);
    }
    // Também verificar pelo nome das campanhas
    for (const c of existingCampaigns) {
      const state = String(c.state || c.status || '').toLowerCase();
      if (state === 'archived') continue;
      const name = c.name || c.campaign_name || '';
      const parts = name.split('|').map(p => p.trim());
      if (parts.length >= 5) {
        const kw = parts.slice(4).join(' | ');
        existingTermsSet.add(normTerm(kw));
      }
    }

    // ── FASE 4: Criar campanhas canônicas ─────────────────────────────────
    const termsToProcess = Array.from(allTermsSet).filter(t => !existingTermsSet.has(t));
    report.terms_evaluated = termsToProcess.length;

    let created = 0;
    for (const term of termsToProcess) {
      if (created >= max_campaigns) break;

      // Verificar duplicata via checkKeywordDuplicates
      try {
        const dupCheck = await base44.asServiceRole.functions.invoke('checkKeywordDuplicates', {
          amazon_account_id,
          asin: asin.toUpperCase(),
          keywords: [{ keyword_text: term, match_type: 'exact' }],
          _service_role: true,
        });
        const dupData = dupCheck?.data || dupCheck;
        if (dupData?.has_duplicates && (dupData?.allowed || []).length === 0) {
          report.campaigns_skipped_duplicate++;
          report.skipped_terms.push(term);
          continue;
        }
      } catch {}

      // Criar campanha canônica
      try {
        const createRes = await base44.asServiceRole.functions.invoke('createManualCampaignV2', {
          amazon_account_id,
          asin: asin.toUpperCase(),
          keyword: term,
          bid: DEFAULT_BID,
          budget: DEFAULT_BUDGET,
          match_type: 'exact',
          bidding_strategy: 'DOWN_ONLY',
          initial_state: 'enabled',
          _service_role: true,
        });
        const cd = createRes?.data || createRes;

        if (cd?.ok) {
          if (cd?.already_exists || cd?.blocked_duplicate) {
            report.campaigns_skipped_duplicate++;
            report.skipped_terms.push(term);
          } else {
            created++;
            report.campaigns_created++;
            report.created_campaigns.push({
              keyword: term,
              campaign_id: cd.campaign_id,
              campaign_name: cd.campaign_name,
            });
          }
        } else if (cd?.error) {
          report.campaigns_failed++;
          report.errors.push({ keyword: term, error: cd.error });
        }
      } catch (e) {
        report.campaigns_failed++;
        report.errors.push({ keyword: term, error: e.message });
      }

      await sleep(DELAY_MS);
    }

    report.completed_at = new Date().toISOString();

    // Log
    await base44.asServiceRole.entities.SyncExecutionLog.create({
      amazon_account_id,
      operation: 'expand_coverage_for_asin',
      trigger_type: 'manual',
      status: report.campaigns_failed > 0 ? 'warning' : 'success',
      started_at: startedAt,
      completed_at: report.completed_at,
      records_processed: report.campaigns_created,
      result_summary: JSON.stringify({
        asin,
        auto_reactivated: report.auto_reactivated,
        terms_found: report.terms_found,
        campaigns_created: report.campaigns_created,
        campaigns_skipped: report.campaigns_skipped_duplicate,
        campaigns_failed: report.campaigns_failed,
      }).slice(0, 4000),
    }).catch(() => {});

    return Response.json(report);
  } catch (error) {
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});