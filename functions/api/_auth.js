// Server-side validation of an EVE SSO access token. Used by every endpoint
// that stores or acts on per-character data. On success we return
// { characterId, corporationId, characterName, token } so callers can enforce
// per-character + corp-membership checks and reuse the token for ESI calls.
//
// The token's signature is verified against EVE's published JWKS — a forged
// token (valid issuer + expiry but a bad signature) is rejected. This matters
// now that a token can grant Discord roles: identity has to be sound, not just
// plausible.

import { getServiceClient } from "./_supabase.js";

const ESI_BASE = "https://esi.evetech.net/latest";
const EVE_ISSUER = "login.eveonline.com";
const JWKS_URL = "https://login.eveonline.com/oauth/jwks";
const JWKS_TTL_MS = 60 * 60 * 1000;
// Per-character corp/faction lookup is cached at this TTL. Tradeoff: a member
// kicked from the corp keeps access until their entry expires. Five minutes
// is short enough that revocation is fast, long enough that the ESI call is
// no longer in the hot path for every authed request.
const CHAR_INFO_TTL_MS = 5 * 60 * 1000;
const CHAR_INFO_MAX = 500;
const ESI_CHAR_TIMEOUT_MS = 5000;
const JWKS_TIMEOUT_MS = 5000;

let jwksCache = null;
let jwksAt = 0;
const charInfoCache = new Map(); // characterId → { corporationId, factionId, name, fetchedAt }

// EVE's signing keys, cached for an hour. Keeps a stale copy on a fetch failure
// so a brief JWKS outage doesn't lock every member out — signing keys rotate
// rarely, and the signature check below is still enforced against them.
async function getJwks() {
  if (jwksCache && Date.now() - jwksAt < JWKS_TTL_MS) return jwksCache;
  try {
    const res = await fetch(JWKS_URL, { signal: AbortSignal.timeout(JWKS_TIMEOUT_MS) });
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data?.keys)) {
        jwksCache = data.keys;
        jwksAt = Date.now();
      }
    }
  } catch { /* fall through to a stale cache if we have one */ }
  if (jwksCache) return jwksCache;
  throw new Error("JWKS unavailable");
}

// Cache-first fetch of an EVE character's corp + faction. The previous version
// hit ESI on every authed request, so a slow ESI made every endpoint slow and
// a stuck ESI hung login indefinitely. On fetch failure we fall back to a
// stale entry if one exists, so a brief ESI outage doesn't kick everyone out.
async function getCharacterInfo(characterId) {
  const cached = charInfoCache.get(characterId);
  if (cached && Date.now() - cached.fetchedAt < CHAR_INFO_TTL_MS) return cached;
  try {
    const res = await fetch(
      `${ESI_BASE}/characters/${characterId}/?datasource=tranquility`,
      { signal: AbortSignal.timeout(ESI_CHAR_TIMEOUT_MS) }
    );
    if (!res.ok) return cached ?? null;
    const data = await res.json();
    const entry = {
      corporationId: data?.corporation_id ?? null,
      factionId: data?.faction_id ?? null,
      name: data?.name ?? null,
      fetchedAt: Date.now(),
    };
    if (charInfoCache.size >= CHAR_INFO_MAX) {
      // Crude FIFO eviction — Map iteration order is insertion order. Cap
      // exists to defend against pathological growth, not to be smart.
      charInfoCache.delete(charInfoCache.keys().next().value);
    }
    charInfoCache.set(characterId, entry);
    return entry;
  } catch {
    return cached ?? null;
  }
}

