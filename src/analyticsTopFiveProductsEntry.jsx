import React from 'react';
import { createRoot } from 'react-dom/client';
import TopFiveProductRevenueChart from '@/components/analytics/TopFiveProductRevenueChart';

let scheduled = false;
let root = null;

function findLegacyCard() {
  const heading = Array.from(document.querySelectorAll('h2')).find((node) =>
    node.textContent?.includes('Receita & Spend por Produto')
      && !node.textContent?.includes('Top 5')
  );
  return heading?.closest('.bg-surface-1') || heading?.parentElement?.parentElement || null;
}

function mount() {
  scheduled = false;
  if (!location.pathname.toLowerCase().includes('analytics')) return;
  if (document.querySelector('[data-top-five-product-chart="true"]')) return;

  const legacyCard = findLegacyCard();
  if (!legacyCard) return;

  const host = document.createElement('div');
  host.dataset.topFiveProductChartHost = 'true';
  legacyCard.replaceWith(host);
  root = createRoot(host);
  root.render(<TopFiveProductRevenueChart />);
}

function scheduleMount() {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(mount);
}

new MutationObserver(scheduleMount).observe(document.documentElement, { childList: true, subtree: true });
window.addEventListener('DOMContentLoaded', scheduleMount);
window.addEventListener('popstate', scheduleMount);
window.setTimeout(scheduleMount, 400);
window.setTimeout(scheduleMount, 1400);
