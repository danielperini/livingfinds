const SORTABLE_SELECTOR = 'table:not([data-no-global-sort])';

function normalize(value) {
  return String(value ?? '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseCellValue(cell) {
  const raw = normalize(cell?.getAttribute('data-sort-value') || cell?.textContent || '');
  if (!raw || raw === '—' || raw === '-') return { type: 'empty', value: '' };

  const dateMatch = raw.match(/^(\d{2})\/(\d{2})(?:\/(\d{2,4}))?(?:,?\s*(\d{2}):(\d{2}))?/);
  if (dateMatch) {
    const [, day, month, yearRaw = String(new Date().getFullYear()), hour = '00', minute = '00'] = dateMatch;
    const year = yearRaw.length === 2 ? `20${yearRaw}` : yearRaw;
    const timestamp = new Date(`${year}-${month}-${day}T${hour}:${minute}:00`).getTime();
    if (!Number.isNaN(timestamp)) return { type: 'number', value: timestamp };
  }

  const cleaned = raw
    .replace(/R\$/gi, '')
    .replace(/\$/g, '')
    .replace(/%/g, '')
    .replace(/x$/i, '')
    .replace(/[^\d,.-]/g, '');

  if (cleaned && /\d/.test(cleaned)) {
    let numeric = cleaned;
    const hasComma = numeric.includes(',');
    const hasDot = numeric.includes('.');
    if (hasComma && hasDot) numeric = numeric.replace(/\./g, '').replace(',', '.');
    else if (hasComma) numeric = numeric.replace(',', '.');
    const number = Number(numeric);
    if (Number.isFinite(number)) return { type: 'number', value: number };
  }

  return { type: 'text', value: raw.toLocaleLowerCase('pt-BR') };
}

function compareValues(a, b, direction) {
  if (a.type === 'empty' && b.type !== 'empty') return 1;
  if (b.type === 'empty' && a.type !== 'empty') return -1;
  if (a.type === 'number' && b.type === 'number') return (a.value - b.value) * direction;
  return String(a.value).localeCompare(String(b.value), 'pt-BR', { numeric: true, sensitivity: 'base' }) * direction;
}

function getBodyRows(table) {
  const tbody = table.tBodies?.[0];
  if (!tbody) return [];
  return Array.from(tbody.rows).filter(row => row.cells.length > 0 && !row.hasAttribute('data-no-sort-row'));
}

function applySort(table, columnIndex, directionName) {
  const tbody = table.tBodies?.[0];
  if (!tbody) return;
  const direction = directionName === 'asc' ? 1 : -1;
  const rows = getBodyRows(table).map((row, originalIndex) => ({
    row,
    originalIndex,
    parsed: parseCellValue(row.cells[columnIndex]),
  }));

  rows.sort((a, b) => compareValues(a.parsed, b.parsed, direction) || a.originalIndex - b.originalIndex);
  const fragment = document.createDocumentFragment();
  rows.forEach(({ row }) => fragment.appendChild(row));
  tbody.appendChild(fragment);
}

function clearDirections(table) {
  table.querySelectorAll('thead th[data-global-sortable="true"]').forEach(header => {
    header.removeAttribute('data-sort-direction');
    header.setAttribute('aria-sort', 'none');
  });
}

function handleHeaderActivation(header) {
  const table = header.closest('table');
  if (!table) return;
  const columnIndex = Array.from(header.parentElement?.cells || []).indexOf(header);
  if (columnIndex < 0) return;
  const nextDirection = header.getAttribute('data-sort-direction') === 'asc' ? 'desc' : 'asc';
  clearDirections(table);
  header.setAttribute('data-sort-direction', nextDirection);
  header.setAttribute('aria-sort', nextDirection === 'asc' ? 'ascending' : 'descending');
  applySort(table, columnIndex, nextDirection);
}

function enhanceTable(table) {
  if (!(table instanceof HTMLTableElement)) return;
  const headerRow = table.tHead?.rows?.[0];
  const tbody = table.tBodies?.[0];
  if (!headerRow || !tbody) return;

  table.classList.add('premium-sortable-table');
  Array.from(headerRow.cells).forEach((header, index) => {
    const label = normalize(header.textContent);
    if (!label || header.hasAttribute('data-no-sort')) return;
    header.setAttribute('data-global-sortable', 'true');
    header.setAttribute('tabindex', '0');
    header.setAttribute('role', 'button');
    header.setAttribute('aria-sort', header.getAttribute('aria-sort') || 'none');
    header.setAttribute('title', `Ordenar por ${label}`);
    header.dataset.sortColumnIndex = String(index);
  });
}

function enhanceAll(root = document) {
  root.querySelectorAll?.(SORTABLE_SELECTOR).forEach(enhanceTable);
}

export function installGlobalTableSorting() {
  if (typeof document === 'undefined' || window.__livingfindsGlobalTableSortingInstalled) return;
  window.__livingfindsGlobalTableSortingInstalled = true;

  const onClick = event => {
    const header = event.target.closest?.('th[data-global-sortable="true"]');
    if (!header) return;
    event.preventDefault();
    handleHeaderActivation(header);
  };

  const onKeyDown = event => {
    const header = event.target.closest?.('th[data-global-sortable="true"]');
    if (!header || !['Enter', ' '].includes(event.key)) return;
    event.preventDefault();
    handleHeaderActivation(header);
  };

  document.addEventListener('click', onClick);
  document.addEventListener('keydown', onKeyDown);

  const observer = new MutationObserver(mutations => {
    for (const mutation of mutations) {
      const table = mutation.target instanceof Element ? mutation.target.closest?.('table') : null;
      if (table) enhanceTable(table);

      mutation.addedNodes.forEach(node => {
        if (!(node instanceof Element)) return;
        if (node.matches?.(SORTABLE_SELECTOR)) enhanceTable(node);
        const parentTable = node.closest?.('table');
        if (parentTable) enhanceTable(parentTable);
        enhanceAll(node);
      });
    }
  });

  const start = () => {
    enhanceAll(document);
    observer.observe(document.body, { childList: true, subtree: true });
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
}
