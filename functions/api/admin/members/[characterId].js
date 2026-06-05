// POST /api/admin/members/:characterId — admin actions against one linked
// member's Discord account.
//
//   body { action: "sync" }                        force a role re-sync
//   body { action: "addRole", roleId }             grant a Discord role manually
//   body { action: "removeRole", roleId }          strip a Discord role manually
//
// Manual role actions call Discord directly without touching applied_roles —
// the next sync will reconcile against the title map and undo any overrides
// that conflict with reality. This matches "manual override is a stopgap".

import { getServiceClient } from "../../_supabase.js";
import { verifyEveAuth, isLeader, AUTH_HEADERS } from "../../_auth.js";
import { addGuildRole, removeGuildRole } from "../../_discord.js";
import { syncDiscordUser } from "../../_discord_sync.js";

export async function onRequestPost({ request, env, params }) {
  const auth = await verifyEveAuth(request, env);
  if (auth.error) return jsonResp({ error: auth.error }, auth.status);
  if (!(await isLeader(auth.characterId, env))) {
    return jsonResp({ error: "Leadership only" }, 403);
  }

  const characterId = parseInt(params.characterId, 10);
  if (!Number.isFinite(characterId)) {
    return jsonResp({ error: "Invalid character id" }, 400);
  }

  const body = await request.json().catch(() => ({}));
  const action = body?.action;

  const db = getServiceClient(env);
  const { data: row } = await db
    .from("discord_links")
    .select("discord_user_id")
    .eq("character_id", characterId)
    .maybeSingle();
  if (!row?.discord_user_id) {
    return jsonResp({ error: "Character is not linked to a Discord account" }, 404);
  }

  if (action === "sync") {
    const result = await syncDiscordUser(db, env, row.discord_user_id, { force: true });
    return jsonResp({ ok: true, sync: result });
  }

  if (action === "addRole" || action === "removeRole") {
    const roleId = typeof body?.roleId === "string" ? body.roleId.trim() : "";
    if (!roleId) return jsonResp({ error: "Missing roleId" }, 400);
    try {
      if (action === "addRole") await addGuildRole(env, row.discord_user_id, roleId);
      else                       await removeGuildRole(env, row.discord_user_id, roleId);
    } catch (e) {
      return jsonResp({ error: e.message }, 502);
    }
    await db.from("discord_sync_log").insert({
      character_id: characterId,
      action: `manual-${action}`,
      detail: `by ${auth.characterName ?? auth.characterId}: ${roleId}`,
    });
    return jsonResp({ ok: true });
  }

  return jsonResp({ error: "Unknown action" }, 400);
}

export async function onRequestOptions() {
  return new Response(null, { headers: AUTH_HEADERS });
}

function jsonResp(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: AUTH_HEADERS });
}
