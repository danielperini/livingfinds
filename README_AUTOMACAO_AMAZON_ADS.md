# Automação de Relatórios Amazon Ads

## Visão Geral

Sistema automatizado para sincronização de relatórios Amazon Ads **duas vezes por dia** (06:00 e 22:00 BRT), garantindo dados sempre atualizados para análise e otimização de campanhas.

---

## Configuração

### Horários de Execução (America/Sao_Paulo)

| Automação | Horário BRT | Horário UTC | Ação |
|-----------|-------------|-------------|------|
| `Amazon Ads Reports - 06:00 BRT` | 06:00 | 09:00 | Solicita relatórios |
| `Amazon Ads Download - 06:15 BRT` | 06:15 | 09:15 | Processa relatórios |
| `Amazon Ads Reports - 22:00 BRT` | 22:00 | 01:00+1 | Solicita relatórios |
| `Amazon Ads Download - 22:15 BRT` | 22:15 | 01:15+1 | Processa relatórios |

---

## Relatórios Solicitados

### 1. **SP_Termo_Pesquisa_BR** (spSearchTerm)
**Principal relatório** — dados detalhados por termo de pesquisa

**Colunas incluídas:**
- Identificação: `date`, `campaignId`, `campaignName`, `adGroupId`, `adGroupName`
- Keywords: `keywordId`, `keyword`, `keywordType`, `matchType`, `searchTerm`
- Produto: `advertisedAsin`, `advertisedSku`
- Métricas: `impressions`, `clicks`, `ctr`, `cpc`, `cost`
- Conversões (janelas de atribuição):
  - Pedidos: `purchases1d`, `purchases7d`, `purchases14d`, `purchases30d`
  - Unidades: `unitsSoldClicks1d`, `unitsSoldClicks7d`, `unitsSoldClicks14d`, `unitsSoldClicks30d`
  - Vendas: `sales1d`, `sales7d`, `sales14d`, `sales30d`
  - Vendas mesmo SKU: `attributedSalesSameSku1d/7d/14d/30d`
  - Unidades mesmo SKU: `unitsSoldSameSku1d/7d/14d/30d`
- Performance: `acosClicks7d`, `acosClicks14d`, `roasClicks7d`, `roasClicks14d`, `conversionRate`

### 2. **SP_Campanhas_BR** (spCampaigns)
Dados agregados por campanha

**Colunas:** `date`, `campaignId`, `campaignName`, `campaignStatus`, `campaignBudgetAmount`, `impressions`, `clicks`, `ctr`, `cpc`, `cost`, `purchases1d/7d/14d/30d`, `unitsSoldClicks1d/7d/14d/30d`, `sales1d/7d/14d/30d`, `acosClicks7d/14d`, `roasClicks7d/14d`

### 3. **SP_Produtos_BR** (spAdvertisedProduct)
Dados por produto anunciado

**Colunas:** `date`, `campaignId`, `campaignName`, `adGroupId`, `adGroupName`, `adId`, `advertisedAsin`, `advertisedSku`, `impressions`, `clicks`, `ctr`, `cpc`, `cost`, `purchases1d/7d/14d/30d`, `unitsSoldClicks1d/7d/14d/30d`, `sales1d/7d/14d/30d`

---

## Estrutura do Banco de Dados

### Entidade: `SearchTerm`

**Chave única:** `unique_key = date|campaign_id|ad_group_id|search_term|keyword_id|asin`

| Campo | Tipo | Descrição |
|-------|------|-----------|
| `amazon_account_id` | string | ID da conta |
| `date` | date | Data do registro |
| `campaign_id` | string | ID da campanha |
| `campaign_name` | string | Nome da campanha |
| `ad_group_id` | string | ID do grupo de anúncios |
| `ad_group_name` | string | Nome do grupo |
| `keyword_id` | string | ID da keyword |
| `keyword_text` | string | Texto da keyword |
| `keyword_type` | string | Tipo (keyword/target) |
| `match_type` | enum | `exact`, `phrase`, `broad`, `auto` |
| `search_term` | string | Termo pesquisado |
| `advertised_asin` | string | ASIN do produto |
| `advertised_sku` | string | SKU do produto |
| `impressions` | number | Impressões |
| `clicks` | number | Cliques |
| `ctr` | number | CTR (%) |
| `cpc` | number | CPC médio |
| `spend` | number | Investimento |
| `orders_1d/7d/14d/30d` | number | Pedidos por janela |
| `units_1d/7d/14d/30d` | number | Unidades vendidas |
| `sales_1d/7d/14d/30d` | number | Vendas ($) por janela |
| `acos_7d/14d` | number | ACoS (%) |
| `roas_7d/14d` | number | ROAS |
| `conversion_rate` | number | Taxa de conversão |
| `unique_key` | string | Chave única para deduplicação |
| `synced_at` | datetime | Data da sincronização |

---

## Variáveis de Ambiente Necessárias

```bash
# Credenciais Amazon Ads
ADS_CLIENT_ID=amzn1.application-oa2-xxxx
ADS_CLIENT_SECRET=xxxx
ADS_REFRESH_TOKEN=Atza|xxxx
ADS_PROFILE_ID=xxxx
ADS_REGION=NA  # ou EU, FE

# Opcionais (fallback)
AMAZON_SP_REFRESH_TOKEN=xxxx
AMAZON_LWA_CLIENT_ID=xxxx
AMAZON_LWA_CLIENT_SECRET=xxxx
```

