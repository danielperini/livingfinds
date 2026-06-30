# Regra de Boost de Campanhas Novas (24h)

## Visão Geral
Implementada regra automática de ajuste de bids para campanhas novas nas primeiras 24 horas.

## Regra Implementada

**Condição:** Campanha nova (< 24h da criação) + SEM impressões + SEM gasto

**Ação:** Aumentar bid em:
- **R$ 0.10** OU
- **5% do bid atual**

**O que for MAIOR** entre os dois valores.

## Exemplos

| Bid Atual | 5% do Bid | Mínimo R$0.10 | Aumento Aplicado | Novo Bid |
|-----------|-----------|---------------|------------------|----------|
| R$ 0.25   | R$ 0.01   | R$ 0.10       | **R$ 0.10**      | R$ 0.35  |
| R$ 0.50   | R$ 0.03   | R$ 0.10       | **R$ 0.10**      | R$ 0.60  |
| R$ 1.00   | R$ 0.05   | R$ 0.10       | **R$ 0.10**      | R$ 1.10  |
| R$ 2.00   | R$ 0.10   | R$ 0.10       | **R$ 0.10**      | R$ 2.10  |
| R$ 3.00   | R$ 0.15   | R$ 0.10       | **R$ 0.15**      | R$ 3.15  |
| R$ 5.00   | R$ 0.25   | R$ 0.10       | **R$ 0.25**      | R$ 5.25  |

## Após 24 Horas

Após as primeiras 24h, a campanha segue as **regras normais de otimização**:
- Ajustes diários de bid conforme performance (ACoS, ROAS, vendas)
- Análise de search terms para negativação ou promoção
- Revisão de budget e pacing

## Funções Backend

### 1. `boostNewCampaigns24h`
- Executa o boost de bids em campanhas elegíveis
- Atualiza bids diretamente na Amazon Ads API (endpoint `/sp/keywords`)
- Registra logs em `CampaignCreationLog`
- Processa todas as contas Amazon conectadas

### 2. `optimizeKeywordBidsDaily` (existente)
- Continua executando ajustes diários normais
- Regras: sem impressões (+R$0.10), ACoS alto (-R$0.10), performance (+R$0.05)
- Respeita intervalo de 24h entre alterações

## Automação

**Nome:** `Boost Bids - Campanhas Novas 24h`

**Agendamento:** Diário às **07:00 BRT (10:00 UTC)**

**Cron:** `0 10 * * *`

**Função:** `boostNewCampaigns24h`

## Entidades Atualizadas

### Campaign
- Adicionado campo `created_at` (date-time)
- Usado para calcular idade da campanha (< 24h)

### CampaignCreationLog
- Registra todas as alterações de bid
- Campos: `old_bid`, `new_bid`, `rationale`, `rule_applied`
- `rule_applied`: `new_campaign_24h_boost`

## Fluxo de Execução

1. **07:00 BRT** - Automação dispara `boostNewCampaigns24h`
2. Função carrega todas as contas Amazon conectadas
3. Para cada conta:
   - Busca campanhas criadas nas últimas 24h (`created_at > now - 24h`)
   - Verifica se têm `impressions == 0` E `spend == 0`
   - Para cada keyword da campanha:
     - Calcula aumento (R$0.10 ou 5%)
     - Atualiza bid na Amazon Ads API
     - Atualiza banco local
     - Registra log da alteração
4. Retorna resumo da execução

## Logs e Auditoria

Todas as alterações ficam registradas em `CampaignCreationLog`:
```json
{
  "operation_type": "update_bid",
  "entity_type": "keyword",
  "keyword_id": "...",
  "old_bid": 0.25,
  "new_bid": 0.35,
  "rationale": "Campanha nova (<24h) sem impressões/gasto. Boost: R$0.10 (5.0%)",
  "rule_applied": "new_campaign_24h_boost",
  "status": "success",
  "amazon_response": "...",
  "request_id": "..."
}
```

## Integração com Outras Regras

Esta regra **não substitui** as otimizações existentes:

| Horário | Função | Finalidade |
|---------|--------|------------|
| 07:00 BRT | `boostNewCampaigns24h` | Boost inicial (24h) |
| 06:00 BRT | `optimizeKeywordBidsDaily` | Ajustes diários normais |
| 10:00 BRT | `monitorSearchTerms` | Análise de search terms |
| 01:00 BRT | `runDailyAIAdsAnalysis` | Análise completa com IA |

## Critérios de Elegibilidade

✅ **Elegível para boost:**
- Campanha criada há menos de 24 horas
- Zero impressões
- Zero gasto
- Criada pelo app (`created_by_app: true`)

❌ **Não elegível:**
- Campanha com > 24h de vida
- Já teve impressões (mesmo que poucas)
- Já teve gasto (mesmo que mínimo)
- Campanhas não criadas pelo app

## Monitoramento

Para verificar execuções:
1. Acesse Dashboard → Logs
2. Filtre por `rule_applied = new_campaign_24h_boost`
3. Verifique keywords com `old_bid ≠ new_bid`

## Próximos Passos

Após o boost de 24h, a campanha entra no fluxo normal:
- **Dia 2-7:** Ajustes diários conforme performance
- **Dia 7+:** Otimização completa com IA (180 dias de dados)
- **Search terms:** Análise diária para negativação e promoção