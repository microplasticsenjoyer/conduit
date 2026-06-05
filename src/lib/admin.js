import { useState, useEffect } from "react";

// Tells the rest of the app whether the logged-in character has admin rights
// (either env-listed in EVE_LEADERSHIP_IDS, or in the admin_users table).
// Used by App.jsx to decide whether to show the Admin tab.
export function useIsAdmin(auth) {
  const [isAdmin, setIsAdmin] = useState(false);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!auth?.eveAuth || !auth?.isCorpMember) {
      setIsAdmin(false);
      setReady(true);
      return;
    }
    (async () => {
      try {
        const token = await auth.getAccessToken();
        if (!token) return;
        const r = await fetch("/api/admin/me", {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (r.ok) {
          const data = await r.json();
          if (!cancelled) setIsAdmin(!!data.isAdmin);
        }
      } catch { /* default false — non-admin */ }
      finally {
        if (!cancelled) setReady(true);
      }
    })();
    return () => { cancelled = true; };
  }, [auth?.eveAuth?.characterId, auth?.isCorpMember]);

  return { isAdmin, ready };
}
