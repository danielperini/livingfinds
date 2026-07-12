/**
 * submitApprovedListingEnhancement v2
 * Submete à Amazon SOMENTE propostas com approval_status === 'approved'.
 * Usa PATCH mínimo. Valida marca, detecção de conflito externo antes de enviar.
 * Nunca usa PUT completo. Nunca remove campos não relacionados.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const MARKETPLACE_ID = Deno.env.get('AMAZON_MARKETPLACE_ID') || 'A2Q3Y263D00KWC';
const SP_CLIENT_ID = Deno.env.get('AMAZON_LWA_CLIENT_ID') || Deno.env.get('SP_CLIENT_ID') || '';
const SP_CLIENT_SECRET = Deno.env.get('AMAZON_LWA_CLIENT_SECRET') || Deno.env.get('SP_CLIENT_SECRET') || '';
const SP_REFRESH_TOKEN = Deno.env.get('AMAZON_SP_REFRESH_TOKEN') || Deno.env.get('SP_REFRESH_TOKEN') || '';

/**
 * BRAND SAFETY — contextos de aplicação:
 *
 * BLOQUEIO ABSOLUTO em conteúdo orgânico (listing):
 *   organic_terms, item_name (título), bullet_point, product_description,
 *   generic_keyword (backend), a_plus_content
 *
 * PERMITIDO EM CAMPANHAS PAGAS (paid keywords):
 *   Marcas de terceiros são válidas como segmentação competitiva.
 *   Regras: campanha separada, match EXACT, aprovação humana, bid reduzido.
 *   A marca do concorrente NUNCA deve aparecer no conteúdo do listing.
 *
 * Esta função cobre SOMENTE conteúdo orgânico (listing/organic_terms).
 * Para validação de paid keywords, use classifyPaidKeyword (no motor de campanhas).
 */
const THIRD_PARTY_BRANDS = [
  'samsung','apple','xiaomi','lg','sony','intelbras','philips','nike','adidas',
  'motorola','huawei','positivo','multilaser','britannia','britania','mondial',
  'electrolux','brastemp','consul','whirlpool','bosch','siemens','panasonic',
  'toshiba','dell','hp','lenovo','asus','acer','microsoft','google','amazon',
];

// Campos de listing onde marcas de terceiros são BLOQUEADAS.
const ORGANIC_CONTENT_FIELDS = new Set([
  'item_name', 'bullet_point', 'product_description',
  'generic_keyword', 'a_plus_content', 'organic_terms',
]);

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
  const patchValue = (() => {
    if (fieldName === 'generic_keyword' || fieldName === 'search_terms') {
      const terms = proposedValue.split(' ').filter(Boolean);
      return terms.map(v => ({ value: v, marketplace_id: MARKETPLACE_ID }));
    }
    if (fieldName === 'item_name')
      return [{ value: proposedValue, language_tag: 'pt_BR', marketplace_id: MARKETPLACE_ID }];
    if (fieldName === 'bullet_point') {
      const bullets = (() => { try { return JSON.parse(proposedValue); } catch { return [proposedValue]; } })();
      return (Array.isArray(bullets) ? bullets : [String(bullets)])
        .map((b: string) => ({ value: b, language_tag: 'pt_BR', marketplace_id: MARKETPLACE_ID }));
    }
    if (fieldName === 'product_description')
      return [{ value: proposedValue, language_tag: 'pt_BR', marketplace_id: MARKETPLACE_ID }];
    return [{ value: proposedValue, marketplace_id: MARKETPLACE_ID }];
  })();

  return {
    productType,
    patches: [{ op: 'replace', path: `/attributes/${fieldName}`, value: patchValue }],
  };
}

