import React from 'react';
import { createRoot } from 'react-dom/client';
import SeparatedPerformanceCharts from '@/components/dashboard/SeparatedPerformanceCharts';

let mountedRoot = null;
let mountedContainer = null;
let scheduled = false;

function findLegacyPerformanceCard() {
  const headings = Array.from(document.querySelectorAll('h2'));
  const heading = headings.find((node) => {
    const title = node.textContent?.trim();
    return title === 'Gasto · Vendas · Faturamento Real'
      || title === 'Gasto Vendas Cliques Impressões e IA'
      || title === 'Gasto e Vendas Ads';
  });
  return heading?.closest('.bg-surface-1') || null;
}

function mountSeparatedCharts() {
  scheduled = false;
  const legacyCard = findLegacyPerformanceCard();
  if (!legacyCard) return;

  legacyCard.style.display = 'none';
  legacyCard.setAttribute('aria-hidden', 'true');

  if (mountedContainer?.isConnected && mountedRoot) return;

  const existing = document.querySelector('[data-dashboard-separated-charts-root="true"]');
  if (existing) {
    mountedContainer = existing;
    return;
  }

  const container = document.createElement('div');
  container.setAttribute('data-dashboard-separated-charts-root', 'true');
  container.className = 'contents';
  legacyCard.insertAdjacentElement('afterend', container);

  mountedContainer = container;
  mountedRoot = createRoot(container);
  mountedRoot.render(<SeparatedPerformanceCharts />);
}

function scheduleMount() {
  if (scheduled) return;
  scheduled = true;
  window.requestAnimationFrame(mountSeparatedCharts);
}

const observer = new MutationObserver(scheduleMount);
observer.observe(document.documentElement, { childList: true, subtree: true });
window.addEventListener('DOMContentLoaded', scheduleMount);
window.addEventListener('popstate', scheduleMount);
window.setTimeout(scheduleMount, 250);
window.setTimeout(scheduleMount, 1000);
