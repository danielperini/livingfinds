import { strict as assert } from 'node:assert';
import {
  calculateFactoryIntentScore,
  campaignFactoryPlanKey,
  extractFactorySearchTermSignal,
  isFactoryEconomicallyHealthy,
} from './campaignFactorySignals.ts';

Deno.test('Factory lê os campos canônicos do relatório de search terms', () => {
  const signal = extractFactorySearchTermSignal({
    search_term: 'lixeira automática com sensor',
    advertised_asin: 'b0abc12345',
    orders_14d: 2,
    sales_14d: 180,
    clicks: 12,
    spend: 24,
    campaign_id: '123',
  });
  assert.equal(signal.keyword, 'lixeira automática com sensor');
  assert.equal(signal.asin, 'B0ABC12345');
  assert.equal(signal.metrics.orders, 2);
  assert.equal(signal.metrics.sales, 180);
});

Deno.test('Factory preserva compatibilidade com aliases legados', () => {
  const signal = extractFactorySearchTermSignal({
    query: 'moedor de café elétrico',
    asin: 'B0LEGACY01',
    orders: 1,
    sales: 69.9,
  });
  assert.equal(signal.keyword, 'moedor de café elétrico');
  assert.equal(signal.asin, 'B0LEGACY01');
  assert.equal(signal.metrics.orders, 1);
});

Deno.test('Intent mede cobertura da keyword e não o tamanho do título', () => {
  const score = calculateFactoryIntentScore(
    'interruptor inteligente sem neutro',
    'Interruptor Inteligente WiFi Touch 1 Botão Sem Neutro Automação Residencial',
    'Casa inteligente',
  );
  assert.ok(score >= 72, `score esperado >=72, recebido ${score}`);
  assert.ok(calculateFactoryIntentScore('microfone lapela', 'Interruptor inteligente WiFi', 'Casa') < 30);
});

Deno.test('Hash de plano é independente do hash operacional do Keyword Bank', () => {
  assert.equal(
    campaignFactoryPlanKey('b0abc12345', 'Lixeira Automática', 'EXACT'),
    'BR|B0ABC12345|lixeira automatica|exact|CAMPAIGN_FACTORY',
  );
});

Deno.test('Venda atribuída sem gasto não é descartada do Harvest', () => {
  assert.ok(isFactoryEconomicallyHealthy({ sales: 89.9, spend: 0, acos: 0 }, 25));
  assert.ok(!isFactoryEconomicallyHealthy({ sales: 100, spend: 40, acos: 0 }, 25));
});
