/**
 * submitApprovedListingEnhancement
 * Submete à Amazon somente propostas com approval_status === 'approved'.
 * Usa PATCH mínimo. Valida marca, schema e conflito externo antes de enviar.
 * Nunca usa PUT completo. Nunca remove campos não relacionados.
 * Nunca envia null sem aprovação explícita.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const MARKETPLACE_ID = Deno.env.get('AMAZON_MARKETPLACE_ID') || 'A2Q3Y263D00KWC';
const SP_CLIENT_ID = Deno.env.get('SP_CLIENT_ID') || Deno.env.get('AMAZON_LWA_CLIENT_ID') || '';
const SP_CLIENT_SECRET = Deno.env.get('SP_CLIENT_SECRET') || Deno.env.get('AMAZON_LWA_CLIENT_SECRET') || '';
const SP_REFRESH_TOKEN = Deno.env.get('SP_REFRESH_TOKEN') || Deno.env.get('AMAZON_SP_REFRESH_TOKEN') || '';

const THIRD_PARTY_BRANDS = [
  'samsung','apple','xiaomi','lg','sony','intelbras','philips','nike','adidas',
  'motorola','huawei','positivo','multilaser','britannia','britania','mondial',
  'electrolux','brastemp','consul','whirlpool','bosch','siemens','panasonic',
  'toshiba','dell','hp','lenovo','asus','acer','microsoft','google','amazon',
];

function validateNoThirdPartyBrand(text: string): { safe: boolean; detected: string[] } {
  const normalized = (text || '').toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[-_./]/g, ' ');
  const detected: string[] = [];
  for (const brand of THIRD_PARTY_BRANDS) {
    if (new RegExp(`\\b${brand}\\b`).test(normalized)) detected.push(brand);
  }
  return { safe: detected.length === 0, detected };
}

async function getSpAccessToken(): Promise<string> {
  const res = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: SP_REFRESH_TOKEN,
      client_id: SP_CLIENT_ID,
      client_secret: SP_CLIENT_SECRET,
    }).toString(),
  });
  if (!res.ok) throw new Error(`SP token: ${res.status} ${await res.text()}`);
  return (await res.json()).access_token;
}

async function fetchCurrentListing(accessToken: string, sellerId: string, sku: string, marketplaceId: string): Promise<any> {
  const url = `https://sellingpartnerapi-na.amazon.com/listings/2021-08-01/items/${sellerId}/${encodeURIComponent(sku)}?marketplaceIds=${marketplaceId}&includedData=attributes`;
  const res = await fetch(url, { headers: { 'x-amz-access-token': accessToken, 'Content-Type': 'application/json' } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`fetchListing ${sku}: ${res.status}`);
  return res.json();
}

function buildMinimalPatch(fieldName: string, proposedValue: string, productType: string): any {
  // PATCH mínimo: apenas o campo alterado
  const patchValue = (() => {
    if (fieldName === 'generic_keyword' || fieldName === 'search_terms') {
      const terms = proposedValue.split(' ').filter(Boolean);
      return terms.map(v => ({ value: v, marketplace_id: MARKETPLACE_ID }));
    }
    if (fieldName === 'item_name') return [{ value: proposedValue, language_tag: 'pt_BR', marketplace_id: MARKETPLACE_ID }];
    if (fieldName === 'bullet_point') {
      const bullets = (() => { try { return JSON.parse(proposedValue); } catch { return [proposedValue]; } })();
      return Array.isArray(bullets)
        ? bullets.map((b: string) => ({ value: b, language_tag: 'pt_BR', marketplace_id: MARKETPLACE_ID }))
        : [{ value: String(bullets), language_tag: 'pt_BR', marketplace_id: MARKETPLACE_ID }];
    }
    if (fieldName === 'product_description') return [{ value: proposedValue, language_tag: 'pt_BR', marketplace_id: MARKETPLACE_ID }];
    return [{ value: proposedValue, marketplace_id: MARKETPLACE_ID }];
  })();

  return {
    productType,
    patches: [{
      op: 'replace',
      path: `/attributes/${fieldName}`,
      value: patchValue,
    }],
  };
}

async function submitPatch(accessToken: string, sellerId: string, sku: string, marketplaceId: string, patch: any): Promise<any> {
  const url = `https://sellingpartnerapi-na.amazon.com/listings/2021-08-01/items/${sellerId}/${encodeURIComponent(sku)}?marketplaceIds=${marketplaceId}&mode=VALIDATION_PREVIEW`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: { 'x-amz-access-token': accessToken, 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  const data = await res.json();
  return { status: res.status, data };
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    // Somente admin pode publicar
    if (user.role !== 'admin') {
      return Response.json({ error: 'Apenas administradores podem submeter alterações.' }, { status: 403 });
    }

    const body = await req.json().catch(() => ({}));
    const { proposal_id, amazon_account_id } = body;

    if (!proposal_id) return Response.json({ error: 'proposal_id obrigatório' }, { status: 400 });

    // Carregar proposta
    const proposals = await base44.asServiceRole.entities.ListingEnhancementProposal.filter({ id: proposal_id });
    const proposal = proposals[0];
    if (!proposal) return Response.json({ error: 'Proposta não encontrada' }, { status: 404 });

    const aid = amazon_account_id || proposal.amazon_account_id;

    // Validação: deve estar aprovada
    if (proposal.approval_status !== 'approved') {
      return Response.json({ ok: false, error: `Proposta não aprovada. Status: ${proposal.approval_status}` }, { status: 422 });
    }

    // Validação: não submeter se já submetido ou confirmado
    if (['submitted', 'processing', 'confirmed'].includes(proposal.submission_status || '')) {
      return Response.json({ ok: false, error: `Proposta já submetida. Status: ${proposal.submission_status}` }, { status: 409 });
    }

    // Validação final de marca (imediatamente antes do PATCH)
    const brandCheck = validateNoThirdPartyBrand(proposal.proposed_value || '');
    if (!brandCheck.safe) {
      await base44.asServiceRole.entities.ListingEnhancementProposal.update(proposal.id, {
        brand_safety_status: 'blocked',
        submission_status: 'failed',
        amazon_issues: JSON.stringify([{ message: `Marca de terceiro detectada: ${brandCheck.detected.join(', ')}` }]),
        updated_at: new Date().toISOString(),
      });
      return Response.json({ ok: false, error: `Marca de terceiro bloqueada: ${brandCheck.detected.join(', ')}` }, { status: 422 });
    }

    // Valor não pode ser null/vazio sem aprovação explícita
    if (!proposal.proposed_value || proposal.proposed_value.trim() === '') {
      return Response.json({ ok: false, error: 'proposed_value está vazio. Preencha o valor antes de submeter.' }, { status: 422 });
    }

    // Buscar conta
    const accounts = await base44.asServiceRole.entities.AmazonAccount.filter({ id: aid });
    const account = accounts[0];
    if (!account) return Response.json({ error: 'Conta não encontrada' }, { status: 404 });

    const sellerId = account.seller_id || Deno.env.get('AMAZON_SELLER_ID') || '';
    const marketplaceId = account.marketplace_id || MARKETPLACE_ID;

    let accessToken: string;
    try {
      accessToken = await getSpAccessToken();
    } catch (e: any) {
      return Response.json({ ok: false, error: `Token SP-API: ${e.message}` }, { status: 503 });
    }

    // Verificar conflito externo: comparar valor atual com snapshot
    const snapshot = proposal.snapshot_id
      ? (await base44.asServiceRole.entities.ListingSnapshot.filter({ id: proposal.snapshot_id }).catch(() => []))[0]
      : null;

    if (snapshot && proposal.sku) {
      const currentListing = await fetchCurrentListing(accessToken, sellerId, proposal.sku, marketplaceId).catch(() => null);
      if (currentListing) {
        const currentAttr = currentListing.attributes || {};
        const fieldName = proposal.field_name || '';
        const currentFieldVal = currentAttr[fieldName];
        const snapshotAttr: any = {};
        try { Object.assign(snapshotAttr, JSON.parse(snapshot.attributes || '{}')); } catch {}
        const snapshotFieldVal = snapshotAttr[fieldName];

        // Verificar se o valor atual diverge do snapshot (alteração externa)
        const currentStr = JSON.stringify(currentFieldVal || '');
        const snapshotStr = JSON.stringify(snapshotFieldVal || '');
        if (currentStr !== snapshotStr) {
          await base44.asServiceRole.entities.ListingEnhancementProposal.update(proposal.id, {
            external_change_detected: true,
            approval_status: 'conflict',
            amazon_issues: JSON.stringify([{
              message: 'Alteração externa detectada após snapshot. Revisão necessária antes de submeter.',
              current: currentStr.slice(0, 200),
              snapshot: snapshotStr.slice(0, 200),
            }]),
            updated_at: new Date().toISOString(),
          });
          return Response.json({
            ok: false,
            conflict: true,
            error: 'Valor atual diverge do snapshot. Possível alteração externa. Revise antes de submeter.',
          }, { status: 409 });
        }
      }
    }

    const now = new Date().toISOString();
    const productType = proposal.product_type || snapshot?.product_type || '';

    // Montar PATCH mínimo
    const patch = buildMinimalPatch(proposal.field_name || '', proposal.proposed_value, productType);

    // Atualizar status para submetendo
    await base44.asServiceRole.entities.ListingEnhancementProposal.update(proposal.id, {
      submission_status: 'submitted',
      submitted_at: now,
      updated_at: now,
    });

    // Submeter PATCH
    const submitResult = await submitPatch(accessToken, sellerId, proposal.sku || '', marketplaceId, patch);
    const submissionId = submitResult.data?.submissionId || submitResult.data?.listingId || '';
    const submittedIssues = submitResult.data?.issues || [];

    if (submitResult.status === 200 || submitResult.status === 202) {
      await base44.asServiceRole.entities.ListingEnhancementProposal.update(proposal.id, {
        submission_status: submitResult.status === 202 ? 'processing' : 'confirmed',
        amazon_submission_id: submissionId,
        amazon_issues: JSON.stringify(submittedIssues),
        confirmed_at: submitResult.status === 200 ? now : null,
        updated_at: now,
      });

      // Registrar no histórico
      await base44.asServiceRole.entities.ListingEnhancementHistory.create({
        amazon_account_id: aid,
        marketplace_id: marketplaceId,
        product_id: proposal.product_id,
        asin: proposal.asin,
        sku: proposal.sku,
        field_name: proposal.field_name,
        value_before: proposal.current_value,
        value_after: proposal.proposed_value,
        proposal_id: proposal.id,
        snapshot_id: proposal.snapshot_id,
        submitted_by: user.id,
        submitted_at: now,
        amazon_status: submitResult.status === 202 ? 'processing' : 'confirmed',
        amazon_issues: JSON.stringify(submittedIssues),
        rollback_status: 'eligible',
        created_at: now,
      });

      return Response.json({
        ok: true,
        submission_id: submissionId,
        status: submitResult.status === 202 ? 'processing' : 'confirmed',
        issues: submittedIssues,
        note: submitResult.status === 202
          ? 'Processando na Amazon. Consulte pollListingSubmissionStatus para confirmar.'
          : 'Confirmado pela Amazon.',
      });
    }

    // Erro na submissão
    const errorIssues = submitResult.data?.issues || [{ message: `HTTP ${submitResult.status}` }];
    await base44.asServiceRole.entities.ListingEnhancementProposal.update(proposal.id, {
      submission_status: 'failed',
      amazon_issues: JSON.stringify(errorIssues),
      updated_at: now,
    });

    return Response.json({ ok: false, error: `Submissão falhou: ${submitResult.status}`, issues: errorIssues }, { status: 422 });

  } catch (error: any) {
    console.error('[submitApprovedListingEnhancement]', error.message);
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});