async function submitPatch(
  accessToken: string, sellerId: string, sku: string,
  marketplaceId: string, patch: any, dryRun: boolean
): Promise<any> {
  const mode = dryRun ? 'VALIDATION_PREVIEW' : 'ACTUAL';
  const url = `https://sellingpartnerapi-na.amazon.com/listings/2021-08-01/items/${sellerId}/${encodeURIComponent(sku)}?marketplaceIds=${marketplaceId}&mode=${mode}`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: { 'x-amz-access-token': accessToken, 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  return { status: res.status, data: await res.json() };
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    if (user.role !== 'admin')
      return Response.json({ error: 'Apenas administradores podem submeter alterações.' }, { status: 403 });

    const body = await req.json().catch(() => ({}));
    const { proposal_id, amazon_account_id, dry_run = false } = body;

    if (!proposal_id) return Response.json({ error: 'proposal_id obrigatório' }, { status: 400 });

    const proposals = await base44.asServiceRole.entities.ListingEnhancementProposal.filter({ id: proposal_id });
    const proposal = proposals[0];
    if (!proposal) return Response.json({ error: 'Proposta não encontrada' }, { status: 404 });

    const aid = amazon_account_id || proposal.amazon_account_id;

    if (proposal.approval_status !== 'approved')
      return Response.json({ ok: false, error: `Proposta não aprovada. Status: ${proposal.approval_status}` }, { status: 422 });

    if (!dry_run && ['submitted', 'processing', 'confirmed'].includes(proposal.submission_status || ''))
      return Response.json({ ok: false, error: `Proposta já submetida. Status: ${proposal.submission_status}` }, { status: 409 });

    // Validação de marca — aplica SOMENTE em campos de conteúdo orgânico do listing.
    // Paid keywords (competitor_brand_keyword) NÃO passam por esta validação aqui.
    const fieldName = proposal.field_name || '';
    const isOrganicContentField = ORGANIC_CONTENT_FIELDS.has(fieldName);
    if (isOrganicContentField) {
      const brandCheck = validateNoThirdPartyBrand(proposal.proposed_value || '');
      if (!brandCheck.safe) {
        await base44.asServiceRole.entities.ListingEnhancementProposal.update(proposal.id, {
          brand_safety_status: 'blocked', submission_status: 'failed',
          amazon_issues: JSON.stringify([{
            message: `Marca de terceiro bloqueada no conteúdo orgânico: ${brandCheck.detected.join(', ')}. Marcas de terceiros são proibidas em título, bullets, descrição e termos orgânicos.`,
          }]),
          updated_at: new Date().toISOString(),
        });
        return Response.json({
          ok: false,
          error: `Marca de terceiro bloqueada em campo orgânico (${fieldName}): ${brandCheck.detected.join(', ')}`,
          context: 'organic_content_block',
          note: 'Marcas de terceiros podem ser usadas como keywords pagas em campanha separada, mas nunca em conteúdo do listing.',
        }, { status: 422 });
      }
    }

    if (!proposal.proposed_value?.trim())
      return Response.json({ ok: false, error: 'proposed_value está vazio. Preencha antes de submeter.' }, { status: 422 });

    const accounts = await base44.asServiceRole.entities.AmazonAccount.filter({ id: aid });
    const account = accounts[0];
    if (!account) return Response.json({ error: 'Conta não encontrada' }, { status: 404 });

    const sellerId = account.seller_id || Deno.env.get('AMAZON_SELLER_ID') || '';
    const marketplaceId = account.marketplace_id || MARKETPLACE_ID;

    if (!sellerId) {
      return Response.json({ ok: false, error: 'seller_id não configurado. Configure o Seller ID em Integrações → Amazon (SP-API).' }, { status: 400 });
    }

    let accessToken: string;
    try { accessToken = await getSpAccessToken(); }
    catch (e: any) { return Response.json({ ok: false, error: `Token SP-API: ${e.message}` }, { status: 503 }); }

    // Verificar conflito externo
    if (!dry_run && proposal.snapshot_id && proposal.sku) {
      const snapshot = (await base44.asServiceRole.entities.ListingSnapshot.filter({ id: proposal.snapshot_id }).catch(() => []))[0];
      if (snapshot) {
        const currentListing = await fetchCurrentListing(accessToken, sellerId, proposal.sku, marketplaceId).catch(() => null);
        if (currentListing) {
          const snapshotAttr: any = {};
          try { Object.assign(snapshotAttr, JSON.parse(snapshot.attributes || '{}')); } catch {}
          const currentStr = JSON.stringify(currentListing.attributes?.[proposal.field_name || ''] || '');
          const snapshotStr = JSON.stringify(snapshotAttr[proposal.field_name || ''] || '');
          if (currentStr !== snapshotStr) {
            await base44.asServiceRole.entities.ListingEnhancementProposal.update(proposal.id, {
              external_change_detected: true, approval_status: 'conflict',
              amazon_issues: JSON.stringify([{ message: 'Alteração externa detectada após snapshot. Revise antes de submeter.' }]),
              updated_at: new Date().toISOString(),
            });
            return Response.json({ ok: false, conflict: true, error: 'Valor atual diverge do snapshot. Possível alteração externa.' }, { status: 409 });
          }
        }
      }
    }

    const now = new Date().toISOString();
    const productType = proposal.product_type || '';
    const patch = buildMinimalPatch(proposal.field_name || '', proposal.proposed_value, productType);

    if (!dry_run) {
      await base44.asServiceRole.entities.ListingEnhancementProposal.update(proposal.id, {
        submission_status: 'submitted', submitted_at: now, updated_at: now,
      });
    }

    const result = await submitPatch(accessToken, sellerId, proposal.sku || '', marketplaceId, patch, dry_run);
    const submissionId = result.data?.submissionId || result.data?.listingId || '';
    const resultIssues = result.data?.issues || [];

    if (dry_run) {
      return Response.json({
        ok: result.status < 400, dry_run: true,
        validation_status: result.status, issues: resultIssues,
        note: 'Modo de validação — nenhuma alteração foi submetida à Amazon.',
      });
    }

    if (result.status === 200 || result.status === 202) {
      const finalStatus = result.status === 202 ? 'processing' : 'confirmed';
      await base44.asServiceRole.entities.ListingEnhancementProposal.update(proposal.id, {
        submission_status: finalStatus,
        amazon_submission_id: submissionId,
        amazon_issues: JSON.stringify(resultIssues),
        confirmed_at: result.status === 200 ? now : undefined,
        updated_at: now,
      });

      await base44.asServiceRole.entities.ListingEnhancementHistory.create({
        amazon_account_id: aid, marketplace_id: marketplaceId,
        product_id: proposal.product_id, asin: proposal.asin, sku: proposal.sku,
        field_name: proposal.field_name,
        value_before: proposal.current_value, value_after: proposal.proposed_value,
        proposal_id: proposal.id, snapshot_id: proposal.snapshot_id,
        submitted_by: user.id, submitted_at: now,
        amazon_status: finalStatus,
        amazon_issues: JSON.stringify(resultIssues),
        rollback_status: 'eligible', created_at: now,
      });

      return Response.json({
        ok: true, submission_id: submissionId, status: finalStatus, issues: resultIssues,
        note: result.status === 202 ? 'Processando na Amazon.' : 'Confirmado pela Amazon.',
      });
    }

    // Erro
    const errorIssues = result.data?.issues || [{ message: `HTTP ${result.status}` }];
    await base44.asServiceRole.entities.ListingEnhancementProposal.update(proposal.id, {
      submission_status: 'failed', amazon_issues: JSON.stringify(errorIssues), updated_at: now,
    });
    return Response.json({ ok: false, error: `Submissão falhou: ${result.status}`, issues: errorIssues }, { status: 422 });

  } catch (error: any) {
    console.error('[submitApprovedListingEnhancement]', error.message);
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});