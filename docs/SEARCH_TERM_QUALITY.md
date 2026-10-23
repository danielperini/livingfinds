# Qualidade de termos de busca

O filtro compartilhado está em `base44/shared/searchTermQuality.js`, com entrada TypeScript em `searchTermQuality.ts`. A normalização mantém acentos e hífens, usa NFC, caixa baixa e espaços únicos. A classificação é lexical e determinística, sem LLM e sem chamadas Amazon.

## Fluxos rastreados

- `SearchTerms`, `KeywordManagement` e `TermBankPageV2` consultam as entidades pelo cliente compatível. A API HTTP usa `makeEntities`; as funções usam o mesmo adaptador por meio do import-map Hostinger. O filtro de leitura alcança SearchTerm, Keyword, KeywordSuggestion, NegativeKeywordSuggestion, TermBank e ImportedSearchTermReportRow antes das agregações locais e recomendações. SearchTerms também aplica a regra explicitamente.
- Funções como monitorSearchTerms, mineSearchTermOpportunities, updateTermBankFromAutomaticCampaigns, promoteWinningSearchTerms, runWeeklySearchTermPromotion, runTermBankToCampaigns e os motores recebem apenas registros aceitos nessas leituras. A criação/atualização de sugestões e TermBank rejeita termos inválidos e grava SearchTermQualityAudit. Escritas de dados de origem permanecem permitidas e recebem os campos de auditoria.
- `aggregateSearchTerms` e o agregador de desperdício aplicam a regra também em arrays fornecidos diretamente, antes de somar métricas. Totais financeiros independentes de campanhas não são recalculados pela exclusão de consultas.
- `downloadAndProcessAmazonAdsReportJob` preserva a consulta original, inclusive vazia, e faz o upsert na visão de auditoria. `importSearchTermReport` usa a mesma visão na reimportação para reencontrar linhas excluídas. A importação diária preserva variantes brutas das duplicatas normalizadas e rejeita conflitos de métricas.
- As três páginas não tinham exportador CSV de termos próprio. As consultas padrão agora fornecem dados filtrados aos consumidores/exportadores. O CSV histórico do MotorDecisionFeed também exclui linhas com keyword_text inválido, preservando os registros originais no backend.

## Auditoria e painel

Campos: raw_term, normalized_term, accepted, exclusion_reason, source, campaign_id e amazon_account_id. A consulta explícita `{ search_term_quality_view: 'audit' }` nas entidades de termos retorna também exclusões, sem autorizar decisões. Leituras legadas são classificadas sem reescrever o histórico; os campos ficam persistidos nas próximas escritas. O filtro não executa delete nem migração.

O painel em Dashboard e SearchTerms mostra contagem por observação e motivos. Não são contagens de consultas únicas. A visão inclui dados históricos e importações, e falhas de leitura ficam visíveis.

O contexto assíncrono do registry compartilha contadores entre funções aninhadas, isolando execuções concorrentes. Registra SearchTermQualityCycle quando há exclusões, com o nome da função raiz, conta recebida no payload, data e contagem de IDs examinados. A resposta recebe search_term_quality e term_validation_outcome. Falha ao persistir o resumo é indicada por audit_status=unavailable, preservando o resultado da operação para não induzir replay remoto. A interface distingue ausência de ações de ausência de validação.

## Exemplos

| Excluídos | Preservados |
| --- | --- |
| B0F45JG27L, B0CYNX7FZY, B0GKWZLCVH | lixeira automatica |
| XZ123QW98, sku_123456 | lixeira automatica 13l |
| 12345, 2026, !!!, vazio | banheiro 15 litros |
| a1, bcdfgh | lixeira automática, porta-retrato, ventilador 60w |

## Limites e validação

- Uma heurística não comprova vocabulário nem intenção comercial: palavras inventadas contendo vogais podem passar; siglas, marcas e palavras sem vogais podem ser excluídas. Não há promessa de desempenho publicitário.
- A paginação filtra antes de aplicar offset/limit e atravessa páginas inteiras excluídas. A leitura padrão pode examinar muitas linhas; medir custo em contas grandes antes de adotar materialização/indexação. A visão de auditoria pagina diretamente.
- Deduplicação sequencial de sugestões usa texto normalizado e escopo conta/campanha/adgroup/ASIN/SKU/match type. Não impõe índice único a dados legados nem garante unicidade entre escritores concorrentes. Duplicatas históricas não são apagadas. Observações diárias não são deduplicadas apenas por texto.
- O contador de execução representa os registros examinados na leitura (incluindo a página interna de até 500 linhas), não o número de oportunidades comerciais. Entradas raiz sem amazon_account_id não podem ser atribuídas à conta no painel; isso permanece explícito no registro.
- Não houve migração retroativa, acesso ao banco real, confirmação visual em produção, deploy ou chamada Amazon. Rotinas de retenção/substituição de dados já existentes não foram alteradas por este filtro.
- Build local passou com avisos de configuração Vite ausente, Browserslist antigo e bundle grande. O artefato local não comprova prontidão de produção.

Validação: testes de qualidade/importação/harvest/desperdício e regressões de motor; testes do repositório com SQL simulado e sem permissões de rede/ambiente; testes do contexto concorrente; test:ui-contract e regressões Node do dashboard; deno check com server/deno.json; build Vite; git diff --check. CI remoto deve ser conferido no PR.
