import { base44 } from '@/api/base44Client';

let scheduled = false;
let productMap = null;

function productName(product) {
  return String(
    product?.title
      || product?.product_name
      || product?.name
      || product?.item_name
      || product?.listing_title
      || product?.asin
      || 'Produto sem nome'
  ).trim();
}

function shortName(value, max = 30) {
  const text = String(value || '');
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

async function loadProducts() {
  if (productMap) return productMap;
  try {
    const me = await base44.auth.me();
    let accounts = await base44.entities.AmazonAccount.filter({ user_id: me.id });
    if (!accounts.length) accounts = await base44.entities.AmazonAccount.list();
    const account = accounts[0];
    if (!account) return new Map();

    const products = await base44.entities.Product.filter(
      { amazon_account_id: account.id },
      '-updated_at',
      2000
    );
    productMap = new Map(products.filter((p) => p.asin).map((p) => [String(p.asin).trim(), productName(p)]));
    return productMap;
  } catch {
    return new Map();
  }
}

function findCard(title) {
  const heading = Array.from(document.querySelectorAll('h2')).find((node) =>
    node.textContent?.includes(title)
  );
  return heading?.closest('.bg-surface-1') || heading?.parentElement?.parentElement || null;
}

function enhanceTopProductsChart(map) {
  const card = findCard('Receita & Spend por Produto');
  if (!card || card.dataset.replacedTopFive === 'true') return;

  card.querySelectorAll('svg text').forEach((node) => {
    const asin = node.textContent?.trim();
    const name = map.get(asin);
    if (!name) return;
    node.textContent = shortName(name);
    node.setAttribute('title', name);
  });
}

function enhanceProductTable(map) {
  const card = findCard('Resumo de Performance por Produto');
  const table = card?.querySelector('table');
  if (!table) return;

  const headerRow = table.querySelector('thead tr');
  const headers = Array.from(headerRow?.children || []);
  if (!headers.length) return;

  let titleIndex = headers.findIndex((cell) => ['Título do produto', 'Nome do produto'].includes(cell.textContent?.trim()));
  let asinIndex = headers.findIndex((cell) => cell.textContent?.trim() === 'ASIN');
  if (asinIndex < 0) return;

  if (titleIndex < 0) {
    const th = document.createElement('th');
    th.textContent = 'Título do produto';
    th.className = headers[asinIndex].className;
    headerRow.insertBefore(th, headers[asinIndex]);
    titleIndex = asinIndex;
    asinIndex += 1;
  } else {
    headerRow.children[titleIndex].textContent = 'Título do produto';
  }

  table.querySelectorAll('tbody tr').forEach((row) => {
    const cells = Array.from(row.children);
    if (!cells.length || cells.length === 1) return;

    const asinCellIndex = cells.findIndex((cell) => /^B0[A-Z0-9]{8}$/.test(cell.textContent?.trim() || ''));
    if (asinCellIndex < 0) return;

    const asin = cells[asinCellIndex].textContent.trim();
    const name = map.get(asin);
    if (!name) return;

    const existingTitleCell = cells.length === headerRow.children.length ? cells[titleIndex] : null;
    const existingLooksLikeTitle = existingTitleCell && !/^B0[A-Z0-9]{8}$/.test(existingTitleCell.textContent?.trim() || '');

    if (existingLooksLikeTitle) {
      existingTitleCell.textContent = name;
      existingTitleCell.title = name;
      existingTitleCell.className = 'px-4 py-3 text-slate-200 min-w-[240px]';
    } else {
      const td = document.createElement('td');
      td.textContent = name;
      td.title = name;
      td.className = 'px-4 py-3 text-slate-200 min-w-[240px]';
      row.insertBefore(td, row.children[titleIndex] || null);
    }

    row.dataset.productNameEnhanced = 'true';
  });

  const emptyCell = table.querySelector('tbody td[colspan]');
  if (emptyCell) emptyCell.setAttribute('colspan', String(headerRow.children.length));
}

async function apply() {
  scheduled = false;
  if (!location.pathname.toLowerCase().includes('analytics')) return;
  const map = await loadProducts();
  if (!map.size) return;
  enhanceTopProductsChart(map);
  enhanceProductTable(map);
}

function schedule() {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(apply);
}

new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });
window.addEventListener('DOMContentLoaded', schedule);
window.addEventListener('popstate', schedule);
window.setTimeout(schedule, 400);
window.setTimeout(schedule, 1400);
