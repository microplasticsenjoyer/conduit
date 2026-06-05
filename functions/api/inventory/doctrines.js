// Corp-shared doctrine config for the Inventory tab.
//
//   GET /api/inventory/doctrines
//     → { entries: [{ id, doctrine, name, target, fitting }],
//         changelog: [{ logId, type, at, by, id, doctrine, name, target, fitting, changes? }],
//         notes: { [doctrine]: { notes, updatedBy, updatedAt } } }
//
//   PUT /api/inventory/doctrines
//     body { entries: [{ id, doctrine, name, target, fitting }] }
//     → replaces ALL rows for the caller's corp (atomic last-write-wins) and
//       records what changed (adds / deletes / per-field edits) in the
//       corp-wide changelog. Returns the new entries + refreshed changelog.
//
//   PATCH /api/inventory/doctrines
//     body { doctrine, notes }
//     → upserts the bulletin/notes block for a single doctrine tag (an empty
//       note clears it). Returns the refreshed notes map.
//
// Auth: EVE SSO bearer token. Membership in the configured corp is enforced
// server-side. Replace-all keeps the client logic simple — any save sends
// the full list and we reconcile to it; the diff against the previous set is
// what feeds "Recent Changes".

import { getServiceClient } from "../_supabase.js";
import { verifyEveAuth, AUTH_HEADERS } from "../_auth.js";

const CHANGELOG_LIMIT = 100;

export async function onRequestGet({ request, env }) {
  const auth = await verifyEveAuth(request, env);
  if (auth.error) return jsonResp({ error: auth.error }, auth.status);
  if (!auth.corporationId) return jsonResp({ entries: [], changelog: [], notes: {} });

  const db = getServiceClient(env);
  const { data, error } = await db
    .from("corp_doctrine")
    .select("id, doctrine, name, target, fitting, updated_at, updated_by_character_name")
    .eq("corp_id", auth.corporationId)
    .order("doctrine", { ascending: true })
    .order("name", { ascending: true });
  if (error) return jsonResp({ error: error.message }, 500);

  return jsonResp({
    entries: (data ?? []).map(toCamel),
    changelog: await readChangelog(db, auth.corporationId),
    notes: await readNotes(db, auth.corporationId),
  });
}

export async function onRequestPut({ request, env }) {
  const auth = await verifyEveAuth(request, env);
  if (auth.error) return jsonResp({ error: auth.error }, auth.status);
  if (!auth.corporationId) return jsonResp({ error: "No corp context" }, 403);

  const body = await request.json().catch(() => ({}));
  const entries = Array.isArray(body.entries) ? body.entries : null;
  if (!entries) return jsonResp({ error: "entries[] required" }, 400);
  if (entries.length > 500) return jsonResp({ error: "Too many entries (max 500)" }, 400);

  const now = new Date().toISOString();
  const corpId = auth.corporationId;
  const rows = [];
  for (const e of entries) {
    if (!e?.doctrine || !e?.name) continue;
    const id = isUuid(e.id) ? e.id : crypto.randomUUID();
    rows.push({
      id,
      corp_id: corpId,
      doctrine: String(e.doctrine).slice(0, 80),
      name: String(e.name).slice(0, 200),
      target: Math.max(0, parseInt(e.target, 10) || 0),
      fitting: e.fitting ? String(e.fitting).slice(0, 20_000) : null,
      updated_by_character_id: auth.characterId,
      updated_by_character_name: auth.characterName,
      updated_at: now,
    });
  }

  const db = getServiceClient(env);

  // Snapshot the corp's current set so we can record what this save changed.
  const { data: prevRows, error: selErr } = await db
    .from("corp_doctrine")
    .select("id, doctrine, name, target, fitting")
    .eq("corp_id", corpId);
  if (selErr) return jsonResp({ error: selErr.message }, 500);
  const logRows = diffDoctrines(prevRows ?? [], rows, { corpId, auth, now });

  // Replace-all: drop the corp's current rows, insert the incoming set.
  const { error: delErr } = await db.from("corp_doctrine").delete().eq("corp_id", corpId);
  if (delErr) return jsonResp({ error: delErr.message }, 500);
  if (rows.length > 0) {
    const { error: insErr } = await db.from("corp_doctrine").insert(rows);
    if (insErr) return jsonResp({ error: insErr.message }, 500);
  }

  // Best-effort: the doctrine is already saved at this point, so a changelog
  // write failure shouldn't fail the request (and a retry would double-log).
  if (logRows.length > 0) await db.from("corp_doctrine_changelog").insert(logRows);

  return jsonResp({ entries: rows.map(toCamel), changelog: await readChangelog(db, corpId) });
}

