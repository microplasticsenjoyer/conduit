// DELETE /api/admin/admins/:characterId — revoke admin rights.
//
// Env-listed admins (EVE_LEADERSHIP_IDS) cannot be removed from the DB; they
// must be edited out of wrangler.jsonc and redeployed. The endpoint also
// refuses self-removal to prevent an accidental lock-out.

import { getServiceClient } from "../../_supabase.js";
import { verifyEveAuth, isLeader, AUTH_HEADERS } from "../../_auth.js";

export async function onRequestDelete({ request, env, params }) {
  const auth = await verifyEveAuth(request, env);
  if (auth.error) return jsonResp({ error: auth.error }, auth.status);
  if (!(await isLeader(auth.characterId, env))) {
    return jsonResp({ error: "Leadership only" }, 403);
  }

  const characterId = parseInt(params.characterId, 10);
  if (!Number.isFinite(characterId)) {
    return jsonResp({ error: "Invalid character id" }, 400);
  }

  const envIds = (env.EVE_LEADERSHIP_IDS ?? "")
    .split(",")
    .map((s) => parseInt(s.trim(), 10))
    .filter(Number.isFinite);
  if (envIds.includes(characterId)) {
    return jsonResp({
      error: "Env-listed admins must be removed from wrangler.jsonc and redeployed.",
    }, 400);
  }

  if (characterId === auth.characterId) {
    return jsonResp({ error: "You can't remove yourself." }, 400);
  }

  const db = getServiceClient(env);
  const { error } = await db.from("admin_users").delete().eq("character_id", characterId);
  if (error) return jsonResp({ error: error.message }, 500);

  return new Response(null, { status: 204, headers: AUTH_HEADERS });
}

export async function onRequestOptions() {
  return new Response(null, { headers: AUTH_HEADERS });
}

function jsonResp(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: AUTH_HEADERS });
}
