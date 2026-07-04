const STORAGE_KEY = 'livingfinds:pendingKickoffs';
const LAST_ASIN_KEY = 'livingfinds:lastKickoffAsin';

function normalizeText(value = '') {
  return String(value).replace(/\s+/g, ' ').trim().toLowerCase();
}

function readPending() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'); }
  catch { return {}; }
}

function writePending(value) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
}

function asinFromElement(element) {
  const text = element?.closest('tr')?.textContent || element?.textContent || '';
  return text.match(/B0[A-Z0-9]{8}/i)?.[0]?.toUpperCase() || null;
}

function captureKickoffRequest(event) {
  const button = event.target?.closest?.('button');
  if (!button) return;
  const text = normalizeText(button.textContent);
  if (!text.includes('kick-off') && !text.includes('enviar solicitação') && !text.includes('programar kick-off')) return;
  const asin = asinFromElement(button) || document.body.textContent.match(/B0[A-Z0-9]{8}/i)?.[0]?.toUpperCase();
  if (asin) localStorage.setItem(LAST_ASIN_KEY, asin);
}

function captureSuccessMessage() {
  const bodyText = normalizeText(document.body.textContent);
  const success = bodyText.includes('solicitação enviada') || bodyText.includes('kick-off programado');
  if (!success) return;

  const asin = localStorage.getItem(LAST_ASIN_KEY);
  if (!asin) return;

  const pending = readPending();
  if (!pending[asin]) {
    pending[asin] = { requestedAt: new Date().toISOString() };
    writePending(pending);
  }
}

function patchProductsTable() {
  if (window.location.pathname !== '/products') return;

  captureSuccessMessage();
  const pending = readPending();
  let changedPending = false;

  document.querySelectorAll('tr').forEach((row) => {
    const cells = row.querySelectorAll('td');
    if (cells.length < 3) return;

    const asin = asinFromElement(row);
    if (!asin) return;

    const statusCell = cells[2];
    const statusText = normalizeText(statusCell.textContent);
    const actionsCell = cells[cells.length - 1];
    const isActive = statusText.includes('ativa');
    const isPaused = statusText.includes('pausada');
    const isPending = Boolean(pending[asin]);
    const isUnavailableLinked = statusText.includes('indisponível') && /\.\.\.[a-z0-9]{4,}/i.test(statusCell.textContent || '');

    if ((isActive || isPaused) && pending[asin]) {
      delete pending[asin];
      changedPending = true;
      return;
    }

    if (isPending || isUnavailableLinked) {
      const badge = statusCell.querySelector('span');
      if (badge) {
        badge.textContent = 'Solicitação enviada';
        badge.className = 'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-cyan/10 text-cyan border border-cyan/20';
      }

      if (actionsCell && normalizeText(actionsCell.textContent) !== 'solicitação enviada') {
        actionsCell.innerHTML = '<span class="inline-flex items-center px-2.5 py-1.5 text-xs font-semibold rounded-lg border bg-cyan/10 border-cyan/20 text-cyan whitespace-nowrap">Solicitação enviada</span>';
      }
    }
  });

  if (changedPending) writePending(pending);
}

export function installCampaignInsertionGuard() {
  if (typeof window === 'undefined' || typeof MutationObserver === 'undefined') return;

  document.addEventListener('click', captureKickoffRequest, true);
  const run = () => window.requestAnimationFrame(patchProductsTable);
  document.addEventListener('DOMContentLoaded', run, { once: true });
  window.addEventListener('popstate', run);

  const observer = new MutationObserver(run);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  run();
}
