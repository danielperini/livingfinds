let scheduled = false;

function findDuplicateImpressionsCard() {
  const heading = Array.from(document.querySelectorAll('h2')).find((node) =>
    /^Impressões por Dia\s*\(/.test(node.textContent?.trim() || '')
  );
  if (!heading) return null;
  return heading.closest('.bg-surface-1') || heading.parentElement?.parentElement || null;
}

function removeDuplicateImpressionsCard() {
  scheduled = false;
  if (!location.pathname.toLowerCase().includes('analytics')) return;
  const card = findDuplicateImpressionsCard();
  if (card) card.remove();
}

function scheduleRemoval() {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(removeDuplicateImpressionsCard);
}

new MutationObserver(scheduleRemoval).observe(document.documentElement, {
  childList: true,
  subtree: true,
});

window.addEventListener('DOMContentLoaded', scheduleRemoval);
window.addEventListener('popstate', scheduleRemoval);
window.setTimeout(scheduleRemoval, 300);
window.setTimeout(scheduleRemoval, 1200);