// Upsert the bulletin/notes block for a single doctrine tag. Unlike the
// entries PUT this is a targeted write — one doctrine's notes at a time — so
// concurrent edits to different doctrines don't clobber each other.
export async function onRequestPatch({ request, env }) {
  const auth = await verifyEveAuth(request, env);
  if (auth.error) return jsonResp({ error: auth.error }, auth.status);
  if (!auth.corporationId) return jsonResp({ error: "No corp context" }, 403);

  const body = await request.json().catch(() => ({}));
  const doctrine = body?.doctrine ? String(body.doctrine).slice(0, 80) : null;
  if (!doctrine) return jsonResp({ error: "doctrine required" }, 400);
  const notes = typeof body.notes === "string" ? body.notes.slice(0, 10_000) : "";

  const db = getServiceClient(env);
  const corpId = auth.corporationId;

  // An empty note clears the bulletin — drop the row rather than store blanks.
  if (notes.trim() === "") {
    const { error } = await db
      .from("corp_doctrine_notes")
      .delete()
      .eq("corp_id", corpId)
      .eq("doctrine", doctrine);
    if (error) return jsonResp({ error: error.message }, 500);
  } else {
    const { error } = await db
      .from("corp_doctrine_notes")
      .upsert({
        corp_id: corpId,
        doctrine,
        notes,
        updated_by_character_id: auth.characterId,
        updated_by_character_name: auth.characterName,
        updated_at: new Date().toISOString(),
      }, { onConflict: "corp_id,doctrine" });
    if (error) return jsonResp({ error: error.message }, 500);
  }

  return jsonResp({ notes: await readNotes(db, corpId) });
}

export async function onRequestOptions() {
  return new Response(null, { headers: AUTH_HEADERS });
}

// ── Changelog ───────────────────────────────────────────────────────────────

// Compares the previous doctrine set to the new one and produces changelog rows
// for additions, deletions, and per-field edits (doctrine tag, name, target,
// fitting). Entries are matched by id, which the client preserves across edits.
function diffDoctrines(prevRows, newRows, { corpId, auth, now }) {
  const prevById = new Map(prevRows.map((r) => [r.id, r]));
  const newById = new Map(newRows.map((r) => [r.id, r]));
  const out = [];
  const stamp = (r, change_type, changes) => ({
    corp_id: corpId,
    changed_at: now,
    changed_by_character_id: auth.characterId ?? null,
    changed_by_character_name: auth.characterName ?? null,
    change_type,
    entry_id: r.id,
    doctrine: r.doctrine,
    name: r.name,
    target: r.target ?? null,
    fitting: r.fitting ?? null,
    changes: changes ?? null,
  });
  for (const r of newRows) {
    const prev = prevById.get(r.id);
    if (!prev) { out.push(stamp(r, "added")); continue; }
    const changes = [];
    if (prev.doctrine !== r.doctrine) changes.push({ field: "doctrine", from: prev.doctrine, to: r.doctrine });
    if (prev.name !== r.name) changes.push({ field: "name", from: prev.name, to: r.name });
    if ((prev.target ?? 0) !== (r.target ?? 0)) changes.push({ field: "target", from: prev.target ?? 0, to: r.target ?? 0 });
    if ((prev.fitting ?? null) !== (r.fitting ?? null)) changes.push({ field: "fitting", from: prev.fitting ?? null, to: r.fitting ?? null });
    if (changes.length > 0) out.push(stamp(r, "edited", changes));
  }
  for (const r of prevRows) {
    if (!newById.has(r.id)) out.push(stamp(r, "deleted"));
  }
  return out;
}

async function readChangelog(db, corpId) {
  const { data } = await db
    .from("corp_doctrine_changelog")
    .select("id, changed_at, changed_by_character_name, change_type, entry_id, doctrine, name, target, fitting, changes")
    .eq("corp_id", corpId)
    .order("changed_at", { ascending: false })
    .limit(CHANGELOG_LIMIT);
  return (data ?? []).map(toChangelogEntry);
}

function toChangelogEntry(row) {
  const e = {
    logId: row.id,
    type: row.change_type,
    at: row.changed_at ? new Date(row.changed_at).getTime() : 0,
    by: row.changed_by_character_name ?? "Unknown",
    id: row.entry_id,
    doctrine: row.doctrine,
    name: row.name,
    target: row.target,
    fitting: row.fitting ?? null,
  };
  if (Array.isArray(row.changes) && row.changes.length > 0) e.changes = row.changes;
  return e;
}

// ── Bulletin notes ───────────────────────────────────────────────────────────

// Per-doctrine freeform notes, returned as a { [doctrine]: {...} } map so the
// client can look up each doctrine group's bulletin directly. A missing table
// (migration not yet applied) degrades to an empty map rather than a 500.
async function readNotes(db, corpId) {
  const { data } = await db
    .from("corp_doctrine_notes")
    .select("doctrine, notes, updated_at, updated_by_character_name")
    .eq("corp_id", corpId);
  const out = {};
  for (const row of data ?? []) {
    out[row.doctrine] = {
      notes: row.notes ?? "",
      updatedAt: row.updated_at ?? null,
      updatedBy: row.updated_by_character_name ?? null,
    };
  }
  return out;
}

// ── Misc ────────────────────────────────────────────────────────────────────

function jsonResp(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: AUTH_HEADERS });
}
function isUuid(s) {
  return typeof s === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}
function toCamel(row) {
  return {
    id: row.id,
    doctrine: row.doctrine,
    name: row.name,
    target: row.target,
    fitting: row.fitting,
    updatedAt: row.updated_at ?? null,
    updatedBy: row.updated_by_character_name ?? null,
  };
}
