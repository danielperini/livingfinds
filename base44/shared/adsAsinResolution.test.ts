import { assertEquals } from 'jsr:@std/assert@1.0.14';
import {
  buildCampaignAsinIndex,
  buildKeywordAsinIndex,
  normalizeAsin,
  normalizeNegativeMatchType,
  resolveAdsAsin,
} from './adsAsinResolution.ts';

Deno.test('normaliza somente ASINs validos', () => {
  assertEquals(normalizeAsin(' b0ghp9ppwn '), 'B0GHP9PPWN');
  assertEquals(normalizeAsin('invalido'), '');
});

Deno.test('resolve ASIN por keyword e depois por campanha canonica', () => {
  const campaigns = buildCampaignAsinIndex(
    [{ campaign_id: 'c1', asin: 'B0GHP9PPWN' }],
    [{ campaign_id: 'c2', asin: 'B0FCYR3VBD' }],
  );
  const keywords = buildKeywordAsinIndex([{ keyword_id: 'k1', asin: 'B0ABC12345' }]);
  assertEquals(resolveAdsAsin({ keyword_id: 'k1', campaign_id: 'c1' }, keywords, campaigns), 'B0ABC12345');
  assertEquals(resolveAdsAsin({ keyword_id: 'k2', campaign_id: 'c1' }, keywords, campaigns), 'B0GHP9PPWN');
});

Deno.test('nao atribui ASIN quando a campanha anuncia mais de um produto', () => {
  const campaigns = buildCampaignAsinIndex([], [
    { campaign_id: 'multi', asin: 'B0GHP9PPWN' },
    { campaign_id: 'multi', asin: 'B0FCYR3VBD' },
  ]);
  assertEquals(campaigns.has('multi'), false);
  assertEquals(resolveAdsAsin({ campaign_id: 'multi' }, new Map(), campaigns), '');
});

Deno.test('normaliza tipos negativos sem duplicar o prefixo', () => {
  assertEquals(normalizeNegativeMatchType('NEGATIVE_EXACT'), 'negative_exact');
  assertEquals(normalizeNegativeMatchType('phrase'), 'negative_phrase');
});
