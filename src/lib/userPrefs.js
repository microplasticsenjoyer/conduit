// Server-backed user preferences sync (core trading prefs only). Local
// localStorage stays the source-of-truth for offline + first-paint speed; on
// successful login we hydrate from the server, and changes are pushed back
// debounced. The set is intentionally tiny:
//
//   defaultStationId, salesTax, brokerFee, lpPrice, mfgTax
//
// All other prefs (UI toggles, doctrines, hauling cargo text, etc.) remain
// localStorage-only and don't sync.

import { useEffect, useRef, useState } from "react";

const KEY_MAP = {
  defaultStationId: "praxis:appraise:stationId",
  salesTax:         "praxis:appraise:salesTax",
  brokerFee:        "praxis:appraise:brokerFee",
  lpPrice:          "praxis:lpStore:lpPrice",
  mfgTax:           "praxis:lpStore:mfgTax",
};

function readLocal(prefKey) {
  try {
    const v = localStorage.getItem(KEY_MAP[prefKey]);
    if (v == null) return null;
    if (prefKey === "defaultStationId") {
      const n = parseInt(v, 10);
      return Number.isFinite(n) ? n : null;
    }
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : null;
  } catch { return null; }
}

function writeLocal(prefKey, value) {
  try {
    if (value == null) localStorage.removeItem(KEY_MAP[prefKey]);
    else localStorage.setItem(KEY_MAP[prefKey], String(value));
  } catch {}
}

// Hydrates server prefs into localStorage on first authenticated render.
// Returns a `pushPrefs(partial)` function for callers to upload local changes
// back to the server (debounced internally).
export function useSyncedPrefs(auth) {
  const { eveAuth, isCorpMember, getAccessToken } = auth ?? {};
  const [hydrated, setHydrated] = useState(false);
  const [error, setError] = useState(null);
  const pushTimer = useRef(null);
  const pendingRef = useRef({});

  useEffect(() => {
    if (!eveAuth || !isCorpMember) return;
    let cancelled = false;
    (async () => {
      try {
        const token = await getAccessToken();
        if (!token) return;
        const res = await fetch("/api/prefs", { headers: { Authorization: `Bearer ${token}` } });
        if (!res.ok) throw new Error(`prefs fetch ${res.status}`);
        const json = await res.json();
        if (cancelled) return;
        const remote = json.prefs ?? {};
        // Server wins on first hydration — corp mates expect their settings to
        // follow them across devices. If the server has no value for a key,
        // we leave the local value alone so first-time-on-server users don't
        // get reset to nulls.
        for (const k of Object.keys(KEY_MAP)) {
          if (remote[k] != null) writeLocal(k, remote[k]);
        }
        setHydrated(true);
      } catch (err) {
        if (!cancelled) setError(err.message);
      }
    })();
    return () => { cancelled = true; };
  }, [eveAuth?.characterId, isCorpMember]); // eslint-disable-line react-hooks/exhaustive-deps

  function pushPrefs(partial) {
    if (!eveAuth || !isCorpMember) return;
    pendingRef.current = { ...pendingRef.current, ...partial };
    if (pushTimer.current) clearTimeout(pushTimer.current);
    pushTimer.current = setTimeout(async () => {
      const payload = pendingRef.current;
      pendingRef.current = {};
      try {
        const token = await getAccessToken();
        if (!token) return;
        await fetch("/api/prefs", {
          method: "PUT",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify(payload),
        });
      } catch {}
    }, 800);
  }

  return { hydrated, error, pushPrefs };
}

export const SYNCED_PREF_KEYS = Object.keys(KEY_MAP);
