import { useState, useEffect, useCallback } from "react";

const STORAGE_PREFIX = "praxis:auth:";
const ESI_BASE = "https://esi.evetech.net/latest";
const EVE_SSO_AUTH = "https://login.eveonline.com/v2/oauth/authorize";
const EVE_SSO_TOKEN = "https://login.eveonline.com/v2/oauth/token";
// Space-separated. read_corporation_contracts powers the Inventory tab;
// read_projects powers the Corp Projects leaderboard refresh (Director-only —
// regular members just get a harmless extra grant and read the cached board);
// read_titles (characters) powers the Profile tab's self-service role sync;
// read_titles (corporations) lets a Director refresh every member's titles in
// one call so the Admin sync can apply title changes without each member having
// to log in/out themselves (Director-only — a harmless extra grant otherwise).
const SSO_SCOPE = "esi-contracts.read_corporation_contracts.v1 esi-corporations.read_projects.v1 esi-characters.read_titles.v1 esi-corporations.read_titles.v1";
// Must match exactly the Callback URL registered for this client on
// developers.eveonline.com. EVE SSO does exact-string matching, so we
// always send users to your-domain.example regardless of which origin they started
// from (e.g. preview deployments redirect to prod for the callback).
const SSO_CALLBACK_URL = "https://your-domain.example/?tab=inventory&sso=callback";

function read(key, fallback = null) {
  try {
    const v = localStorage.getItem(STORAGE_PREFIX + key);
    return v !== null ? JSON.parse(v) : fallback;
  } catch { return fallback; }
}
function write(key, value) {
  try { localStorage.setItem(STORAGE_PREFIX + key, JSON.stringify(value)); } catch {}
}
function clear(key) {
  try { localStorage.removeItem(STORAGE_PREFIX + key); } catch {}
}

function generateVerifier() {
  const arr = new Uint8Array(32);
  crypto.getRandomValues(arr);
  return btoa(String.fromCharCode(...arr))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

async function deriveChallenge(verifier) {
  const data = new TextEncoder().encode(verifier);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return btoa(String.fromCharCode(...new Uint8Array(hash)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

function parseJwt(token) {
  try {
    return JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
  } catch { return null; }
}

// Migrate legacy keys from the old "praxis:inventory:" prefix where Inventory
// stored its own auth state. Runs once on first hook mount per session.
let migrated = false;
function migrateLegacyAuth() {
  if (migrated) return;
  migrated = true;
  const keys = ["eveAuth", "clientId", "corpId"];
  for (const k of keys) {
    const oldKey = "praxis:inventory:" + k;
    const newKey = STORAGE_PREFIX + k;
    try {
      if (localStorage.getItem(newKey) === null) {
        const v = localStorage.getItem(oldKey);
        if (v !== null) localStorage.setItem(newKey, v);
      }
      localStorage.removeItem(oldKey);
    } catch {}
  }
}

export function useEveAuth() {
  if (typeof window !== "undefined") migrateLegacyAuth();

  const [eveAuth, setEveAuth] = useState(() => read("eveAuth"));
  const [clientId, setClientId] = useState(() => read("clientId"));
  const [corpId, setCorpId] = useState(() => read("corpId"));
  const [ssoError, setSsoError] = useState(null);
  const [isAuthReady, setIsAuthReady] = useState(false);

  // Fetch SSO config (clientId + corpId) if missing
  useEffect(() => {
    if (clientId && corpId) { setIsAuthReady(true); return; }
    fetch("/api/inventory/config")
      .then((r) => r.json())
      .then((cfg) => {
        if (cfg.eveClientId) { write("clientId", cfg.eveClientId); setClientId(cfg.eveClientId); }
        if (cfg.corpId)      { write("corpId", cfg.corpId);         setCorpId(cfg.corpId); }
      })
      .catch(() => {})
      .finally(() => setIsAuthReady(true));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Handle SSO callback once on mount
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("sso") !== "callback") return;

    const code = params.get("code");
    const returnedState = params.get("state");
    const storedState = read("pkce_state");
    const verifier = read("pkce_verifier");

    params.delete("sso");
    params.delete("code");
    params.delete("state");
    const cleanQuery = params.toString();
    window.history.replaceState({}, "", cleanQuery ? `?${cleanQuery}` : window.location.pathname);

    if (!code || returnedState !== storedState || !verifier) {
      setSsoError("SSO callback error: state mismatch. Please try again.");
      return;
    }

    clear("pkce_state");
    clear("pkce_verifier");

    const cId = read("clientId");
    if (!cId) { setSsoError("EVE client ID not configured."); return; }

    (async () => {
      try {
        const tokenRes = await fetch(EVE_SSO_TOKEN, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "authorization_code",
            code,
            client_id: cId,
            code_verifier: verifier,
          }),
        });
        if (!tokenRes.ok) throw new Error(`Token exchange failed (${tokenRes.status})`);
        const tokens = await tokenRes.json();

        const jwt = parseJwt(tokens.access_token);
        const characterId = jwt?.sub?.split(":")?.[2];
        const characterName = jwt?.name;
        if (!characterId) throw new Error("Could not parse character from token");

        const charRes = await fetch(`${ESI_BASE}/characters/${characterId}/`);
        if (!charRes.ok) throw new Error("Could not fetch character info from ESI");
        const charData = await charRes.json();

        const auth = {
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token,
          expiresAt: Date.now() + (tokens.expires_in - 30) * 1000,
          characterId,
          characterName,
          corporationId: charData.corporation_id,
        };
        write("eveAuth", auth);
        setEveAuth(auth);
      } catch (err) {
        setSsoError(`EVE login failed: ${err.message}`);
      }
    })();
  }, []);

  const isCorpMember = !!eveAuth && !!corpId &&
    String(eveAuth.corporationId) === String(corpId);

  const getAccessToken = useCallback(async () => {
    let auth = read("eveAuth");
    if (!auth) return null;

    if (Date.now() < auth.expiresAt) return auth.accessToken;

    const cId = read("clientId");
    const res = await fetch(EVE_SSO_TOKEN, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: auth.refreshToken,
        client_id: cId,
      }),
    });
    if (!res.ok) {
      clear("eveAuth");
      setEveAuth(null);
      throw new Error("EVE session expired — please log in again.");
    }
    const tokens = await res.json();
    const refreshed = {
      ...auth,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt: Date.now() + (tokens.expires_in - 30) * 1000,
    };
    write("eveAuth", refreshed);
    setEveAuth(refreshed);
    return refreshed.accessToken;
  }, []);

  const login = useCallback(async () => {
    setSsoError(null);
    const cId = clientId ?? read("clientId");
    if (!cId) { setSsoError("EVE app not configured — contact the site admin."); return; }

    const verifier = generateVerifier();
    const challenge = await deriveChallenge(verifier);
    const state = crypto.randomUUID();

    write("pkce_verifier", verifier);
    write("pkce_state", state);

    const params = new URLSearchParams({
      response_type: "code",
      client_id: cId,
      redirect_uri: SSO_CALLBACK_URL,
      scope: SSO_SCOPE,
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
    window.location.href = `${EVE_SSO_AUTH}?${params}`;
  }, [clientId]);

  const logout = useCallback(() => {
    clear("eveAuth");
    setEveAuth(null);
  }, []);

  return {
    eveAuth,
    corpId,
    isCorpMember,
    isAuthReady,
    ssoError,
    login,
    logout,
    getAccessToken,
  };
}
