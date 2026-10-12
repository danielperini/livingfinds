import { classifyDelivery, productGate } from './campaignDeliveryGovernor.ts';
import { validateAmazonAction } from './amazonActionRegistry.ts';
import { clampAmazonBid } from './amazonBidCeiling.ts';
import {
  amazonBidMatchesExpected,
  buildKeywordBidMutation,
  normalizeAmazonBatchResponse,
} from './amazonBidMutation.ts';

function assert(condition: unknown, message = 'assertion failed'): asserts condition {
  if (!condition) throw new Error(message);
}
function assertEquals(actual: unknown, expected: unknown, message = 'values differ') {
  if (actual !== expected) throw new Error(`${message}: expected=${expected}, actual=${actual}`);
}

Deno.test('E2E simulado: métricas econômicas geram redução, Ads API altera o bid e o probe confirma', async () => {
  const snapshot = {
    impressions: 1200,
    clicks: 50,
    orders: 0,
    sales: 0,
    spend: 30,
    currentBid: 0.72,
    availableFba: 20,
    maximumProfitableSpend: 10,
  };
  const metrics = {
    ctr: snapshot.clicks / snapshot.impressions * 100,
    cpc: snapshot.spend / snapshot.clicks,
    acos: snapshot.sales > 0 ? snapshot.spend / snapshot.sales * 100 : null,
    spendVsEconomicLimit: snapshot.spend / snapshot.maximumProfitableSpend,
  };
  assertEquals(Number(metrics.ctr.toFixed(2)), 4.17);
  assertEquals(metrics.cpc, 0.6);
  assertEquals(metrics.acos, null, 'ACoS sem vendas deve ser indefinido, não 0%');
  assertEquals(metrics.spendVsEconomicLimit, 3);

  const product = productGate({ status: 'active', fba_inventory: snapshot.availableFba, offer_active: true });
  assert(product.eligible, 'produto com saldo FBA confirmado deve passar pelo gate');

  const decision = classifyDelivery({
    ageHours: 20 * 24,
    metricsFresh: true,
    impressions: snapshot.impressions,
    clicks: snapshot.clicks,
    orders: snapshot.orders,
    sales: snapshot.sales,
    spend: snapshot.spend,
    isManualExact: true,
    isAuto: false,
    maximumProfitableSpend: snapshot.maximumProfitableSpend,
    breakEvenAcos: 25,
    targetAcos: 15,
    matureClicks: snapshot.clicks,
    conversionRate: 0.10,
    safeCpc: 0.30,
    currentCpc: metrics.cpc,
    priorReduction: true,
    persistentLowRelevance: true,
    attributionConfidence: 'complete',
  });
  assertEquals(decision.action, 'profit_guard');
  assertEquals(decision.code, 'NO_CONVERSION_REDUCE_STRONG');
  const reduction = Number(decision.evidence?.recommended_reduction_pct || 0);
  assert(reduction > 0 && reduction <= 0.12, 'redução precisa ser gradual e explicitamente recomendada');

  const proposedBid = Math.round(snapshot.currentBid * (1 - reduction) * 100) / 100;
  assert(proposedBid > 0 && proposedBid < snapshot.currentBid);
  assert(validateAmazonAction({ action: 'reduce_bid', execution_mode: 'EXPEDITED_QUEUE' }).valid);
  const mutation = buildKeywordBidMutation({ keywordId: 'keyword-test-42', bid: proposedBid });
  assertEquals(mutation.method, 'PUT');
  assertEquals(mutation.path, '/sp/keywords');
  assertEquals(mutation.payload.keywords[0].keywordId, 'keyword-test-42');
  assertEquals(mutation.payload.keywords[0].bid, proposedBid);
  const sent: any[] = [];
  const remote = { bid: snapshot.currentBid };
  const fakeAmazonAdsApi = {
    async put(request: any) {
      sent.push(request);
      const attempted = request.payload.keywords[0];
      remote.bid = Number(clampAmazonBid(attempted.bid, 1));
      return {
        status: 200,
        headers: { request_id: 'mock-request-1' },
        payload: { keywords: { success: [{ keywordId: attempted.keywordId }], error: [] } },
      };
    },
  };

  const raw = await fakeAmazonAdsApi.put(mutation);
  const apiResult = normalizeAmazonBatchResponse(raw, mutation.entityKey);
  assert(apiResult.ok, 'resposta de sucesso da API simulada deve ser reconhecida');
  assertEquals(apiResult.request_id, 'mock-request-1');
  assertEquals(sent.length, 1, 'uma decisão deve gerar uma única requisição no cenário');
  assert(amazonBidMatchesExpected(remote.bid, proposedBid), 'o valor remoto simulado deve bater com o proposto');
});

Deno.test('E2E simulado: estoque zero, economia ausente e resposta parcial não são sucesso', async () => {
  const noStock = productGate({ status: 'active', fba_inventory: 0, offer_active: true });
  assertEquals(noStock.eligible, false);
  assertEquals(noStock.code, 'OUT_OF_STOCK');

  const noEconomics = classifyDelivery({
    ageHours: 500,
    metricsFresh: true,
    impressions: 1200,
    clicks: 50,
    orders: 0,
    sales: 0,
    spend: 30,
    isManualExact: true,
    isAuto: false,
    maximumProfitableSpend: 0,
    breakEvenAcos: null,
    targetAcos: 15,
  });
  assertEquals(noEconomics.action, 'monitor');
  assertEquals(noEconomics.code, 'MOTOR_MONITORING_ECONOMICS_MISSING');

  const partial = normalizeAmazonBatchResponse({
    status: 200,
    payload: { keywords: { success: [{ keywordId: 'one' }], error: [{ keywordId: 'two', message: 'rejected' }] } },
  }, 'keywords');
  assertEquals(partial.ok, false, 'sucesso parcial não deve ser contado como lote confirmado');
  assertEquals(partial.errors.length, 1);
  assertEquals(amazonBidMatchesExpected(0.5, 0.6), false, 'valor divergente precisa continuar pendente de confirmação');
});
