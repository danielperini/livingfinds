# Motor de repricing por SKU

## Escopo canônico

A unidade de decisão é `amazon_account_id + marketplace_id + seller_id + SKU + ASIN-filho`.

O motor nunca usa o ASIN-pai, o título ou outra variação como substituto do SKU. Cor, tamanho, capacidade, canal de fulfillment e qualquer outra variação permanecem isolados. Um SKU duplicado, sem ASIN-filho ou sem vínculo econômico inequívoco é bloqueado.

## APIs Amazon utilizadas

Leitura:

- Listings Items API `getListingsItem`: preço atual, product type, status BUYABLE, issues e fulfillment.
- Product Pricing API `getListingOffers`: oferta própria, Featured Offer, concorrentes, FBA/FBM/Prime e reputação disponível.
- Product Pricing API `getCompetitiveSummary`: Featured Buying Options e preços de referência.
- Product Pricing API `getFeaturedOfferExpectedPriceBatch`: FOEP por SKU.

Escrita:

- Listings Items API `patchListingsItem` em `/attributes/purchasable_offer`.
- Toda alteração passa primeiro por `mode=VALIDATION_PREVIEW`.
- O preço local só é atualizado depois de nova leitura confirmar o valor na Amazon.

## Entradas determinísticas

- custo unitário e custos variáveis do `ProductEconomics` exato do SKU;
- comissão/tarifas Amazon;
- ACoS de equilíbrio e ACoS-alvo;
- gasto, vendas e pedidos de Ads vinculados ao Product Ad do SKU;
- vendas SP-API do mesmo SKU;
- estoque vendável, cobertura e velocidade do mesmo SKU;
- preço atual confirmado na Amazon;
- Featured Offer, concorrente mais baixo, FOEP e preços de referência;
- limites de alteração, cooldown e quantidade máxima de mudanças diárias.

## Confiança mínima

A execução automática exige confiança de evidência `>= 0,90`. Isso não significa garantia de ganhar a Featured Offer. A Amazon também considera disponibilidade, fulfillment, entrega e experiência do vendedor.

Pesos:

- SKU inequívoco: 15%;
- listing atual e BUYABLE: 15%;
- economia acionável: 20%;
- estoque atual: 10%;
- vendas e Ads atuais: 10%;
- dados competitivos: 10%;
- FOEP: 5%;
- pré-validação Amazon aceita: 10%;
- ausência de anomalias: 5%.

## Piso econômico

O piso protege simultaneamente:

- custos variáveis;
- comissão Amazon;
- lucro mínimo em reais e percentual;
- verba compatível com ACoS-alvo;
- buffer de segurança.

Nenhum alvo competitivo pode ultrapassar o piso para baixo.

## Política de decisão

- ACoS acima da meta: nunca reduzir preço.
- lucro pós-Ads negativo: nunca reduzir preço.
- estoque baixo: nunca reduzir preço.
- estoque excessivo: redução controlada, respeitando piso.
- Featured Offer própria: elevar apenas quando houver espaço competitivo seguro.
- Featured Offer perdida: usar FOEP; sem FOEP, usar Featured Offer ou concorrente elegível.
- mudança por ciclo: queda máxima padrão de 3% e aumento máximo de 5%.
- variação acumulada diária: máximo padrão de 8%.
- cooldown padrão: 6 horas.
- máximo padrão: 4 repricings por SKU/dia.

## Idempotência e autorreparo

A chave inclui conta, SKU, preço anterior, preço proposto e hora. Respostas 409 são tratadas por confirmação do estado, sem criar uma segunda ação. Respostas 429, 504 e 524 permanecem pendentes para confirmação posterior. Decisões não confirmadas não alteram o preço persistido no app.

## Pré-requisitos de produção

- aplicação SP-API com roles `Pricing` e `Product Listing`;
- seller e marketplace corretos na `AmazonAccount`;
- LWA refresh token válido;
- custos e economia por SKU atualizados;
- sincronizações de Ads, vendas e estoque dentro das janelas de freshness;
- publicação da branch no Base44.
