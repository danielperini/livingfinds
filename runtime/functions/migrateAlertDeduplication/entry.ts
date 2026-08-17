/**
 * migrateAlertDeduplication
 *
 * Migração segura dos alertas existentes:
 * 1. Calcula deduplication_key canônica para alertas sem ela
 * 2. Agrupa duplicados → mantém o mais antigo como canônico
 * 3. Soma occurrence_count, usa last_detected_at mais recente
 * 4. Marca duplicados como resolved com resolution_reason = duplicate_consolidated
 * 5. Reclassifica: rate_limit + mensagem de gasto → spend_overpacing
 * 6. Reclassifica: low_stock com metric_value=0 → out_of_stock
 * 7. Reclassifica: keyword com entity_id ASIN → entity_type = product_target
 * 8. NÃO apaga nenhum registro histórico
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const ASIN_PATTERN = /^[A-Z0-9]{10}$/;

function buildDedupKey(a: any): string {
  const parts = [
    a.amazon_account_id || '',
    a.alert_type || '',
    a.entity_type || 'account',
    a.entity_id || '',
  ];
  return parts.join('::').toLowerCase().replace(/\s+/g, '_');
}

function isAsin(v: string): boolean { return ASIN_PATTERN.test((v || '').trim().toUpperCase()); }

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user || user.role !== 'admin') return Response.json({ error: 'admin only' }, { status: 403 });

    const body = await req.json().catch(() => ({}));
    const { dry_run = true, amazon_account_id } = body;

    let alerts: any[];
    if (amazon_account_id) {
      alerts = await base44.asServiceRole.entities.Alert.filter({ amazon_account_id }, '-created_at', 1000).catch(() => []);
    } else {
      alerts = await base44.asServiceRole.entities.Alert.filter({}, '-created_at', 1000).catch(() => []);
    }

    const now = new Date().toISOString();
    let reclassified = 0, deduplicated = 0, keyPatched = 0;

    // ── Passo 1: Reclassificações ─────────────────────────────────────────
    for (const a of alerts) {
      const updates: any = {};
      let needsUpdate = false;

      // rate_limit + mensagem de gasto → spend_overpacing
      if (a.alert_type === 'rate_limit') {
        const msg = (a.message || '').toLowerCase();
        if (msg.includes('gasto') || msg.includes('spend') || msg.includes('r$') || msg.includes('orçamento')) {
          updates.alert_type = 'spend_overpacing';
          updates.alert_family = 'budget';
          needsUpdate = true;
          reclassified++;
        }
      }

      // low_stock com metric_value=0 ou current_value=0 → out_of_stock
      if (a.alert_type === 'low_stock' && (a.metric_value === 0 || a.current_value === 0)) {
        updates.alert_type = 'out_of_stock';
        updates.alert_family = 'inventory';
        updates.severity = a.campaign_id ? 'critical' : 'high';
        needsUpdate = true;
        reclassified++;
      }

      // keyword com entity_id ASIN → product_target
      if (a.entity_type === 'keyword' && isAsin(a.entity_id || '')) {
        updates.entity_type = 'product_target';
        updates.target_id = a.entity_id;
        needsUpdate = true;
        reclassified++;
      }

      // Preencher deduplication_key faltante
      if (!a.deduplication_key) {
        updates.deduplication_key = buildDedupKey({ ...a, ...updates });
        needsUpdate = true;
        keyPatched++;
      }

      if (needsUpdate && !dry_run) {
        updates.updated_at = now;
        await base44.asServiceRole.entities.Alert.update(a.id, updates).catch(() => {});
      }
    }

    // Recarregar para deduplicação com chaves corrigidas
    const refreshed = dry_run ? alerts : await base44.asServiceRole.entities.Alert.filter(
      amazon_account_id ? { amazon_account_id } : {}, '-created_at', 1000
    ).catch(() => []);

    // ── Passo 2: Deduplicação ─────────────────────────────────────────────
    // Agrupar por dedup_key, somente alertas active/acknowledged
    const activeAlerts = refreshed.filter((a: any) => a.status === 'active' || a.status === 'acknowledged');
    const groups = new Map<string, any[]>();

    for (const a of activeAlerts) {
      const key = a.deduplication_key || buildDedupKey(a);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(a);
    }

    for (const [key, group] of groups.entries()) {
      if (group.length <= 1) continue;

      // Manter o mais antigo como canônico
      group.sort((a, b) => new Date(a.created_at || 0).getTime() - new Date(b.created_at || 0).getTime());
      const canonical = group[0];
      const duplicates = group.slice(1);

      // Somar occurrence_count, usar last_detected_at mais recente
      const totalOccurrences = group.reduce((s, a) => s + (a.occurrence_count || 1), 0);
      const lastDetected = group.reduce((latest, a) => {
        const d = a.last_detected_at || a.created_at || '';
        return d > latest ? d : latest;
      }, '');

      if (!dry_run) {
        await base44.asServiceRole.entities.Alert.update(canonical.id, {
          occurrence_count: totalOccurrences,
          last_detected_at: lastDetected || now,
          deduplication_key: key,
          updated_at: now,
        }).catch(() => {});

        for (const dup of duplicates) {
          await base44.asServiceRole.entities.Alert.update(dup.id, {
            status: 'resolved',
            resolved_at: now,
            resolution_reason: 'duplicate_consolidated',
            updated_at: now,
          }).catch(() => {});
          deduplicated++;
        }
      } else {
        deduplicated += duplicates.length;
      }
    }

    return Response.json({
      ok: true,
      dry_run,
      total_alerts_scanned: alerts.length,
      reclassified,
      dedup_keys_patched: keyPatched,
      duplicates_consolidated: deduplicated,
      note: dry_run ? 'Modo dry_run — nenhuma alteração foi aplicada. Passe dry_run=false para executar.' : 'Migração concluída.',
    });

  } catch (error: any) {
    console.error('[migrateAlertDeduplication]', error.message);
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});