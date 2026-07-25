/**
 * usePerformanceData — cache em memória de módulo por sessão
 *
 * Garante no máximo um fetch por pageKey:accountId:date por visita.
 * O cache vive na variável de módulo `store` e é limpo apenas via refresh().
 *
 * Uso:
 *   const { data, loading, refresh } = usePerformanceData(
 *     'dayparting',
 *     accountId,
 *     (accountId) => Promise.all([...queries...]).then(([a, b]) => ({ a, b }))
 *   );
 */
import { useState, useEffect, useCallback, useRef } from 'react';

// Cache global em memória de módulo (não persiste entre reloads de página)
const store = new Map();

function cacheKey(pageKey, accountId) {
  const today = new Date().toISOString().slice(0, 10);
  return `${pageKey}:${accountId}:${today}`;
}

export function usePerformanceData(pageKey, accountId, fetchFn) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const fetchingRef = useRef(false);

  const load = useCallback(async (invalidate = false) => {
    if (!accountId || !fetchFn) return;
    const key = cacheKey(pageKey, accountId);

    if (!invalidate && store.has(key)) {
      setData(store.get(key));
      setLoading(false);
      return;
    }

    if (fetchingRef.current) return;
    fetchingRef.current = true;
    setLoading(true);

    try {
      const result = await fetchFn(accountId);
      store.set(key, result);
      setData(result);
    } finally {
      fetchingRef.current = false;
      setLoading(false);
    }
  }, [pageKey, accountId, fetchFn]);

  useEffect(() => { load(false); }, [load]);

  const refresh = useCallback(() => {
    if (!accountId) return;
    store.delete(cacheKey(pageKey, accountId));
    load(true);
  }, [pageKey, accountId, load]);

  return { data, loading, refresh };
}