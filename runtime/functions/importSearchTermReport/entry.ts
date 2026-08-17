/**
 * importSearchTermReport — Importa relatório de Termos de Pesquisa do Excel/CSV
 * 
 * Extrai dados de relatórios Amazon Ads em formato Excel ou CSV
 * e importa para a entidade SearchTerm
 * 
 * Campos esperados no arquivo:
 * - Data inicial, Data final (ou date)
 * - Campanha, Grupo de anúncios, Palavra-chave, Termo de pesquisa
 * - ASIN, Tipo de correspondência (match type)
 * - Impressões, Cliques, CTR, CPC, Gastos (spend)
 * - Vendas (sales), Pedidos (orders), ACoS, ROAS
 * - Unidades vendidas, Taxa de conversão
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const { file_url, amazon_account_id } = body;

    if (!file_url) {
      return Response.json({ error: 'file_url required' }, { status: 400 });
    }

    // Resolver conta Amazon
    let accountId = amazon_account_id;
    if (!accountId) {
      const accounts = await base44.asServiceRole.entities.AmazonAccount.filter({ user_id: user.id }, '-last_sync_at', 1);
      if (accounts.length === 0) return Response.json({ error: 'Nenhuma conta Amazon encontrada' }, { status: 404 });
      accountId = accounts[0].id;
    }

    // Extrair dados do arquivo
    const extractionResult = await base44.asServiceRole.integrations.Core.ExtractDataFromUploadedFile({
      file_url: file_url,
      json_schema: {
        type: 'object',
        properties: {
          rows: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                'Data inicial': { type: 'string' },
                'Data final': { type: 'string' },
                'Campanha': { type: 'string' },
                'ID da campanha': { type: 'string' },
                'Grupo de anúncios': { type: 'string' },
                'ID do grupo de anúncios': { type: 'string' },
                'Palavra-chave': { type: 'string' },
                'ID da palavra-chave': { type: 'string' },
                'Termo de pesquisa': { type: 'string' },
                'ASIN': { type: 'string' },
                'SKU': { type: 'string' },
                'Tipo de correspondência': { type: 'string' },
                'Impressões': { type: 'number' },
                'Cliques': { type: 'number' },
                'CTR': { type: 'number' },
                'CPC': { type: 'number' },
                'Gastos': { type: 'number' },
                'Vendas': { type: 'number' },
                'Pedidos': { type: 'number' },
                'ACOS': { type: 'number' },
                'ROAS': { type: 'number' },
                'Unidades vendidas': { type: 'number' },
                'Taxa de conversão': { type: 'number' },
                // Campos em inglês (fallback)
                'Campaign': { type: 'string' },
                'Ad Group': { type: 'string' },
                'Keyword': { type: 'string' },
                'Search Term': { type: 'string' },
                'Match Type': { type: 'string' },
                'Impressions': { type: 'number' },
                'Clicks': { type: 'number' },
                'Spend': { type: 'number' },
                'Sales': { type: 'number' },
                'Orders': { type: 'number' },
              }
            }
          }
        }
      }
    });

    if (extractionResult.status !== 'success' || !extractionResult.output?.rows) {
      return Response.json({ 
        error: 'Falha ao extrair dados', 
        details: extractionResult.details 
      }, { status: 400 });
    }

    const rows = extractionResult.output.rows;
    console.log(`[importSearchTermReport] ${rows.length} linhas extraídas`);

    // Normalizar e mapear dados
    const normalizeMatchType = (mt) => {
      if (!mt) return 'broad';
      const m = mt.toLowerCase();
      if (m.includes('exat') || m === 'exact') return 'exact';
      if (m.includes('fras') || m === 'phrase') return 'phrase';
      if (m.includes('ampl') || m === 'broad') return 'broad';
      if (m.includes('auto')) return 'auto';
      return 'broad';
    };

    const searchTermRecords = [];
    const today = new Date().toISOString().slice(0, 10);

    for (const row of rows) {
      // Mapear campos (português e inglês)
      const campaignName = row['Campanha'] || row['Campaign'] || '';
      const campaignId = row['ID da campanha'] || row['Campaign ID'] || row['campaignId'] || '';
      const adGroupName = row['Grupo de anúncios'] || row['Ad Group'] || '';
      const adGroupId = row['ID do grupo de anúncios'] || row['Ad Group ID'] || row['adGroupId'] || '';
      const keywordText = row['Palavra-chave'] || row['Keyword'] || '';
      const keywordId = row['ID da palavra-chave'] || row['Keyword ID'] || row['keywordId'] || '';
      const searchTerm = row['Termo de pesquisa'] || row['Search Term'] || '';
      const asin = row['ASIN'] || row['advertisedAsin'] || '';
      const sku = row['SKU'] || row['advertisedSku'] || '';
      const matchType = normalizeMatchType(row['Tipo de correspondência'] || row['Match Type'] || '');
      
      // Métricas
      const impressions = Number(row['Impressões'] || row['Impressions'] || 0);
      const clicks = Number(row['Cliques'] || row['Clicks'] || 0);
      const spend = Number(row['Gastos'] || row['Spend'] || 0);
      const sales = Number(row['Vendas'] || row['Sales'] || 0);
      const orders = Number(row['Pedidos'] || row['Orders'] || 0);
      const units = Number(row['Unidades vendidas'] || row['Units Sold'] || 0);
      const ctr = Number(row['CTR'] || 0) / 100; // Converter porcentagem
      const cpc = Number(row['CPC'] || 0);
      const acos = Number(row['ACOS'] || row['ACoS'] || 0);
      const roas = Number(row['ROAS'] || 0);
      const conversionRate = Number(row['Taxa de conversão'] || row['Conversion Rate'] || 0) / 100;

      // Gerar chave única
      const uniqueKey = `${campaignId || ''}|${adGroupId || ''}|${keywordId || ''}|${searchTerm.slice(0, 50)}|${today}`;

      searchTermRecords.push({
        amazon_account_id: accountId,
        date: today,
        campaign_id: campaignId,
        campaign_name: campaignName,
        ad_group_id: adGroupId,
        ad_group_name: adGroupName,
        keyword_id: keywordId,
        keyword_text: keywordText,
        keyword_type: 'search_term',
        match_type: matchType,
        search_term: searchTerm,
        advertised_asin: asin,
        advertised_sku: sku,
        impressions,
        clicks,
        ctr,
        cpc,
        spend,
        orders_1d: orders,
        orders_7d: orders,
        orders_14d: orders,
        orders_30d: orders,
        units_1d: units,
        units_7d: units,
        units_14d: units,
        units_30d: units,
        sales_1d: sales,
        sales_7d: sales,
        sales_14d: sales,
        sales_30d: sales,
        acos_7d: acos,
        acos_14d: acos,
        roas_7d: roas,
        roas_14d: roas,
        conversion_rate: conversionRate,
        unique_key: uniqueKey,
        synced_at: new Date().toISOString(),
      });
    }

    // Limpar dados antigos (últimos 30 dias) para evitar duplicação
    const cutoffDate = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const existingRecords = await base44.asServiceRole.entities.SearchTerm.filter({
      amazon_account_id: accountId,
    }, '-date', 5000);

    const toDelete = existingRecords.filter(r => r.date && r.date >= cutoffDate);
    for (let i = 0; i < toDelete.length; i += 500) {
      const ids = toDelete.slice(i, i + 500).map(r => r.id);
      await Promise.all(ids.map(id => base44.asServiceRole.entities.SearchTerm.delete(id)));
    }
    console.log(`[importSearchTermReport] ${toDelete.length} registros antigos removidos`);

    // Importar novos registros em lotes
    for (let i = 0; i < searchTermRecords.length; i += 500) {
      const batch = searchTermRecords.slice(i, i + 500);
      await base44.asServiceRole.entities.SearchTerm.bulkCreate(batch);
    }

    console.log(`[importSearchTermReport] ${searchTermRecords.length} registros importados`);

    return Response.json({
      ok: true,
      imported: searchTermRecords.length,
      deleted: toDelete.length,
      amazon_account_id: accountId,
      message: `${searchTermRecords.length} termos de pesquisa importados`,
    });
  } catch (error) {
    console.error('[importSearchTermReport] Erro:', error.message);
    return Response.json({ error: error.message }, { status: 500 });
  }
});