# Prompt Xano — Correções Pendentes (Round 2)

Olá! Testei novamente os endpoints após as primeiras correções. Algumas melhoraram, mas ainda há 5 problemas. Por favor corrige:

---

## 🔴 BUGS CRÍTICOS

### 1. `GET /logs` → Env var `BASE44_API_KEY` não configurada
**Erro:** `{"code":"ERROR_FATAL","message":"Workspace environment variable BASE44_API_KEY is not configured"}`  
**Solução:** No painel Xano → **Settings → Environment Variables** → adicionar a variável `BASE44_API_KEY` com o valor correto da chave da API Base44. Ou remover a dependência desta variável se não for necessária.

---

### 2. `GET /amazon/campaigns` → Parâmetro `account_id` não reconhecido
**Erro:** `{"code":"ERROR_CODE_INPUT_ERROR","message":"Unsupported parameter reference - account_id"}`  
**O que acontece:** O endpoint não aceita `account_id` como query param apesar de estar documentado assim.  
**Solução:** Corrigir o endpoint para aceitar `account_id` como query param opcional. Alternativa: redirecionar para `/campaigns` que já funciona.

---

### 3. `GET /base44/dashboard_cards` → Bug interno `acc.profile_id`
**Erro:** `{"code":"ERROR_FATAL","message":"Unable to locate var: acc.profile_id"}`  
**O que acontece:** Quando chamado sem `account_id`, o endpoint tenta aceder a `acc.profile_id` mas `acc` não está definido (lookup falhou ou não há account).  
**Solução:** Adicionar verificação antes de usar `acc` — se não encontrar account, retornar objeto com zeros em vez de crashar. Exemplo:
```
if acc == null then return { total_sales: 0, ad_spend: 0, acos: 0, ... }
```

---

### 4. `GET /amazon/metrics/daily_summary` → Mesmo bug `acc.profile_id`
**Erro:** `{"code":"ERROR_FATAL","message":"Unable to locate var: acc.profile_id"}`  
**Causa:** Mesmo problema do endpoint acima — lookup de account falha silenciosamente e depois `acc` é usado sem verificação.  
**Solução:** Mesma abordagem — guard clause antes de usar `acc`. Se não há account, retornar array vazio `[]`.

---

### 5. `GET /amazon/dashboard` → `start_date` ainda obrigatório
**Erro:** `{"code":"ERROR_FATAL","message":"Unable to locate input: start_date"}`  
**Contexto:** Pedi para tornar `start_date` e `end_date` opcionais com default dos últimos 30 dias, mas a correção não foi aplicada.  
**Solução:** Adicionar no início do endpoint:
```
start_date = input.start_date ?? today - 30 days
end_date   = input.end_date   ?? today
```

---

## ✅ JÁ CORRIGIDOS (não tocar)
- `GET /amazon/products` — agora aceita sem `search` ✅
- `GET /dashboard/decisions` — agora aceita sem `status` ✅
- `GET /campaigns` — funciona e retorna dados ✅
- `GET /ads-agent/decisions`, `/memory`, `/rules` — ok ✅
- `GET /dashboard/keywords` — ok ✅

---

## 📋 RESUMO DOS 5 PROBLEMAS RESTANTES

| Endpoint | Erro | Solução |
|---|---|---|
| `GET /logs` | `BASE44_API_KEY` não configurada | Configurar env var no Xano |
| `GET /amazon/campaigns` | `account_id` não reconhecido | Corrigir param ou redirecionar para `/campaigns` |
| `GET /base44/dashboard_cards` | `acc.profile_id` — null pointer | Guard clause: se account null → retornar zeros |
| `GET /amazon/metrics/daily_summary` | `acc.profile_id` — null pointer | Mesmo guard clause → retornar array vazio |
| `GET /amazon/dashboard` | `start_date` ainda obrigatório | Aplicar default: últimos 30 dias |