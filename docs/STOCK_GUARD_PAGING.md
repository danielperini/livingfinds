# Proteção de estoque e frescor: correção incremental após PR #175

O painel publicado revelou 3.208 registros locais de campanha. A implementação
de `autoStockCampaignGuard` e `checkInventoryChangesAndKickoff` ainda limitava
parte de suas leituras a 2.000 campanhas, 500 produtos e 5.000 ProductAds.
Falhas em algumas fontes viravam listas vazias. Isso era uma lacuna verificável
no código, mas não prova a causa dos alertas reais dos ASINs B0F45JG27L e
B0DJ3RGHK6: seu estado remoto não foi consultado nesta tarefa.

Os dois caminhos agora leem todas as páginas das fontes relevantes com o
contrato Hostinger já validado no PR #175. Leitura incompleta falha e não declara
`stock_guard_confirmed`. A proteção carrega produtos, campanhas e ProductAds
antes de iniciar seu caminho remoto. `dry_run`/`audit_only` retornam somente
contagens locais, sem token, chamadas Amazon, kickoff ou escrita, e não confirmam
que a pausa foi aplicada. O modo de execução existente permanece separado.

O frescor agora distingue a última atualização recente da cobertura da fonte:
uma linha atualizada há seis minutos não torna antigos registros de outras
entidades recentes. O painel mostra a data da última atualização e quantos
registros estão antigos ou sem timestamp confiável. O flag conservador
`data_stale` da fonte continua preservado.

Cinco testes específicos cobrem 3.208 campanhas, uma campanha de produto sem
estoque além da linha 2.000, falha de página sem falso sucesso, simulação dos
dois handlers reais sem escrita/chamada externa e separação dos dois conceitos
de frescor. As regressões de idempotência, claims, scheduler, ciclo e dashboard
são executadas com Amazon simulada e PostgreSQL descartável quando aplicável.

Este trabalho não transforma o motor em operacional confirmado: o ciclo
histórico de 23/10 continua bloqueado, e pausas e escritas incertas ainda exigem
reconciliação remota antes de qualquer repetição. As 350 decisões históricas
com envio sem confirmação não são 350 ações novas que possam ser reenviadas.
Nenhum alerta real foi resolvido ou descartado, nenhuma campanha real foi
alterada, e não houve replay, merge ou deploy nesta tarefa. O stash operacional
anterior foi mantido.

Validação local: 84 testes passaram (5 específicos e 79 regressões, incluindo
6 integrações PostgreSQL). `deno check` dos módulos afetados, lint do componente
alterado, build Vite e `git diff --check` passaram. O build mantém avisos de
app ID ausente e chunks grandes; não comprova integração ou produção.
