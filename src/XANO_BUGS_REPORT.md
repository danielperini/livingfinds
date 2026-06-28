# Xano Bug Report — Living Finds API
## Data: 2026-06-28

## ✅ ENDPOINTS FUNCIONANDO
- GET /amazon/products → 200 OK
- GET /amazon/metrics/daily_summary → 200 OK (retorna [] se sem dados)
- GET /amazon/products/performance/list → 200 OK
- PATCH /campaigns/{id} → 200 OK
- POST /bids/apply → OK

## ❌ BUGS CRÍTICOS A CORRIGIR

### 1. GET /amazon/dashboard
**Erro:** `Function does not exist: function:0`
**Causa:** Referência a uma função interna que não existe ou foi deletada.
**Fix:** No editor do endpoint, verificar todas as "Function" calls na stack e remover/substituir a function:0.

### 2. GET /amazon/analysis/campaigns
**Erro:** `Function does not exist: function:0`  
**Fix:** Mesmo que acima.

### 3. GET /amazon/campaigns
**Erro:** `Unable to locate var: acc.profile_id`
**Causa:** A variável `acc` (amazon_account) não está sendo encontrada ou o campo `profile_id` não existe nela.
**Fix:** Verificar o query que busca a conta Amazon e garantir que `profile_id` existe na tabela `amazon_accounts`.

### 4. GET /ads-agent/decisions
**Erro:** `Function does not exist: function:0`
**Fix:** Mesmo que #1.

### 5. GET /amazon/keywords
**Erro:** `Missing param: campaign_id` (parâmetro obrigatório não documentado)
**Fix:** Tornar `campaign_id` opcional. Se não fornecido, retornar todas as keywords.

### 6. GET /logs
**Erro:** `Function does not exist: function:0`
**Fix:** Mesmo que #1.

## 📋 PARÂMETROS NECESSÁRIOS (Base44 já envia)
- /amazon/analysis/campaigns: start_date, end_date
- /amazon/metrics/daily_summary: sem parâmetros

## 🔑 AUTENTICAÇÃO
- Header: X-API-Key: {{XANO_API_KEY}} ✅ funcionando
- Base44 sempre envia este header via xanoProxy