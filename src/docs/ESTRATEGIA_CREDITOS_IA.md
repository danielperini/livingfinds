# Estratégia de Uso Mínimo de Créditos de Integração Base44

## Princípio: Todas as chamadas de IA usam API direta da Anthropic (ANTHROPIC_API_KEY), nunca `InvokeLLM` do Base44.

---

## Funções de IA — inventário completo

| Função | Modelo | Frequência | Custo |
|--------|--------|------------|-------|
| `runWeeklyMotorPrelection` | claude-opus-4-8 (via `AI_WEEKLY_REVIEW_MODEL`) | 1x/semana (qui 03h50) | API Anthropic direta ✅ |
| `runWeeklyAIDirectivesEngine` | claude-3-5-haiku (via `AI_WEEKLY_REVIEW_MODEL`) | 1x/semana (domingo noite) | API Anthropic direta ✅ |
| `claudeAdsAgent` | claude-sonnet-4-5 | Só quando `mode=claude_analyze` | API Anthropic direta ✅ |
| `generateListingEnhancementSuggestions` | claude-3-5-haiku | Manual, por ASIN | API Anthropic direta ✅ |
| `runCrossAsinTransfer` | `AI_WEEKLY_REVIEW_MODEL` | Só heurística 70-95% zona cinzenta | API Anthropic direta ✅ |
| `suggestProductKeywordsWithAI` | claude-haiku-4-5 | Só `force_ai: true` (kickoff manual) | API Anthropic direta ✅ |
| `runDailyConsolidatedAI` | claude-haiku-4-5 | Só quando há anomalias detectadas | API Anthropic direta ✅ (corrigido) |

---

## Camadas de proteção de crédito

### 1. `aiGatekeeper` — portão obrigatório
- Cache por `input_hash` com TTL por tipo de análise (1-30 dias)
- Budget diário: 20 chamadas, 150k tokens
- Bloqueia cálculos simples (`bid_rule`, `calc_metrics`, etc.) — usa motor determinístico
- `calls_avoided_cache` e `calls_avoided_rules` registrados em `AIUsageLog`

### 2. Motor determinístico prioritário
- Todas as decisões de bid, budget, placement e pause são calculadas por regras determinísticas
- IA só é chamada para análise estratégica, NUNCA para decisões operacionais diárias
- `runDailyConsolidatedAI`: skip se nenhuma anomalia detectada (zero chamadas IA na maioria dos dias)
- `suggestProductKeywordsWithAI`: modo determinístico por padrão; IA só com `force_ai: true`

### 3. Frequência mínima
- `runWeeklyMotorPrelection`: 1 chamada/semana (idempotente por semana)
- `runWeeklyAIDirectivesEngine`: 1 chamada/semana
- `runDailyConsolidatedAI`: 0 chamadas/dia se não há anomalias (maioria dos dias)
- `claudeAdsAgent`: apenas via requisição manual no `aiEngine?mode=claude_analyze`

### 4. Cache agressivo
- TTLs por tipo: keyword_relevance=30d, search_term_intent=30d, campaign_strategy=7d
- Resultados em `AIAnalysisCache` com reuse_count rastreado
- `recordAIResult` persiste resultados para reutilização

---

## Regra absoluta
**NUNCA usar `base44.integrations.Core.InvokeLLM()`** nas funções backend.
Sempre usar `fetch('https://api.anthropic.com/v1/messages', ...)` com `ANTHROPIC_API_KEY`.

O `InvokeLLM` do Base44 consome créditos de integração pagos.
A API da Anthropic é cobrada separadamente e não consome créditos Base44.