function b64urlToBytes(s) {
  let b64 = String(s).replace(/-/g, "+").replace(/_/g, "/");
  while (b64.length % 4) b64 += "=";
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function decodeSegment(seg) {
  try {
    return JSON.parse(new TextDecoder().decode(b64urlToBytes(seg)));
  } catch { return null; }
}

// Verifies the JWT signature against EVE's JWKS. Returns the decoded payload on
// success, null on any failure (malformed, unknown key, bad signature).
async function verifyJwt(token) {
  const parts = String(token).split(".");
  if (parts.length !== 3) return null;
  const header = decodeSegment(parts[0]);
  const payload = decodeSegment(parts[1]);
  if (!header || !payload) return null;

  let keys;
  try { keys = await getJwks(); } catch { return null; }
  const jwk = keys.find((k) => k.kid === header.kid)
    ?? keys.find((k) => k.alg && k.alg === header.alg);
  if (!jwk) return null;

  let importParams, verifyParams;
  if (jwk.kty === "RSA") {
    importParams = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" };
    verifyParams = { name: "RSASSA-PKCS1-v1_5" };
  } else if (jwk.kty === "EC") {
    importParams = { name: "ECDSA", namedCurve: jwk.crv || "P-256" };
    verifyParams = { name: "ECDSA", hash: "SHA-256" };
  } else {
    return null;
  }

  try {
    const key = await crypto.subtle.importKey("jwk", jwk, importParams, false, ["verify"]);
    const data = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
    const ok = await crypto.subtle.verify(verifyParams, key, b64urlToBytes(parts[2]), data);
    return ok ? payload : null;
  } catch {
    return null;
  }
}

// Pass `{ allowNonCorp: true }` to let a non-corp character through with
// `inCorp: false` on the returned auth — only the Profile + Discord link
// endpoints opt in. Every other caller keeps the default and continues to
// 403 non-corp characters.
export async function verifyEveAuth(request, env, { allowNonCorp = false } = {}) {
  const authHeader = request.headers.get("Authorization") || "";
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) return { error: "Missing Bearer token", status: 401 };
  const token = match[1].trim();

  const jwt = await verifyJwt(token);
  if (!jwt) return { error: "Invalid or unverifiable token", status: 401 };

  if (!jwt.iss || jwt.iss.indexOf(EVE_ISSUER) === -1) {
    return { error: "Invalid token issuer", status: 401 };
  }
  const expMs = (jwt.exp ?? 0) * 1000;
  if (!expMs || expMs < Date.now()) {
    return { error: "Token expired", status: 401 };
  }

  // sub is e.g. "CHARACTER:EVE:90000001"
  const sub = String(jwt.sub ?? "");
  const subParts = sub.split(":");
  const characterId = parseInt(subParts[subParts.length - 1], 10);
  if (!Number.isFinite(characterId)) return { error: "No character claim", status: 401 };

  // Fetch the character's current corp from ESI; enforces the corp gate
  // server-side rather than trusting client-asserted corp membership.
  // Cached per-character (see getCharacterInfo) so the hot path doesn't
  // pay an ESI round-trip on every authed request.
  const charInfo = await getCharacterInfo(characterId);
  if (!charInfo) return { error: "Could not load character info", status: 502 };
  const { corporationId, factionId } = charInfo;

  const expectedCorp = env.EVE_CORP_ID ? parseInt(env.EVE_CORP_ID, 10) : null;
  const inCorp = expectedCorp == null || corporationId === expectedCorp;
  if (!inCorp && !allowNonCorp) {
    return { error: "Not a corp member", status: 403 };
  }

  return {
    characterId,
    corporationId,
    factionId,
    inCorp,
    characterName: jwt.name ?? charInfo.name ?? null,
    token,
  };
}

// Leadership / admin gate. Empty/unset env var on its own = no env-bootstrapped
// admin; the admin_users table can still grant access at runtime. This mirrors
// the SRP/fund pattern of fail-secure when nothing is configured — leadership
// editing the corp wallet or Discord roles should never silently default to
// "anyone". Async because of the DB read — every caller must `await`.
export async function isLeader(characterId, env) {
  const envList = (env.EVE_LEADERSHIP_IDS ?? "")
    .split(",")
    .map((s) => parseInt(s.trim(), 10))
    .filter(Number.isFinite);
  if (envList.includes(characterId)) return true;

  try {
    const db = getServiceClient(env);
    const { data } = await db
      .from("admin_users")
      .select("character_id")
      .eq("character_id", characterId)
      .maybeSingle();
    return !!data;
  } catch {
    // Fail closed on a DB blip — better to deny than to silently grant.
    return false;
  }
}

export const AUTH_HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
};
