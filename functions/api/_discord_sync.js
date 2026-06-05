// Discord role-sync engine. fetchTitles reads a character's in-game corp
// titles; computeDesiredRoles maps an account's titles to the Discord roles it
// should hold; syncDiscordUser reconciles one Discord account against that
// target. All EVE characters sharing a discord_user_id (main + alts) are
// considered together.

import {
  getGuildMember,
  addGuildRole,
  removeGuildRole,
  setGuildNickname,
  formatEveNickname,
} from "./_discord.js";
import { getCorporationTicker } from "./_corp_info.js";

const ESI_BASE = "https://esi.evetech.net/latest";

// A character's in-game corp titles, read with that character's own EVE token.
// Throws an Error with `.status` set so callers can detect a 403 (the token was
// issued before esi-characters.read_titles.v1 was granted).
export async function fetchTitles(token, characterId) {
  let res;
  try {
    res = await fetch(
      `${ESI_BASE}/characters/${characterId}/titles/?datasource=tranquility`,
      {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(8000),
      }
    );
  } catch (e) {
    const err = new Error(`ESI titles request failed (${e.name === "TimeoutError" ? "timeout" : e.message})`);
    err.status = 504;
    throw err;
  }
  if (!res.ok) {
    const err = new Error(`ESI titles request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  const data = await res.json();
  return Array.isArray(data)
    ? data.map((t) => ({ title_id: t.title_id, name: t.name }))
    : [];
}

// The Discord roles an account should hold. Corp members get corp-only roles;
// non-corp linked characters always get the guest role (when configured) so
// they can reach guest-only Discord channels, and additionally get any
// matching militia role. Corp members never receive militia or guest roles
// even if their character is enlisted in a mapped militia.
//
//   inCorp:    verified-member + matching title roles
//   !inCorp:   __guest__ role (if configured) + any matching militia roles
export function computeDesiredRoles({ titleMap, militiaMap }, { inCorp, titleNames, factionIds }) {
  const desired = new Set();

  if (inCorp) {
    for (const m of titleMap ?? []) {
      // The __guest__ sentinel applies only to non-corp linked accounts —
      // guard against a hand-edited DB granting it to a corp member.
      if (m.title_name === "__guest__") continue;
      if (m.title_name == null || titleNames.has(m.title_name)) {
        desired.add(m.discord_role_id);
      }
    }
  } else {
    const guest = (titleMap ?? []).find((m) => m.title_name === "__guest__");
    if (guest) desired.add(guest.discord_role_id);
    for (const m of militiaMap ?? []) {
      if (factionIds.has(Number(m.faction_id))) {
        desired.add(m.discord_role_id);
      }
    }
  }

  return desired;
}

// The most recently linked / re-synced row in a multi-character (main + alts)
// Discord account. Used to choose which character's name + corp ticker drive
// the Discord nickname.
function pickFreshestRow(rows) {
  if (!rows || !rows.length) return null;
  let best = rows[0];
  let bestTs = Date.parse(best?.updated_at ?? "") || 0;
  for (let i = 1; i < rows.length; i++) {
    const ts = Date.parse(rows[i]?.updated_at ?? "") || 0;
    if (ts > bestTs) { best = rows[i]; bestTs = ts; }
  }
  return best;
}

function setsEqual(a, b) {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

async function logSync(db, characterId, action, detail) {
  try {
    await db.from("discord_sync_log").insert({
      character_id: characterId ?? null,
      action,
      detail: detail ? String(detail).slice(0, 500) : null,
    });
  } catch { /* logging must never break a sync */ }
}

// Reconciles one Discord account's roles against its linked characters' titles
// and militia. `opts.force` runs even when applied_roles already matches the
// target; `opts.titleMap` / `opts.militiaMap` let a sweep pass the maps in
// once instead of re-querying them.
export async function syncDiscordUser(db, env, discordUserId, opts = {}) {
  const { force = false } = opts;

  const { data: rows } = await db
    .from("discord_links")
    .select("character_id, character_name, corporation_id, titles, in_corp, faction_id, applied_roles, updated_at")
    .eq("discord_user_id", discordUserId);
  if (!rows || !rows.length) {
    return { discordUserId, skipped: true, reason: "no linked characters" };
  }

  const inCorp = rows.some((r) => r.in_corp);
  const titleNames = new Set();
  const factionIds = new Set();
  for (const r of rows) {
    // Titles only count when the character is in corp.
    if (r.in_corp) {
      for (const t of Array.isArray(r.titles) ? r.titles : []) {
        if (t?.name) titleNames.add(t.name);
      }
    }
    // Militia counts regardless of corp membership.
    if (r.faction_id != null) factionIds.add(Number(r.faction_id));
  }

  let titleMap = opts.titleMap;
  let militiaMap = opts.militiaMap;
  if (titleMap == null || militiaMap == null) {
    const [titleRes, militiaRes] = await Promise.all([
      titleMap == null
        ? db.from("title_role_map").select("title_name, discord_role_id")
        : Promise.resolve({ data: titleMap }),
      militiaMap == null
        ? db.from("militia_role_map").select("faction_id, discord_role_id")
        : Promise.resolve({ data: militiaMap }),
    ]);
    if (titleMap == null) titleMap = titleRes.data ?? [];
    if (militiaMap == null) militiaMap = militiaRes.data ?? [];
  }

  const managed = new Set([
    ...titleMap.map((m) => m.discord_role_id),
    ...militiaMap.map((m) => m.discord_role_id),
  ]);
  const desired = computeDesiredRoles(
    { titleMap, militiaMap },
    { inCorp, titleNames, factionIds }
  );
  const desiredArr = [...desired].sort();

  // applied_roles is kept identical across an account's rows — read row[0].
  const appliedPrev = new Set(
    Array.isArray(rows[0].applied_roles) ? rows[0].applied_roles : []
  );
  if (!force && setsEqual(desired, appliedPrev)) {
    return { discordUserId, skipped: true, reason: "already in sync", desired: desiredArr };
  }

  let current;
  try {
    current = await getGuildMember(env, discordUserId);
  } catch (e) {
    await logSync(db, rows[0].character_id, "error", `member lookup: ${e.message}`);
    return { discordUserId, skipped: true, reason: "discord lookup failed", desired: desiredArr };
  }
  if (current === null) {
    await logSync(db, rows[0].character_id, "skip", "not a member of the Discord server");
    return {
      discordUserId, skipped: true, reason: "not in guild",
      desired: desiredArr, memberFound: false,
    };
  }

  const currentSet = new Set(current);
  const toAdd = [...desired].filter((r) => !currentSet.has(r));
  const toRemove = [...currentSet].filter((r) => managed.has(r) && !desired.has(r));

  // applied = the managed roles we believe are on the account after this run.
  // Unmanaged roles (assigned by hand in Discord) are never touched.
  const applied = new Set([...currentSet].filter((r) => managed.has(r)));
  const errors = [];
  for (const roleId of toAdd) {
    try { await addGuildRole(env, discordUserId, roleId); applied.add(roleId); }
    catch (e) { errors.push(e.message); }
  }
  for (const roleId of toRemove) {
    try { await removeGuildRole(env, discordUserId, roleId); applied.delete(roleId); }
    catch (e) { errors.push(e.message); }
  }

  // Push the `[TICKER] CharacterName` nickname. Pick the most recently touched
  // linked character so the nickname tracks whichever character the user last
  // signed in / re-synced with. Failure here (typically 403 from role
  // hierarchy or guild-owner protection) is logged but doesn't roll back the
  // role changes — Discord-side fix-up is straightforward.
  const nickRow = pickFreshestRow(rows);
  if (nickRow?.character_name) {
    try {
      const ticker = await getCorporationTicker(db, nickRow.corporation_id);
      const nickname = formatEveNickname(ticker, nickRow.character_name);
      await setGuildNickname(env, discordUserId, nickname);
    } catch (e) {
      await logSync(db, nickRow.character_id, "nick-error", e.message);
    }
  }

  const appliedArr = [...applied].sort();
  const now = new Date().toISOString();
  await db.from("discord_links")
    .update({ applied_roles: appliedArr, last_synced_at: now, updated_at: now })
    .eq("discord_user_id", discordUserId);

  await logSync(
    db, rows[0].character_id,
    errors.length ? "sync-partial" : "sync",
    `+${toAdd.length} -${toRemove.length}${errors.length ? ` errors: ${errors.join("; ")}` : ""}`
  );

  return {
    discordUserId, skipped: false, memberFound: true,
    desired: desiredArr, applied: appliedArr,
    added: toAdd, removed: toRemove, errors,
  };
}
