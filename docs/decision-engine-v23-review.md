# Referência econômica e motor v23 — 07/10/2026

Fonte: valores enviados pelo usuário nesta conversa. Período não informado. Não são respostas atuais das APIs. Preços médios arredondados podem diferir do faturamento dividido pelas unidades. Os dez produtos não representam todo o catálogo.

Custo unitário é CMV; lucro antes de Ads já informado pelo usuário preserva tarifas e demais custos implícitos. Não recalcular lucro apenas como preço menos CMV. O teto indicativo usa 80% da margem antes de Ads, limitado à meta de conta de 15%; é uma proposta de reserva de lucro. O motor usa economia atual da API e custos confirmados, não estes preços históricos.

| SKU | Produto | CMV/un. R$ | Preço médio R$ | Un. | Faturamento R$ | Lucro antes Ads R$ | Ads R$ | Lucro pós Ads R$ | Lucro antes Ads/un. R$ | Meta ACoS indicativa |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| FBA-0087b | Lixeira preta 13L | 40,95 | 78,40 | 54 | 4.233,69 | 836,33 | 275,31 | 561,02 | 15,49 | 15,00% |
| FBA-0010b | Lixeira branca 18L | 57,55 | 90,82 | 26 | 2.361,40 | 221,58 | 26,27 | 195,31 | 8,52 | 7,51% |
| FBA-0076A | Interruptor 1 botão | 40,00 | 71,90 | 23 | 1.653,70 | 244,78 | 83,91 | 160,87 | 10,64 | 11,84% |
| SKU-002314V | Headset vermelho | 45,00 | 79,90 | 15 | 1.198,50 | 140,85 | 279,77 | -138,92 | 9,39 | 9,40% |
| FBA-0087 | Lixeira branca 13L | 40,95 | 72,90 | 14 | 1.020,60 | 186,35 | 8,39 | 177,96 | 13,31 | 14,61% |
| FBA-0008P | Moedor preto | 40,00 | 69,90 | 14 | 978,60 | 122,35 | 408,58 | -286,23 | 8,74 | 10,00% |
| FBA-0010 | Lixeira premium 15L | 54,60 | 85,90 | 9 | 773,10 | 66,52 | 1,37 | 65,15 | 7,39 | 6,88% |
| FBA-0024b | Ventilador E27 | 38,50 | 51,57 | 12 | 618,80 | -48,80 | 0,71 | -49,51 | -4,07 | 0,00% |
| FBA-0071 | Lixeira cinza 15L | 52,50 | 86,90 | 5 | 434,50 | 51,20 | 5,37 | 45,83 | 10,24 | 9,43% |
| SKU-002314A | Headset azul | 45,00 | 79,90 | 4 | 319,60 | 38,08 | 62,03 | -23,95 | 9,52 | 9,53% |

Ads/faturamento total é TACoS aproximado, não ACoS de campanha. Não converter os gastos agregados em orçamento diário sem conhecer as datas, nem estimar CPC sem cliques e conversão.

## Ações por produto e campanha

- FBA-0087b e FBA-0087: preservar termos com lucro confirmado; expansão gradual apenas se FBA disponível, oferta comprável, custo confirmado e margem atual. Investimento baixo não comprova falta de orçamento.
- FBA-0010b, FBA-0010 e FBA-0071: margem estreita exige CPC menor; respeitar pausas manuais. Não aplicar uma meta genérica de 15% acima da margem.
- FBA-0076A: manter vencedores e testar consultas específicas de 1 botão/sem neutro, após confirmar características reais da oferta.
- SKU-002314V, SKU-002314A e FBA-0008P: priorizar contenção de termos deficitários, preservar termos lucrativos, calcular CPC pela margem e conversão observadas. Dados agregados não identificam a campanha ou palavra culpada.
- FBA-0024b: prejuízo anterior aos Ads exige revisão de CMV, tarifas e preço. Não escalar publicidade enquanto a economia confirmada for não positiva.
- FBA-0122: novo produto; descobrir por FBA disponível e oferta. Solicitar custo antes do kickoff; não inventar custo, conversão ou palavras vencedoras.

## Termos para pesquisa, ainda não vencedores

Lixeiras: lixeira automática com sensor 13 litros; lixeira automática 18 litros; lixeira sensor 15 litros. Interruptor: interruptor wifi 1 tecla sem neutro. Headsets: headset gamer usb com microfone. Moedor: moedor café elétrico recarregável. Microfone: microfone condensador usb com braço articulado. Confirmar aderência ao produto e métricas antes de ativar; termos genéricos ou incompatíveis não recebem expansão automática.

## Implementação v23

- Um orquestrador canônico existente; não acrescentar gateways ou microsserviços para este caso.
- Estoque = Disponível FBA (`inventoryDetails.fulfillableQuantity`); total/reservado/a caminho não são saldo vendável. FBA ausente é desconhecido.
- Meta econômica nunca supera 80% do ACoS de equilíbrio confirmado. Economia completa com lucro antes de Ads não positivo recebe meta zero.
- CPC explícito é limitado pela economia e conversão observadas; arredondar para baixo.
- Promoções EXACT mantêm atribuição ao mesmo SKU e deduplicação existentes; simulação mostra candidatos, gasto, vendas e bid proposto.
- Dayparting existente usa evidência horária; não inventar horários vencedores a partir de totais por SKU.
- Manter executor, idempotência, auditoria e confirmação Amazon existentes. Reutilizar catálogo, relatórios e funções; não duplicar campanhas apenas para cumprir contagem.

Referências: [FBA Inventory API](https://developer-docs.amazon/sp-api/docs/fba-inventory-api), [segmentação Sponsored Products](https://advertising.amazon.com/en-us/library/guides/targeting-with-sponsored-products/), [regras de lance por horário](https://advertising.amazon.com/en-us/resources/whats-new/schedule-based-bid-rules-available-for-sponsored-products/).
