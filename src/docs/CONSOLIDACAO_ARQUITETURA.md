# Consolidação da Arquitetura LivingFinds — Amazon Ads

## Resumo da Implementação

Esta documentação consolida toda a integração com Amazon Ads API e SP-API em uma arquitetura única, econômica, segura e sem funções duplicadas.

## Funções Criadas/Consolidadas

### 1. runDailyAmazonDataSync
**Quando**: 06:00 BRT (09:00 UTC)  
**O quê**: Sincronização completa de dados Amazon Ads

**Responsabilidades**:
- Validar contexto (profileId, marketplaceId, currencyCode)
- Verificar se sync do dia já foi concluído
- Importar campanhas via API v3
- Solicitar 8 relatórios essenciais (30 dias)
- Aguardar processamento Amazon (polling)
- Baixar e descompactar relatórios
- Salvar dados brutos (AdsReportRaw)
- Normalizar e upsert (CampaignMetricsDaily, Campaign, Product, Keyword)
- Recalcular KPIs
- Identificar alertas e oportunidades

**Retenção**: 180 dias de histórico para IA

### 2. runDailyAmazonActionQueue ✨ NOVA
**Quando**: 00:00 BRT (03:00 UTC)  
**O quê**: Processa fila de ações pendentes

**Responsabilidades**:
- Buscar ações AgentAction/OptimizationDecision pendentes
- Ordenar por dependência (criar → atualizar → pausar)
- Processar sequencialmente (não paralelo)
- Respeitar rate limits e HTTP 429 Retry-After
- Tratar HTTP 207 item a item
- Atualizar status (EXECUTED | FAILED)
- Registrar histórico e amazon_response

**Ordem de Execução**:
1. Criar campanhas (AUTO/MANUAL)
2. Criar ad groups
3. Criar anúncios (product ads)
4. Criar keywords e product targets
5. Criar negative keywords
6. Atualizar bids
7. Atualizar budgets
8. Pausar/ativar campanhas

### 3. runDailyAIAdsAnalysis
**Quando**: 01:00 BRT (04:00 UTC)  
**O quê**: Análise IA consolidada

**Responsabilidades**:
- Carregar dados completos (180 dias)
- Calcular tendências e métricas
- Aplicar regras determinísticas
- Filtrar casos irrelevantes
- Montar resumo consolidado
- Chamar IA (1x/conta/dia)
- Gerar decisões (AdsAiDecision)
- Salvar com analysisHash (evita re-análise)

**IA Econômica**:
- NÃO calcula métricas (código faz isso)
- NÃO processa arquivos
- NÃO valida conta
- Recebe APENAS oportunidades e riscos identificados

## Entidades Consolidadas

### AmazonAccount
```json
{
  "amazon_account_id": "...",
  "seller_id": "...",
  "marketplace_id": "A2Q3Y263D00KWC",
  "ads_profile_id": "...",
  "ads_refresh_token": "...",
  "country_code": "BR",
  "currency_code": "BRL",
  "currency_symbol": "R$",
  "locale": "pt-BR"
}
```

### CampaignMetricsDaily
- Histórico diário por campanha
- Preservar 180 dias
- Fonte única para dashboards e IA

### AgentAction / OptimizationDecision
- Fila de alterações pendentes
- Status: `PENDING → APPROVED → EXECUTED | FAILED`
- `amazon_response`, `executed_at`, `request_id`

### SyncExecutionLog
- Log de cada execução
- `execution_date`, `duration_ms`, `records_processed`
- Limite: 6 syncs automáticos/dia

## Relatórios Essenciais (8 tipos)

1. `spCampaigns` - Campanhas (DAILY + SUMMARY)
2. `spAdGroups` - Grupos de anúncios
3. `spProductAds` - Produtos anunciados
4. `spKeywords` - Keywords manuais
5. `spSearchTerms` - Termos de pesquisa
6. `spTargeting` - Product targets
7. `spNegativeKeywords` - Keywords negativas
8. `spAdvertisedProduct` - Produtos por ASIN

