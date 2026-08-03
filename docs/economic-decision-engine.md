# Motor econômico por produto

## Escopo

O motor usa somente dados persistidos a partir da Amazon Ads API, Amazon SP-API e custos reais informados no LivingFinds. Não cria métricas, custos, termos ou resultados artificiais.

Fluxo canônico: `Amazon APIs -> funções Base44 -> entidades -> snapshot econômico -> regras determinísticas -> fila idempotente -> execução Amazon -> confirmação -> auditoria`.

## Estruturas reutilizadas

- `ProductEconomics`: economia corrente e custos reais confirmados.
- `RepricingSnapshot`: snapshot econômico imutável por SKU e hora.
- `Product`: estado atual da jornada e última transição.
- `SearchTerm` e `TermBank`: termos reais e atribuição mesmo SKU/halo.
- `SearchTermPromotion`: saga AUTO para MANUAL EXACT e negativa de origem.
- `OptimizationDecision`: decisão, evidência, snapshot e confirmação.
- `AmazonActionQueue`: fila idempotente, retries e confirmação.
- `AmazonApiRequestLog`: endpoint, status, request ID, tentativa e erro Amazon.

Não foi criado backend paralelo. `runEconomicProductJourney` consolida elegibilidade e estado; criação, reparo, colheita e execução continuam delegadas aos executores Amazon existentes.

## Snapshot econômico

Cada captura registra fontes, validade e versão. Um snapshot anterior nunca é sobrescrito.

```text
margin_before_ads = sale_price - soma(custos variáveis)
margin_rate = margin_before_ads / sale_price
break_even_acos = margin_before_ads / sale_price
target_acos = break_even_acos * safety_factor
allowable_ad_spend_per_order = sale_price * target_acos
max_sustainable_cpc = conversion_rate * allowable_ad_spend_per_order
```

Custo ausente/não confirmado, preço não positivo, taxas vencidas, estoque desconhecido, vendas vencidas ou margem não positiva tornam o snapshot não acionável. Isso bloqueia criação e aumento de investimento.

## Estados

`NOT_ELIGIBLE`, `ECONOMICS_PENDING`, `READY_FOR_DISCOVERY`, `DISCOVERY_AUTO`, `LEARNING`, `HARVEST_PENDING`, `MANUAL_CREATION_PENDING`, `MANUAL_VALIDATION`, `ACTIVE_OPTIMIZATION`, `LOW_VOLUME_GUARDED`, `PROTECTED_WINNER`, `OUT_OF_STOCK`, `COOLDOWN`, `ARCHIVED`, `ERROR_RETRYABLE` e `ERROR_BLOCKED`.

Cada transição registra estado anterior, novo estado, motivo, snapshot, função, instante e próxima avaliação. Estoque zero prevalece sobre criação. Retorno do estoque volta à elegibilidade sem alterar as chaves idempotentes.

## Descoberta e colheita

A campanha AUTO permanece como descoberta. Somente venda confirmada do mesmo SKU/ASIN, com economia acionável e bid dentro do CPC sustentável, pode entrar na promoção. Venda exclusivamente halo é rejeitada.

A chave canônica da campanha manual é `account_id|profile_id|marketplace_id|asin|normalized_term|EXACT`.

A forma original do termo é preservada. O executor cria uma campanha por termo, um Ad Group, um Product Ad e uma keyword EXACT. A negativa EXACT na AUTO ocorre apenas depois da validação da manual; falhas ficam em `repair_required`.

## Baixo volume e bids

Os limites de baixo volume são configuráveis em `FeatureFlag.config`. Produtos classificados como `LOW_VOLUME_GUARDED` usam intervalo de 72 horas. Nenhum aumento pode ultrapassar 20% por ciclo ou `max_sustainable_cpc`. ACoS zero sem venda não é vencedor.

## Retries, confirmação e repricing

`amazonApiGatewayCore` respeita `Retry-After` para 429 e aplica backoff. `amazonAdsCommand` trata OAuth, 409, 429, 500/502/503 e timeout 504/524. Timeouts não autorizam recriação cega.

Toda ação só deve ser concluída após leitura de confirmação na Amazon. Estados locais não são prova de ativação.

Scraping de páginas públicas foi removido do caminho decisório. A concorrência que pode autorizar alteração de preço vem somente da Amazon Product Pricing API. Em 429, a conexão fica degradada e o motor não usa concorrência vencida.

## Rollout seguro

Por padrão, a jornada calcula, persiste snapshots e atualiza estados, mas não cria recursos Amazon. Para ativar uma conta:

1. Confirmar OAuth Ads e SP-API, seller, profile e marketplace.
2. Confirmar custos por SKU, preço, taxas, estoque e vendas atualizados.
3. Criar `FeatureFlag`:

```json
{
  "key": "economic_product_journey_v1",
  "amazon_account_id": "ACCOUNT_ID",
  "enabled": true,
  "environment": "prod",
  "scope": "account",
  "config": {
    "max_actions_per_cycle": 5,
    "max_promotions_per_cycle": 5,
    "target_acos_safety_factor": 0.75,
    "low_volume_units_30d": 2,
    "low_volume_units_65d": 4
  }
}
```

4. Executar `runEconomicProductJourney` com `dry_run: true` e revisar estados/bloqueios.
5. Executar com `execute: true`, começando com uma conta e até cinco ações.
6. Conferir IDs e estados diretamente na Amazon antes de ampliar o limite.

## Sobreposições auditadas

O repositório contém múltiplas gerações de kickoff, bid optimizer, criação manual, pipelines e filas. Elas foram preservadas para não apagar histórico nem quebrar rotas. A entrada recomendada é `runUnifiedDecisionEngine`; novas evoluções devem delegar a ela.

## Troubleshooting

- `ECONOMICS_PENDING`: conferir custo confirmado, preço SP-API, taxas e vendas recentes.
- `ERROR_RETRYABLE`: estoque desconhecido ou sincronização vencida.
- `OUT_OF_STOCK`: nenhuma criação ou aumento permitido; histórico permanece.
- `repair_required`: consultar IDs existentes na Amazon e retomar do último recurso confirmado.
- HTTP 429: aguardar `Retry-After`; não zerar métricas nem recriar recursos.
- HTTP 504/524: consultar existência antes de repetir criação.
