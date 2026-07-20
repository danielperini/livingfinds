import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const TARGET_ACOS = 15;
const MAX_ACOS = 18;
const MAX_BID_CHANGE_PCT = 20;

/**
 * runUnifiedDecisionEngine
 *
 * Entrada canônica e única do motor de decisões do LivingFinds.
 * Antes de delegar, alinha de forma idempotente as configurações existentes
 * à política operacional vigente: ACoS alvo 15%, faixa de alerta até 18% e
 * variação máxima automática de bid de 20% por ação.
 *
 * Nenhuma configuração fictícia é criada: somente registros existentes são
 * atualizados. O motor determinístico continua responsável por estoque,
 * margem, cooldown, proteção de vencedores, idempotência e auditoria.
 */
Deno.serve(async (request) => {
  try {
    const base44 = createClientFromRequest(request);
    const body = await request.json().catch(() => ({}));
    const authenticated = await base44.auth.isAuthenticated().catch(() => false);

    if (!authenticated && !body._service_role) {
      return Response.json({ ok: false, error: 'Não autorizado' }, { status: 401 });
    }

    let account: any = null;
    if (body.amazon_account_id) {
      const rows = await base44.asServiceRole.entities.AmazonAccount.filter({ id: body.amazon_account_id }, null, 1).catch(() => []);
      account = rows[0] || null;
    }
    if (!account) {
      const rows = await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' }, '-created_date', 1).catch(() => []);
      account = rows[0] || null;
    }

    const policyUpdates: any = {
      target_acos: TARGET_ACOS,
      max_acos: MAX_ACOS,
      max_bid_increase_pct: MAX_BID_CHANGE_PCT,
      max_bid_decrease_pct: MAX_BID_CHANGE_PCT,
    };
    const policyResult: any = { performance_settings_updated: false, autopilot_config_updated: false };

    if (account?.id) {
      const perf = await base44.asServiceRole.entities.PerformanceSettings.filter(
        { amazon_account_id: account.id }, '-updated_at', 1,
      ).catch(() => []);
      if (perf[0]?.id) {
        const p = perf[0];
        const changed = Number(p.target_acos) !== TARGET_ACOS ||
          Number(p.max_acos) !== MAX_ACOS ||
          Number(p.max_bid_increase_pct) !== MAX_BID_CHANGE_PCT ||
          Number(p.max_bid_decrease_pct) !== MAX_BID_CHANGE_PCT;
        if (changed) {
          await base44.asServiceRole.entities.PerformanceSettings.update(p.id, policyUpdates);
          policyResult.performance_settings_updated = true;
        }
      }

      const configs = await base44.asServiceRole.entities.AutopilotConfig.filter(
        { amazon_account_id: account.id }, null, 1,
      ).catch(() => []);
      if (configs[0]?.id) {
        const c = configs[0];
        const cfgUpdate = {
          target_acos: TARGET_ACOS,
          maximum_acos: MAX_ACOS,
          max_bid_increase_pct: MAX_BID_CHANGE_PCT,
          max_bid_decrease_pct: MAX_BID_CHANGE_PCT,
        };
        const changed = Number(c.target_acos) !== TARGET_ACOS ||
          Number(c.maximum_acos) !== MAX_ACOS ||
          Number(c.max_bid_increase_pct) !== MAX_BID_CHANGE_PCT ||
          Number(c.max_bid_decrease_pct) !== MAX_BID_CHANGE_PCT;
        if (changed) {
          await base44.asServiceRole.entities.AutopilotConfig.update(c.id, cfgUpdate);
          policyResult.autopilot_config_updated = true;
        }
      }
    }

    const payload = {
      ...body,
      amazon_account_id: body.amazon_account_id || account?.id || null,
      target_acos_goal: TARGET_ACOS,
      max_acos_goal: MAX_ACOS,
      max_bid_change_pct: MAX_BID_CHANGE_PCT,
      _service_role: true,
      source_function: body.source_function || 'runUnifiedDecisionEngine',
      engine_version: 'unified-v2-acos15',
    };

    const result = await base44.asServiceRole.functions.invoke(
      'runDeterministicDecisionEngine',
      payload,
    );

    const data = result?.data || result || {};

    return Response.json({
      ok: data?.ok !== false,
      engine: 'unified',
      delegated_to: 'runDeterministicDecisionEngine',
      amazon_account_id: payload.amazon_account_id,
      policy: {
        target_acos: TARGET_ACOS,
        max_acos: MAX_ACOS,
        max_bid_change_pct: MAX_BID_CHANGE_PCT,
        ...policyResult,
      },
      result: data,
    });
  } catch (error: any) {
    return Response.json(
      {
        ok: false,
        engine: 'unified',
        error: error?.message || 'Falha no motor unificado de decisões',
      },
      { status: 500 },
    );
  }
});
