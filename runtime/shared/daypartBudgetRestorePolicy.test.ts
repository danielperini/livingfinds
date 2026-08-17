import { decideDaypartBudgetRestore } from './daypartBudgetRestorePolicy.ts';

const assert = (condition: boolean, message: string) => { if (!condition) throw new Error(message); };

Deno.test('restaura somente redução feita pelo app em janela de bid', () => {
  const result = decideDaypartBudgetRestore({
    currentBudget: 5,
    baselineBudget: 15,
    currentSpend: 1,
    minimumCampaignBudget: 15,
    remainingAccountBudget: 50,
    accountHardCap: false,
    bidOnlyWindow: true,
    pauseWindow: false,
    active: true,
    inStock: true,
    appReducedBudget: true,
  });
  assert(result.eligible, 'deveria restaurar');
  assert(result.targetBudget === 15, 'deveria retornar ao baseline');
});

Deno.test('não restaura durante pausa programada', () => {
  const result = decideDaypartBudgetRestore({
    currentBudget: 5, baselineBudget: 15, currentSpend: 0, minimumCampaignBudget: 15,
    remainingAccountBudget: 100, accountHardCap: false, bidOnlyWindow: true,
    pauseWindow: true, active: true, inStock: true, appReducedBudget: true,
  });
  assert(!result.eligible && result.reason === 'NOT_BID_ONLY_WINDOW', 'pausa deve bloquear');
});

Deno.test('não ignora hard cap da conta', () => {
  const result = decideDaypartBudgetRestore({
    currentBudget: 5, baselineBudget: 15, currentSpend: 0, minimumCampaignBudget: 15,
    remainingAccountBudget: 100, accountHardCap: true, bidOnlyWindow: true,
    pauseWindow: false, active: true, inStock: true, appReducedBudget: true,
  });
  assert(!result.eligible && result.reason === 'ACCOUNT_HARD_CAP', 'hard cap deve bloquear');
});

Deno.test('não altera budget sem evidência de redução pelo LivingFinds', () => {
  const result = decideDaypartBudgetRestore({
    currentBudget: 5, baselineBudget: 15, currentSpend: 0, minimumCampaignBudget: 15,
    remainingAccountBudget: 100, accountHardCap: false, bidOnlyWindow: true,
    pauseWindow: false, active: true, inStock: true, appReducedBudget: false,
  });
  assert(!result.eligible && result.reason === 'NO_APP_REDUCTION_EVIDENCE', 'não deve adivinhar baseline');
});
