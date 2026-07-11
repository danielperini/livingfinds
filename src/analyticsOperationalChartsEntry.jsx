import React from 'react';
import { createRoot } from 'react-dom/client';
import OperationalPerformanceCharts from '@/components/analytics/OperationalPerformanceCharts';

let scheduled = false;
let mounted = false;

function isAnalyticsPage() {
  return location.pathname.toLowerCase().includes('analytics');
}

function findInsertionPoint() {
  const trend = document.querySelector('[data-acos-tacos-trend-chart="true"]');
  if (trend) return trend;

  const heading = Array.from(document.querySelectorAll('h2')).find((node) =>
    node.textContent?.includes('Tendência de ACoS')
  );
  return heading?.closest('.bg-surface-1') || null;
}

function mount() {
  scheduled = false;
  if (!isAnalyticsPage() || mounted || document.querySelector('[data-analytics-operational-root="true"]')) return;

  const insertionPoint = findInsertionPoint();
  if (!insertionPoint?.parentElement) return;

  const rootNode = document.createElement('div');
  rootNode.dataset.analyticsOperationalRoot = 'true';
  insertionPoint.insertAdjacentElement('afterend', rootNode);
  createRoot(rootNode).render(<OperationalPerformanceCharts />);
  mounted = true;
}

function schedule() {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(mount);
}

new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });
window.addEventListener('DOMContentLoaded', schedule);
window.addEventListener('popstate', () => { mounted = false; schedule(); });
window.setTimeout(schedule, 300);
window.setTimeout(schedule, 1200);
