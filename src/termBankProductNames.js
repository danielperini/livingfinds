import { base44 } from '@/api/base44Client';

let scheduled = false;
let productMap = null;

function resolveProductName(product) {
  return String(
    product?.title
      || product?.product_name
      || product?.name
      || product?.item_name
      || product?.listing_title
      || product?.asin
      || ''
  ).trim();
}

async function loadProductMap() {
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

    productMap = new Map(
      products
        .filter((product) => product?.asin)
        .map((product) => [String(product.asin).trim(), resolveProductName(product)])
        .filter(([, name]) => Boolean(name))
    );
    return productMap;
  } catch {
    return new Map();
  }
}

function findTermBankTable() {
  const heading = Array.from(document.querySelectorAll('h1')).find((node) =>
    node.textContent?.includes('Banco de Termos')
  );
  if (!heading) return null;

  return Array.from(document.querySelectorAll('table')).find((table) => {
    const headers = Array.from(table.querySelectorAll('thead th')).map((cell) => cell.textContent?.trim());
    return headers.includes('Produto / ASIN') && headers.includes('Termo');
  }) || null;
}

function applyNames(map) {
  const table = findTermBankTable();
  if (!table) return;

  const headers = Array.from(table.querySelectorAll('thead th'));
  const productIndex = headers.findIndex((cell) => cell.textContent?.trim() === 'Produto / ASIN');
  if (productIndex < 0) return;

  table.querySelectorAll('tbody tr').forEach((row) => {
    const cell = row.children[productIndex];
    if (!cell) return;

    const asinNode = Array.from(cell.querySelectorAll('*')).find((node) => /^B0[A-Z0-9]{8}$/.test(node.textContent?.trim() || ''));
    const asin = asinNode?.textContent?.trim();
    const name = asin ? map.get(asin) : null;
    if (!name) return;

    const nameNode = cell.querySelector('p');
    if (!nameNode) return;
    nameNode.textContent = name;
    nameNode.title = name;
    nameNode.classList.remove('text-slate-500');
    nameNode.classList.add('text-slate-200');
  });
}

async function apply() {
  scheduled = false;
  if (!location.pathname.toLowerCase().includes('term-bank')) return;
  const map = await loadProductMap();
  if (!map.size) return;
  applyNames(map);
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
window.setTimeout(schedule, 1200);
