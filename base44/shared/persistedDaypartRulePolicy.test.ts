import { assert, assertEquals } from 'jsr:@std/assert@1';
import { bidMultiplierForRule, campaignMatchesRule, ruleMatchesNow } from './persistedDaypartRulePolicy.ts';

Deno.test('aplica janela noturna que cruza meia-noite em dia útil', () => {
  const rule = {
    status: 'enabled', timezone: 'America/Sao_Paulo',
    days_of_week: ['WEDNESDAY'], holiday_mode: 'IGNORE', holiday_dates: [],
    start_time: '23:59', end_time: '03:00',
  };
  assert(ruleMatchesNow(rule, new Date('2026-08-06T03:30:00.000Z'))); // 00:30 BRT de quinta: janela iniciada na quarta
});

Deno.test('aplica regra de fim de semana também em feriado', () => {
  const rule = {
    status: 'enabled', timezone: 'America/Sao_Paulo',
    days_of_week: ['SATURDAY', 'SUNDAY'], holiday_mode: 'WEEKEND_POLICY',
    holiday_dates: ['2026-09-07'], start_time: '00:00', end_time: '23:59',
  };
  assert(ruleMatchesNow(rule, new Date('2026-09-07T15:00:00.000Z')));
});

Deno.test('regra pausada nunca executa', () => {
  assertEquals(ruleMatchesNow({ status: 'paused', days_of_week: ['WEDNESDAY'], start_time: '00:00', end_time: '23:59' }, new Date('2026-08-05T15:00:00.000Z')), false);
});

Deno.test('respeita escopo por campanha e targeting AUTO', () => {
  const rule = { scope_type: 'SELECTED', campaign_ids: ['123'], targeting_types: ['AUTO'] };
  assert(campaignMatchesRule(rule, { campaign_id: '123', targeting_type: 'AUTO' }));
  assertEquals(campaignMatchesRule(rule, { campaign_id: '456', targeting_type: 'AUTO' }), false);
  assertEquals(campaignMatchesRule(rule, { campaign_id: '123', targeting_type: 'MANUAL' }), false);
});

Deno.test('converte ajuste percentual em multiplicador', () => {
  assertEquals(bidMultiplierForRule({ adjustment_value: -60 }), 0.4);
  assertEquals(bidMultiplierForRule({ adjustment_value: -50 }), 0.5);
  assertEquals(bidMultiplierForRule({ adjustment_value: 0 }), 1);
});
