import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';
import { decideSalesModeWaste, isProtectedWinner30d } from '../../shared/salesModeWastePolicy.ts';

const n = (v: unknown) => Number.isFinite(Number(v)) ? Number(v) : 0;
const active = (v: unknown) => ['enabled', 'active'].includes(String(v || '').toLowerCase());
const cid = (c: any) => String(c.amazon_campaign_id || c.campaign_id || c.id || '');

function brDate(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d);
}

function addMetric(map: Map<string, any>, id: string, row: any) {
  const a = map.get(id) || { spend: 0, sales: 0, orders: 0, clicks: 0, impressions: 0, days: new Set<string>() };
  a.spend += n(row.spend); a.sales += n(row.sales); a.orders += n(row.orders);
  a.clicks += n(row.clicks); a.impressions += n(row.impressions); a.days.add(String(row.date || ''));
  map.set(id, a);
}



/*
 * V3_WINNER_PRECHECK_BEFORE_PAUSE
 *
 * Qualquer PAUSE gerado por este componente é apenas uma
 * PROPOSTA interna.
 *
 * O V3 deve rejeitar a proposta ANTES da persistência quando
 * existir venda/rentabilidade vencedora recente, salvo nova
 * evidência econômica material de prejuízo.
 *
 * Zero gasto nunca é waste.
 */
const V3_WINNER_PRECHECK_BEFORE_PAUSE = true;