---

## Fluxo de Execução

### Fase 1: Request (06:00 e 22:00)
1. Renova token OAuth via LWA
2. Calcula período (últimos 30 dias até ontem)
3. Solicita 3 relatórios em paralelo
4. Lida com duplicatas (425 — reutiliza reportId existente)
5. Cria registro `SyncRun` com status `running`
6. Retorna `reportIds` para polling

### Fase 2: Download (06:15 e 22:15)
1. Verifica status de cada relatório
2. Aguarda todos estarem `COMPLETED`
3. Baixa URLs (GZIP)
4. Descomprime e parseia JSON
5. Processa dados:
   - **SearchTerm**: delete por data + bulkCreate (chave única)
   - **Campaigns**: bulkUpdate existentes
   - **Products**: upsert por ASIN
   - **CampaignMetricsDaily**: upsert por (campaign_id, date)
6. Atualiza `AmazonAccount.last_sync_at`
7. Marca `SyncRun` como `success`

---

## Tratamento de Erros

### Token OAuth
- Cache em memória (renova 60s antes de expirar)
- Fallback: `AmazonAccount.ads_refresh_token` > `ADS_REFRESH_TOKEN`

### Rate Limits
- Solicitações em paralelo (Promise.allSettled)
- Bulk operations em lotes de 500 registros
- Retry implícito via polling (15 min)

### Relatórios Duplicados
- HTTP 425: extrai `reportId` do erro e reutiliza
- Log: `✓ searchTerms: xxx (duplicado)`

### Dados Corrigidos
- Delete + insert por data (atualiza registros existentes)
- Chave única previne duplicatas dentro do mesmo dia

---

## Monitorização

### Logs da Função
```
[scheduledAdsReportSync] 3 relatórios solicitados
✓ searchTerms: 12345 registos
✓ Campaigns: 45 atualizadas
✓ Products: 123
[scheduledAdsReportSync] Concluído em 8.3s
```

### Entidades para Auditoria

**SyncRun:**
```json
{
  "operation": "scheduledReports:2024-01-15:{...reportIds...}",
  "status": "success",
  "records_received": 15000,
  "records_upserted": 12500,
  "duration_ms": 8300,
  "started_at": "2024-01-15T09:00:00Z",
  "completed_at": "2024-01-15T09:08:30Z"
}
```

**AmazonAccount:**
```json
{
  "last_sync_at": "2024-01-15T09:08:30Z",
  "status": "connected"
}
```

---

## Exemplo de Resposta da API

### Request (06:00)
```json
{
  "ok": true,
  "reportIds": {
    "searchTerms": "amzn1.adreport.xxxx-xxxx-xxxx",
    "campaigns": "amzn1.adreport.yyyy-yyyy-yyyy",
    "products": "amzn1.adreport.zzzz-zzzz-zzzz"
  },
  "syncRunId": "6a4351269c4d8c07e6b78070",
  "period": {
    "start": "2024-12-16",
    "end": "2024-01-14"
  },
  "errors": [],
  "message": "3 relatórios solicitados. Execute action=\"download\" em 5-15 minutos."
}
```

### Download (06:15)
```json
{
  "ok": true,
  "ready": true,
  "search_terms": 12345,
  "campaigns": 45,
  "products": 123,
  "download_errors": [],
  "duration_s": "8.3"
}
```

---

## Testes Básicos

### Teste Manual — Request
```bash
curl -X POST https://seu-app.base44.app/functions/scheduledAdsReportSync \
  -H "Content-Type: application/json" \
  -d '{"action": "request", "amazon_account_id": "xxx"}'
```

### Teste Manual — Download
```bash
curl -X POST https://seu-app.base44.app/functions/scheduledAdsReportSync \
  -H "Content-Type: application/json" \
  -d '{
    "action": "download",
    "reportIds": {"searchTerms": "amzn1.adreport.xxx"},
    "syncRunId": "6a4351269c4d8c07e6b78070"
  }'
```

### Verificar Dados
```javascript
// No console do navegador ou backend
const terms = await base44.entities.SearchTerm.filter({ 
  amazon_account_id: 'xxx',
  date: '2024-01-14'
}, '-created_date', 10);
console.log(`Search terms: ${terms.length}`);
```

---

## Limitações Conhecidas

1. **Latência Amazon**: Relatórios podem levar 5-30 min para processar
2. **Dados atrasados**: Métricas de 30d podem levar 48h para estabilizar
3. **Rate limits**: API Amazon limita ~10 requests/segundo
4. **Colunas indisponíveis**: Algumas métricas (ex: páginas Kindle) só aparecem para produtos elegíveis

---

## Próximos Passos Sugeridos

- [ ] Criar dashboard de monitorização de syncs
- [ ] Implementar alertas de falha (email/Slack)
- [ ] Adicionar relatório de posicionamento (top of search)
- [ ] Implementar rollback em caso de falha crítica
- [ ] Cache de dados históricos para reduzir chamadas API

---

## Suporte

Em caso de falha:
1. Verifique `SyncRun` com status `error`
2. Consulte logs da função no dashboard Base44
3. Valide tokens em `AmazonAccount.ads_refresh_token`
4. Teste manualmente com `test_backend_function