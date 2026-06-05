// POST /api/profile/sync — re-sync the caller's Discord roles right now.
//
// Refreshes the caller's title snapshot from ESI, then reconciles their linked
// Discord account's roles against it. Powers the Profile tab's "Re-sync now"
// button.
//
// Auth: EVE SSO bearer token.

import { getServiceClient } from "../_supabase.js";
import { verifyEveAuth, AUTH_HEADERS } from "../_auth.js";
import { fetchTitles, syncDiscordUser } from "../_discord_sync.js";

export async function onRequestPost({ request, env }) {
  const auth = await verifyEveAuth(request, env, { allowNonCorp: true });
  if (auth.error) return jsonResp({ error: auth.error }, auth.status);

  const db = getServiceClient(env);
  const inCorp = auth.inCorp;

  // Non-corp characters never have corp titles — skip the ESI call so the
  // expected 403 doesn't surface as a "reauth" error on the Profile tab.
  let titles = [];
  if (inCorp) {
    try {
      titles = await fetchTitles(auth.token, auth.characterId);
    } catch (e) {
      if (e.status === 403) {
        return jsonResp(
          { error: "Your EVE login predates the titles permission. Log out and log in again." },
          403
        );
      }
      return jsonResp({ error: "Could not read titles from EVE ESI." }, 502);
    }
  }

  const now = new Date().toISOString();
  await db.from("discord_links").upsert(
    {
      character_id: auth.characterId,
      character_name: auth.characterName ?? `Character ${auth.characterId}`,
      corporation_id: auth.corporationId,
      faction_id: auth.factionId,
      titles,
      in_corp: inCorp,
      updated_at: now,
    },
    { onConflict: "character_id" }
  );

  const { data: link } = await db
    .from("discord_links")
    .select("discord_user_id")
    .eq("character_id", auth.characterId)
    .maybeSingle();
  if (!link?.discord_user_id) {
    return jsonResp({ error: "Link your Discord account first." }, 400);
  }

  const sync = await syncDiscordUser(db, env, link.discord_user_id, { force: true });
  return jsonResp({ ok: true, sync });
}

export async function onRequestOptions() {
  return new Response(null, { headers: AUTH_HEADERS });
}

function jsonResp(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: AUTH_HEADERS });
}
