// Militia (Faction Warfare) → Discord role mapping editor.
//
//   POST   /api/admin/militia-map      body { factionId, discordRoleId }   upsert
//   DELETE /api/admin/militia-map?id=  remove a mapping
//
// Accepts the four FW militias plus the two pirate insurgency factions —
// whatever MILITIA_FACTION_IDS exposes.

import { getServiceClient } from "../_supabase.js";
import { verifyEveAuth, isLeader, AUTH_HEADERS } from "../_auth.js";
import { MILITIA_FACTION_IDS } from "../_militias.js";

export async function onRequestPost({ request, env }) {
  const auth = await verifyEveAuth(request, env);
  if (auth.error) return jsonResp({ error: auth.error }, auth.status);
  if (!(await isLeader(auth.characterId, env))) {
    return jsonResp({ error: "Leadership only" }, 403);
  }

  const body = await request.json().catch(() => ({}));
  const factionId = parseInt(body?.factionId, 10);
  if (!MILITIA_FACTION_IDS.includes(factionId)) {
    return jsonResp({
      error: `factionId must be one of: ${MILITIA_FACTION_IDS.join(", ")}`,
    }, 400);
  }
  const discordRoleId = typeof body?.discordRoleId === "string"
    ? body.discordRoleId.trim() : "";
  if (!discordRoleId) return jsonResp({ error: "discordRoleId required" }, 400);

  const db = getServiceClient(env);
  const { data, error } = await db
    .from("militia_role_map")
    .upsert(
      { faction_id: factionId, discord_role_id: discordRoleId },
      { onConflict: "faction_id" }
    )
    .select("id, faction_id, discord_role_id")
    .single();
  if (error) return jsonResp({ error: error.message }, 500);

  return jsonResp({
    mapping: {
      id: data.id,
      factionId: data.faction_id,
      discordRoleId: data.discord_role_id,
    },
  });
}

export async function onRequestDelete({ request, env }) {
  const auth = await verifyEveAuth(request, env);
  if (auth.error) return jsonResp({ error: auth.error }, auth.status);
  if (!(await isLeader(auth.characterId, env))) {
    return jsonResp({ error: "Leadership only" }, 403);
  }

  const id = new URL(request.url).searchParams.get("id");
  if (!id) return jsonResp({ error: "id required" }, 400);

  const db = getServiceClient(env);
  const { error } = await db.from("militia_role_map").delete().eq("id", id);
  if (error) return jsonResp({ error: error.message }, 500);
  return new Response(null, { status: 204, headers: AUTH_HEADERS });
}

export async function onRequestOptions() {
  return new Response(null, { headers: AUTH_HEADERS });
}

function jsonResp(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: AUTH_HEADERS });
}
