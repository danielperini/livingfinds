# Prompt para Xano — Correções e Melhorias da Living Finds API

Olá! Tenho a Living Finds API no Xano (`/api:living-finds-api`) e encontrei os seguintes problemas ao integrar com o frontend React. Por favor corrige os endpoints abaixo.

---

## 🔴 BUGS CRÍTICOS A CORRIGIR

### 1. `GET /logs` → Erro 500 interno
**Problema:** Retorna `{"code":"ERROR_FATAL","message":"Function does not exist: function:0"}`  
**Solução:** Verificar e corrigir a função interna referenciada neste endpoint. Provavelmente uma função foi eliminada ou renomeada e o endpoint ainda a referencia.

---

### 2. `GET /amazon/products` → `search` obrigatório impede listagem geral
**Problema:** O param `search` é obrigatório mas quando enviado vazio (`search=""`) dá erro. Não é possível listar todos os produtos sem filtro.  
**Solução:** Tornar `search` **opcional**. Quando ausente ou vazio, retornar todos os produtos.

---

### 3. `GET /amazon/campaigns` → Todos os params obrigatórios em simultâneo
**Problema:** `state`, `account_id` e `search` são todos obrigatórios, o que impede listagem sem filtros.  
**Solução:** Tornar `search` e `state` **opcionais**. Apenas `account_id` deve ser obrigatório (ou também opcional com fallback para o account do user autenticado).

---

### 4. `GET /amazon/keywords` → Todos os params obrigatórios
**Problema:** `campaign_id`, `ad_group_id`, `state`, `search` e `match_type` são todos obrigatórios.  
**Solução:** Tornar todos **opcionais** exceto `campaign_id`. Quando ausentes, não aplicar filtro.

---

### 5. `GET /dashboard/decisions` → `status` obrigatório
**Problema:** Não é possível listar todas as decisões sem filtrar por status.  
**Solução:** Tornar `status` **opcional**. Quando ausente, retornar todas as decisões.

---

## 🟡 MELHORIAS IMPORTANTES

### 6. `GET /base44/dashboard_cards` → `start_date` e `end_date` obrigatórios
**Pedido:** Tornar opcionais com **default dos últimos 30 dias** quando não enviados.  
Assim o frontend pode chamar sem params e obter sempre dados relevantes.

---

### 7. `GET /amazon/metrics/daily_summary` → `start_date` e `end_date` obrigatórios
**Pedido:** Mesmo que acima — tornar opcionais com **default dos últimos 30 dias**.

---

### 8. `GET /amazon/dashboard` → `account_id` obrigatório
**Pedido:** Tornar `account_id` **opcional** — quando ausente, usar o account associado ao user autenticado (Bearer token).

---

### 9. `GET /amazon/campaigns` → `account_id` obrigatório
**Pedido:** Tornar `account_id` **opcional** — quando ausente, usar o account do user autenticado.

---

### 10. `PATCH /amazon-accounts/{id}` → `ai_auto_optimization` e `status` obrigatórios
**Problema:** Para atualizar apenas o `max_daily_budget_limit` tenho de enviar sempre os outros campos.  
**Solução:** Todos os campos devem ser **opcionais** — só atualizar os que forem enviados (PATCH semântico).

---

## 🟢 ENDPOINTS A CONFIRMAR (funcionaram mas estão vazios)

Estes endpoints responderam 200 mas com dados a zero/vazios. Confirmar se há dados na base:

- `GET /ads-agent/decisions` → `items: []` (sem decisões)
- `GET /ads-agent/memory` → `items: []` (sem memória)  
- `GET /dashboard/summary` → todos os valores a `0`
- `GET /learning/status` → `events_collected: 0`

Se há dados no Xano e não estão a ser retornados, verificar filtros/queries internas.

---

## ℹ️ CONTEXTO TÉCNICO

- **Frontend:** React (Base44 platform) em `https://x8ki-letl-twmt.n7.xano.io/api:living-finds-api`
- **Auth:** Bearer token JWT obtido via `POST /auth/login`
- **Rate limit:** Estamos a atingir o limite de 10 req/20s do plano atual — considerar upgrade se a app for para produção
- **Endpoints que funcionam bem:** `/health`, `/ads-agent/rules`, `/dashboard/keywords`, `/decisions/approve`, `/decisions/reject`

---

## 📋 RESUMO DAS ALTERAÇÕES

| Endpoint | Problema | Solução |
|---|---|---|
| `GET /logs` | Erro 500 fatal | Corrigir função interna |
| `GET /amazon/products` | `search` obrigatório | Tornar opcional |
| `GET /amazon/campaigns` | Todos os params obrigatórios | Só `account_id` obrigatório |
| `GET /amazon/keywords` | Todos os params obrigatórios | Só `campaign_id` obrigatório |
| `GET /dashboard/decisions` | `status` obrigatório | Tornar opcional |
| `GET /base44/dashboard_cards` | `start_date`/`end_date` obrigatórios | Default últimos 30 dias |
| `GET /amazon/metrics/daily_summary` | `start_date`/`end_date` obrigatórios | Default últimos 30 dias |
| `GET /amazon/dashboard` | `account_id` obrigatório | Usar account do user autenticado |
| `PATCH /amazon-accounts/{id}` | Campos obrigatórios | Todos opcionais (PATCH real) |