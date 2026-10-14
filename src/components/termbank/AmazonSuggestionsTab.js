import React, { useEffect, useMemo, useRef } from 'react';
import AmazonSuggestionsTabOriginal from './AmazonSuggestionsTab.jsx';

const resolveProductTitle = (product) => {
  const candidates = [
    product?.product_name,
    product?.display_name,
    product?.title,
    product?.name,
    product?.item_name,
    product?.listing_title,
    product?.product_title,
  ];

  const title = candidates
    .map((value) => String(value || '').trim())
    .find((value) => value && value !== '-' && value.toLowerCase() !== 'produto');

  if (title) return title;
  if (product?.sku) return `Produto ${product.sku}`;
  return product?.asin ? `Produto ${product.asin}` : 'Produto sem título';
};

const DARK_SELECT_CSS = `
  .amazon-suggestions-dark-product-select select {
    background-color: #0f172a !important;
    color: #f8fafc !important;
    border-color: #334155 !important;
    color-scheme: dark;
  }
  .amazon-suggestions-dark-product-select select:focus {
    border-color: #6366f1 !important;
    box-shadow: 0 0 0 2px rgba(99, 102, 241, 0.28);
    outline: none;
  }
  .amazon-suggestions-dark-product-select select option {
    background: #0f172a !important;
    color: #f8fafc !important;
  }
`;

export default function AmazonSuggestionsTab(props) {
  const rootRef = useRef(null);
  const titleByAsin = useMemo(() => new Map(
    (props.products || [])
      .filter((product) => product?.asin)
      .map((product) => [String(product.asin), resolveProductTitle(product)])
  ), [props.products]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return undefined;

    const normalizeProductSelect = () => {
      const selects = Array.from(root.querySelectorAll('select'));
      const select = selects.find((candidate) =>
        Array.from(candidate.options || []).some((option) => titleByAsin.has(String(option.value || '')))
      );

      if (!select) return;

      select.style.backgroundColor = '#0f172a';
      select.style.color = '#f8fafc';
      select.style.borderColor = '#334155';
      select.style.colorScheme = 'dark';
      select.style.minWidth = 'min(100%, 520px)';

      Array.from(select.options || []).forEach((option) => {
        option.style.backgroundColor = '#0f172a';
        option.style.color = '#f8fafc';

        if (!option.value) {
          option.textContent = 'Selecionar produto...';
          return;
        }

        const title = titleByAsin.get(String(option.value));
        if (title) option.textContent = title;
      });
    };

    normalizeProductSelect();
    const observer = new MutationObserver(normalizeProductSelect);
    observer.observe(root, { childList: true, subtree: true });

    return () => observer.disconnect();
  }, [titleByAsin]);

  return React.createElement(
    'div',
    { ref: rootRef, className: 'amazon-suggestions-dark-product-select' },
    React.createElement('style', null, DARK_SELECT_CSS),
    React.createElement(AmazonSuggestionsTabOriginal, props),
  );
}
