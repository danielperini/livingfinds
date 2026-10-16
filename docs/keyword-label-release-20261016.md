# Release e operação Amazon Ads — 16/10/2026

Código publicado: `0f4cd6fe` (ID/texto) e `74f56a4d` (auditoria do motor).
Release em produção: `74f56a4d610e+keyword-label.20261016`.
Branch: `fix/keyword-id-label`; commits enviados sem force push.

## Deploy

O artefato partiu da imagem e dos arquivos do container em execução. Aplicou os patches de backend e o frontend validado, preservando os demais arquivos e os assets antigos. O diretório privado `.deploy/keyword-label-20261016` guarda a imagem anterior, os snapshots e as configurações necessárias ao rollback. As configurações de runtime não devem ser publicadas nem adicionadas ao Git.

Canário com scheduler/worker desativados: health, banco, 448 funções e assets do frontend aprovados. Antes da troca, a admissão foi pausada e os locks de scheduler/motor foram drenados. A primeira tentativa parou antes da troca por causa de uma execução antiga de 15/10, falha no preflight de estoque e ainda marcada com resultado remoto desconhecido. Após sincronização completa de 679 campanhas na Amazon e verificação de ausência de mutações pendentes, o registro foi reconciliado com trilha de auditoria; a execução antiga não foi reenviada.

A troca seguinte passou no health check. A manutenção foi encerrada. Health final: `ok=true`, `db=true`, 448 funções, scheduler saudável e worker habilitado. Rollback não foi necessário.

## Melhoria validada do motor

A migração estrutural de campanhas podia exceder 180 segundos dentro do ciclo de decisão e impedir as etapas seguintes. O ciclo agora chama uma auditoria local, sem executar a migração ali; o modo `dry_run` também preserva esse comportamento. A migração explícita continua disponível.

Um ciclo intradiário controlado concluiu com `ok=true`, `core_stages_ok=true`, `partial=false` e nenhuma etapa falha. A auditoria local terminou em aproximadamente 0,7 segundo. Esse ciclo não incluiu repricing nem expansões estruturais. O fechamento diário completo não foi reexecutado nesta validação; o histórico do slot diário antigo permanece como histórico de falha.

## Alteração efetiva na Amazon

- Campanha: `16209687146105`, AUTO.
- Produto: ASIN `B0HLMF8PPD`, SKU `FBA-0122`.
- Estado remoto: `PAUSED` → `ENABLED`.
- Orçamento preservado: R$ 5/dia.
- Lances dos grupos preservados e relidos: R$ 0,57 e R$ 0,50.
- Anúncios ativos vinculados ao mesmo SKU/ASIN, estoque FBA de 15 unidades, oferta comprável, custo confirmado, margem positiva e ausência de trava manual.
- Histórico de 30 dias sem gasto nessa campanha. Controlador no estado seguro: teto da conta R$ 100, gasto projetado R$ 24,63, saldo R$ 75,37.
- Decisão `2aa7f5e4-60f0-4ef5-9c30-9a480f973556`: persistida como `executed` e `confirmed` após leitura de volta na Amazon.

A alteração usou o gateway existente, com uma única escrita de estado e sem repetir a mutação após a confirmação. Não foram alterados budgets, bids, preços de produtos ou travas manuais nessa operação.

## Testes e limites

Testes de regressão de ID/texto e CSV, contratos de UI, persistência, auditoria sem mutações e integridade passaram. O build passou; oito testes backend passaram dentro da imagem sem rede. Os commits da correção passam em `git diff --check`. As alterações staged/unstaged anteriores foram preservadas, inclusive seus avisos globais de whitespace e erros antigos de lint/tipos.

A simulação de performance examinou 2.000 keywords, com zero ajustes elegíveis por falta de atribuição same-SKU atualizada. O novo relatório explícito foi aceito pela Amazon (`942627ac-6fc1-44f6-bf34-7cc6d0f4b9f8`) e estava em `PROCESSING` na última consulta. O poller existente segue responsável por processá-lo. A fila de OptimizationDecision não tinha ações aprovadas para execução naquele momento. O audit E2E ainda apontou avisos de estoque desconhecido em outros produtos e erros históricos de sincronização; não houve reativação desses produtos.

Evidências locais, sem credenciais publicadas: `reports/keyword-label-deploy-20261016/`, incluindo `final-summary.json`, `image-tests.log`, `canary-health.json`, `health-final.json` e os recibos das consultas/escritas na Amazon.
