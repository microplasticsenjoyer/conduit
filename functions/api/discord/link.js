// Discord account linking.
//
//   POST   /api/discord/link   — exchange an OAuth code, link Discord to the
//                                authenticated EVE character, apply roles
//   DELETE /api/discord/link   — unlink Discord from the authenticated character
//
// Auth: EVE SSO bearer token. The Discord OAuth code is exchanged server-side
// so the client secret never reaches the browser.

import { getServiceClient } from "../_supabase.js";
import { verifyEveAuth, AUTH_HEADERS } from "../_auth.js";
import { exchangeDiscordCode } from "../_discord.js";
import { fetchTitles, syncDiscordUser } from "../_discord_sync.js";

export async function onRequestPost({ request, env }) {
  const auth = await verifyEveAuth(request, env, { allowNonCorp: true });
  if (auth.error) return jsonResp({ error: auth.error }, auth.status);

  const body = await request.json().catch(() => ({}));
  const code = typeof body.code === "string" ? body.code.trim() : "";
  if (!code) return jsonResp({ error: "Missing OAuth code" }, 400);

  let discord;
  try {
    discord = await exchangeDiscordCode(env, code);
  } catch (e) {
    return jsonResp({ error: `Discord linking failed: ${e.message}` }, 502);
  }

  const db = getServiceClient(env);
  const inCorp = auth.inCorp;
  const now = new Date().toISOString();

  // Capture titles up front so the first sync is complete. A 403 here just
  // means the EVE token predates the titles scope — link anyway, base role only.
  let titles = null;
  try { titles = await fetchTitles(auth.token, auth.characterId); } catch { titles = null; }

  const row = {
    character_id: auth.characterId,
    character_name: auth.characterName ?? `Character ${auth.characterId}`,
    corporation_id: auth.corporationId,
    faction_id: auth.factionId,
    discord_user_id: discord.id,
    discord_username: discord.username,
    in_corp: inCorp,
    updated_at: now,
  };
  if (titles) row.titles = titles;

  const { error } = await db.from("discord_links").upsert(row, { onConflict: "character_id" });
  if (error) return jsonResp({ error: error.message }, 500);

  // Apply roles immediately so the member sees the result on the Profile tab.
  let sync = null;
  try {
    sync = await syncDiscordUser(db, env, discord.id, { force: true });
  } catch (e) {
    sync = { error: e.message };
  }

  return jsonResp({ ok: true, discord: { username: discord.username }, sync });
}

export async function onRequestDelete({ request, env }) {
  const auth = await verifyEveAuth(request, env, { allowNonCorp: true });
  if (auth.error) return jsonResp({ error: auth.error }, auth.status);

  const db = getServiceClient(env);
  const { error } = await db
    .from("discord_links")
    .update({
      discord_user_id: null,
      discord_username: null,
      applied_roles: [],
      updated_at: new Date().toISOString(),
    })
    .eq("character_id", auth.characterId);
  if (error) return jsonResp({ error: error.message }, 500);

  return jsonResp({ ok: true });
}

export async function onRequestOptions() {
  return new Response(null, { headers: AUTH_HEADERS });
}

function jsonResp(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: AUTH_HEADERS });
}
