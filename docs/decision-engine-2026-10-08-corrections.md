# Correção econômica e execução verificável — 08/10/2026

- O total variável por unidade inclui tarifas Amazon uma única vez. A regra de ACoS não volta a subtrair a tarifa; ausência de total não vira zero.
- Custos confirmados continuam confirmados quando falta CPA histórico. Esse caso mantém Ads parcial e mantém repricing bloqueado conforme sua validação própria.
- Importação e atualização econômica reutilizam o cálculo de contribuição antes de Ads. O imposto percentual configurado é contabilizado separadamente de tributos unitários extras.
- O ajuste de palavras-chave usa relatórios fechados, atualizados, com atribuição verificada ao mesmo SKU. Para cortes, exige cliques/gasto com pelo menos sete dias de maturidade; preserva vencedores no agregado.
- SKU ambíguo, pausa manual, estoque desatualizado, tarifa antiga ou margem desconhecida impedem o ajuste automático. Cada execução limita alterações e deduplica IDs.
- Lance e campanha são consultados antes da alteração. Aceitação e confirmação por releitura são estados distintos. Simulação não envia PUT nem grava alteração de lance.
- O criador legado a partir de KeywordSuggestion usa o mesmo promotor comprovado; não publica sugestões diretamente.
- Uma consulta FBA bem-sucedida mais recente substitui a exceção temporária do vendedor, inclusive se a quantidade for zero.

Validação: testes de contribuição, margem, atribuição, estoque e limites de promoção; checagem de tipos dos quatro módulos alterados. A suíte ampliada encontrou três falhas pré-existentes nos arquivos não alterados repricingPolicy.test.ts (dois valores esperados) e productCampaignPauseGuard.test.ts (pausa legada sem lock). Não foram ocultadas nem atribuídas à correção.

Limites: isto não implementa DSP, AMC, Marketing Stream nem conversão por sessão. As filas antigas precisam de reconciliação individual; não são declaradas confirmadas por simples status local. As demais rotinas legadas ainda exigem revisão antes de afirmar uniformidade completa do motor.
