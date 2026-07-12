/**
 * cleanupInadequateManualCampaigns
 *
 * Pausa e arquiva (na Amazon + localmente) campanhas manuais inadequadas:
 * 1. ÓRFÃS: campanhas sem nenhuma keyword ativa
 * 2. DUPLICATAS: mesmo asin+termo em 2+ campanhas — mantém a mais recente, pausa as demais
 *
 * dry_run=true (padrão): apenas relatório, sem ações.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.38';

const V3_CT = 'application/vnd.spCampaign.v3+json';
const THROTTLE_MS = 400;
const BATCH = 20;

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }
function normTerm(t: string) { return (t||'').toLowerCase().trim().replace(/\s+/g,' '); }

async function pauseOnAmazon(base44: any, aid: string, campaignIds: string[]): Promise<{ok: number, fail: number}> {
  let ok = 0, fail = 0;
  for (let i = 0; i < campaignIds.length; i += BATCH) {
    const batch = campaignIds.slice(i, i + BATCH).map(id => ({ campaignId: id, state: 'PAUSED' }));
    const res = await base44.asServiceRole.functions.invoke('amazonAdsCommand', {
      amazon_account_id: aid,
      method: 'PUT',
      path: '/sp/campaigns',
      payload: { campaigns: batch },
      content_type: V3_CT,
      accept: V3_CT,
      _service_role: true,
    }).catch(() => null);
    const data = res?.data?.payload || res?.data || {};
    const success = data?.campaigns?.success || [];
    const errors = data?.campaigns?.error || [];
    ok += success.length;
    fail += errors.length;
    await sleep(THROTTLE_MS);
  }
  return { ok, fail };
}

Deno.serve(async (req) => {
  const t0 = Date.now();
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));

    if (!body._service_role) {
      const user = await base44.auth.me().catch(() => null);
      if (!user) return Response.json({ ok: false, error: 'Não autorizado' }, { status: 401 });
    }

    const dry_run: boolean = body.dry_run !== false;
    const aid = body.amazon_account_id;
    if (!aid) return Response.json({ ok: false, error: 'amazon_account_id required' });

    const now = new Date().toISOString();

    // Carregar dados
    const [campaigns, keywords] = await Promise.all([
      base44.asServiceRole.entities.Campaign.filter({ amazon_account_id: aid }, null, 500),
      base44.asServiceRole.entities.Keyword.filter({ amazon_account_id: aid }, null, 3000),
    ]);

    const manualCampaigns = campaigns.filter((c: any) => {
      const tt = (c.targeting_type || c.campaign_type || '').toUpperCase();
      const status = (c.status || c.state || '').toLowerCase();
      return tt === 'MANUAL' && !['archived'].includes(status);
    });

    // Índice de keywords ativas por campaign_id
    const kwByCamp = new Map<string, any[]>();
    for (const kw of keywords) {
      const cid = String(kw.campaign_id || '');
      if (!kwByCamp.has(cid)) kwByCamp.set(cid, []);
      kwByCamp.get(cid)!.push(kw);
    }

    // ── 1. Identificar órfãs (sem keywords ativas) ─────────────────────
    const orphans: any[] = [];
    const withKw: any[] = [];

    for (const c of manualCampaigns) {
      const cid = String(c.campaign_id || '');
      const kws = (kwByCamp.get(cid) || []).filter((k: any) =>
        !['archived','deleted'].includes((k.state || k.status || '').toLowerCase())
      );
      if (kws.length === 0) {
        orphans.push(c);
      } else {
        withKw.push({ campaign: c, keywords: kws });
      }
    }

    // ── 2. Identificar duplicatas de termo+asin ────────────────────────
    // Estratégia: manter a campanha MAIS RECENTE (maior created_date ou campaign_id lexicográfico)
    // Pausar todas as mais antigas com mesmo asin+termo
    const canonicalByKey = new Map<string, any>(); // key -> { campaign, keyword }
    const duplicates: any[] = [];

    // Ordenar por created_date desc (mais recentes primeiro = têm prioridade)
    const sorted = withKw.sort((a: any, b: any) => {
      const da = a.campaign.created_date || a.campaign.created_at || '';
      const db = b.campaign.created_date || b.campaign.created_at || '';
      return db.localeCompare(da);
    });

    for (const item of sorted) {
      const c = item.campaign;
      const asin = c.asin || '';
      const status = (c.status || c.state || '').toLowerCase();
      // Só considerar campanhas enabled/active como potencialmente canônicas
      const activeKws = item.keywords.filter((k: any) =>
        (k.state || k.status || '').toLowerCase() === 'enabled'
      );

      for (const kw of activeKws) {
        const term = normTerm(kw.keyword_text || kw.keyword || '');
        if (!term || !asin) continue;
        const key = `${asin}|${term}`;

        if (!canonicalByKey.has(key)) {
          canonicalByKey.set(key, { campaign: c, keyword: kw });
        } else {
          // Já existe — esta é duplicata
          duplicates.push({ campaign: c, keyword: kw, term, asin, key });
        }
      }
    }

    // Deduplicar: uma campanha pode ter múltiplos termos duplicados, mas só pausar uma vez
    const dupCampaignIds = new Set(duplicates.map((d: any) => String(d.campaign.campaign_id || '')));
    // Remover das duplicatas qualquer campanha que também seja "canônica" para outro termo
    // (só pausar se TODOS os seus termos já têm canônica)
    const safeToPauseDups = [...dupCampaignIds].filter(cid => {
      const item = sorted.find((s: any) => String(s.campaign.campaign_id) === cid);
      if (!item) return true;
      const activeKws = item.keywords.filter((k: any) => (k.state || k.status || '').toLowerCase() === 'enabled');
      const asin = item.campaign.asin || '';
      // Verificar se TODOS os termos desta campanha têm uma canônica diferente
      return activeKws.every((kw: any) => {
        const term = normTerm(kw.keyword_text || kw.keyword || '');
        const key = `${asin}|${term}`;
        const canonical = canonicalByKey.get(key);
        return canonical && String(canonical.campaign.campaign_id) !== cid;
      });
    });

    const stats = {
      manual_total: manualCampaigns.length,
      orphans: orphans.length,
      duplicates_campaigns: safeToPauseDups.length,
      duplicate_term_pairs: duplicates.length,
      canonical_kept: canonicalByKey.size,
    };

    if (dry_run) {
      return Response.json({
        ok: true,
        dry_run: true,
        stats,
        orphan_sample: orphans.slice(0, 8).map((c: any) => ({
          name: c.campaign_name || c.name,
          status: c.status,
          campaign_id: c.campaign_id,
        })),
        duplicate_sample: duplicates.slice(0, 8).map((d: any) => ({
          name: d.campaign.campaign_name,
          term: d.term,
          asin: d.asin,
        })),
        message: `${orphans.length} órfãs + ${safeToPauseDups.length} campanhas duplicadas serão pausadas/arquivadas.`,
        duration_ms: Date.now() - t0,
      });
    }

    // ── EXECUÇÃO REAL ──────────────────────────────────────────────────

    // Pausar órfãs na Amazon (campaign_id válido)
    const orphanAmazonIds = orphans.map((c: any) => String(c.campaign_id)).filter(Boolean);
    const orphanResult = await pauseOnAmazon(base44, aid, orphanAmazonIds);

    // Arquivar órfãs localmente
    for (const c of orphans) {
      await base44.asServiceRole.entities.Campaign.update(c.id, {
        status: 'archived', state: 'archived', updated_at: now,
      }).catch(() => {});
    }

    // Pausar duplicatas na Amazon
    const dupResult = await pauseOnAmazon(base44, aid, safeToPauseDups);

    // Atualizar localmente as duplicatas pausadas
    for (const cid of safeToPauseDups) {
      const item = sorted.find((s: any) => String(s.campaign.campaign_id) === cid);
      if (item) {
        await base44.asServiceRole.entities.Campaign.update(item.campaign.id, {
          status: 'paused', state: 'paused', updated_at: now,
        }).catch(() => {});
      }
    }

    // Log de execução
    await base44.asServiceRole.entities.SyncExecutionLog.create({
      amazon_account_id: aid,
      operation: 'cleanup_inadequate_manual_campaigns',
      trigger_type: body._service_role ? 'automatic' : 'manual',
      status: 'success',
      execution_date: now.slice(0, 10),
      started_at: new Date(t0).toISOString(),
      completed_at: now,
      duration_ms: Date.now() - t0,
      records_processed: orphans.length + safeToPauseDups.length,
      result_summary: JSON.stringify({
        orphans_paused: orphanResult.ok,
        orphans_fail: orphanResult.fail,
        duplicates_paused: dupResult.ok,
        duplicates_fail: dupResult.fail,
      }),
    }).catch(() => {});

    return Response.json({
      ok: true,
      dry_run: false,
      stats,
      results: {
        orphans_archived_locally: orphans.length,
        orphans_paused_amazon: orphanResult.ok,
        orphans_amazon_fail: orphanResult.fail,
        duplicates_paused_amazon: dupResult.ok,
        duplicates_amazon_fail: dupResult.fail,
        duplicates_updated_locally: safeToPauseDups.length,
      },
      duration_ms: Date.now() - t0,
    });

  } catch (error: any) {
    console.error('[cleanupInadequateManualCampaigns]', error.message);
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});