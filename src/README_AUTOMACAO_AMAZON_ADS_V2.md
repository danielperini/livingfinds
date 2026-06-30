# Automação de Relatórios Amazon Ads — OTIMIZADA

## 🎯 Mudanças Principais

### ANTES (Problema)
- Somava dados de múltiplos relatórios
- Duplicava spend entre execuções
- Não armazenava dados brutos

### AGORA (Solução)
- ✅ **Limpa dados antigos** antes de importar novos
- ✅ **Armazena raw data** em `AdsReportRaw` (para IA/auditoria)
- ✅ **Armazena histórico completo** em `AdsMetricsHistory`
- ✅ **NÃO SOMA** — substitui completamente os últimos 30 dias
- ✅ **Mantém todas as métricas** mesmo sem uso imediato no backend

---

## 📊 Entidades Criadas

### 1. `AdsReportRaw`
**Finalidade:** Armazenar dados brutos dos relatórios (linha por linha)
**Uso:** IA, auditoria, consultas futuras, debugging

| Campo | Tipo | Descrição |
|-------|------|-----------|
| `amazon_account_id` | string | ID da conta |
| `report_type` | enum | `searchTerms`, `campaigns`, `products` |
| `report_id` | string | ID do relatório Amazon |
| `report_date` | date | Data do registro |
| `period_start` | date | Início do período (30 dias) |
| `period_end` | date | Fim do período |
| `raw_data` | object | Dados completos da linha |
| `processed` | boolean | Se já foi processado |
| `synced_at` | datetime | Data do sync |

### 2. `AdsMetricsHistory`
**Finalidade:** Histórico unificado de todas as métricas
**Uso:** Análise temporal, ML, consultas agregadas

| Campo | Tipo | Descrição |
|-------|------|-----------|
| `amazon_account_id` | string | ID da conta |
| `date` | date | Data do registro |
| `campaign_id` | string | ID da campanha |
| `campaign_name` | string | Nome da campanha |
| `ad_group_id` | string | ID do grupo |
| `keyword_id` | string | ID da keyword |
| `keyword_text` | string | Texto da keyword |
| `search_term` | string | Termo pesquisado |
| `match_type` | enum | `exact`, `phrase`, `broad`, `auto` |
| `advertised_asin` | string | ASIN do produto |
| `advertised_sku` | string | SKU do produto |
| `report_type` | enum | Origem: `searchTerms`, `campaigns`, `products` |
| `impressions` | number | Impressões |
| `clicks` | number | Cliques |
| `spend` | number | Investimento |
| `orders_1d/7d/14d/30d` | number | Pedidos por janela |
| `sales_1d/7d/14d/30d` | number | Vendas ($) por janela |
| `acos_14d` | number | ACoS 14d |
| `roas_14d` | number | ROAS 14d |
| `unique_key` | string | Chave: `date|campaign|adgroup|keyword|search|asin` |
| `synced_at` | datetime | Data do sync |

---

## 🔄 Fluxo de Execução (Atualizado)

### 1. Request (06:00 e 22:00 BRT)
```
1. Renova token OAuth
2. Solicita 3 relatórios (searchTerms, campaigns, products)
3. Guarda reportIds no SyncRun
```

### 2. Download (06:15 e 22:15 BRT)
```
1. Verifica status dos relatórios
2. ⚠️ LIMPA DADOS ANTIGOS (últimos 30 dias)
   - SearchTerm
   - AdsReportRaw
   - AdsMetricsHistory
   - CampaignMetricsDaily (por date range)
3. Baixa e descomprime relatórios
4. Salva raw data → AdsReportRaw
5. Salva histórico → AdsMetricsHistory
6. Atualiza entidades operacionais:
   - SearchTerm
   - CampaignMetricsDaily
   - Campaign (upsert)
   - Product (upsert)
7. Marca SyncRun como success
```

---

## 🧹 Limpeza Manual (Opcional)

Se precisar limpar dados manualmente antes de um sync:

```javascript
// No console do navegador ou backend
const result = await base44.functions.invoke('cleanupAllAdsData', {
  amazon_account_id: 'xxx' // opcional
});
console.log(result.data);
```

**Entidades limpas:**
- SearchTerm
- AdsReportRaw
- AdsMetricsHistory
- CampaignMetricsDaily
- Campaign
- Product
- Keyword

