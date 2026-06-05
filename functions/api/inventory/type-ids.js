// Shared name → type_id resolver.
//
//   POST /api/inventory/type-ids
//     body { names: ["Caldari Navy Mjolnir Heavy Missile", ...] }
//     → { ids: { "<lower-name>": <type_id>, ... } }
//
// Looks up requested names in the corp-shared `type_id_cache` table; any
// names not yet cached are resolved via a single ESI /universe/ids/ POST
// and upserted back. EVE type IDs are immutable so cached rows live
// forever. Corp-gated (matches the rest of /api/inventory/).

import { getServiceClient } from "../_supabase.js";
import { verifyEveAuth, AUTH_HEADERS } from "../_auth.js";

const ESI_BASE = "https://esi.evetech.net/latest";
const MAX_NAMES = 500;

export async function onRequestPost({ request, env }) {
  const auth = await verifyEveAuth(request, env);
  if (auth.error) return jsonResp({ error: auth.error }, auth.status);

  const body = await request.json().catch(() => ({}));
  const namesIn = Array.isArray(body?.names) ? body.names : null;
  if (!namesIn) return jsonResp({ error: "names[] required" }, 400);

  // Dedupe + lowercase + trim. Cap the request size to keep ESI calls bounded.
  const wanted = new Map(); // lower → original case (for the ESI call)
  for (const raw of namesIn) {
    if (typeof raw !== "string") continue;
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (!wanted.has(key)) wanted.set(key, trimmed);
    if (wanted.size >= MAX_NAMES) break;
  }
  if (wanted.size === 0) return jsonResp({ ids: {} });

  const db = getServiceClient(env);
  const keys = [...wanted.keys()];

  // 1. Read what's already cached.
  const { data: cached, error: selErr } = await db
    .from("type_id_cache")
    .select("name, type_id")
    .in("name", keys);
  if (selErr) return jsonResp({ error: selErr.message }, 500);

  const ids = {};
  const cachedSet = new Set();
  for (const row of cached ?? []) {
    ids[row.name] = row.type_id;
    cachedSet.add(row.name);
  }

  // 2. Resolve anything missing via ESI in one shot.
  const missingKeys = keys.filter((k) => !cachedSet.has(k));
  if (missingKeys.length > 0) {
    const missingOrig = missingKeys.map((k) => wanted.get(k));
    try {
      const esiRes = await fetch(
        `${ESI_BASE}/universe/ids/?datasource=tranquility`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(missingOrig),
          signal: AbortSignal.timeout(8000),
        }
      );
      if (esiRes.ok) {
        const data = await esiRes.json();
        const rowsToInsert = [];
        for (const t of data?.inventory_types ?? []) {
          if (!t?.name || !t?.id) continue;
          const k = t.name.toLowerCase();
          ids[k] = t.id;
          rowsToInsert.push({ name: k, type_id: t.id });
        }
        // Best-effort cache write; on conflict ignore (race-safe).
        if (rowsToInsert.length > 0) {
          await db
            .from("type_id_cache")
            .upsert(rowsToInsert, { onConflict: "name", ignoreDuplicates: true });
        }
      }
    } catch {
      // ESI hiccup — return what we have from the cache, client will retry.
    }
  }

  return jsonResp({ ids });
}

export async function onRequestOptions() {
  return new Response(null, { headers: AUTH_HEADERS });
}

function jsonResp(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: AUTH_HEADERS });
}
