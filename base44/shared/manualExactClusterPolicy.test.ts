import {
  areCommerciallyCoherentTerms,
  buildTermLifecycleIdempotencyKey,
  deriveCommercialIntentCluster,
  evaluateManualExactCluster,
} from './manualExactClusterPolicy.ts';

Deno.test('termos de banheiro não são agrupados com escritório', () => {
  if (areCommerciallyCoherentTerms('lixeira automatica banheiro', 'lixeira automatica escritorio')) {
    throw new Error('use cases distintos não podem compartilhar cluster');
  }
});

Deno.test('variações linguísticas equivalentes compartilham intenção', () => {
  if (!areCommerciallyCoherentTerms('fechadura eletronica c alexa', 'fechadura eletronica com alexa')) {
    throw new Error('variações equivalentes deveriam ser coerentes');
  }
});

Deno.test('cluster manual limita no máximo cinco exact e não duplica família', () => {
  const existing = [
    'lixeira automatica banheiro',
    'lixeira sensor banheiro',
    'lixeira inteligente banheiro',
    'lixeira sem toque banheiro',
    'lixeira automatica para banheiro',
  ].map((keywordText) => ({ keywordText, asin: 'B0TEST0001', intentCluster: 'BANHEIRO_AUTOMATICA', maturityStage: 'MANUAL_CLUSTERED' }));

  const capped = evaluateManualExactCluster({
    candidateKeyword: 'lixeira sensor para banheiro',
    candidateAsin: 'B0TEST0001',
    candidateIntentCluster: 'BANHEIRO_AUTOMATICA',
    existingKeywords: existing,
  });
  if (capped.allowed || capped.reason !== 'MANUAL_CLUSTER_CAP_REACHED') throw new Error(`cap incorreto: ${capped.reason}`);

  const duplicate = evaluateManualExactCluster({
    candidateKeyword: 'fechadura eletronica com alexa',
    candidateAsin: 'B0TEST0002',
    existingKeywords: [{ keywordText: 'fechadura eletronica c alexa', asin: 'B0TEST0002' }],
  });
  if (duplicate.allowed || duplicate.reason !== 'TERM_FAMILY_ALREADY_COVERED') throw new Error(`duplicidade não detectada: ${duplicate.reason}`);
});

Deno.test('winner exige campanha singleton', () => {
  const result = evaluateManualExactCluster({
    candidateKeyword: 'lixeira automatica banheiro',
    candidateAsin: 'B0TEST0001',
    candidateMaturityStage: 'WINNER',
    winnerIsolation: true,
    existingKeywords: [{ keywordText: 'lixeira sensor banheiro', asin: 'B0TEST0001' }],
  });
  if (result.allowed || result.reason !== 'WINNER_REQUIRES_SINGLETON_CAMPAIGN') throw new Error('winner não foi isolado');
});

Deno.test('idempotência usa família do termo e transição', () => {
  const a = buildTermLifecycleIdempotencyKey({ accountId: 'A', asin: 'B0X', termFamily: 'fechadura eletronica c alexa', transition: 'PROMOTION_CANDIDATE', action: 'CREATE_EXACT', window: '2026-08-12' });
  const b = buildTermLifecycleIdempotencyKey({ accountId: 'A', asin: 'B0X', termFamily: 'fechadura eletronica com alexa', transition: 'PROMOTION_CANDIDATE', action: 'CREATE_EXACT', window: '2026-08-12' });
  if (a !== b) throw new Error('variantes da mesma família devem colidir na mesma idempotência');
});

Deno.test('deriva intenção explícita de uso', () => {
  const key = deriveCommercialIntentCluster('lixeira automatica banheiro');
  if (!key.includes('BANHEIRO')) throw new Error(`intenção inesperada: ${key}`);
});
