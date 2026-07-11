const DESKTOP_BREAKPOINT = 1024;
let scheduled = false;

function findDashboardRoot() {
  const heading = Array.from(document.querySelectorAll('h1')).find((node) =>
    /^(Bom dia|Boa tarde|Boa noite),/.test(node.textContent?.trim() || '')
  );
  if (!heading) return null;

  let current = heading.parentElement;
  while (current && current !== document.body) {
    if (current.classList?.contains('space-y-4')) return current;
    current = current.parentElement;
  }
  return null;
}

function directChildFor(node, root) {
  if (!node || !root) return null;
  let current = node;
  while (current?.parentElement && current.parentElement !== root) {
    current = current.parentElement;
  }
  return current?.parentElement === root ? current : null;
}

function findByText(root, selector, texts) {
  const accepted = Array.isArray(texts) ? texts : [texts];
  return Array.from(root.querySelectorAll(selector)).find((node) => {
    const value = node.textContent?.trim() || '';
    return accepted.some((text) => value === text || value.includes(text));
  });
}

function setPlacement(root, node, order, span) {
  const child = directChildFor(node, root);
  if (!child) return;
  child.dataset.dashboardLayoutManaged = 'true';
  child.style.order = String(order);
  child.style.gridColumn = `span ${span} / span ${span}`;
  child.style.minWidth = '0';
}

function resetLayout(root) {
  root.removeAttribute('data-dashboard-logical-layout');
  root.style.removeProperty('display');
  root.style.removeProperty('grid-template-columns');
  root.style.removeProperty('gap');
  root.style.removeProperty('align-items');

  Array.from(root.children).forEach((child) => {
    if (child.dataset.dashboardLayoutManaged === 'true') {
      child.style.removeProperty('order');
      child.style.removeProperty('grid-column');
      child.style.removeProperty('min-width');
      delete child.dataset.dashboardLayoutManaged;
    }
  });
}

function applySeparatedChartsLayout() {
  const container = document.querySelector('[data-separated-performance-charts="true"]');
  if (!container) return;

  const children = Array.from(container.children);
  if (window.innerWidth < DESKTOP_BREAKPOINT) {
    container.style.removeProperty('display');
    container.style.removeProperty('grid-template-columns');
    container.style.removeProperty('gap');
    children.forEach((child) => {
      child.style.removeProperty('grid-column');
      child.style.removeProperty('order');
      child.style.removeProperty('min-width');
    });
    return;
  }

  container.style.display = 'grid';
  container.style.gridTemplateColumns = 'repeat(12, minmax(0, 1fr))';
  container.style.gap = '1rem';

  children.forEach((child) => {
    child.style.minWidth = '0';
    child.style.order = '3';
    child.style.gridColumn = '1 / -1';
  });

  if (children[0]) {
    children[0].style.order = '1';
    children[0].style.gridColumn = 'span 4 / span 4';
  }
  if (children[1]) {
    children[1].style.order = '1';
    children[1].style.gridColumn = 'span 8 / span 8';
  }
  if (children[2]) {
    children[2].style.order = '2';
    children[2].style.gridColumn = '1 / -1';
  }
  if (children[3]) {
    children[3].style.order = '3';
    children[3].style.gridColumn = '1 / -1';
  }
}

function applyDashboardLayout() {
  scheduled = false;
  const root = findDashboardRoot();
  if (!root) return;

  if (window.innerWidth < DESKTOP_BREAKPOINT) {
    resetLayout(root);
    applySeparatedChartsLayout();
    return;
  }

  root.dataset.dashboardLogicalLayout = 'true';
  root.style.display = 'grid';
  root.style.gridTemplateColumns = 'repeat(12, minmax(0, 1fr))';
  root.style.gap = '1rem';
  root.style.alignItems = 'start';

  Array.from(root.children).forEach((child, index) => {
    child.dataset.dashboardLayoutManaged = 'true';
    child.style.order = String(100 + index);
    child.style.gridColumn = '1 / -1';
    child.style.minWidth = '0';
  });

  const header = root.querySelector('h1');
  setPlacement(root, header, 1, 12);

  setPlacement(root, findByText(root, '*', 'Dashboard e IA sincronizados'), 2, 4);
  setPlacement(root, findByText(root, '*', 'Sincronização das APIs'), 2, 8);
  setPlacement(root, findByText(root, '*', 'próxima em 5min'), 3, 12);

  const separated = root.querySelector('[data-dashboard-separated-charts-root="true"]');
  setPlacement(root, separated, 4, 12);

  setPlacement(root, findByText(root, 'h2', ['Faturamento x Mês Anterior', 'Comparação mês atual vs mês anterior']), 5, 7);
  setPlacement(root, findByText(root, 'h2', 'Metas de Performance Aplicadas'), 5, 5);

  setPlacement(root, findByText(root, 'h2', 'Resumo de performance'), 6, 12);

  setPlacement(root, findByText(root, 'h2', 'Alterações da IA'), 7, 4);
  setPlacement(root, findByText(root, 'h2', 'Top campanhas por gasto'), 7, 8);

  setPlacement(root, findByText(root, 'h2', 'Saúde dos produtos'), 8, 6);
  setPlacement(root, findByText(root, 'h2', 'Eficiência operacional'), 8, 6);

  setPlacement(root, findByText(root, 'h2', 'Orçamento e pacing'), 9, 6);
  setPlacement(root, findByText(root, 'h2', 'Metas vs realidade'), 9, 6);

  setPlacement(root, findByText(root, 'h2', 'Decisões e automação'), 10, 12);

  applySeparatedChartsLayout();
}

function scheduleApply() {
  if (scheduled) return;
  scheduled = true;
  window.requestAnimationFrame(applyDashboardLayout);
}

const style = document.createElement('style');
style.textContent = `
  [data-dashboard-logical-layout="true"] > * {
    margin-top: 0 !important;
  }
  @media (min-width: 1024px) {
    [data-dashboard-logical-layout="true"] [data-dashboard-separated-charts-root="true"] {
      min-width: 0;
    }
  }
`;
document.head.appendChild(style);

const observer = new MutationObserver(scheduleApply);
observer.observe(document.documentElement, { childList: true, subtree: true });
window.addEventListener('DOMContentLoaded', scheduleApply);
window.addEventListener('resize', scheduleApply);
window.addEventListener('popstate', scheduleApply);
window.setTimeout(scheduleApply, 300);
window.setTimeout(scheduleApply, 1200);