---

## 📈 Vantagens da Nova Abordagem

| Vantagem | Descrição |
|----------|-----------|
| **Sem duplicação** | Delete + insert garante dados únicos |
| **Raw data preservada** | Auditoria completa possível |
| **Histórico rico** | IA pode analisar padrões temporais |
| **Spend correto** | Não soma entre relatórios |
| **Atualização limpa** | Dados corrigidos pela Amazon são refletidos |
| **Consultas futuras** | Dados brutos disponíveis para análise ad-hoc |

---

## 🔍 Exemplo de Consultas

### Total spend por dia (últimos 7 dias)
```javascript
const spend = await base44.entities.AdsMetricsHistory.filter({
  amazon_account_id: 'xxx',
  date: { $gte: '2024-01-08' }
});

const byDate = spend.reduce((acc, r) => {
  acc[r.date] = (acc[r.date] || 0) + r.spend;
  return acc;
}, {});
```

### Top search terms por vendas
```javascript
const terms = await base44.entities.SearchTerm.filter({
  amazon_account_id: 'xxx',
  sales_14d: { $gt: 0 }
}, '-sales_14d', 50);
```

### Raw data de um relatório específico
```javascript
const raw = await base44.entities.AdsReportRaw.filter({
  amazon_account_id: 'xxx',
  report_type: 'searchTerms',
  report_date: '2024-01-14'
}, '-synced_at', 100);
```

---

## ⚙️ Configuração das Automações

| Automação | Horário BRT | Cron UTC | Ação |
|-----------|-------------|----------|------|
| `Amazon Ads Reports - 06:00 BRT` | 06:00 | `0 9 * * *` | Request |
| `Amazon Ads Download - 06:15 BRT` | 06:15 | `15 9 * * *` | Download + Limpeza + Import |
| `Amazon Ads Reports - 22:00 BRT` | 22:00 | `0 1 * * *` | Request |
| `Amazon Ads Download - 22:15 BRT` | 22:15 | `15 1 * * *` | Download + Limpeza + Import |

---

## 📝 Logs Esperados

```
[scheduledAdsReportSync] 3 relatórios solicitados
✓ searchTerms: 15000 linhas
✓ campaigns: 500 linhas
✓ products: 2000 linhas
[clearLast30Days] Limpando dados de 2024-05-31 a 2024-06-29
[clearLast30Days] Dados limpos
✓ AdsReportRaw: 17500 registos
✓ AdsMetricsHistory: 17500 registos
✓ SearchTerm: 15000 registos
✓ CampaignMetricsDaily: 450 registos
✓ Campaign: 45 atualizadas
✓ Product: 123 atualizados
[scheduledAdsReportSync] ✅ CONCLUÍDO em 12.3s
```

---

## 🚀 Próximos Passos

1. **Execute limpeza manual** (opcional, se já há dados):
   ```js
   await base44.functions.invoke('cleanupAllAdsData');
   ```

2. **Aguarde próxima automação** (06:00 ou 22:00) ou execute manual:
   ```js
   const req = await base44.functions.invoke('scheduledAdsReportSync', { action: 'request' });
   // Aguarde 15 min
   const dl = await base44.functions.invoke('scheduledAdsReportSync', { 
     action: 'download',
     reportIds: req.data.reportIds,
     syncRunId: req.data.syncRunId 
   });
   ```

3. **Valide dados**:
   ```js
   const count = await base44.entities.AdsMetricsHistory.list();
   console.log(`Total: ${count.length} registros`);
   ```

---

## 📊 Espaço em Disco Estimado

- **AdsReportRaw**: ~500KB por 1000 linhas × 30 dias × 3 relatórios = ~45MB/mês
- **AdsMetricsHistory**: ~200KB por 1000 linhas × 30 dias = ~6MB/mês
- **SearchTerm**: ~100KB por 1000 linhas × 30 dias = ~3MB/mês

**Total estimado**: ~54MB/mês para conta média (10k linhas/dia)

---

## 🔒 Segurança

- Dados armazenados por 30 dias (rolling)
- Raw data pode ser apagada após 90 dias se necessário
- Use `cleanupSyncLogs` para manutenção periódica

---

**Implementado**: 2024-06-30  
**Versão**: 2.0 (com limpeza e raw data)