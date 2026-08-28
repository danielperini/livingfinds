import { assertEquals } from "jsr:@std/assert@1";
import { decideSalesModeWaste, isProtectedWinner30d } from "./salesModeWastePolicy.ts";

const waste = {
  spend: 20,
  sales: 0,
  orders: 0,
  clicks: 12,
  ageDays: 10,
  minAgeDays: 7,
  minSpend: 5,
  maxAcos: 40,
  posteriorRecoveryProbability: 0.1,
};

Deno.test("waste follows hold, two reductions, then pause only with persistent proof", () => {
  assertEquals(
    decideSalesModeWaste({ ...waste, ageDays: 2, priorReductions: 0 }).action,
    "HOLD",
  );
  assertEquals(
    decideSalesModeWaste({ ...waste, priorReductions: 0 }).action,
    "REDUCE_BID_5",
  );
  assertEquals(
    decideSalesModeWaste({ ...waste, priorReductions: 1 }).action,
    "REDUCE_BID_10",
  );
  assertEquals(
    decideSalesModeWaste({ ...waste, priorReductions: 2 }).action,
    "PAUSE",
  );
});

Deno.test("low sample is never paused", () => {
  assertEquals(
    decideSalesModeWaste({ ...waste, spend: 4, clicks: 2, priorReductions: 9 })
      .action,
    "HOLD",
  );
});

Deno.test("7d ruim não reduz winner rentável de 30d", () => {
  assertEquals(isProtectedWinner30d({ orders30d: 3, sales30d: 300, spend30d: 30, growthAcosCeiling: 25, maximumAcos: 40 }), true);
});

Deno.test("ROAS histórico 10 protege contra intraday sem venda", () => {
  assertEquals(isProtectedWinner30d({ orders30d: 2, sales30d: 100, spend30d: 10, growthAcosCeiling: 20, maximumAcos: 40 }), true);
  assertEquals(decideSalesModeWaste({ ...waste, spend: 2, clicks: 3, priorReductions: 0 }).action, "HOLD");
});


Deno.test("posterior ausente nunca autoriza PAUSE", () => {
  assertEquals(
    decideSalesModeWaste({
      ...waste,
      posteriorRecoveryProbability: undefined,
      priorReductions: 2,
    }).action,
    "HOLD",
  );
});
