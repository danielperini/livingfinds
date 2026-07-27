# Living Finds — Backend self-hosted (fora do Base44)

Este diretório é a **camada de compatibilidade** que tira o back-end do Base44 e o roda
por conta própria (VPS), **sem reescrever** as 311 funções nem as 116 entidades.

## Como funciona

As funções em `../base44/functions/*/entry.ts` importam `@base44/sdk` e usam
`base44.entities`, `base44.auth`, `base44.integrations`, `base44.functions`, `base44.connectors`.
Em vez de reescrevê-las, nós:

1. **Interceptamos o import** (`deno.json` → import-map) e injetamos o nosso shim
   (`src/sdk/mod.ts`) no lugar do `@base44/sdk` real.
2. **Reimplementamos o SDK** sobre Postgres:
   - `src/sdk/entities.ts` — CRUD (`filter/get/list/create/bulkCreate/update/delete/deleteMany`)
     em tabelas-documento (`id, created_date, updated_date, created_by, data jsonb`), criadas sob demanda.
   - `src/sdk/auth.ts` — `me()/isAuthenticated()` (single-tenant).
   - `src/sdk/integrations.ts` — `Core.InvokeLLM` via Anthropic (Claude); `SendEmail/UploadFile` stub.
   - `src/sdk/functions.ts` — `invoke(name, payload)` chamando o handler-alvo em processo.
   - `src/sdk/connectors.ts` — `getConnection('googledrive')`.
3. **Carregamos as funções** (`src/registry.ts`) substituindo temporariamente `Deno.serve`
   para capturar o handler de cada `entry.ts` (elas não sobem servidor; viram rotas).
4. **Servimos** em `POST /functions/:nome` (`src/main.ts`) e rodamos os **crons**
   (`src/scheduler.ts`, lendo `../base44/schedules/amazon-automation-schedule.json`).

```
Request  ──►  /functions/:nome  ──►  handler da função (entry.ts)
                                          │  usa base44.* ──►  shim ──►  Postgres / Anthropic / Amazon APIs
Scheduler (crons) ─────────────────────────┘
```

## Rodar localmente (Docker — recomendado)

```bash
cp server/.env.example server/.env      # preencha as chaves
# na raiz do repo:
docker compose -f server/docker-compose.yml up -d --build
curl localhost:8000/health
curl localhost:8000/functions           # lista as funções carregadas
```

## Rodar localmente (Deno direto)

Pré-requisitos: Deno 2.x + um Postgres acessível em `DATABASE_URL`.

```bash
cd server
cp .env.example .env
deno task schema     # gera schema.sql a partir das 116 entidades
deno task migrate    # aplica no Postgres (opcional: as tabelas também nascem sob demanda)
deno task start      # sobe o backend na porta 8000
```

## Frontend (mesma origem)

O backend também serve o **frontend React** e expõe a API compatível com o `@base44/sdk`
(`/api/apps/:appId/entities/...` e `/api/apps/:appId/functions/:name`) — como o
`src/api/base44Client.js` usa `serverUrl: ''`, o SDK chama a mesma origem. Basta buildar o
front e apontar `FRONTEND_DIR` para o `dist/`:

```bash
# na raiz do repo
VITE_BASE44_APP_ID=<appId> npm install && VITE_BASE44_APP_ID=<appId> npm run build
# o Dockerfile copia ./dist para /app/dist (FRONTEND_DIR). Rebuild:
docker compose -f server/docker-compose.yml up -d --build
```

Abra `http://<host>:8000/` para a tela do app. As rotas `/api/*` (usadas pelo front) ficam
abertas na mesma origem; proteja com Nginx + Basic Auth/HTTPS em produção.

## Deploy na VPS (Hostinger)

1. Instale Docker + Docker Compose na VPS.
2. `git clone` do repo, `cp server/.env.example server/.env` e preencha as chaves reais.
3. `docker compose -f server/docker-compose.yml up -d --build`.
4. Ponha um Nginx na frente com HTTPS (Let's Encrypt) apontando para `:8000`.
5. Registre as **redirect URIs** de OAuth (Amazon Ads/SP-API) com o domínio da VPS
   e ajuste `APP_BASE_URL`.

## Testar uma função

```bash
curl -X POST localhost:8000/functions/checkSpApiConnection \
  -H 'authorization: Bearer SEU_API_TOKEN' \
  -H 'content-type: application/json' \
  -d '{"amazon_account_id":"<id>"}'
```

## Pendências / próximos passos

- [ ] Validar os números (ACOS/CPC/histórico) contra a interface da Amazon — requisito crítico do cliente.
- [ ] Migrar entidades "quentes" (Campaign, Keyword, metrics) para colunas tipadas + índices dedicados.
- [ ] Padronizar versões do `@anthropic-ai/sdk` (hoje há 0.27→0.52 espalhadas).
- [ ] Ajustar chamadas internas que usam `http://localhost:8000` fixo (ex.: applyOptimizationRules).
- [ ] Notificações via Discord (webhook) no fim do lote noturno.

> Detalhes da arquitetura original e do plano em `../../livefinding/docs/MIGRATION.md`.