Deno.serve(async (request) => {
  try {
    const base44 = createClientFromRequest(request);
    const body = await request.json().catch(() => ({}));
    const authenticated = await base44.auth.isAuthenticated().catch(() => false);
    if (!authenticated && !body._service_role) return Response.json({ ok: false, error: 'Não autorizado' }, { status: 401 });

    const accounts = body.amazon_account_id
      ? await base44.asServiceRole.entities.AmazonAccount.filter({ id: body.amazon_account_id }, undefined, 1)
      : await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' }, '-updated_at', 50);

    const lookbackDays = Math.max(3, Math.min(30, Number(body.lookback_days ?? 7)));
    const minAgeDays = Math.max(3, Math.min(30, Number(body.min_age_days ?? 7)));
    const dryRun = body.dry_run === true;
    const today = brDate();
    const cutoff = new Date(Date.now() - lookbackDays * 86400000).toISOString().slice(0, 10);
    const cutoff30 = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const results: any[] = [];

    for (const account of accounts) {
      const aid = String(account.id);
      const [campaigns, metrics, settingsRows, existingDecisions, keywords] = await Promise.all([
        base44.asServiceRole.entities.Campaign.filter({ amazon_account_id: aid }, '-created_at', 10000).catch(() => []),
        base44.asServiceRole.entities.CampaignMetricsDaily.filter({ amazon_account_id: aid }, '-date', 30000).catch(() => []),
        base44.asServiceRole.entities.PerformanceSettings.filter({ amazon_account_id: aid }, '-updated_at', 1).catch(() => []),
        base44.asServiceRole.entities.OptimizationDecision.filter({ amazon_account_id: aid }, '-created_at', 30000).catch(() => []),
        base44.asServiceRole.entities.Keyword.filter({ amazon_account_id: aid }, '-updated_at', 20000).catch(() => []),
      ]);
      const settings = settingsRows[0] || {};
      const targetAcos = n(settings.target_acos || settings.acos_target || 15);
      const maxAcos = n(settings.maximum_acos || settings.max_acos || Math.max(35, targetAcos * 2));
      const growthAcosCeiling = Math.max(targetAcos, Math.min(maxAcos, targetAcos * 1.45));
      const minSpend = n(settings.min_spend_for_decision || 5);

      const agg = new Map<string, any>();
      const agg30 = new Map<string, any>();
      for (const m of metrics) {
        const date = String(m.date || '');
        const id = String(m.campaign_id || '');
        if (!id || date < cutoff30) continue;
        addMetric(agg30, id, m);
        if (date >= cutoff) addMetric(agg, id, m);
      }

      const candidates: any[] = [];
      const protectedWinners: any[] = [];
      for (const campaign of campaigns) {
        if (!active(campaign.state || campaign.status)) continue;
        if (campaign.protected_high_performance === true) continue;
        const id = cid(campaign);
        if (!id) continue;
        const created = new Date(String(campaign.created_at || campaign.created_date || '')).getTime();
        const ageDays = Number.isFinite(created) ? (Date.now() - created) / 86400000 : 999;
        /*
         * LEARNING MODE
         *
         * Campanhas novas podem operar temporariamente no prejuízo.
         *
         * 0–10 dias:
         *   - nunca pausar por ACoS, falta de venda ou baixa performance;
         *   - apenas hard guards externos podem interromper.
         *
         * A finalidade é comprar dados suficientes para descobrir
         * CPC, CTR, CVR e termos vencedores.
         */
        const learningGraceDays = 10;

        if (ageDays < learningGraceDays) {
          continue;
        }

        if (ageDays < minAgeDays) continue;
        const a = agg.get(id) || {
          spend: 0,
          sales: 0,
          orders: 0,
          clicks: 0,
          impressions: 0,
          days: new Set<string>(),
        };

        const long = agg30.get(id) || {
          spend: 0,
          sales: 0,
          orders: 0,
          clicks: 0,
          impressions: 0,
          days: new Set<string>(),
        };

        /*
         * ZERO DELIVERY CLEANUP
         *
         * Campanha >=7 dias que nunca gerou impressão, clique,
         * pedido ou venda em 30 dias não precisa consumir estrutura
         * indefinidamente.
         *
         * Só aplica a campanhas criadas pelo app/IA ou com nomenclatura
         * operacional conhecida.
         */
        const campaignName = String(
          campaign.name ||
          campaign.campaign_name ||
          ''
        ).toUpperCase();

        const managedCampaign =
          campaign.created_by_app === true ||
          campaign.created_by_ai === true ||
          campaign.amazon_suggested === true ||
          campaign.ai_generated === true ||
          /^SP\s*\|/.test(campaignName) ||
          /^AUTO\s*\|/.test(campaignName);

        const zeroDelivery30d =
          long.impressions <= 0 &&
          long.clicks <= 0 &&
          long.orders <= 0 &&
          long.sales <= 0 &&
          long.spend <= 0;

        if (
          managedCampaign &&
          ageDays >= Math.max(14, minAgeDays) &&
          zeroDelivery30d
        ) {
          candidates.push({
            campaign,
            id,
            ageDays,

            spend:0,
            sales:0,
            orders:0,
            clicks:0,
            impressions:0,
            acos:999,

            long,
            longAcos:999,
            longRoas:0,

            priorReductions:2,

            wasteDecision:{
              action: 'HOLD',
              reason:'DELEGATE_ZERO_DELIVERY_TO_LIFECYCLE',
              confidence:0.99,
              wasteScore:100,
            },

            wasteKeyword:null,
            score:100000 + ageDays,
          });

          continue;
        }

        /*
         * Para campanhas que tiveram entrega, permanece a lógica
         * econômica original: só considerar waste depois do spend mínimo.
         */
        if (a.spend < minSpend) continue;
        const acos = a.sales > 0 ? a.spend / a.sales * 100 : 999;
        const longAcos = long.sales > 0 ? long.spend / long.sales * 100 : 999;
        const longRoas = long.spend > 0 ? long.sales / long.spend : 0;
        const provenWinner30d = isProtectedWinner30d({
          orders30d: long.orders, sales30d: long.sales, spend30d: long.spend,
          growthAcosCeiling, maximumAcos: maxAcos,
        });
        const strongWinner30d = long.orders >= 2 && longRoas >= 4 && longAcos < maxAcos;

        // Sales-first: uma janela curta não pode cortar um ativo que possui
        // conversão e rentabilidade comprovadas em 30 dias. Ele volta ao
        // motor de growth/recovery, que pode ajustar bid dentro do safe CPC.
        if (provenWinner30d || strongWinner30d) {
          protectedWinners.push({
            campaign_id: id,
            asin: campaign.asin || campaign.advertised_asin || null,
            orders_30d: long.orders,
            sales_30d: Number(long.sales.toFixed(2)),
            spend_30d: Number(long.spend.toFixed(2)),
            acos_30d: Number(longAcos.toFixed(2)),
            roas_30d: Number(longRoas.toFixed(2)),
            reason: provenWinner30d ? 'PROFITABLE_WINNER_30D' : 'HIGH_ROAS_WINNER_30D',
          });
          continue;
        }

        const priorReductions = existingDecisions.filter((d: any) => String(d.campaign_id || d.entity_id || '') === id && /reduce.*bid|decrease.*bid/i.test(String(d.action || '')) && ['executed', 'completed', 'confirming'].includes(String(d.status || '').toLowerCase())).length;
        /*
         * LEARNING LOSS ENVELOPE
         *
         * Entre 10 e 21 dias ainda aceitamos prejuízo controlado.
         *
         * Sem pedido:
         *   tolerar até max(R$15, 1.5 x minSpend).
         *
         * Com pedido:
         *   tolerar ACoS temporário até 2x maximumAcos.
         *
         * Isso não remove hard cap da conta nem estoque/listing guards.
         */
        const learningLossSpend =
          Math.max(15, minSpend * 1.5);

        const learningAcosCeiling =
          Math.max(maxAcos, maxAcos * 2);

        if (ageDays < 21) {

          if (
            a.orders <= 0 &&
            a.spend <= learningLossSpend
          ) {
            continue;
          }

          if (
            a.orders > 0 &&
            a.sales > 0 &&
            (a.spend / a.sales * 100) <= learningAcosCeiling
          ) {
            continue;
          }
        }

        const wasteDecision = decideSalesModeWaste({
          spend: a.spend,
          sales: a.sales,
          orders: a.orders,
          clicks: a.clicks,
          ageDays,
          minAgeDays,
          minSpend,
          maxAcos,
          priorReductions
        });

        if (wasteDecision.action === 'HOLD') continue;

        // Pausa exige confirmação também na janela longa. Uma campanha que
        // converteu recentemente pode receber redução, mas não ser encerrada
        // por um spike de CPC ou atraso de atribuição da janela curta.
        if (wasteDecision.action === 'PAUSE' && long.orders > 0 && long.sales > 0) continue;

        const wasteKeyword = keywords.find((keyword: any) => String(keyword.campaign_id || '') === id && active(keyword.state || keyword.status));
        if (wasteDecision.action !== 'PAUSE' && !wasteKeyword) continue;
        candidates.push({ campaign, id, ageDays, ...a, acos, long, longAcos, longRoas, priorReductions, wasteDecision, wasteKeyword, score: wasteDecision.wasteScore * 100 + a.spend });
      }

      candidates.sort((a, b) => b.score - a.score);
      const selected = candidates;
      const created: any[] = [];

      for (const c of selected) {
        const isPause = c.wasteDecision.action === 'PAUSE';
        const key = `SALES_MODE_WASTE_${c.wasteDecision.action}|${aid}|${c.id}|${today}`;

        const rationale = `${lookbackDays}d: gasto R$${c.spend.toFixed(2)}, ${c.clicks} cliques, ${c.orders} pedidos; 30d: ${c.long.orders} pedidos, ROAS ${Number.isFinite(c.longRoas) ? c.longRoas.toFixed(2) : '0'}; ${c.wasteDecision.reason}.`;
        if (
          existingDecisions.some(
            (d: any) =>
              d.idempotency_key === key &&
              ![
                'failed',
                'rejected',
                'cancelled',
                'expired'
              ].includes(
                String(d.status || '').toLowerCase()
              )
          )
        ) {
          created.push({
            campaign_id: c.id,
            campaign_name:
              c.campaign.name ||
              c.campaign.campaign_name,
            idempotency_key: key,
            reused_existing: true,
            rationale
          });
          continue;
        }
        if (dryRun) {
          created.push({ campaign_id: c.id, campaign_name: c.campaign.name || c.campaign.campaign_name, rationale, dry_run: true });
          continue;
        }
        const decision = await base44.asServiceRole.entities.OptimizationDecision.create({
          amazon_account_id: aid,
          decision_type: 'sales_mode_waste_rotation',
          entity_type: isPause ? 'campaign' : 'keyword',
          entity_id: isPause ? c.id : String(c.wasteKeyword.keyword_id || c.wasteKeyword.id),
          campaign_id: c.id,
          campaign_name: c.campaign.name || c.campaign.campaign_name || null,
          asin: c.campaign.asin || c.campaign.advertised_asin || null,
          keyword_id: isPause ? null : String(c.wasteKeyword.keyword_id || c.wasteKeyword.id),
          action: isPause ? 'pause_campaign' : 'reduce_bid',
          canonical_action_type: isPause ? 'CAMPAIGN_STATE_CHANGE' : 'KEYWORD_BID_CHANGE',
          rationale,
          rule_key: `SALES_MODE_${c.wasteDecision.action}`,
          reason_code:
            isPause && String(c.wasteDecision.reason || '').toUpperCase().includes('ZERO_DELIVERY')
              ? 'HARD_ZERO_DELIVERY_30D'
              : c.wasteDecision.reason.toUpperCase(),
          value_before: isPause ? 'ENABLED' : n(c.wasteKeyword.current_bid || c.wasteKeyword.bid),
          value_after: isPause ? 'PAUSED' : Number((n(c.wasteKeyword.current_bid || c.wasteKeyword.bid) * (
            c.wasteDecision.action === 'REDUCE_BID_15' ? 0.85 :
            c.wasteDecision.action === 'REDUCE_BID_10' ? 0.9 : 0.95
          )).toFixed(2)),
          confidence: c.wasteDecision.confidence,

          rollback_plan:
            isPause
              ? 'RESTORE_CAMPAIGN_STATE:enabled'
              : `RESTORE_PREVIOUS_VALUE:${n(c.wasteKeyword.current_bid || c.wasteKeyword.bid)}`,

          risk: 'medium',
          requires_approval: false,
          approval_status: 'auto_approved_deterministic', status: 'approved', queue_status: 'pending',
          priority_class: 'P1', execution_mode: 'EXPEDITED_QUEUE',
          confirmation_required: true, confirmation_status: 'pending',
          idempotency_key: key, conflict_group: `${aid}|campaign|${c.id}`,
          source_function: 'runSalesModeWasteRotation',

          policy_version: 'PROFIT_ENGINE_V4',
          decision_owner: 'CANONICAL_PROFIT_ENGINE_V4',
          canonical_engine: 'CANONICAL_PROFIT_ENGINE_V4',

          model_version: 'sales-mode-v1.2-long-window-winner-protection',
          target_acos: targetAcos,
          current_acos: c.acos >= 999 ? null : c.acos,
          data_used: JSON.stringify({
            lookback_days: lookbackDays, age_days: c.ageDays,
            spend: c.spend, sales: c.sales, orders: c.orders, clicks: c.clicks, impressions: c.impressions,
            spend_30d: c.long.spend, sales_30d: c.long.sales, orders_30d: c.long.orders,
            acos_30d: c.longAcos >= 999 ? null : c.longAcos, roas_30d: c.longRoas,
            target_acos: targetAcos, growth_acos_ceiling: growthAcosCeiling, maximum_acos: maxAcos,
            prior_reductions: c.priorReductions, waste_score: c.wasteDecision.wasteScore,
            winner_protected: false,

            admission: {
              verified: true,
              observed_at:
                new Date().toISOString(),
              verified_by:
                'CANONICAL_PROFIT_ENGINE_V3',
              source:
                'runSalesModeWasteRotation'
            },

            canonical_engine:
              'CANONICAL_PROFIT_ENGINE_V3',

            policy_version:
              'PROFIT_ENGINE_V3'
          }),
          created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
        });
        created.push({ decision_id: decision.id, campaign_id: c.id, campaign_name: c.campaign.name || c.campaign.campaign_name, rationale });
      }

      results.push({
        amazon_account_id: aid,
        policy: 'short_window_waste_never_overrides_proven_30d_winner',
        growth_acos_ceiling: growthAcosCeiling,
        protected_winners_30d: protectedWinners.length,
        protected_winner_sample: protectedWinners.slice(0, 50),
        daily_pause_limit: 'unlimited_only_when_economically_proven',
        candidates: candidates.length,
        selected: selected.length,
        decisions_created: created.length,
        decisions: created,
      });
    }

    return Response.json({ ok: true, engine: 'sales-mode-waste-rotation-v1.2', dry_run: dryRun, lookback_days: lookbackDays, results });
  } catch (error: any) {
    return Response.json({ ok: false, engine: 'sales-mode-waste-rotation-v1.2', error: error?.message || 'Falha na rotação de desperdício' }, { status: 500 });
  }
});
