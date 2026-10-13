export type AutoCampaignRepairPreflight =
  | { ok: true; campaignId: string }
  | { ok: false; code: 'MISSING_CAMPAIGN_ID' | 'MISSING_ACCOUNT_ID' | 'MISSING_PRODUCT_ID'; reason: string };

export function autoCampaignRepairPreflight(item: Record<string, unknown> | null | undefined): AutoCampaignRepairPreflight {
  const row = item || {};
  if (!String(row.amazon_account_id || '').trim()) {
    return { ok: false, code: 'MISSING_ACCOUNT_ID', reason: 'Conta Amazon ausente; reparo não pode ser executado.' };
  }
  const campaignId = String(row.campaign_id || row.amazon_campaign_id || '').trim();
  if (!campaignId) {
    return { ok: false, code: 'MISSING_CAMPAIGN_ID', reason: 'ID de campanha ausente; criação deve ocorrer no fluxo de cobertura/Kick-off.' };
  }
  if (!String(row.asin || row.sku || '').trim()) {
    return { ok: false, code: 'MISSING_PRODUCT_ID', reason: 'ASIN e SKU ausentes; reparo não pode ser vinculado a um produto.' };
  }
  return { ok: true, campaignId };
}

export function autoCampaignRepairCancellationPatch(
  item: Record<string, unknown> | null | undefined,
  now = new Date().toISOString(),
) {
  const preflight = autoCampaignRepairPreflight(item);
  if (preflight.ok) throw new Error('Não é possível cancelar um reparo válido.');
  return {
    status: 'cancelled',
    completed_at: now,
    retryable: false,
    error_code: preflight.code,
    last_error: preflight.reason,
  };
}
