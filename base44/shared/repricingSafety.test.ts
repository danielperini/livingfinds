import {
  actionBlocksAutomaticDay,
  dayKeyInTimeZone,
  dedupeOperationalConfirmedHistory,
  importedUnitCostError,
  isAutomaticRepricingRuntimeEnabled,
  isConcurrentPriceAction,
  isOperationalConfirmedHistory,
  listingExecutionBlockReasons,
  pricesMatch,
} from "./repricingSafety.ts";

Deno.test("automacao de preco nasce desligada e exige flag explicita", () => {
  for (const value of [undefined, null, "", "false", "1", "yes"]) {
    if (isAutomaticRepricingRuntimeEnabled(value)) {
      throw new Error(`flag insegura aceita: ${String(value)}`);
    }
  }
  if (!isAutomaticRepricingRuntimeEnabled(" TRUE ")) {
    throw new Error("flag explicita verdadeira foi rejeitada");
  }
});

Deno.test("usa a data civil de Sao Paulo no limite da meia-noite", () => {
  if (dayKeyInTimeZone("2026-08-01T02:59:59.999Z") !== "2026-07-31") {
    throw new Error(
      "instante anterior a meia-noite foi classificado no dia errado",
    );
  }
  if (dayKeyInTimeZone("2026-08-01T03:00:00.000Z") !== "2026-08-01") {
    throw new Error("meia-noite de Sao Paulo foi classificada no dia errado");
  }
});

Deno.test("acao automatica confirmada impede segundo ciclo no mesmo dia", () => {
  const action = {
    status: "confirmed",
    created_at: "2026-08-01T12:00:00.000Z",
    idempotency_key: "repricing:seller:market:FBA-0010B:2026-08-01",
  };
  if (!actionBlocksAutomaticDay(action, "2026-08-01")) {
    throw new Error("acao confirmada deveria bloquear o dia");
  }
  if (actionBlocksAutomaticDay(action, "2026-08-02")) {
    throw new Error("acao do dia anterior nao deveria bloquear um novo dia");
  }
});

Deno.test("acao pendente ou em processamento impede concorrencia", () => {
  for (const status of ["pending", "submitted", "processing"]) {
    if (!isConcurrentPriceAction({ status })) {
      throw new Error(`${status} deveria bloquear concorrencia`);
    }
  }
  if (isConcurrentPriceAction({ status: "blocked" })) {
    throw new Error(
      "acao bloqueada permanentemente pode ser reavaliada apos correcao",
    );
  }
});

Deno.test("registro legado com price_before zero nao entra no painel operacional", () => {
  if (
    isOperationalConfirmedHistory({
      history_type: "price_confirmed",
      status: "confirmed",
      price_before: 0,
      price_after: 99,
      amazon_response: {},
    })
  ) throw new Error("registro legado invalido foi aceito");
});

Deno.test("painel exige confirmacao posterior documentada pela Amazon", () => {
  const base = {
    history_type: "price_confirmed",
    status: "confirmed",
    price_before: 100,
    price_after: 101,
  };
  if (isOperationalConfirmedHistory(base)) {
    throw new Error("registro sem resposta Amazon foi aceito");
  }
  if (!isOperationalConfirmedHistory({ ...base, amazon_response: {} })) {
    throw new Error("registro confirmado valido foi rejeitado");
  }
});

Deno.test("deduplica historicos confirmados do mesmo SKU no mesmo dia", () => {
  const rows = [
    {
      id: "new",
      sku: "fba-0010b",
      history_type: "price_confirmed",
      status: "confirmed",
      price_before: 100,
      price_after: 102,
      changed_at: "2026-08-01T15:00:00Z",
      amazon_response: {},
    },
    {
      id: "old",
      sku: "FBA 0010b",
      history_type: "price_confirmed",
      status: "confirmed",
      price_before: 99,
      price_after: 100,
      changed_at: "2026-08-01T12:00:00Z",
      amazon_response: {},
    },
  ];
  const deduped = dedupeOperationalConfirmedHistory(rows);
  if (deduped.length !== 1 || deduped[0].id !== "new") {
    throw new Error(
      "historico mais recente nao foi preservado na deduplicacao",
    );
  }
});

Deno.test("divergencia da Amazon nao confirma nem autoriza base obsoleta", () => {
  if (pricesMatch(101, 100)) {
    throw new Error("precos divergentes foram aceitos");
  }
  if (!pricesMatch("100.00", 100)) {
    throw new Error("precos equivalentes foram rejeitados");
  }
});

Deno.test("listing inativo ou nao compravel bloqueia execucao", () => {
  const reasons = listingExecutionBlockReasons({
    offerActive: false,
    buyable: false,
    productType: "",
    sellerFulfillmentType: "MFN",
  });
  if (reasons.length !== 4) {
    throw new Error("listing inseguro nao foi bloqueado integralmente");
  }
  if (
    listingExecutionBlockReasons({
      offerActive: true,
      buyable: true,
      productType: "HOME",
      sellerFulfillmentType: "AFN",
    }).length
  ) {
    throw new Error("listing FBA valido foi bloqueado");
  }
});

Deno.test("importacao rejeita custo zero, negativo, vazio ou texto", () => {
  for (const unit_cost of [0, -1, "", "abc", null]) {
    if (!importedUnitCostError({ unit_cost })) {
      throw new Error(`custo inválido foi aceito na importação: ${unit_cost}`);
    }
  }
  if (!importedUnitCostError({})) throw new Error("custo omitido foi aceito");
  if (importedUnitCostError({ unit_cost: "50.25" })) {
    throw new Error("custo positivo válido foi rejeitado");
  }
});
