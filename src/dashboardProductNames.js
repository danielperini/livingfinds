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

function makeAsinLine(tagName, asin) {
  const line = document.createElement(tagName);
  line.textContent = asin;
  line.dataset.generatedProductAsin = 'true';
  line.setAttribute('aria-hidden', 'true');
  line.className = tagName === 'p'
    ? 'text-[9px] text-cyan font-mono mt-0.5 truncate max-w-full overflow-hidden whitespace-nowrap'
    : 'text-[9px] text-cyan font-mono block truncate max-w-full overflow-hidden whitespace-nowrap';
  return line;
}

function enhanceTopCampaigns(map) {
  const card = findCard('Top campanhas por gasto');
  if (!card) return;

  card.style.overflow = 'hidden';
  card.style.maxWidth = '100%';

  card.querySelectorAll('p').forEach((node) => {
    if (node.dataset.generatedProductAsin === 'true') return;
    if (node.dataset.productNameEnhanced === 'true') return;

    const original = node.textContent?.trim() || '';
    const asin = extractAsin(original);
    const name = asin ? map.get(asin) : null;
    if (!name) return;

    const suffix = original.replace(asin, '').replace(/^\s*\|\s*/, '').trim();
    node.textContent = suffix ? `${name} · ${suffix}` : name;
    node.title = `${name} · ${asin}${suffix ? ` · ${suffix}` : ''}`;
    node.dataset.productNameEnhanced = 'true';
    node.classList.add('truncate', 'max-w-full', 'overflow-hidden', 'whitespace-nowrap');

    node.insertAdjacentElement('afterend', makeAsinLine('p', asin));
  });
}

function enhanceProductHealth(map) {
  const card = findCard('Saúde dos produtos');
  if (!card) return;

  card.style.overflow = 'hidden';
  card.style.maxWidth = '100%';

  card.querySelectorAll('span').forEach((node) => {
    if (node.dataset.generatedProductAsin === 'true') return;
    if (node.dataset.productNameEnhanced === 'true') return;

    const original = node.textContent?.trim() || '';
    const asin = extractAsin(original);
    const name = asin ? map.get(asin) : null;
    if (!name) return;

    node.textContent = name;
    node.title = `${name} · ${asin}`;
    node.dataset.productNameEnhanced = 'true';
    node.classList.add('block', 'truncate', 'max-w-full', 'overflow-hidden', 'whitespace-nowrap');

    node.insertAdjacentElement('afterend', makeAsinLine('span', asin));
  });

  const attentionLabel = Array.from(card.querySelectorAll('p, span')).find((node) =>
    node.textContent?.trim() === 'Requer atenção:'
  );
  const attentionContainer = attentionLabel?.parentElement;
  if (attentionContainer) {
    attentionContainer.style.overflow = 'hidden';
    attentionContainer.style.maxWidth = '100%';
  }
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

const observer = new MutationObserver((mutations) => {
  const onlyGeneratedNodes = mutations.every((mutation) =>
    Array.from(mutation.addedNodes || []).every((node) =>
      node.nodeType !== Node.ELEMENT_NODE
      || node.dataset?.generatedProductAsin === 'true'
    )
  );

  if (!onlyGeneratedNodes) schedule();
});

observer.observe(document.documentElement, { childList: true, subtree: true });
window.addEventListener('DOMContentLoaded', schedule);
window.addEventListener('popstate', schedule);
window.setTimeout(schedule, 400);
window.setTimeout(schedule, 1200);
