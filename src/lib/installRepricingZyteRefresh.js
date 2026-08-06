import { base44 } from '@/api/base44Client';

const BUTTON_ID = 'lf-zyte-competitor-refresh';
let running = false;

async function resolveAccountId() {
  const me = await base44.auth.me();
  let accounts = await base44.entities.AmazonAccount.filter({ user_id: me.id }).catch(() => []);
  if (!accounts.length) accounts = await base44.entities.AmazonAccount.filter({ status: 'connected' }).catch(() => []);
  if (!accounts.length) accounts = await base44.entities.AmazonAccount.list('-updated_date', 1).catch(() => []);
  return accounts[0]?.id || null;
}

function setButtonState(button, text, disabled) {
  button.textContent = text;
  button.disabled = disabled;
  button.style.opacity = disabled ? '0.65' : '1';
  button.style.cursor = disabled ? 'wait' : 'pointer';
}

async function runRefresh(button) {
  if (running) return;
  running = true;
  setButtonState(button, 'Consultando Zyte...', true);
  try {
    const accountId = await resolveAccountId();
    if (!accountId) throw new Error('Conta Amazon não encontrada.');
    const response = await base44.functions.invoke('refreshZyteCompetitorResearch', {
      amazon_account_id: accountId,
      max_products: 20,
    });
    const payload = response?.data || response;
    if (!payload?.ok) throw new Error(payload?.error || 'Falha ao consultar concorrentes pela Zyte.');
    const result = payload.results?.[0] || {};
    setButtonState(button, `${result.populated || 0} SKUs atualizados`, true);
    window.setTimeout(() => window.location.reload(), 1200);
  } catch (error) {
    setButtonState(button, `Erro: ${String(error?.message || error).slice(0, 90)}`, false);
    window.setTimeout(() => setButtonState(button, 'Atualizar concorrência Zyte', false), 8000);
  } finally {
    running = false;
  }
}

function installButton() {
  if (window.location.pathname !== '/repricing' || document.getElementById(BUTTON_ID)) return;
  const headings = [...document.querySelectorAll('h1')];
  const heading = headings.find((node) => node.textContent?.trim() === 'Repricing');
  if (!heading) return;
  const header = heading.closest('div.flex.flex-col') || heading.parentElement?.parentElement;
  const actions = header?.querySelector('div.flex.flex-wrap.gap-2');
  if (!actions) return;

  const button = document.createElement('button');
  button.id = BUTTON_ID;
  button.type = 'button';
  button.className = 'inline-flex items-center justify-center gap-2 rounded-lg border border-violet-500/30 bg-violet-500/10 px-3 py-2 text-xs font-semibold text-violet-300 disabled:opacity-50';
  button.textContent = 'Atualizar concorrência Zyte';
  button.title = 'Consulta páginas públicas da Amazon via Zyte e persiste somente preços reais de produtos equivalentes.';
  button.addEventListener('click', () => runRefresh(button));
  actions.prepend(button);
}

export function installRepricingZyteRefresh() {
  if (typeof window === 'undefined') return;
  const observer = new MutationObserver(installButton);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener('popstate', installButton);
  window.setInterval(installButton, 1500);
  installButton();
}
