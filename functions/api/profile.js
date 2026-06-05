// GET /api/profile — the data behind the Profile tab.
//
// Returns the caller's EVE identity, their live in-game titles, their Discord
// link status, and a per-role view of what the site thinks they should have vs.
// what is actually on their Discord account. Read-only: it refreshes the
// caller's title snapshot but never changes Discord roles (that's /profile/sync).
//
// Auth: EVE SSO bearer token.

import { getServiceClient } from "./_supabase.js";
import { verifyEveAuth, AUTH_HEADERS } from "./_auth.js";
import { fetchTitles, computeDesiredRoles } from "./_discord_sync.js";
import { getGuildMember } from "./_discord.js";
import { MILITIAS } from "./_militias.js";

export async function onRequestGet({ request, env }) {
  const auth = await verifyEveAuth(request, env, { allowNonCorp: true });
  if (auth.error) return jsonResp({ error: auth.error }, auth.status);

  const db = getServiceClient(env);
  const inCorp = auth.inCorp;

  // Live titles from ESI — only meaningful for corp members. For non-corp
  // callers ESI would 403 (titles only exist within a corp), so skip the call
  // and avoid surfacing a misleading "reauth" hint on the Profile tab.
  let titles = [];
  let titlesError = null;
  if (inCorp) {
    try {
      titles = await fetchTitles(auth.token, auth.characterId);
    } catch (e) {
      titlesError = e.status === 403 ? "reauth" : "esi";
    }
  }

  // Persist the snapshot (and identity) so the Phase 2 sweep has fresh data.
  const now = new Date().toISOString();
  const row = {
    character_id: auth.characterId,
    character_name: auth.characterName ?? `Character ${auth.characterId}`,
    corporation_id: auth.corporationId,
    faction_id: auth.factionId,
    in_corp: inCorp,
    updated_at: now,
  };
  if (!titlesError) row.titles = titles; // don't clobber a good snapshot on error
  await db.from("discord_links").upsert(row, { onConflict: "character_id" });

  const { data: link } = await db
    .from("discord_links")
    .select("discord_user_id, discord_username, last_synced_at")
    .eq("character_id", auth.characterId)
    .maybeSingle();

  const result = {
    character: {
      id: auth.characterId,
      name: auth.characterName,
      corporationId: auth.corporationId,
      factionId: auth.factionId,
      militiaName: auth.factionId ? (MILITIAS[auth.factionId] ?? null) : null,
      inCorp,
    },
    titles,
    titlesError,
    discord: {
      linked: !!link?.discord_user_id,
      username: link?.discord_username ?? null,
    },
    roles: null,
    lastSyncedAt: link?.last_synced_at ?? null,
  };

  if (link?.discord_user_id) {
    result.roles = await buildRoleView(
      db, env, link.discord_user_id, auth.characterId, titles, inCorp, auth.factionId
    );
  }
  return jsonResp(result);
}

// Builds the "should have vs. on Discord" role table for the linked account,
// using the caller's live titles + militia plus the stored snapshots of any
// linked alts.
async function buildRoleView(db, env, discordUserId, callerCharId, callerTitles, callerInCorp, callerFactionId) {
  const { data: rows } = await db
    .from("discord_links")
    .select("character_id, titles, in_corp, faction_id")
    .eq("discord_user_id", discordUserId);

  let inCorp = false;
  const titleNames = new Set();
  const factionIds = new Set();
  for (const r of rows ?? []) {
    const isCaller = r.character_id === callerCharId;
    const memberInCorp = isCaller ? callerInCorp : r.in_corp;
    const memberFactionId = isCaller ? callerFactionId : r.faction_id;
    if (memberInCorp) {
      inCorp = true;
      const ts = isCaller ? callerTitles : (Array.isArray(r.titles) ? r.titles : []);
      for (const t of ts) if (t?.name) titleNames.add(t.name);
    }
    if (memberFactionId != null) factionIds.add(Number(memberFactionId));
  }

  const [titleRes, militiaRes] = await Promise.all([
    db.from("title_role_map").select("id, title_name, discord_role_id"),
    db.from("militia_role_map").select("id, faction_id, discord_role_id"),
  ]);
  const titleMap = titleRes.data ?? [];
  const militiaMap = militiaRes.data ?? [];
  const desired = computeDesiredRoles({ titleMap, militiaMap }, { inCorp, titleNames, factionIds });

  let onDiscord = null;
  let memberFound = true;
  try {
    const current = await getGuildMember(env, discordUserId);
    if (current === null) memberFound = false;
    else onDiscord = new Set(current);
  } catch {
    memberFound = false;
  }

  const titleRows = titleMap.map((m) => {
    const isGuest = m.title_name === "__guest__";
    const isBase = m.title_name == null;
    return {
      label: isBase ? "Verified member" : isGuest ? "Guest" : m.title_name,
      kind: isBase ? "base" : isGuest ? "guest" : "title",
      roleId: m.discord_role_id,
      desired: desired.has(m.discord_role_id),
      onDiscord: onDiscord ? onDiscord.has(m.discord_role_id) : null,
    };
  });
  const militiaRows = militiaMap.map((m) => ({
    label: MILITIAS[m.faction_id] ?? `Faction ${m.faction_id}`,
    kind: "militia",
    roleId: m.discord_role_id,
    desired: desired.has(m.discord_role_id),
    onDiscord: onDiscord ? onDiscord.has(m.discord_role_id) : null,
  }));
  const roles = [...titleRows, ...militiaRows];
  const inSync = memberFound && onDiscord
    ? roles.every((r) => r.desired === r.onDiscord)
    : null;

  return { memberFound, inSync, roles };
}

export async function onRequestOptions() {
  return new Response(null, { headers: AUTH_HEADERS });
}

function jsonResp(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: AUTH_HEADERS });
}
