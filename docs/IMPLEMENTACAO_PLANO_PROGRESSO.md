# Living Finds — progresso da implementação

Atualizado em 2026-10-21. Branch de trabalho: `codex/complete-livingfinds-plan`.

## Correção concluída nesta etapa

- A importação manual de termos de pesquisa não apaga mais histórico operacional.
- Linhas sem data diária válida, janela de atribuição explícita ou métricas obrigatórias são recusadas antes da escrita. Relatórios agregados de vários dias são bloqueados nesta tabela diária.
- Vendas, pedidos e unidades são gravados somente na janela declarada (1, 7, 14 ou 30 dias); as outras janelas ficam nulas.
- A gravação é isolada em `ImportedSearchTermReportRow` e identificada por lote. A interface só apresenta lotes concluídos. Falhas deixam lotes ocultos e repetíveis, preservando os lotes anteriormente publicados.
- Reenvio idêntico é idempotente. Retificação cria um novo lote sem sobrescrever ou apagar evidência anterior.
- Dados importados manualmente não são elegíveis para decisões nem para negativação automática. Marketplace e moeda da conta ficam associados às linhas e ao lote.
- O caminho legado `processReportsBatch`, que removia dados da conta antes de persistir o novo lote, agora retorna desativado e direciona ao pipeline canônico de relatórios.

## Evidência local

- Testes Node do normalizador e da persistência de lote: `npm run test:ui-contract` (25 testes, incluindo 7 testes novos da importação).
- ESLint direcionado aos arquivos JavaScript novos: aprovado.
- Build de produção: aprovado, com avisos existentes de configuração Vite e tamanho de chunk.
- `git diff --check`: aprovado.
- Typecheck e lint gerais já falhavam na baseline por erros/avisos preexistentes em outros módulos; a CI também os configura como não bloqueantes.
- Testes Deno/PostgreSQL não foram executados localmente: Deno não conseguiu obter dependências npm do registry neste ambiente e Docker/PostgreSQL local não estão disponíveis.

## Limites e próximos passos do plano geral

Esta alteração é código implementado e validado parcialmente em ambiente local. Não comprova implantação, integração com dados reais, nem execução em produção. Nenhum deploy, migração de produção ou alteração em campanhas Amazon foi feito.

O plano geral de confiabilidade do motor ainda exige concluir e validar as etapas pendentes de ingestão oficial, cálculos/escopo financeiro, regras e simulação do motor, execução/reconciliação, interface operacional e validação integrada. O deploy só deve ocorrer após revisão e aprovação de CI e procedimento de publicação próprio.
