export function visiblePageNumbers(currentPage, pageCount, radius = 1) {
  const safeCount = Math.max(1, Number(pageCount) || 1);
  const safeCurrent = Math.min(Math.max(1, Number(currentPage) || 1), safeCount);
  const pages = new Set([1, safeCount]);

  for (let page = safeCurrent - radius; page <= safeCurrent + radius; page += 1) {
    if (page >= 1 && page <= safeCount) pages.add(page);
  }

  return [...pages].sort((left, right) => left - right).reduce((items, page, index, ordered) => {
    if (index > 0 && page - ordered[index - 1] > 1) items.push(`ellipsis-${page}`);
    items.push(page);
    return items;
  }, []);
}

export function pageRange(page, pageSize, total) {
  if (!total) return { from: 0, to: 0 };
  const from = (page - 1) * pageSize + 1;
  return { from, to: Math.min(total, from + pageSize - 1) };
}
