// POST /api/admin/admins — grant admin rights to another character.
//   body { characterName }     resolves via ESI universe/ids and inserts.
//
// Existing admins (env-listed or in admin_users) can promote others. The env
// list stays as the immutable bootstrap; everything else is managed here.

import { getServiceClient } from "../_supabase.js";
import { verifyEveAuth, isLeader, AUTH_HEADERS } from "../_auth.js";

const ESI_BASE = "https://esi.evetech.net/latest";

export async function onRequestPost({ request, env }) {
  const auth = await verifyEveAuth(request, env);
  if (auth.error) return jsonResp({ error: auth.error }, auth.status);
  if (!(await isLeader(auth.characterId, env))) {
    return jsonResp({ error: "Leadership only" }, 403);
  }

  const body = await request.json().catch(() => ({}));
  const name = String(body?.characterName ?? "").trim();
  if (!name) return jsonResp({ error: "characterName required" }, 400);

  let resolved = null;
  try {
    const r = await fetch(`${ESI_BASE}/universe/ids/?datasource=tranquility`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify([name]),
      signal: AbortSignal.timeout(5000),
    });
    if (r.ok) {
      const data = await r.json();
      resolved = (data.characters ?? [])[0] ?? null;
    }
  } catch { /* fall through to 404 below */ }
  if (!resolved) {
    return jsonResp({ error: `Character "${name}" not found in EVE` }, 404);
  }

  const db = getServiceClient(env);
  const { error } = await db.from("admin_users").insert({
    character_id: resolved.id,
    character_name: resolved.name,
    granted_by_character_id: auth.characterId,
    granted_by_character_name: auth.characterName ?? null,
  });
  if (error) {
    if (error.code === "23505") {
      return jsonResp({ error: `${resolved.name} is already an admin` }, 409);
    }
    return jsonResp({ error: error.message }, 500);
  }

  return jsonResp({
    admin: {
      characterId: resolved.id,
      characterName: resolved.name,
      source: "db",
      grantedAt: new Date().toISOString(),
      grantedByName: auth.characterName ?? null,
    },
  }, 201);
}

export async function onRequestOptions() {
  return new Response(null, { headers: AUTH_HEADERS });
}

function jsonResp(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: AUTH_HEADERS });
}
