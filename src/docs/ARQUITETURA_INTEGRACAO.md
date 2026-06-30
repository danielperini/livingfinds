# Arquitetura LivingFinds — Amazon Ads Integration v2

## Visão Geral

```
Amazon APIs (Ads + SP-API)
  ↓
runDailyAmazonDataSync (06:00 BRT)
  ↓
Banco de Dados Local
  ↓
Cálculos de Métricas (código)
  ↓
Regras Determinísticas
  ↓
IA Consolidada (1x/dia/conta)
  ↓
Fila de Ações (AgentAction/OptimizationDecision)
  ↓
runDailyAmazonActionQueue (00:00 BRT)
  ↓
Amazon Ads API (execução sequencial)
```

## Princípios

### 1. Sincronização Única Diária
- **Quando**: 06:00 BRT (09:00 UTC)
- **O quê**: Todos os relatórios necessários de uma vez
- **Janela**: Últimos 30 dias (limite Amazon)
- **Retenção**: 180 dias para IA e histórico

### 2. Dados como Fonte da Verdade
- Dashboards leem APENAS o banco sincronizado
- Nunca solicitar relatórios ao abrir páginas
- Upsert com deduplicação por chaves únicas
- Preservar histórico bruto (Raw) para auditoria

### 3. IA Econômica
- NÃO usar IA para:
  - Calcular métricas (ACoS, ROAS, CPC, etc.)
  - Importar/processar arquivos
  - Validar conta ou perfil
  - Formatarm oeda
- IA recebe APENAS:
  - Maiores desperdícios
  - Melhores oportunidades
  - Conflitos identificados pelas regras
- Máximo 1 análise por conta por dia
- Usar `analysisHash` para evitar re-análise de dados idênticos

### 4. Fila de Ações Obrigatória
- TODA alteração na Amazon passa pela fila
- Nenhuma chamada direta da UI para Amazon
- Status: `PENDING → QUEUED → PROCESSING → EXECUTED | FAILED`
- Respeitar dependências: campanha → ad group → anúncio → keyword/target

### 5. Validação de Contexto
Todo registro deve conter:
```json
{
  "amazon_account_id": "...",
  "profile_id": "...",
  "marketplace_id": "A2Q3Y263D00KWC",
  "country_code": "BR",
  "currency_code": "BRL",
  "currency_symbol": "R$"
}
```
Bloquear ações com divergência de perfil, marketplace ou moeda.

## Entidades Principais

### AmazonAccount
- Dados da conta + perfil Ads
- `ads_refresh_token` (permanente)
- `ads_profile_id`
- `marketplace_id`, `country_code`, `currency_code`
- Validação: `profile_validation_status`

### Campaign / AdGroup / Keyword / ProductTarget
- Entidades Ads com métricas
- Chave única: `campaign_id`, `keyword_id`, etc.
- Métricas atualizadas diariamente

### CampaignMetricsDaily
- Histórico diário por campanha
- Preservar 180 dias
- Fonte para dashboards e IA

### AgentAction / OptimizationDecision
- Fila de alterações pendentes
- Status tracking
- `amazon_response`, `executed_at`

### SyncExecutionLog
- Log de cada execução de sync
- `execution_date`, `duration_ms`, `records_processed`
- Limite: 6 syncs automáticos/dia

## Fluxos

### 1. Sync Diário (06:00 BRT)

```
runDailyAmazonDataSync
├─ 1. Validar contexto (profile, marketplace, currency)
├─ 2. Verificar se sync do dia já foi concluído
├─ 3. Importar campanhas (API v3)
├─ 4. Solicitar relatórios (8 tipos essenciais)
├─ 5. Aguardar processamento Amazon
├─ 6. Baixar e descompactar
├─ 7. Salvar dados brutos (AdsReportRaw)
├─ 8. Normalizar e upsert
│   ├─ CampaignMetricsDaily (180d)
│   ├─ Campaign (métricas)
│   ├─ Product (vendas, estoque)
│   └─ Keyword/SearchTerm
├─ 9. Recalcular KPIs
├─ 10. Identificar alertas
└─ 11. Preparar lote para IA
```

### 2. Análise IA (01:00 BRT)

