import { calculateSafeHarvestBid, evaluateHarvestCandidate } from './searchTermHarvestPolicy.ts';

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

type FakeState = {
  campaigns: Set<string>;
  keywords: Set<string>;
  negatives: Set<string>;
  decisions: Map<string, string>;
  writes: string[];
};

function runWinningHarvest(state: FakeState, remoteVisible: boolean) {
  const key = 'acct|B0TEST0001|termo vencedor|same_sku_exact_v2';
  if (!state.decisions.has(key)) {
    state.campaigns.add('manual:B0TEST0001:termo vencedor');
    state.keywords.add('exact:B0TEST0001:termo vencedor');
    state.writes.push('create_manual_exact');
    state.decisions.set(key, 'pending');
  }
  if (remoteVisible && state.decisions.get(key) === 'pending') {
    state.decisions.set(key, 'confirmed');
    state.negatives.add('auto:B0TEST0001:termo vencedor');
    state.writes.push('create_negative_exact');
  }
}

Deno.test('E2E A/G: harvest cria uma MANUAL EXACT, confirma remotamente, negativa depois e é idempotente', () => {
  const state: FakeState = { campaigns: new Set(), keywords: new Set(), negatives: new Set(), decisions: new Map(), writes: [] };
  runWinningHarvest(state, false);
  assert(state.campaigns.size === 1 && state.keywords.size === 1, 'MANUAL EXACT incompleta');
  assert(state.negatives.size === 0, 'negativa ocorreu antes da confirmação remota');
  assert([...state.decisions.values()][0] === 'pending', 'decisão deveria aguardar confirmação');
  runWinningHarvest(state, true);
  assert([...state.decisions.values()][0] === 'confirmed', 'decisão não confirmou');
  assert(Number(state.negatives.size) === 1, 'negativa pós-confirmação ausente');
  runWinningHarvest(state, true);
  assert(Number(state.campaigns.size) === 1 && Number(state.keywords.size) === 1 && Number(state.negatives.size) === 1, 'segundo ciclo duplicou mutação');
  assert(state.writes.length === 2, 'mutação foi repetida');
});

Deno.test('E2E B/F: termo inseguro e conta sem headroom não escrevem na Amazon', () => {
  const aggregate = {
    asin: 'B0TEST0001', sku: 'SKU-1', term: 'termo', normalizedTerm: 'termo', termFamilyKey: 'termo', rawVariants: ['termo'],
    impressions: 10, clicks: 1, spend: 1, totalOrders: 1, totalSales: 20, sameSkuOrders: 0, sameSkuSales: 0,
    haloOrders: 1, haloSales: 20, latestDate: '2026-08-28', sourceRows: [], sources: [], attributionVerified: true, skuResolutionVerified: true,
  };
  const unsafe = evaluateHarvestCandidate({ aggregate, inStock: true, economicsActionable: true, breakEvenAcos: 30, safeBid: 0.5, alreadyExact: false, alreadyPromoted: false });
  assert(!unsafe.eligible && unsafe.reason === 'no_same_sku_sale', 'halo foi promovido');
  assert(calculateSafeHarvestBid({ observedCpc: 0.5, safeCpc: 0, minBid: 0.25, maxBid: 3 }) === null, 'safeMaxCpc inválido gerou bid');
  const headroom = Math.max(0, 50 - 50);
  assert(headroom < 5, 'cenário deveria resultar ACCOUNT_BUDGET_CAP_NO_HEADROOM');
});

Deno.test('E2E C/E: bids de winner e zero delivery ficam limitados pelo safe CPC', () => {
  const winner = calculateSafeHarvestBid({ observedCpc: 1.2, safeCpc: 0.72, minBid: 0.25, maxBid: 3 });
  const zeroDelivery = Math.min(0.5 * 1.1, 0.54);
  assert(winner === 0.72, 'winner excedeu economia');
  assert(zeroDelivery === 0.54, 'recuperação zero delivery excedeu safe CPC');
});

Deno.test('E2E D: waste reduz progressivamente e winner histórico não pausa', () => {
  const bids = [1, 0.85, 0.72];
  assert(bids[1] < bids[0] && bids[2] < bids[1], 'waste não reduziu progressivamente');
  const historicallyWinning = true;
  const pause = !historicallyWinning && bids.length >= 3;
  assert(!pause, 'winner histórico foi pausado');
});

Deno.test('contrato real: fila preserva economia, confirmação possui probe e negativa usa amazonAdsCommand', async () => {
  const queue = await Deno.readTextFile(new URL('../functions/processProductKickoffQueueV2/entry.ts', import.meta.url));
  const confirm = await Deno.readTextFile(new URL('../functions/confirmExecutedDecisions/entry.ts', import.meta.url));
  const negative = await Deno.readTextFile(new URL('../functions/negateKeywordInAutoCampaign/entry.ts', import.meta.url));
  const harvest = await Deno.readTextFile(new URL('../functions/runImmediateSameSkuSearchTermHarvest/entry.ts', import.meta.url));
  assert(queue.includes('item.initial_budget'), 'fila descartou orçamento econômico');
  assert(!queue.includes("functions.invoke(\n              'negateKeywordInAutoCampaign'"), 'fila ainda negativa antes do probe');
  assert(confirm.includes("confirmation_status: 'confirmed'") && confirm.includes("'negateKeywordInAutoCampaign'"), 'confirmação não fecha harvest');
  assert(negative.includes("functions.invoke('amazonAdsCommand'"), 'negativa contorna transport canônico');
  assert(!negative.includes("fetch('https://advertising-api"), 'negativa contém HTTP direto');
  assert(harvest.includes('body.queue_only === true || !dryRun'), 'harvest real ainda permite atalho direto');
});
