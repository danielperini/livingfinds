import { base44 } from '@/api/base44Client';

const ASIN_RE = /\bB0[A-Z0-9]{8}\b/;
const AUTO_SYNC_INTERVAL_MS = 30 * 60 * 1000;
let productMap = null;
let scheduled = false;
let syncingAutomatically = false;

function productTitle(product) {
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
        .filter((product) => product.asin)
        .map((product) => [String(product.asin), productTitle(product)])
    );
    return productMap;
  } catch {
    return new Map();
  }
}

function isAdsPage() {
  return location.pathname === '/ads' || location.pathname.startsWith('/ads/');
}

function widenCampaignColumns() {
  const heading = Array.from(document.querySelectorAll('span, h1, h2')).find(
    (node) => node.textContent?.trim() === 'Campanhas'
  );
  const sidebar = heading?.closest('div.w-\\[480px\\]') || heading?.closest('.flex-shrink-0');
  if (!sidebar) return;

  sidebar.style.width = '720px';
  sidebar.style.minWidth = '720px';
  sidebar.style.maxWidth = '55vw';
  sidebar.dataset.campaignColumnsExpanded = 'true';
}

function enhanceCampaignNames(map) {
  const asinNodes = Array.from(document.querySelectorAll('p, span')).filter((node) =>
    ASIN_RE.test(node.textContent || '')
  );

  asinNodes.forEach((asinNode) => {
    const asin = (asinNode.textContent || '').match(ASIN_RE)?.[0];
    const title = asin ? map.get(asin) : null;
    if (!asin || !title || title === asin) return;

    const item = asinNode.closest('div.cursor-pointer');
    if (!item || item.dataset.productTitleEnhanced === 'true') return;

    const campaignName = Array.from(item.querySelectorAll('p')).find((node) =>
      /^(AUTO|SP \| MANUAL)/i.test(node.textContent?.trim() || '')
    );
    if (!campaignName) return;

    const titleLine = document.createElement('p');
    titleLine.textContent = title;
    titleLine.title = title;
    titleLine.className = 'text-[11px] font-semibold text-cyan truncate mb-1 leading-tight';
    campaignName.parentElement?.insertBefore(titleLine, campaignName);
    item.dataset.productTitleEnhanced = 'true';
  });
}

function removeManualReconciliation() {
  const reconciliationText = Array.from(document.querySelectorAll('h1, h2, h3, p, span')).find((node) =>
    node.textContent?.includes('Conciliação Sponsored Products')
  );
  if (!reconciliationText) return;

  const panel = reconciliationText.closest('.border-t') || reconciliationText.closest('.rounded-xl') || reconciliationText.parentElement;
  if (panel) panel.remove();
}

function addAutomaticSyncLabel() {
  const syncButton = Array.from(document.querySelectorAll('button')).find((button) =>
    ['Sincronizar', 'Sincronizando...'].includes(button.textContent?.trim())
  );
  if (!syncButton || syncButton.parentElement?.querySelector('[data-auto-reconciliation-label]')) return;

  const label = document.createElement('span');
  label.dataset.autoReconciliationLabel = 'true';
  label.textContent = 'Conciliação automática';
  label.className = 'text-[9px] text-emerald-400 whitespace-nowrap';
  syncButton.parentElement?.appendChild(label);
}

async function triggerAutomaticSync() {
  if (syncingAutomatically || !isAdsPage()) return;

  const storageKey = 'livingfinds:ads-auto-reconciliation:last-run';
  const lastRun = Number(localStorage.getItem(storageKey) || 0);
  if (Date.now() - lastRun < AUTO_SYNC_INTERVAL_MS) return;

  const syncButton = Array.from(document.querySelectorAll('button')).find((button) =>
    button.textContent?.trim() === 'Sincronizar' && !button.disabled
  );
  if (!syncButton) return;

  syncingAutomatically = true;
  localStorage.setItem(storageKey, String(Date.now()));
  syncButton.click();
  window.setTimeout(() => {
    syncingAutomatically = false;
  }, 60_000);
}

async function applyEnhancements() {
  scheduled = false;
  if (!isAdsPage()) return;

  widenCampaignColumns();
  removeManualReconciliation();
  addAutomaticSyncLabel();

  const map = await loadProductMap();
  if (map.size) enhanceCampaignNames(map);

  await triggerAutomaticSync();
}

function schedule() {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(applyEnhancements);
}

new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });
window.addEventListener('DOMContentLoaded', schedule);
window.addEventListener('popstate', schedule);
window.setTimeout(schedule, 400);
window.setTimeout(schedule, 1400);