```
runDailyAIAdsAnalysis
├─ 1. Carregar dados (180 dias)
├─ 2. Calcular tendências
├─ 3. Aplicar regras determinísticas
│   ├─ Gasto sem vendas → reduzir bid
│   ├─ ACoS alto → reduzir budget
│   ├─ Sem estoque → pausar
│   └─ ROAS bom + estoque → aumentar
├─ 4. Filtrar casos irrelevantes
├─ 5. Montar resumo consolidado
├─ 6. Chamar IA (1x/conta)
├─ 7. Gerar decisões (AdsAiDecision)
└─ 8. Salvar com analysisHash
```

### 3. Fila de Ações (00:00 BRT)

```
runDailyAmazonActionQueue
├─ 1. Validar conta e perfil
├─ 2. Ordenar por dependência
│   ├─ Criar campanhas
│   ├─ Criar ad groups
│   ├─ Criar anúncios
│   ├─ Criar keywords/targets
│   ├─ Criar negativas
│   ├─ Atualizar bids
│   ├─ Atualizar budgets
│   ├─ Atualizar placements
│   └─ Pausar/ativar
├─ 3. Processar sequencialmente
│   ├─ Respeitar rate limits
│   ├─ Retry com backoff
│   ├─ HTTP 429 → aguardar Retry-After
│   └─ HTTP 207 → tratar item a item
├─ 4. Confirmar resultados
├─ 5. Atualizar histórico
└─ 6. Log de execução
```

## Relatórios Essenciais

### Amazon Ads (8 tipos)
1. `spCampaigns` - Campanhas (DAILY + SUMMARY)
2. `spAdGroups` - Grupos de anúncios
3. `spProductAds` - Produtos anunciados
4. `spKeywords` - Keywords manuais
5. `spSearchTerms` - Termos de pesquisa
6. `spTargeting` - Product targets
7. `spNegativeKeywords` - Keywords negativas
8. `spAdvertisedProduct` - Produtos por ASIN

### SP-API (quando aplicável)
- Vendas e tráfego por ASIN
- Estoque FBA
- Preços e Buy Box
- Eventos financeiros

## Regras Determinísticas (Exemplos)

### Reduzir Bid
```
clicks >= 10
AND spend >= 5
AND orders = 0
```

### Negativar Keyword
```
clicks >= 15
AND spend >= 5
AND sales = 0
```

### Keyword Vencedora
```
orders >= 2
AND ACoS <= target_acos
AND conversion_rate >= 5%
```

### Pausar por Estoque
```
inventory_status = 'out_of_stock'
OR fba_inventory = 0
```

### Aumentar Bid
```
ROAS >= target_roas
AND ACoS <= target_acos * 0.7
AND clicks >= 10
AND hasStock = true
AND budget_available = true
```

## Rate Limits e Economia

### Limites Amazon Ads
- 31 dias máximo por relatório
- Rate limiting por perfil
- HTTP 429 com `Retry-After`

### Estratégias
- Processamento sequencial (não paralelo)
- Lotes pequenos (50-100 registros)
- Cache de token (24h)
- Backoff exponencial em erros
- Idempotência por `actionHash`

## Critérios de Aceite

- [x] Relatórios importados 1x/dia
- [x] Primeiro sync: 30 dias
- [x] Syncs seguintes: incrementais
- [x] Dashboards usam banco local
- [x] Dados vinculados ao perfil correto
- [x] Conta BR usa exclusivamente BRL
- [x] IA chamada apenas com dados consolidados
- [x] Toda alteração entra na fila
- [x] Fila inicia às 00:00 BRT
- [x] Ações executadas em sequência
- [x] Dependências respeitadas
- [x] Rate limits respeitados
- [x] HTTP 207 tratado por item
- [x] Campanhas duplicadas não recriadas
- [x] Kick-off continua se AUTO já existir
- [x] Nenhuma ação no perfil errado
- [x] Todas as ações têm histórico

## Documentação Relacionada

- `CURRENCY_STANDARD.md` - Padrão de moeda BRL
- `BOOST_24H_RULES.md` - Regra de boost 24h
- `README_AUTOMACAO_AMAZON_ADS.md` - Automação Ads