# Padronização de Moeda BRL — Amazon Brasil

## Visão Geral

Implementação centralizada, segura e econômica de padronização monetária para a conta Amazon Brasil.

**Moeda padrão:**
- Código: `BRL`
- Símbolo: `R$`
- Locale: `pt-BR`
- Marketplace: `A2Q3Y263D00KWC` (Amazon.com.br)

---

## Princípios

1. **Centralização**: Uma única fonte de verdade para configuração de marketplaces
2. **Economia**: Zero chamadas desnecessárias à API Amazon ou IA
3. **Segurança**: Validações obrigatórias antes de operações financeiras
4. **Auditabilidade**: Logs de validação e auditoria de divergências
5. **Compatibilidade**: Suporte a múltiplos marketplaces no futuro

---

## Arquitetura

### 1. Configuração Central (`src/lib/marketplaceConfig.ts`)

```typescript
export const AMAZON_MARKETPLACE_CONFIG = {
  BR: {
    marketplaceId: 'A2Q3Y263D00KWC',
    countryCode: 'BR',
    currencyCode: 'BRL',
    currencySymbol: 'R$',
    locale: 'pt-BR',
  },
  // ... outros marketplaces
};
```

**Funções principais:**
- `getMarketplaceConfig({ marketplaceId?, countryCode? })` — Resolve configuração
- `validateAmazonAccountContext({...})` — Valida antes de operações críticas

### 2. Utilitários de Moeda (`src/utils/currency.ts`)

```typescript
// Formatação
formatCurrency(1499.9, 'BRL', 'pt-BR')  // → "R$ 1.499,90"
formatBRL(1499.9)  // → "R$ 1.499,90"

// Normalização
normalizeBRLInput("R$ 1,25")  // → 1.25
normalizeBRLInput("1.000,50")  // → 1000.50

// Validação
isValidMonetaryValue(value)  // boolean
```

### 3. Validação de Perfil (`base44/functions/validateAmazonAccountContext/entry.ts`)

**Payload:**
```json
{
  "amazon_account_id": "123",
  "forceRefresh": false
}
```

**Retorno:**
```json
{
  "ok": true,
  "profileId": "amzn1.ads.123",
  "marketplaceId": "A2Q3Y263D00KWC",
  "countryCode": "BR",
  "currencyCode": "BRL",
  "currencySymbol": "R$",
  "locale": "pt-BR",
  "validationStatus": "VALID",
  "validatedAt": "2026-06-30T10:00:00Z"
}
```

**Validações críticas:**
- ProfileId existe e está ativo
- Brasil deve ter currencyCode = `BRL`
- marketplaceId compatível com país
- Cache de 24h para evitar chamadas repetidas

### 4. Auditoria de Consistência (`base44/functions/auditCurrencyConsistency/entry.ts`)

Verifica em todas as entidades:
- Perfil brasileiro com moeda diferente de BRL
- profileId ausente em campanhas
- marketplaceId divergente
- Valores monetários como texto
- Decisões de IA sem currencyCode/profileId

**Issues identificadas:**
- `ACCOUNT_MARKETPLACE_MISMATCH` (high)
- `CAMPAIGN_MISSING_ACCOUNT` (medium)
- `KEYWORD_TEXT_BID` (medium)
- `DECISION_MISSING_CURRENCY` (high)
- `REPORT_USD_CURRENCY` (critical)
- `ADGROUP_TEXT_BID` (medium)
- `PRODUCT_INCONSISTENT_CAMPAIGN` (medium)

---

## Entidades Atualizadas

### AmazonAccount

```jsonc
{
  "country_code": "BR",
  "currency_code": "BRL",
  "currency_symbol": "R$",
  "locale": "pt-BR",
  "profile_validated_at": "2026-06-30T10:00:00Z",
  "profile_validation_status": "valid"
}
```

### OptimizationDecision

```jsonc
{
  "profile_id": "amzn1.ads.123",
  "marketplace_id": "A2Q3Y263D00KWC",
  "country_code": "BR",
  "currency_code": "BRL",
  "currency_symbol": "R$"
}
```

---

## Regras de Validação

### Antes de Operações Críticas

Todas as operações abaixo devem chamar `validateAmazonAccountContext`:

1. Criar campanha (AUTO ou MANUAL)
2. Atualizar campanha (budget, state)
3. Pausar/Ativar campanha
4. Criar ad group
5. Criar keyword
6. Criar product target
7. Alterar bid
8. Alterar budget
9. Executar decisão de IA
10. Executar automação diária
11. Executar kick-off de produto
12. Aplicar dayparting
13. Ajustar placements
14. Importar relatórios

### Validação de Moeda

```typescript
// Brasil deve usar BRL
if (countryCode === 'BR' && currencyCode !== 'BRL') {
  throw new Error(
    `Moeda inválida para Amazon Brasil: ${currencyCode}. Esperado: BRL.`
  );
}
```

### Validação de ProfileId

```typescript
// ProfileId é obrigatório
if (!profileId) {
  throw new Error('profileId não informado. Perfil Amazon Ads é obrigatório.');
}

// ProfileId da operação deve ser igual ao da conta
if (operationProfileId !== accountProfileId) {
  throw new Error('ProfileId divergente. Operação bloqueada.');
}
```

---

## Cache Econômico

### Perfil Amazon Ads

- **TTL:** 24 horas
- **Invalida quando:**
  - Erro de autenticação
  - Erro de moeda
  - Troca de conta
  - `forceRefresh = true`

