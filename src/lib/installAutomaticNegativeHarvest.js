import { base44 } from '@/api/base44Client';

const RUN_INTERVAL_MS = 60 * 60 * 1000;
const STORAGE_PREFIX = 'livingfinds:auto-negative:last-run:';

async function resolveAccount() {
  const me = await base44.auth.me();
  let accounts = await base44.entities.AmazonAccount.filter({ user_id: me.id });
  if (!accounts.length) accounts = await base44.entities.AmazonAccount.filter({ status: 'connected' });
  if (!accounts.length) accounts = await base44.entities.AmazonAccount.list('-updated_date', 1);
  return accounts[0] || null;
}

async function runAutomaticNegatives() {
  try {
    const account = await resolveAccount();
    if (!account?.id) return;

    const storageKey = `${STORAGE_PREFIX}${account.id}`;
    const lastRun = Number(localStorage.getItem(storageKey) || 0);
    if (Date.now() - lastRun < RUN_INTERVAL_MS) return;

    localStorage.setItem(storageKey, String(Date.now()));
    const response = await base44.functions.invoke('autoNegateInefficientSearchTerms', {
      amazon_account_id: account.id,
      min_clicks: 10,
      min_spend: 2,
      max_per_run: 30,
    });

    const result = response?.data;
    if (!result?.ok) {
      localStorage.removeItem(storageKey);
      console.warn('[auto-negative]', result?.error || 'Execução não concluída');
      return;
    }

    window.dispatchEvent(new CustomEvent('livingfinds:auto-negative-complete', { detail: result }));
  } catch (error) {
    console.warn('[auto-negative]', error?.message || error);
  }
}

export function installAutomaticNegativeHarvest() {
  if (typeof window === 'undefined' || window.__livingfindsAutomaticNegativeHarvestInstalled) return;
  window.__livingfindsAutomaticNegativeHarvestInstalled = true;

  const schedule = () => window.setTimeout(runAutomaticNegatives, 5000);
  schedule();
  window.addEventListener('focus', schedule);
  window.addEventListener('livingfinds:search-terms-synced', schedule);
  window.setInterval(runAutomaticNegatives, RUN_INTERVAL_MS);
}
