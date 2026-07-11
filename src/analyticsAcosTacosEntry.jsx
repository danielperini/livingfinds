import React from 'react';
import { createRoot } from 'react-dom/client';
import AcosTacosTrendChart from '@/components/analytics/AcosTacosTrendChart';

let mountedRoot = null;
let mountedContainer = null;
let scheduled = false;

function findLegacyTrendCard() {
  const heading = Array.from(document.querySelectorAll('h2')).find((node) =>
    node.textContent?.trim().startsWith('Tendência de ACoS')
  );
  return heading?.closest('.bg-surface-1') || null;
}

function mountChart() {
  scheduled = false;
  const legacyCard = findLegacyTrendCard();
  if (!legacyCard) return;

  legacyCard.style.display = 'none';
  legacyCard.setAttribute('aria-hidden', 'true');

  if (mountedContainer?.isConnected && mountedRoot) return;

  const existing = document.querySelector('[data-analytics-acos-tacos-root="true"]');
  if (existing) {
    mountedContainer = existing;
    return;
  }

  const container = document.createElement('div');
  container.setAttribute('data-analytics-acos-tacos-root', 'true');
  legacyCard.insertAdjacentElement('afterend', container);

  mountedContainer = container;
  mountedRoot = createRoot(container);
  mountedRoot.render(<AcosTacosTrendChart />);
}

function scheduleMount() {
  if (scheduled) return;
  scheduled = true;
  window.requestAnimationFrame(mountChart);
}

const observer = new MutationObserver(scheduleMount);
observer.observe(document.documentElement, { childList: true, subtree: true });
window.addEventListener('DOMContentLoaded', scheduleMount);
window.addEventListener('popstate', scheduleMount);
window.setTimeout(scheduleMount, 250);
window.setTimeout(scheduleMount, 1000);
