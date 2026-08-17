/**
 * pollListingSubmissionStatus
 * Verifica o status de submissões de listing em processamento.
 * Atualiza proposals com status 'processing' buscando o resultado final da Amazon.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const MARKETPLACE_ID = Deno.env.get('AMAZON_MARKETPLACE_ID') || 'A2Q3Y263D00KWC';
const SP_CLIENT_ID = Deno.env.get('AMAZON_LWA_CLIENT_ID') || Deno.env.get('SP_CLIENT_ID') || '';
const SP_CLIENT_SECRET = Deno.env.get('AMAZON_LWA_CLIENT_SECRET') || Deno.env.get('SP_CLIENT_SECRET') || '';
const SP_REFRESH_TOKEN = Deno.env.get('AMAZON_SP_REFRESH_TOKEN') || Deno.env.get('SP_REFRESH_TOKEN') || '';

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

async function fetchCurrentListing(
  accessToken: string, sellerId: string, sku: string, marketplaceId: string
): Promise<any> {
  const url = `https://sellingpartnerapi-na.amazon.com/listings/2021-08-01/items/${sellerId}/${encodeURIComponent(sku)}?marketplaceIds=${marketplaceId}&includedData=summaries,attributes,issues`;
  const res = await fetch(url, {
    headers: { 'x-amz-access-token': accessToken, 'Content-Type': 'application/json' },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`fetchListing: ${res.status}`);
  return res.json();
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const { amazon_account_id, proposal_id } = body;

    if (!amazon_account_id) return Response.json({ error: 'amazon_account_id obrigatório' }, { status: 400 });

    const accounts = await base44.asServiceRole.entities.AmazonAccount.filter({ id: amazon_account_id }).catch(() => []);
    const account = accounts[0];
    if (!account) return Response.json({ error: 'Conta não encontrada' }, { status: 404 });

    const sellerId = account.seller_id || Deno.env.get('AMAZON_SELLER_ID') || '';
    const marketplaceId = account.marketplace_id || MARKETPLACE_ID;

    // Buscar proposals em estado 'processing' ou proposal específica
    let proposals: any[];
    if (proposal_id) {
      proposals = await base44.asServiceRole.entities.ListingEnhancementProposal.filter({
        amazon_account_id, id: proposal_id,
      }).catch(() => []);
    } else {
      proposals = await base44.asServiceRole.entities.ListingEnhancementProposal.filter({
        amazon_account_id, submission_status: 'processing',
      }, '-submitted_at', 50).catch(() => []);
    }

    if (!proposals.length) return Response.json({ ok: true, polled: 0, message: 'Nenhuma submissão em processamento.' });

    let accessToken: string;
    try { accessToken = await getSpAccessToken(); }
    catch (e: any) { return Response.json({ ok: false, error: `Token SP-API: ${e.message}` }, { status: 503 }); }

    const now = new Date().toISOString();
    const results: any[] = [];

    for (const proposal of proposals) {
      if (!proposal.sku) { results.push({ id: proposal.id, status: 'skipped', reason: 'no_sku' }); continue; }
      try {
        const listing = await fetchCurrentListing(accessToken, sellerId, proposal.sku, marketplaceId);
        if (!listing) { results.push({ id: proposal.id, status: 'not_found' }); continue; }

        // Verificar se o valor proposto está agora no listing atual
        const currentAttr = listing.attributes || {};
        const fieldName = proposal.field_name || '';
        const currentValue = currentAttr[fieldName];
        const currentValueStr = JSON.stringify(currentValue || '');
        const proposedNorm = (proposal.proposed_value || '').toLowerCase().trim();
        const currentNorm = JSON.stringify(currentValue || '').toLowerCase();
        const confirmed = currentNorm.includes(proposedNorm.slice(0, 30));
        const newIssues = listing.issues || [];
        const finalStatus = confirmed ? 'confirmed' : (newIssues.length > 0 ? 'failed' : 'processing');

        await base44.asServiceRole.entities.ListingEnhancementProposal.update(proposal.id, {
          submission_status: finalStatus,
          amazon_issues: JSON.stringify(newIssues),
          confirmed_at: confirmed ? now : undefined,
          updated_at: now,
        });

        // Atualizar histórico se confirmado
        if (confirmed) {
          const histories = await base44.asServiceRole.entities.ListingEnhancementHistory.filter(
            { proposal_id: proposal.id }, '-created_at', 1
          ).catch(() => []);
          if (histories[0]) {
            await base44.asServiceRole.entities.ListingEnhancementHistory.update(histories[0].id, {
              amazon_status: 'confirmed', confirmed_at: now,
            });
          }
        }

        results.push({ id: proposal.id, asin: proposal.asin, field: fieldName, status: finalStatus, issues_count: newIssues.length });
      } catch (e: any) {
        results.push({ id: proposal.id, status: 'error', error: e.message });
      }
    }

    const confirmed = results.filter(r => r.status === 'confirmed').length;
    const failed = results.filter(r => r.status === 'failed').length;
    const stillProcessing = results.filter(r => r.status === 'processing').length;

    return Response.json({ ok: true, polled: proposals.length, confirmed, failed, still_processing: stillProcessing, results });

  } catch (error: any) {
    console.error('[pollListingSubmissionStatus]', error.message);
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});