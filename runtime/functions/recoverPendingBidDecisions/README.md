# recoverPendingBidDecisions

Executa o backlog de decisões de bid de forma sequencial, sem criar novas decisões.

Entrada recomendada:

```json
{
  "recovery_mode": true,
  "spacing_ms": 2500,
  "max_runtime_ms": 240000,
  "_service_role": true
}
```

Se `continuation_required=true`, execute novamente até `remaining=0`. Depois disso, as novas decisões seguem automaticamente pelas janelas `00:00-04:00` e `13:00-14:00` via `processAmazonNightWindow`.
