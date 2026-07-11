let scheduled = false;

function isDashboardPage() {
  const path = location.pathname.toLowerCase();
  return path === '/' || path.includes('dashboard');
}

function removeMovedCharts() {
  const container = document.querySelector('[data-separated-performance-charts="true"]');
  if (!container) return;

  const children = Array.from(container.children);
  children.slice(2).forEach((child) => {
    child.remove();
  });
}

function removeAiChangesCard() {
  const heading = Array.from(document.querySelectorAll('h2, h3')).find((node) =>
    node.textContent?.trim() === 'Alterações da IA'
  );
  if (!heading) return;

  let card = heading.closest('.bg-surface-1');
  if (!card) card = heading.parentElement;
  if (card) card.remove();
}

function apply() {
  scheduled = false;
  if (!isDashboardPage()) return;
  removeMovedCharts();
  removeAiChangesCard();
}

function schedule() {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(apply);
}

new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });
window.addEventListener('DOMContentLoaded', schedule);
window.addEventListener('popstate', schedule);
window.setTimeout(schedule, 250);
window.setTimeout(schedule, 1000);
