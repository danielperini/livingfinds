function normalizeText(value = '') {
  return String(value).replace(/\s+/g, ' ').trim().toLowerCase();
}

function patchProductsTable() {
  if (window.location.pathname !== '/products') return;

  document.querySelectorAll('tr').forEach((row) => {
    const cells = row.querySelectorAll('td');
    if (cells.length < 3) return;

    const statusCell = cells[2];
    const statusText = normalizeText(statusCell.textContent);
    const hasLinkedCampaignId = /\.\.\.[a-z0-9]{4,}/i.test(statusCell.textContent || '');

    if (statusText.includes('indisponível') && hasLinkedCampaignId) {
      const badge = statusCell.querySelector('span');
      if (badge) {
        badge.textContent = 'Em inserção';
        badge.className = 'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-cyan/10 text-cyan border border-cyan/20';
      }

      const actionsCell = cells[cells.length - 1];
      if (actionsCell && normalizeText(actionsCell.textContent) !== 'aguardar inserção') {
        actionsCell.innerHTML = '<span class="inline-flex items-center px-2.5 py-1.5 text-xs font-semibold rounded-lg border bg-cyan/10 border-cyan/20 text-cyan whitespace-nowrap">Aguardar inserção</span>';
      }
    }
  });
}

export function installCampaignInsertionGuard() {
  if (typeof window === 'undefined' || typeof MutationObserver === 'undefined') return;

  const run = () => window.requestAnimationFrame(patchProductsTable);
  document.addEventListener('DOMContentLoaded', run, { once: true });
  window.addEventListener('popstate', run);

  const observer = new MutationObserver(run);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  run();
}