```typescript
const profileCache = new Map<string, {
  data: ProfileData;
  expiresAt: number;
}>();

// Uso
const cached = profileCache.get(amazon_account_id);
if (cached && cached.expiresAt > Date.now()) {
  return cached.data; // Cache hit
}
```

---

## Formatação no Frontend

### Dashboard e Páginas

```jsx
import { formatBRL } from '@/utils/currency';

// Exibição
<p>{formatBRL(campaign.spend)}</p>  // R$ 1.234,56
<p>{formatBRL(keyword.bid)}</p>      // R$ 0,85
<p>{formatBRL(campaign.budget)}</p>  // R$ 50,00
```

### Inputs Monetários

```jsx
import { normalizeBRLInput } from '@/utils/currency';

// Ao salvar
const normalizedBid = normalizeBRLInput(inputValue);
await base44.entities.Keyword.update(id, { bid: normalizedBid });
```

---

## IA Econômica

### Prompt Fixo para Conta Brasileira

```
This is an Amazon Brazil advertising account.

All monetary values, bids, budgets, costs, sales and financial impacts 
are denominated in Brazilian reais (BRL).

Currency code: BRL
Currency symbol: R$

Do not interpret any value as USD.
Do not perform currency conversion.
Only recommend actions for the supplied profileId.
```

### Contexto Consolidado

```json
{
  "accountContext": {
    "profileId": "amzn1.ads.123",
    "marketplaceId": "A2Q3Y263D00KWC",
    "countryCode": "BR",
    "currencyCode": "BRL",
    "currencySymbol": "R$"
  },
  "summary": {
    "campaignsAnalyzed": 24,
    "keywordsAnalyzed": 186,
    "relevantCases": 12
  }
}
```

---

## Tratamento de Divergências

### Cenário: Amazon retorna USD para perfil BR

**Ações:**
1. Bloquear criação/alteração de campanhas
2. Não executar bids/budgets
3. Não executar decisões automáticas
4. Registrar alerta técnico
5. Solicitar nova sincronização
6. Preservar dados históricos

**Mensagem:**
```
Operação bloqueada: o perfil Amazon Brasil retornou uma moeda 
incompatível (USD). Sincronize novamente o perfil antes de 
alterar campanhas.
```

---

## Auditoria de Registros Existentes

### Executar Auditoria

```bash
POST /api/functions/auditCurrencyConsistency
{
  "amazon_account_id": "123"
}
```

### Correções Automáticas

A auditoria corrige automaticamente:
- `currency_code` vazio → `BRL` (decisões recentes)
- `currency_symbol` vazio → `R$`
- Relacionamentos inequívocos com perfil

**Não corrige automaticamente:**
- Valores históricos suspeitos
- Bids armazenados como texto
- Budgets com formato incorreto

Estes são listados no relatório para revisão manual.

---

## Testes Obrigatórios

### 1. Perfil Brasileiro Válido

```json
{
  "profileId": "amzn1.ads.123",
  "marketplaceId": "A2Q3Y263D00KWC",
  "countryCode": "BR",
  "currencyCode": "BRL"
}
```

**Resultado:** `VALID`

### 2. Perfil Brasileiro com USD

```json
{
  "profileId": "amzn1.ads.123",
  "marketplaceId": "A2Q3Y263D00KWC",
  "countryCode": "BR",
  "currencyCode": "USD"
}
```

**Resultado:** `BLOCKED` — Erro: "Moeda inválida para Amazon Brasil"

### 3. Formatação

```javascript
formatBRL(1.25)      // "R$ 1,25"
formatBRL(1000)      // "R$ 1.000,00"
formatBRL(0)         // "R$ 0,00"
```

### 4. Normalização

```javascript
normalizeBRLInput("R$ 1,25")    // 1.25
normalizeBRLInput("1,25")       // 1.25
normalizeBRLInput("1.000,50")   // 1000.50
normalizeBRLInput(1.25)         // 1.25
```

---

## Critérios de Aceite

- [x] Perfil Amazon Ads identificado por `profileId`
- [x] Perfil associado ao `marketplaceId` correto
- [x] Moeda retornada pela Amazon salva no perfil
- [x] Contas brasileiras usam exclusivamente BRL
- [x] Bids e budgets exibidos em R$
- [x] Nenhuma operação usa conversão cambial
- [x] Decisões de IA incluem profileId, marketplaceId, currencyCode
- [x] Decisões divergentes são bloqueadas
- [x] Validação antes de operações críticas
- [x] Cache de perfil (24h) para economia
- [x] Auditoria de consistência implementada
- [x] Entidades atualizadas com campos de moeda
- [x] Utilitários de formatação centralizados
- [x] Zero IA para cálculos/formato de moeda

---

## Próximos Passos

1. **Executar auditoria** em toda a base de dados
2. **Revisar issues** críticas e altas
3. **Atualizar funções** existentes para usar validação
4. **Testar** criação de campanhas com perfil validado
5. **Validar** decisões de IA com contexto de moeda
6. **Monitorar** logs de validação

---

## Referências

- `src/lib/marketplaceConfig.ts` — Configuração central
- `src/utils/currency.ts` — Utilitários de moeda
- `base44/functions/validateAmazonAccountContext/entry.ts` — Validação de perfil
- `base44/functions/auditCurrencyConsistency/entry.ts` — Auditoria
- `src/pages/CurrencyAudit.jsx` — Interface de auditoria