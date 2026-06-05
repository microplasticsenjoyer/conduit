// Shared helper for fetching the supported LP-store corp list from /api/lp/corps.
// Centralises the corp data so the LP-store UI doesn't drift from the backend
// (functions/api/lp/_corps.js).

import { useEffect, useMemo, useState } from "react";

let corpsPromise = null;

export function fetchCorpGroups() {
  if (!corpsPromise) {
    corpsPromise = fetch("/api/lp/corps")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("corps fetch failed"))))
      .then((j) => j.groups ?? [])
      .catch((err) => {
        corpsPromise = null;
        throw err;
      });
  }
  return corpsPromise;
}

export function useCorpGroups() {
  const [groups, setGroups] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    fetchCorpGroups()
      .then((g) => { if (!cancelled) { setGroups(g); setLoading(false); } })
      .catch((err) => { if (!cancelled) { setError(err.message); setLoading(false); } });
    return () => { cancelled = true; };
  }, []);

  // Memoise so consumers can use `allCorps` as a stable effect dependency.
  // Without this, every render produces a new array reference and any effect
  // depending on it would loop with sibling effects that mutate URL/state.
  const allCorps = useMemo(() => groups.flatMap((g) => g.corps), [groups]);
  // Default-selection candidates: skip placeholders so the picker doesn't
  // land on a "coming soon" entry on first load.
  const enabledCorps = useMemo(() => allCorps.filter((c) => !c.disabled), [allCorps]);
  return { groups, allCorps, enabledCorps, loading, error };
}
