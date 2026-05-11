// useWatchlist.js — localStorage-backed token watchlist
import { useState, useCallback } from 'react';

const KEY = 'suipump_watchlist';

function load() {
  try { return new Set(JSON.parse(localStorage.getItem(KEY) || '[]')); }
  catch { return new Set(); }
}

export function useWatchlist() {
  const [watched, setWatched] = useState(load);

  const toggle = useCallback((curveId) => {
    setWatched(prev => {
      const next = new Set(prev);
      if (next.has(curveId)) next.delete(curveId);
      else next.add(curveId);
      localStorage.setItem(KEY, JSON.stringify([...next]));
      return next;
    });
  }, []);

  const isWatched = useCallback((curveId) => watched.has(curveId), [watched]);

  return { watched, toggle, isWatched };
}
