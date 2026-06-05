// GET /api/admin/overview — everything the Admin tab needs in one shot:
// linked members, the title→role mapping, the Discord guild's roles, and the
// list of admins (env-listed + DB-listed).
//
// Leadership only.

import { getServiceClient } from "../_supabase.js";
import { verifyEveAuth, isLeader, AUTH_HEADERS } from "../_auth.js";
import { listGuildRoles } from "../_discord.js";

const ESI_BASE = "https://esi.evetech.net/latest";

export async function onRequestGet({ request, env }) {
  const auth = await verifyEveAuth(request, env);
  if (auth.error) return jsonResp({ error: auth.error }, auth.status);
  if (!(await isLeader(auth.characterId, env))) {
    return jsonResp({ error: "Leadership only" }, 403);
  }

  const db = getServiceClient(env);

  // listGuildRoles can throw if Discord isn't configured yet — the rest of
  // the panel still works (role IDs will just render without names).
  const [memRes, titleMapRes, militiaMapRes, dbAdminRes, guildRoles] = await Promise.all([
    db.from("discord_links")
      .select("character_id, character_name, corporation_id, discord_user_id, discord_username, titles, in_corp, faction_id, applied_roles, last_synced_at, updated_at")
      .order("updated_at", { ascending: false })
      .limit(2000),
    db.from("title_role_map")
      .select("id, title_name, discord_role_id, created_at")
      .order("created_at", { ascending: true }),
    db.from("militia_role_map")
      .select("id, faction_id, discord_role_id, created_at")
      .order("created_at", { ascending: true }),
    db.from("admin_users")
      .select("character_id, character_name, granted_at, granted_by_character_name")
      .order("granted_at", { ascending: true }),
    listGuildRoles(env).catch(() => []),
  ]);

  const dbAdminRows = dbAdminRes.data ?? [];

  const envIds = (env.EVE_LEADERSHIP_IDS ?? "")
    .split(",")
    .map((s) => parseInt(s.trim(), 10))
    .filter(Number.isFinite);

  // Resolve env-listed admin names from ESI — env list is small (1–3 chars).
  const envAdmins = await Promise.all(envIds.map(async (id) => {
    let name = `Character ${id}`;
    try {
      const r = await fetch(
        `${ESI_BASE}/characters/${id}/?datasource=tranquility`,
        { signal: AbortSignal.timeout(5000) }
      );
      if (r.ok) name = (await r.json()).name ?? name;
    } catch { /* fall back to placeholder */ }
    return { characterId: id, characterName: name, source: "env" };
  }));

  // Don't double-list an admin who's in both env and the DB.
  const envIdSet = new Set(envIds);
  const dbAdmins = dbAdminRows
    .filter((r) => !envIdSet.has(r.character_id))
    .map((r) => ({
      characterId: r.character_id,
      characterName: r.character_name,
      source: "db",
      grantedAt: r.granted_at,
      grantedByName: r.granted_by_character_name,
    }));

  return jsonResp({
    members: (memRes.data ?? []).map((m) => ({
      characterId: m.character_id,
      characterName: m.character_name,
      corporationId: m.corporation_id,
      factionId: m.faction_id ?? null,
      discordUserId: m.discord_user_id,
      discordUsername: m.discord_username,
      titles: Array.isArray(m.titles) ? m.titles : [],
      inCorp: !!m.in_corp,
      appliedRoles: Array.isArray(m.applied_roles) ? m.applied_roles : [],
      lastSyncedAt: m.last_synced_at,
      updatedAt: m.updated_at,
    })),
    titleRoleMap: (titleMapRes.data ?? []).map((r) => ({
      id: r.id,
      titleName: r.title_name,
      discordRoleId: r.discord_role_id,
    })),
    militiaRoleMap: (militiaMapRes.data ?? []).map((r) => ({
      id: r.id,
      factionId: r.faction_id,
      discordRoleId: r.discord_role_id,
    })),
    guildRoles: guildRoles.map((r) => ({
      id: r.id,
      name: r.name,
      color: r.color ?? 0,
      position: r.position ?? 0,
    })),
    admins: [...envAdmins, ...dbAdmins],
  });
}

export async function onRequestOptions() {
  return new Response(null, { headers: AUTH_HEADERS });
}

function jsonResp(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: AUTH_HEADERS });
}
