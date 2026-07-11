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

function findCard(title) {
  const heading = Array.from(document.querySelectorAll('h2')).find((node) =>
    node.textContent?.includes(title)
  );
  return heading?.closest('.bg-surface-1') || heading?.parentElement?.parentElement || null;
}

function extractAsin(text) {
  return String(text || '').match(/\bB0[A-Z0-9]{8}\b/)?.[0] || null;
}

function enhanceTopCampaigns(map) {
  const card = findCard('Top campanhas por gasto');
  if (!card) return;

  card.querySelectorAll('p').forEach((node) => {
    const original = node.textContent?.trim() || '';
    const asin = extractAsin(original);
    const name = asin ? map.get(asin) : null;
    if (!name || node.dataset.productNameEnhanced === 'true') return;

    const suffix = original.replace(asin, '').replace(/^\s*\|\s*/, '').trim();
    node.textContent = suffix ? `${name} · ${suffix}` : name;
    node.title = `${name} · ${asin}${suffix ? ` · ${suffix}` : ''}`;
    node.dataset.productNameEnhanced = 'true';

    const asinLine = document.createElement('p');
    asinLine.textContent = asin;
    asinLine.className = 'text-[9px] text-cyan font-mono mt-0.5';
    node.insertAdjacentElement('afterend', asinLine);
  });
}

function enhanceProductHealth(map) {
  const card = findCard('Saúde dos produtos');
  if (!card) return;

  card.querySelectorAll('span').forEach((node) => {
    const asin = extractAsin(node.textContent?.trim());
    const name = asin ? map.get(asin) : null;
    if (!name || node.dataset.productNameEnhanced === 'true') return;

    node.textContent = name;
    node.title = `${name} · ${asin}`;
    node.dataset.productNameEnhanced = 'true';

    const asinLine = document.createElement('span');
    asinLine.textContent = asin;
    asinLine.className = 'text-[9px] text-cyan font-mono block';
    node.insertAdjacentElement('afterend', asinLine);
  });
}

async function apply() {
  scheduled = false;
  if (location.pathname !== '/' && !location.pathname.toLowerCase().includes('dashboard')) return;
  const map = await loadProductMap();
  if (!map.size) return;
  enhanceTopCampaigns(map);
  enhanceProductHealth(map);
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