## Regras Determinísticas

### Reduzir Bid
```
clicks >= 10 AND spend >= 5 AND orders = 0
```

### Negativar Keyword
```
clicks >= 15 AND spend >= 5 AND sales = 0
```

### Keyword Vencedora
```
orders >= 2 AND ACoS <= target AND conversion >= 5%
```

### Pausar por Estoque
```
inventory_status = 'out_of_stock' OR fba_inventory = 0
```

### Aumentar Bid
```
ROAS >= target AND ACoS <= target * 0.7
AND clicks >= 10 AND hasStock AND budget_available
```

## Fluxo Completo

```
00:00 BRT → runDailyAmazonActionQueue
  ↓ Processa fila de ações pendentes
  ↓ Executa na Amazon (sequencial)
  ↓ Atualiza histórico

06:00 BRT → runDailyAmazonDataSync
  ↓ Importa campanhas e relatórios
  ↓ Processa e normaliza dados
  ↓ Atualiza dashboards

01:00 BRT → runDailyAIAdsAnalysis
  ↓ Analisa dados (180 dias)
  ↓ Aplica regras
  ↓ Gera decisões IA
  ↓ Adiciona à fila

UI (qualquer horário)
  ↓ Lê dados do banco (não chama Amazon)
  ↓ Exibe dashboards
  ↓ Cria ações → fila
```

## Validação de Contexto

**Obrigatório em todos os registros**:
- `amazon_account_id`
- `profile_id`
- `marketplace_id`
- `country_code`
- `currency_code`

**Bloquear ações quando**:
- Moeda divergente (não usar USD para BR)
- Perfil divergente
- Marketplace divergente
- Relatório desatualizado (>7 dias)
- Entidade alterada após recomendação
- Decisão expirada (>7 dias)
- Estoque insuficiente

## Rate Limits e Economia

### Limites Amazon Ads
- 31 dias máximo por relatório
- Rate limiting por perfil
- HTTP 429 com `Retry-After`

### Estratégias Implementadas
- Processamento sequencial (não paralelo)
- Lotes pequenos (50-100 registros)
- Cache de token (24h)
- Backoff exponencial em erros
- Idempotência por `actionHash`
- Retry com limite de tentativas

## Critérios de Aceite

- ✅ Relatórios importados 1x/dia
- ✅ Primeiro sync: 30 dias
- ✅ Syncs seguintes: incrementais
- ✅ Dashboards usam banco local
- ✅ Dados vinculados ao perfil correto
- ✅ Conta BR usa exclusivamente BRL
- ✅ IA chamada apenas com dados consolidados
- ✅ Análises idênticas não consomem novos tokens
- ✅ Toda alteração na Amazon entra em fila
- ✅ Fila inicia às 00:00 BRT
- ✅ Ações executadas em sequência
- ✅ Dependências respeitadas
- ✅ Rate limits e Retry-After respeitados
- ✅ HTTP 207 tratado por item
- ✅ Campanhas duplicadas não recriadas
- ✅ Kick-off continua se AUTO já existir
- ✅ Nenhuma ação no perfil errado
- ✅ Falhas não apagam dados anteriores
- ✅ Todas as ações possuem histórico
- ✅ Resultados posteriores são medidos

## Próximos Passos

1. **Testes em Produção**
   - Monitorar execuções da fila
   - Validar rate limits
   - Ajustar timeouts

2. **Otimizações Futuras**
   - Implementar rollback automático
   - Adicionar alertas de falha
   - Dashboard de fila de ações

3. **Documentação**
   - Manuais de operação
   - Runbooks de troubleshooting
   - SLA de processamento

## Referências

- `ARQUITETURA_INTEGRACAO.md` - Visão geral completa
- `CURRENCY_STANDARD.md` - Padrão de moeda BRL
- `BOOST_24H_RULES.md` - Regra de boost 24h
- `README_AUTOMACAO_AMAZON_ADS.md` - Automação Ads