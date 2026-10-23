/**
 * importSearchTermReport — Importa relatório de Termos de Pesquisa do Excel/CSV
 * 
 * Extrai dados de relatórios Amazon Ads em formato Excel ou CSV
 * e importa em uma coleção isolada, visível para análise manual e inelegível
 * para o motor de decisão.
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
import { normalizeImportedSearchTermRows, persistImportedSearchTermBatch } from '../../shared/importedSearchTermReport.js';

Deno.serve(async (req) => {
  let pendingImportId = null;
  let base44Client = null;
  try {
    const base44 = base44Client = createClientFromRequest(req);
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
    const authorizedAccount = await base44.asServiceRole.entities.AmazonAccount.filter({
      id: accountId,
      user_id: user.id,
    }, undefined, 1);
    if (!authorizedAccount.length) return Response.json({ error: 'Conta Amazon não encontrada para este usuário.' }, { status: 404 });

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
                'Data': { type: 'string' },
                'date': { type: 'string' },
                'Start Date': { type: 'string' },
                'End Date': { type: 'string' },
                'Janela de atribuição (dias)': { type: 'number' },
                'Attribution Window (days)': { type: 'number' },
                'attribution_window_days': { type: 'number' },
                'Campanha': { type: 'string' },
                'ID da campanha': { type: 'string' },
                'Campaign ID': { type: 'string' },
                'campaignId': { type: 'string' },
                'Grupo de anúncios': { type: 'string' },
                'ID do grupo de anúncios': { type: 'string' },
                'Palavra-chave': { type: 'string' },
                'ID da palavra-chave': { type: 'string' },
                'Termo de pesquisa': { type: 'string' },
                'Search Term': { type: 'string' },
                'searchTerm': { type: 'string' },
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

    const normalized = await normalizeImportedSearchTermRows(rows, authorizedAccount[0], new Date().toISOString());
    if (!normalized.ok) return Response.json({ ok: false, error: normalized.error }, { status: 422 });
    const searchTermRecords = normalized.records;
    pendingImportId = normalized.batch_id;

    const importEntity = base44.asServiceRole.entities.ImportedSearchTermReportImport;
    const rowEntity = base44.asServiceRole.entities.ImportedSearchTermReportRow;
    const result = await persistImportedSearchTermBatch({
      findBatch: async (id: string) => (await importEntity.filter({ id }, undefined, 1))[0] || null,
      startBatch: async (record: any) => {
        const prior = await importEntity.filter({ id: record.id }, undefined, 1);
        return prior[0]
          ? await importEntity.update(record.id, record)
          : await importEntity.create(record);
      },
      findRowsByUniqueKeys: async (keys: string[]) => {
        const found = [];
        for (let i = 0; i < keys.length; i += 100) {
          found.push(...await rowEntity.filter({
            amazon_account_id: accountId,
            search_term_quality_view: 'audit', unique_key: { $in: keys.slice(i, i + 100) },
          }, '-synced_at', 500));
        }
        return found;
      },
      updateRows: async (items: any[]) => {
        for (let i = 0; i < items.length; i += 100) await rowEntity.bulkUpdate(items.slice(i, i + 100));
      },
      createRows: async (items: any[]) => {
        for (let i = 0; i < items.length; i += 100) await rowEntity.bulkCreate(items.slice(i, i + 100));
      },
      completeBatch: async (id: string, patch: any) => await importEntity.update(id, { ...patch, status: 'completed', error_code: null }),
      failBatch: async (id: string, errorCode: string) => await importEntity.update(id, { status: 'failed', error_code: errorCode }),
    }, {
      batch_id: normalized.batch_id,
      account_id: accountId,
      marketplace_id: authorizedAccount[0].marketplace_id || '',
      country_code: authorizedAccount[0].country_code || '',
      currency_code: authorizedAccount[0].currency_code || '',
      records: searchTermRecords,
      duplicates_removed: normalized.duplicates_removed,
      started_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
    });

    console.log(`[importSearchTermReport] batch=${normalized.batch_id} ${result.created} criados + ${result.updated} atualizados; armazenamento isolado concluído`);

    return Response.json({
      ok: true,
      imported: result.rows,
      created: result.created,
      updated: result.updated,
      idempotent_replay: result.replayed,
      duplicates_removed: normalized.duplicates_removed,
      deleted: 0,
      import_batch_id: normalized.batch_id,
      amazon_account_id: accountId,
      message: result.replayed
        ? 'Este relatório já foi importado integralmente; nenhum dado foi alterado.'
        : `${searchTermRecords?.length || 0} termos de pesquisa importados`,
    });
  } catch (error: any) {
    console.error('[importSearchTermReport] Erro:', error.message);
    if (pendingImportId) {
      await base44Client?.asServiceRole.entities.ImportedSearchTermReportImport.update(pendingImportId, {
        status: 'failed',
        error_code: 'import_incomplete',
      }).catch(() => {});
    }
    if (String(error?.message || '').startsWith('duplicate_existing_import_key:')) {
      return Response.json({
        ok: false,
        error: 'Já existem registros duplicados dentro deste lote importado. O lote foi mantido oculto para revisão; nenhum dado do SearchTerm operacional foi alterado.',
        import_batch_id: pendingImportId,
      }, { status: 409 });
    }
    return Response.json({ error: error.message }, { status: 500 });
  }
});
