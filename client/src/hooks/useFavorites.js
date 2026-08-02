import { useCallback, useEffect, useState } from 'react';
import { getFavorites, addFavorite, removeFavorite } from '../services/api';

/** Global-ish favorites state shared per page through this hook. */
export function useFavorites() {
  const [favorites, setFavorites] = useState([]);

  const load = useCallback(async () => {
    try {
      const data = await getFavorites();
      setFavorites(data.favorites);
    } catch { /* non-fatal */ }
  }, []);

  useEffect(() => { load(); }, [load]);

  const isFavorite = useCallback((key) => favorites.some((f) => f.key === key), [favorites]);

  const toggle = useCallback(async (entry) => {
    const exists = favorites.some((f) => f.key === entry.key);
    // Optimistic update
    setFavorites((prev) =>
      exists ? prev.filter((f) => f.key !== entry.key) : [{ ...entry, addedAt: Date.now() }, ...prev]
    );
    try {
      if (exists) await removeFavorite(entry.key);
      else await addFavorite(entry);
      return !exists;
    } catch {
      // Revert on failure
      setFavorites((prev) =>
        exists ? [{ ...entry, addedAt: Date.now() }, ...prev] : prev.filter((f) => f.key !== entry.key)
      );
      return exists;
    }
  }, [favorites]);

  return { favorites, isFavorite, toggle, reload: load };
}
