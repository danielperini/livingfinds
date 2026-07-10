/**
 * runWeeklyTermBankPromotion
 *
 * Varredura semanal do TermBank:
 * - Apenas produtos ATIVOS com estoque E sem regra de pausa (should_activate_campaign !== false,
 *   campaign_status !== 'paused', sem OptimizationDecision de pausa pendente)
 * - Confidence >= 0.95, termos INÉDITOS (não existem como keyword EXACT ativa nem campanha)
 * - Até 2 campanhas EXACT por produto via ProductKickoffQueue
 * - Se dentro da janela operacional, dispara processProductKickoffQueueV2 imediatamente
 * - Registra SearchTermPromotion para rastreamento
 * - Sincroniza pausas pendentes na Amazon API (AmazonActionQueue)
 *
 * Disparo: automação semanal (sexta 06h BRT)
 * Proteção: admin only ou service role (automação)
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function getToken(account: any): Promise<string> {
  const res = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: Deno.env.get('ADS_REFRESH_TOKEN') || account.ads_refresh_token,
      client_id: Deno.env.get('ADS_CLIENT_ID') || '',
      client_secret: Deno.env.get('ADS_CLIENT_SECRET') || '',
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) throw new Error(data.error_description || 'Token falhou');
  return data.access_token;
}

function adsBase(region?: string): string {
  const r = String(region || Deno.env.get('ADS_REGION') || 'NA').toUpperCase();
  if (r.includes('EU')) return 'https://advertising-api-eu.amazon.com';
  if (r.includes('FE')) return 'https://advertising-api-fe.amazon.com';
  return 'https://advertising-api.amazon.com';
}

function norm(s: string): string {
  return String(s || '').toLowerCase().trim().replace(/\s+/g, ' ');
}

function buildCampaignName(asin: string, term: string): string {
  const t = norm(term).slice(0, 40);
  return `SP | MANUAL | EXACT | ${asin} | ${t}`.slice(0, 128);
}

// ── Helpers de janela BRT ─────────────────────────────────────────────────────
function getSaoPauloHour(): { hour: number; day: string } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date());
  const p: Record<string, string> = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  return { hour: Number(p.hour || 0), day: `${p.year}-${p.month}-${p.day}` };
}

function getNextSlot(): { hour: number; window: string; at: string; execute_now: boolean } {
  const { hour, day } = getSaoPauloHour();
  const windowHours = [0, 1, 2, 3, 13];
  if (windowHours.includes(hour)) {
    const w = hour === 13 ? '13:00-14:00' : `${String(hour).padStart(2,'0')}:00-${String(hour+1).padStart(2,'0')}:00`;
    return { hour, window: w, at: new Date().toISOString(), execute_now: true };
  }
  if (hour < 13) {
    return { hour: 13, window: '13:00-14:00', at: new Date(`${day}T13:00:00-03:00`).toISOString(), execute_now: false };
  }
  const tom = new Date(`${day}T12:00:00-03:00`);
  tom.setDate(tom.getDate() + 1);
  const nextDay = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(tom);
  return { hour: 0, window: '00:00-01:00', at: new Date(`${nextDay}T00:00:00-03:00`).toISOString(), execute_now: false };
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);

    // Suporte a disparo por automação (service role) ou manual (admin)
    try {
      const user = await base44.auth.me();
      if (!user || user.role !== 'admin') {
        return Response.json({ error: 'Admin only' }, { status: 403 });
      }
    } catch {
      // Automações não têm user — continua como service role
    }

    const body = await req.json().catch(() => ({}));

    // Resolver conta
    let account: any = null;
    if (body.amazon_account_id) {
      const accs = await base44.asServiceRole.entities.AmazonAccount.filter({ id: body.amazon_account_id }, null, 1);
      account = accs[0] || null;
    } else {
      const accs = await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' }, '-created_date', 1);
      account = accs[0] || null;
    }
    if (!account) return Response.json({ ok: false, error: 'Conta Amazon não encontrada' }, { status: 404 });

    const aid = account.id;
    const now = new Date().toISOString();

    // ── Carregar produtos ATIVOS com estoque ──────────────────────────────────
    const allProducts = await base44.asServiceRole.entities.Product.filter(
      { amazon_account_id: aid }, null, 500
    );

    // Carregar decisões de pausa pendentes para detectar produtos bloqueados
    const pauseDecisions = await base44.asServiceRole.entities.OptimizationDecision.filter(
      {
        amazon_account_id: aid,
        decision_type: 'pause',
        status: 'pending',
      }, null, 500
    ).catch(() => []);
    const pausedAsins = new Set(pauseDecisions.map((d: any) => d.asin).filter(Boolean));

    // Filtrar produtos elegíveis respeitando regras de pausa
    const activeProducts = allProducts.filter((p: any) => {
      if (p.status !== 'active') return false;
      if (!p.asin) return false;
      if (Number(p.fba_inventory || 0) <= 0) return false;
      // Regra de pausa: produto explicitamente marcado como inativo para campanhas
      if (p.should_activate_campaign === false) return false;
      // Campanha do produto está pausada por decisão do usuário
      if (p.campaign_status === 'paused') return false;
      // Há decisão de pausa pendente para este produto
      if (pausedAsins.has(p.asin)) return false;
      return true;
    });

    if (!activeProducts.length) {
      return Response.json({ ok: true, message: 'Nenhum produto elegível (verifique estoque e regras de pausa)', created: 0 });
    }

    const activeAsins = new Set(activeProducts.map((p: any) => p.asin));

    // ── Carregar keywords EXACT já existentes ─────────────────────────────────
    const existingKws = await base44.asServiceRole.entities.Keyword.filter(
      { amazon_account_id: aid, match_type: 'exact' }, null, 5000
    ).catch(() => []);
    const exactKwSet = new Set(existingKws.map((k: any) => norm(k.keyword_text || k.keyword || '')));

    // ── Carregar campanhas existentes (não arquivadas) ────────────────────────
    const existingCampaigns = await base44.asServiceRole.entities.Campaign.filter(
      { amazon_account_id: aid }, null, 2000
    ).catch(() => []);
    const campaignNameSet = new Set(
      existingCampaigns
        .filter((c: any) => !c.archived && c.state !== 'archived' && c.status !== 'archived')
        .map((c: any) => norm(c.name || c.campaign_name || ''))
    );

    // ── Carregar fila já agendada para evitar duplicar ────────────────────────
    const queueItems = await base44.asServiceRole.entities.ProductKickoffQueue.filter(
      { amazon_account_id: aid, status: 'scheduled' }, null, 1000
    ).catch(() => []);
    const queuedKwSet = new Set(queueItems.map((q: any) => `${q.asin}|${norm(q.keyword || '')}`));

    // ── Carregar promoções já registradas (evitar duplicar SearchTermPromotion) ──
    const existingPromotions = await base44.asServiceRole.entities.SearchTermPromotion.filter(
      { amazon_account_id: aid }, null, 2000
    ).catch(() => []);
    const promotedKwSet = new Set(
      existingPromotions.map((p: any) => `${p.asin}|${norm(p.search_term || p.keyword || '')}`)
    );

    // ── Carregar TermBank com confidence >= 0.95 ──────────────────────────────
    const allTerms = await base44.asServiceRole.entities.TermBank.filter(
      { amazon_account_id: aid }, '-confidence', 2000
    );

    const MIN_CONFIDENCE = 0.95;
    const eligibleTerms = allTerms.filter((t: any) => {
      if (!t.asin || !activeAsins.has(t.asin)) return false;
      if (!t.term || norm(t.term).length < 3) return false;
      if (t.status === 'archived' || t.status === 'negative') return false;
      const conf = t.confidence != null
        ? (t.confidence <= 1 ? t.confidence : t.confidence / 100)
        : 0;
      if (conf < MIN_CONFIDENCE) return false;
      if (exactKwSet.has(norm(t.term))) return false;
      if (campaignNameSet.has(norm(buildCampaignName(t.asin, t.term)))) return false;
      if (queuedKwSet.has(`${t.asin}|${norm(t.term)}`)) return false;
      if (promotedKwSet.has(`${t.asin}|${norm(t.term)}`)) return false;
      return true;
    });

    // Agrupar por ASIN, ordenar por confidence desc
    const byAsin: Record<string, any[]> = {};
    for (const t of eligibleTerms) {
      if (!byAsin[t.asin]) byAsin[t.asin] = [];
      byAsin[t.asin].push(t);
    }
    for (const asin of Object.keys(byAsin)) {
      byAsin[asin].sort((a: any, b: any) => {
        const ca = a.confidence <= 1 ? a.confidence : a.confidence / 100;
        const cb = b.confidence <= 1 ? b.confidence : b.confidence / 100;
        return cb - ca;
      });
    }

    const results: any[] = [];
    let totalScheduled = 0;
    let totalSkipped = 0;
    let totalFailed = 0;

    const MAX_PER_PRODUCT = 2;
    const slot = getNextSlot();

    for (const product of activeProducts) {
      const asin = product.asin;
      const candidates = (byAsin[asin] || []).slice(0, MAX_PER_PRODUCT);
      if (!candidates.length) continue;

      for (const term of candidates) {
        const kw = norm(term.term);

        try {
          // Verificação dupla de duplicidade em tempo real
          if (exactKwSet.has(kw) || campaignNameSet.has(norm(buildCampaignName(asin, kw))) || queuedKwSet.has(`${asin}|${kw}`)) {
            totalSkipped++;
            continue;
          }

          // Verificação precisa contra o banco (evita race condition em execuções paralelas)
          const inQueue = await base44.asServiceRole.entities.ProductKickoffQueue.filter(
            { amazon_account_id: aid, asin, mode: 'manual_only', status: 'scheduled' }, null, 20
          ).catch(() => []);
          if (inQueue.find((q: any) => norm(q.keyword || '') === kw)) {
            totalSkipped++;
            continue;
          }

          // Enfileirar na ProductKickoffQueue
          const queueItem = await base44.asServiceRole.entities.ProductKickoffQueue.create({
            amazon_account_id: aid,
            asin,
            sku: term.sku || product.sku || null,
            product_name: term.product_name || product.product_name || asin,
            mode: 'manual_only',
            keyword: kw,
            status: 'scheduled',
            queue_hour: slot.hour,
            queue_window: slot.window,
            scheduled_at: slot.at,
            attempt_count: 0,
            max_attempts: 5,
          });

          // Registrar promoção para rastreamento e auditoria
          await base44.asServiceRole.entities.SearchTermPromotion.create({
            amazon_account_id: aid,
            asin,
            search_term: kw,
            keyword: kw,
            source_campaign_id: term.source_campaign_id || term.campaign_id || null,
            confidence: term.confidence,
            status: 'queued',
            queue_item_id: queueItem?.id || null,
            promoted_at: now,
            promotion_source: 'weekly_term_bank',
          }).catch(() => {}); // não crítico

          // Marcar no TermBank que foi promovido
          await base44.asServiceRole.entities.TermBank.update(term.id, {
            promotion_status: 'kickoff_candidate',
            updated_at: now,
          }).catch(() => {});

          // Atualizar sets locais para evitar duplicidade dentro da mesma execução
          queuedKwSet.add(`${asin}|${kw}`);
          campaignNameSet.add(norm(buildCampaignName(asin, kw)));
          promotedKwSet.add(`${asin}|${kw}`);

          totalScheduled++;
          results.push({
            asin,
            term: kw,
            confidence: term.confidence,
            queue_window: slot.window,
            execute_now: slot.execute_now,
            queue_item_id: queueItem?.id,
            status: 'scheduled',
          });

          await wait(200);
        } catch (e: any) {
          totalFailed++;
          results.push({ asin, term: kw, status: 'failed', error: e.message?.slice(0, 200) });
        }
      }
    }

    // ── Se dentro da janela, disparar o processamento imediatamente ───────────
    let executionResult: any = null;
    if (slot.execute_now && totalScheduled > 0) {
      try {
        await wait(500); // pequeno buffer para garantir que os creates foram persistidos
        const execRes = await base44.asServiceRole.functions.invoke('processProductKickoffQueueV2', {
          amazon_account_id: aid,
          force: true,
          _service_role: true,
        });
        executionResult = execRes?.data || null;
        console.log(`[WeeklyTermBank] Execução imediata: ${JSON.stringify(executionResult)}`);
      } catch (e: any) {
        console.warn('[WeeklyTermBank] Erro na execução imediata da fila:', e.message);
        executionResult = { error: e.message };
      }
    }

    // ── Sincronizar pausas pendentes na Amazon API ────────────────────────────
    let pauseFixed = 0;
    try {
      const token = await getToken(account);
      const baseUrl = adsBase(account.region);
      const profileId = account.ads_profile_id || Deno.env.get('ADS_PROFILE_ID');
      const CT = 'application/vnd.spCampaign.v3+json';

      const pendingPause = await base44.asServiceRole.entities.AmazonActionQueue.filter(
        { amazon_account_id: aid, action_type: 'pause_campaign', status: 'pending' }, null, 100
      ).catch(() => []);

      if (pendingPause.length > 0) {
        const ids = pendingPause.map((a: any) => a.entity_id).filter(Boolean);
        if (ids.length) {
          const resp = await fetch(`${baseUrl}/sp/campaigns`, {
            method: 'PATCH',
            headers: {
              'Authorization': `Bearer ${token}`,
              'Amazon-Advertising-API-ClientId': Deno.env.get('ADS_CLIENT_ID') || '',
              'Amazon-Advertising-API-Scope': String(profileId),
              'Content-Type': CT,
              'Accept': CT,
            },
            body: JSON.stringify({
              campaigns: ids.map((id: string) => ({ campaignId: id, state: 'PAUSED' })),
            }),
          });
          const data = await resp.json().catch(() => ({}));
          const successes: any[] = data?.campaigns?.success || data?.success || [];
          for (const s of successes) {
            const cid = s?.campaignId || s?.campaign?.campaignId;
            if (cid) {
              const action = pendingPause.find((a: any) => a.entity_id === String(cid));
              if (action) {
                await base44.asServiceRole.entities.AmazonActionQueue.update(action.id, {
                  status: 'executed',
                  executed_at: now,
                }).catch(() => {});
              }
              pauseFixed++;
            }
          }
        }
      }
    } catch (pauseErr: any) {
      console.error('[WeeklyTermBank] Erro ao sincronizar pausas pendentes:', pauseErr.message);
    }

    return Response.json({
      ok: true,
      ran_at: now,
      products_evaluated: allProducts.length,
      products_eligible: activeProducts.length,
      products_skipped_pause_rules: allProducts.length - activeProducts.length,
      eligible_terms_found: eligibleTerms.length,
      scheduled: totalScheduled,
      skipped: totalSkipped,
      failed: totalFailed,
      pending_pauses_fixed: pauseFixed,
      execute_now: slot.execute_now,
      queue_window: slot.window,
      execution_result: executionResult,
      results,
    });

  } catch (err: any) {
    return Response.json({ ok: false, error: err?.message || 'Erro inesperado' }, { status: 500 });
  }
});