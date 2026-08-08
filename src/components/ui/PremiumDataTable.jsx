import { useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, ChevronsUpDown, Search } from 'lucide-react';
import { pageRange, visiblePageNumbers } from '@/lib/pagination';

function normalize(value) {
  if (value == null) return '';
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  const parsedDate = Date.parse(value);
  if (typeof value === 'string' && /\d{4}-\d{2}-\d{2}/.test(value) && !Number.isNaN(parsedDate)) return parsedDate;
  return String(value).toLocaleLowerCase('pt-BR');
}

function compare(a, b) {
  const left = normalize(a);
  const right = normalize(b);
  if (typeof left === 'number' && typeof right === 'number') return left - right;
  return String(left).localeCompare(String(right), 'pt-BR', { numeric: true, sensitivity: 'base' });
}

export default function PremiumDataTable({
  columns,
  data,
  rowKey = 'id',
  emptyMessage = 'Nenhum registro encontrado.',
  searchable = false,
  searchPlaceholder = 'Pesquisar...',
  initialSort,
  pageSize = 50,
  pageSizeOptions = [25, 50, 100],
  className = '',
}) {
  const [sort, setSort] = useState(initialSort || null);
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [activePageSize, setActivePageSize] = useState(pageSize);

  const visible = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase('pt-BR');
    let rows = normalizedQuery
      ? data.filter((row) => columns.some((column) => {
          const value = column.sortValue ? column.sortValue(row) : row[column.accessor];
          return String(value ?? '').toLocaleLowerCase('pt-BR').includes(normalizedQuery);
        }))
      : [...data];

    if (sort) {
      const column = columns.find((item) => item.id === sort.id);
      if (column) {
        rows.sort((a, b) => {
          const av = column.sortValue ? column.sortValue(a) : a[column.accessor];
          const bv = column.sortValue ? column.sortValue(b) : b[column.accessor];
          return compare(av, bv) * (sort.direction === 'asc' ? 1 : -1);
        });
      }
    }
    return rows;
  }, [columns, data, query, sort]);

  const pages = Math.max(1, Math.ceil(visible.length / activePageSize));
  const safePage = Math.min(page, pages);
  const paginated = visible.slice((safePage - 1) * activePageSize, safePage * activePageSize);
  const range = pageRange(safePage, activePageSize, visible.length);
  const pageItems = visiblePageNumbers(safePage, pages);

  const toggleSort = (column) => {
    setPage(1);
    setSort((current) => {
      if (!current || current.id !== column.id) return { id: column.id, direction: 'asc' };
      return { id: column.id, direction: current.direction === 'asc' ? 'desc' : 'asc' };
    });
  };

  return (
    <section className={`premium-data-table ${className}`}>
      {searchable && (
        <div className="premium-data-table__toolbar">
          <div className="premium-data-table__search">
            <Search className="h-4 w-4" />
            <input
              value={query}
              onChange={(event) => { setQuery(event.target.value); setPage(1); }}
              placeholder={searchPlaceholder}
              aria-label={searchPlaceholder}
            />
          </div>
          <span className="premium-data-table__count">{visible.length.toLocaleString('pt-BR')} registros</span>
        </div>
      )}

      <div className="premium-data-table__scroll">
        <table>
          <thead>
            <tr>
              {columns.map((column) => {
                const active = sort?.id === column.id;
                return (
                  <th key={column.id} className={column.headerClassName || ''}>
                    <button type="button" onClick={() => toggleSort(column)} className="premium-data-table__sorter">
                      <span>{column.header}</span>
                      {active ? (sort.direction === 'asc' ? <ArrowUp /> : <ArrowDown />) : <ChevronsUpDown />}
                    </button>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {paginated.length === 0 ? (
              <tr><td colSpan={columns.length} className="premium-data-table__empty">{emptyMessage}</td></tr>
            ) : paginated.map((row, index) => (
              <tr key={typeof rowKey === 'function' ? rowKey(row, index) : row[rowKey] ?? index}>
                {columns.map((column) => (
                  <td key={column.id} className={column.cellClassName || ''}>
                    {column.cell ? column.cell(row) : row[column.accessor]}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {pages > 1 && (
        <div className="premium-data-table__pagination">
          <span aria-live="polite">Exibindo {range.from}–{range.to} de {visible.length.toLocaleString('pt-BR')}</span>
          <div className="premium-data-table__page-controls" aria-label="Navegação entre páginas">
            <label className="premium-data-table__density-label">
              <span className="sr-only">Linhas por página</span>
              <select value={activePageSize} onChange={(event) => { setActivePageSize(Number(event.target.value)); setPage(1); }}>
                {pageSizeOptions.map((option) => <option key={option} value={option}>{option}/página</option>)}
              </select>
            </label>
            <button type="button" aria-label="Página anterior" disabled={safePage === 1} onClick={() => setPage((value) => Math.max(1, value - 1))}>Anterior</button>
            {pageItems.map((item) => typeof item === 'string'
              ? <span key={item} className="premium-data-table__ellipsis" aria-hidden="true">…</span>
              : <button key={item} type="button" aria-label={`Ir para página ${item}`} aria-current={item === safePage ? 'page' : undefined} className={item === safePage ? 'is-current' : ''} onClick={() => setPage(item)}>{item}</button>)}
            <button type="button" aria-label="Próxima página" disabled={safePage === pages} onClick={() => setPage((value) => Math.min(pages, value + 1))}>Próxima</button>
          </div>
        </div>
      )}
    </section>
  );
}
