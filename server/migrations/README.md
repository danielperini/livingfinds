# Migrações incrementais

Cada mudança de banco deve ser adicionada em um novo arquivo SQL numerado, por exemplo
`0002_add_decision_indexes.sql`. Arquivos já publicados são imutáveis.

- Use `CREATE ... IF NOT EXISTS` e alterações aditivas.
- Não apague ou renomeie tabelas, colunas ou dados durante o deploy.
- Primeiro publique código que aceite o formato antigo e o novo.
- Faça backfill em uma etapa separada e reiniciável.
- Só remova estruturas antigas em uma release posterior, depois de backup e auditoria.
- Para índices pesados, use uma janela de manutenção e prefira `CREATE INDEX CONCURRENTLY`.

O comando `deno task migrate` registra cada arquivo aplicado em
`app_schema_migrations` e não o executa novamente.
