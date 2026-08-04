# Motor unificado de decisão

O único produtor de mudanças de Ads e preço é `runUnifiedDecisionEngine`. Ele roda a cada 15 minutos e fecha o dia anterior às **01:00 BRT**. A sequência é: dados frescos → `RepricingSnapshot` histórico → avaliação econômica → classificação de jornada → decisões canônicas em `OptimizationDecision` → transporte → confirmação Amazon.

`AmazonActionQueue` é somente transporte. Nenhuma alteração é concluída antes de `confirmExecutedDecisions` confirmar a resposta da Amazon. Locks por entidade, idempotência por janela e retentativas permanecem no executor.

## Bootstrap e jornada

Envie `{ "bootstrap": true, "daily_close": true }` ao motor para reconstruir snapshots usando o histórico persistido. Antes de qualquer bid, cada campanha é classificada em uma jornada: descoberta automática, aprendizado, coleta/avaliação de termos, manual exact, winner protegido, defensiva, sem estoque, incompleta ou arquivada. Campanhas AUTO seguem como fonte de descoberta; uma campanha nova tem janela de aprendizado de 72 horas e não é pausada por ausência inicial de vendas.

## Search terms

O relatório `spSearchTerm` alimenta uma única entidade `SearchTerm` para AUTO, manual EXACT, phrase/broad legado e product targeting. `source_type`, termo original/normalizado, origem, ASIN/SKU, same-SKU e halo são preservados. Apenas venda same-SKU permite promoção automática; evidência halo não cria campanha. Consulta igual à keyword EXACT vira evidência da própria keyword, jamais uma estrutura duplicada.

## Operação

Os jobs decisórios legados foram removidos do agendamento. Restaram sincronização de dados, motor unificado, executor, confirmação e transporte/reconciliação de preço. A execução efetiva exige que as configurações de rollout permitam automação e que a Amazon confirme a alteração.
