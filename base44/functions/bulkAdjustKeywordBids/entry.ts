import { createClientFromRequest } from 'npm:@base44/sdk@0.8.38';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));
    if (!body._service_role) return Response.json({ ok: false, error: 'Uso interno' }, { status: 403 });

    const { amazon_account_id, asin_bid_map } = body;

    const accounts = await base44.asServiceRole.entities.AmazonAccount.filter({ id: amazon_account_id }, null, 1);
    const account = accounts[0];
    if (!account) return Response.json({ ok: false, error: 'Conta não encontrada' }, { status: 404 });

    const profileId = account.ads_profile_id;
    const refreshToken = account.ads_refresh_token || Deno.env.get('ADS_REFRESH_TOKEN');
    const clientId = Deno.env.get('ADS_CLIENT_ID');
    const clientSecret = Deno.env.get('ADS_CLIENT_SECRET');

    // ─── Obter token ──────────────────────────────────────────────────────
    const tokenRes = await fetch('https://api.amazon.com/auth/o2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: clientId,
        client_secret: clientSecret,
      }),
    });
    const tokenData = await tokenRes.json();
    const token = tokenData.access_token;
    if (!token) return Response.json({ ok: false, error: 'Falha no token', detail: tokenData }, { status: 500 });

    // ─── Buscar keywords dos ASINs alvo ───────────────────────────────────
    const allKeywords = await base44.asServiceRole.entities.Keyword.filter({ amazon_account_id }, null, 1000);
    const targetAsins = Object.keys(asin_bid_map);

    const toAdjust = [];
    for (const kw of allKeywords) {
      if (!kw.keyword_id || !kw.asin) continue;
      if (!targetAsins.includes(kw.asin)) continue;
      const newBid = asin_bid_map[kw.asin];
      const currentBid = kw.bid || kw.current_bid || 0;
      const isReduction = newBid < currentBid;
      const isBoost = newBid > currentBid && currentBid <= 0.65;
      if (isReduction || isBoost) {
        toAdjust.push({ id: kw.id, keyword_id: kw.keyword_id, asin: kw.asin, old_bid: currentBid, new_bid: newBid });
      }
    }

    if (toAdjust.length === 0) {
      return Response.json({ ok: true, message: 'Nenhuma keyword precisou de ajuste', total: 0 });
    }

    // ─── Base URL ─────────────────────────────────────────────────────────
    const region = Deno.env.get('ADS_REGION') || 'NA';
    const baseUrl = region === 'FE' ? 'https://advertising-api-fe.amazon.com' :
                    region === 'EU' ? 'https://advertising-api-eu.amazon.com' :
                    'https://advertising-api.amazon.com';

    const headers = {
      'Authorization': `Bearer ${token}`,
      'Amazon-Advertising-API-ClientId': clientId,
      'Amazon-Advertising-API-Scope': String(profileId),
      'Content-Type': 'application/vnd.spKeyword.v3+json',
      'Accept': 'application/vnd.spKeyword.v3+json',
    };

    // ─── Enviar em lotes de 10 ────────────────────────────────────────────
    const BATCH = 10;
    const results = { success: [], error: [], db_updated: 0 };

    for (let i = 0; i < toAdjust.length; i += BATCH) {
      const batch = toAdjust.slice(i, i + BATCH);
      const payload = { keywords: batch.map(k => ({ keywordId: k.keyword_id, bid: k.new_bid })) };

      const res = await fetch(`${baseUrl}/sp/keywords`, {
        method: 'PUT',
        headers,
        body: JSON.stringify(payload),
      });
      const data = await res.json();

      const successes = data?.keywords?.success || [];
      const errors = data?.keywords?.error || [];

      // Mapear sucessos para DB update
      const successIds = new Set(successes.map((s) => String(s.keywordId)));

      // Se API retornou 207/200 sem arrays (resposta simplificada), tratar todos como sucesso
      const allSuccess = res.ok && successes.length === 0 && errors.length === 0;

      for (const kw of batch) {
        if (allSuccess || successIds.has(String(kw.keyword_id))) {
          results.success.push({ keyword_id: kw.keyword_id, asin: kw.asin, new_bid: kw.new_bid });
          try {
            await base44.asServiceRole.entities.Keyword.update(kw.id, {
              bid: kw.new_bid,
              current_bid: kw.new_bid,
              updated_at: new Date().toISOString(),
            });
            results.db_updated++;
          } catch (_) { /* continua */ }
        }
      }
      for (const e of errors) {
        results.error.push({ keyword_id: e.keywordId, error: e.errorType || e.description });
      }

      if (i + BATCH < toAdjust.length) {
        await new Promise((r) => setTimeout(r, 600));
      }
    }

    // ─── Registrar log de execução ────────────────────────────────────────
    await base44.asServiceRole.entities.SyncExecutionLog.create({
      amazon_account_id,
      operation: 'bulk_bid_adjustment',
      trigger_type: 'manual',
      status: results.error.length === 0 ? 'success' : 'warning',
      started_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
      records_processed: toAdjust.length,
      records_imported: results.success.length,
      result_summary: `Ajustado ${results.success.length}/${toAdjust.length} keywords. Erros: ${results.error.length}.`,
    }).catch(() => {});

    return Response.json({
      ok: true,
      total_attempted: toAdjust.length,
      amazon_success: results.success.length,
      amazon_error: results.error.length,
      db_updated: results.db_updated,
      errors: results.error.slice(0, 10),
    });

  } catch (error) {
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});