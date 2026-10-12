# Living Finds Principal Engineer (isolated SDK)

Este pacote adiciona um agente auxiliar com OpenAI Agents SDK. O sistema existente e o motor V6SIA continuam separados e não são substituídos. A aplicação principal é hospedada no VPS Hostinger; `base44/` contém módulos de compatibilidade e regras já usadas pelo projeto.

## Requisitos e execução

Node.js 22 ou superior e uma chave OpenAI configurada com segurança no ambiente do serviço Hostinger ou do processo local:

```sh
npm ci --prefix agents
npm test --prefix agents
npm start --prefix agents -- "Analise o fluxo V6SIA e indique lacunas"
```

Configure a chave no gerenciador de variáveis do serviço Hostinger ou em um mecanismo seguro local; nunca a inclua em argumentos, arquivos versionados ou logs. Também é possível enviar a tarefa por stdin. O modelo padrão é `gpt-6-luna`; `LIVINGFINDS_ENGINEER_MODEL` permite selecionar outro modelo disponível à conta.

O agente devolve análise/proposta. O retorno `analysis_only` não prova que uma alteração foi aplicada em GitHub ou no VPS. Tracing não deve incluir dados sensíveis.

## Ferramentas e limites

- Ler arquivos textuais allowlisted do checkout local, com bloqueio de traversal/secrets e sem conteúdo parcial para arquivos grandes.
- Propor diff sem gravar arquivo.
- Executar somente as suítes fixas `v6sia` e `frontend_contracts`.
- Consultar no máximo as 10 Actions mais recentes (token de leitura), health check público configurado e presença de variáveis.
- Não tem ferramenta de alteração de campanhas Amazon, lance/orçamento/keyword, banco, estoque, secrets, `main`, deploy ou shell livre.

Use uma credencial GitHub separada e somente leitura em `GITHUB_READ_TOKEN`. Não forneça ao processo do agente credenciais Amazon Ads ou de banco. A configuração atual apenas informa se `DATABASE_URL` está presente; não consulta o banco. Para health, configure `LIVINGFINDS_PUBLIC_HEALTH_URL` como URL pública HTTPS de `livingfinds.com.br` ou um endereço loopback HTTP.

A análise pode estar incompleta quando dados ou ferramentas não estiverem configurados. O agente não garante lucro, conversão ou melhoria de vendas. Execução protegida requer fluxo independente, aprovação humana e reconciliação.
