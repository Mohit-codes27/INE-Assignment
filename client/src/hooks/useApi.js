import { useEffect, useState, useCallback } from 'react';
import * as api from '../api/client';

// Backend lists must always be arrays — normalize so a malformed payload can
// never crash a `.length`/`.map` in a component; errors surface as messages.
const asArray = (v) => (Array.isArray(v) ? v : []);

export function useTracked() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.listTracked();
      if (!Array.isArray(res)) throw new Error('Tracked list returned an unexpected response.');
      setData(res);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { load(); }, [load]);
  return { data: data || [], loading, error, reload: load };
}

export function useSearch(query) {
  const [data, setData] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  useEffect(() => {
    if (!query || query.trim().length < 2) { setData([]); return; }
    setLoading(true);
    const t = setTimeout(async () => { // debounce
      try {
        setError(null);
        const res = await api.searchProducts(query.trim());
        if (!Array.isArray(res)) throw new Error('Search returned an unexpected response.');
        setData(res);
      } catch (e) {
        setError(e.message);
        setData([]);
      } finally {
        setLoading(false);
      }
    }, 400);
    return () => clearTimeout(t);
  }, [query]);
  return { data, loading, error };
}

export function useDetails(trackedId) {
  const [tracked, setTracked] = useState(null);
  const [history, setHistory] = useState([]);
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [scraping, setScraping] = useState(false);
  const load = useCallback(async () => {
    if (!trackedId) return;
    setLoading(true);
    setError(null);
    try {
      const [t, h, l] = await Promise.all([api.getTracked(trackedId), api.getHistory(trackedId), api.getLogs(trackedId)]);
      setTracked(t);
      setHistory(asArray(h));
      setLogs(asArray(l));
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [trackedId]);
  useEffect(() => { load(); }, [load]);
  const scrape = useCallback(async () => {
    setScraping(true);
    try {
      const r = await api.scrapeNow(trackedId);
      await load();
      return r;
    } finally {
      setScraping(false);
    }
  }, [trackedId, load]);
  return { tracked, history, logs, loading, error, reload: load, scrape, scraping };
}
