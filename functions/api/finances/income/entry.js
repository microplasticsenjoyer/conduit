// POST   /api/finances/income/entry — record a new entry (leadership only)
// PATCH  /api/finances/income/entry — edit or restore an entry (leadership only)
// DELETE /api/finances/income/entry — soft-delete an entry (leadership only)
//
// PATCH body: { id, direction?, amount?, category?, effectiveMonth?, notes?,
//               restore?: true }
//   - `restore: true` clears deleted_at; all other fields ignored.
//   - Otherwise: any subset of fields is allowed; edited_at/edited_by_* stamped.
// DELETE body: { id } — sets deleted_at = now().

import { getServiceClient } from "../../_supabase.js";
import { verifyEveAuth, isLeader, AUTH_HEADERS } from "../../_auth.js";

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const DIRECTIONS = new Set(["inflow", "outflow"]);
const ROW_COLS = "id, direction, amount, category, effective_month, notes, recorded_by_id, recorded_by_name, recorded_at, edited_at, edited_by_id, edited_by_name, deleted_at";

export async function onRequestPost({ request, env }) {
  const auth = await verifyEveAuth(request, env);
  if (auth.error) return jsonResp({ error: auth.error }, auth.status);
  if (!(await isLeader(auth.characterId, env))) {
    return jsonResp({ error: "Leadership only" }, 403);
  }

  const body = await request.json().catch(() => ({}));
  const direction = String(body?.direction ?? "").trim();
  if (!DIRECTIONS.has(direction)) {
    return jsonResp({ error: "direction must be 'inflow' or 'outflow'" }, 400);
  }
  const amount = Number(body?.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    return jsonResp({ error: "amount must be a positive number" }, 400);
  }
  const category = String(body?.category ?? "").trim();
  if (!category) return jsonResp({ error: "category required" }, 400);
  const effectiveMonth = String(body?.effectiveMonth ?? "").trim();
  if (!MONTH_RE.test(effectiveMonth)) {
    return jsonResp({ error: "effectiveMonth must be YYYY-MM" }, 400);
  }
  const notes = body?.notes == null ? null : String(body.notes).trim().slice(0, 500) || null;

  const db = getServiceClient(env);
  const { data, error } = await db
    .from("income_entries")
    .insert({
      direction,
      amount,
      category: category.slice(0, 80),
      effective_month: effectiveMonth,
      notes,
      recorded_by_id: auth.characterId,
      recorded_by_name: auth.characterName ?? "Unknown",
      recorded_at: new Date().toISOString(),
    })
    .select(ROW_COLS)
    .single();
  if (error) return jsonResp({ error: error.message }, 500);

  return jsonResp({ entry: shape(data) }, 201);
}

export async function onRequestPatch({ request, env }) {
  const auth = await verifyEveAuth(request, env);
  if (auth.error) return jsonResp({ error: auth.error }, auth.status);
  if (!(await isLeader(auth.characterId, env))) {
    return jsonResp({ error: "Leadership only" }, 403);
  }

  const body = await request.json().catch(() => ({}));
  const id = String(body?.id ?? "").trim();
  if (!id) return jsonResp({ error: "id required" }, 400);

  const db = getServiceClient(env);

  if (body?.restore === true) {
    const { data, error } = await db
      .from("income_entries")
      .update({ deleted_at: null })
      .eq("id", id)
      .select(ROW_COLS)
      .maybeSingle();
    if (error) return jsonResp({ error: error.message }, 500);
    if (!data) return jsonResp({ error: "Entry not found" }, 404);
    return jsonResp({ entry: shape(data) });
  }

  const patch = {};
  if (body?.direction != null) {
    const direction = String(body.direction).trim();
    if (!DIRECTIONS.has(direction)) {
      return jsonResp({ error: "direction must be 'inflow' or 'outflow'" }, 400);
    }
    patch.direction = direction;
  }
  if (body?.amount != null) {
    const amount = Number(body.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      return jsonResp({ error: "amount must be a positive number" }, 400);
    }
    patch.amount = amount;
  }
  if (body?.category != null) {
    const category = String(body.category).trim();
    if (!category) return jsonResp({ error: "category required" }, 400);
    patch.category = category.slice(0, 80);
  }
  if (body?.effectiveMonth != null) {
    const effectiveMonth = String(body.effectiveMonth).trim();
    if (!MONTH_RE.test(effectiveMonth)) {
      return jsonResp({ error: "effectiveMonth must be YYYY-MM" }, 400);
    }
    patch.effective_month = effectiveMonth;
  }
  if (body?.notes !== undefined) {
    if (body.notes == null) patch.notes = null;
    else patch.notes = String(body.notes).trim().slice(0, 500) || null;
  }

  if (Object.keys(patch).length === 0) {
    return jsonResp({ error: "no fields to update" }, 400);
  }

  patch.edited_at = new Date().toISOString();
  patch.edited_by_id = auth.characterId;
  patch.edited_by_name = auth.characterName ?? "Unknown";

  const { data, error } = await db
    .from("income_entries")
    .update(patch)
    .eq("id", id)
    .is("deleted_at", null)
    .select(ROW_COLS)
    .maybeSingle();
  if (error) return jsonResp({ error: error.message }, 500);
  if (!data) return jsonResp({ error: "Entry not found" }, 404);

  return jsonResp({ entry: shape(data) });
}

export async function onRequestDelete({ request, env }) {
  const auth = await verifyEveAuth(request, env);
  if (auth.error) return jsonResp({ error: auth.error }, auth.status);
  if (!(await isLeader(auth.characterId, env))) {
    return jsonResp({ error: "Leadership only" }, 403);
  }

  const body = await request.json().catch(() => ({}));
  const id = String(body?.id ?? "").trim();
  if (!id) return jsonResp({ error: "id required" }, 400);

  const db = getServiceClient(env);
  const { data, error } = await db
    .from("income_entries")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", id)
    .is("deleted_at", null)
    .select(ROW_COLS)
    .maybeSingle();
  if (error) return jsonResp({ error: error.message }, 500);
  if (!data) return jsonResp({ error: "Entry not found" }, 404);

  return jsonResp({ entry: shape(data) });
}

export async function onRequestOptions() {
  return new Response(null, { headers: AUTH_HEADERS });
}

function shape(row) {
  return {
    id: row.id,
    direction: row.direction,
    amount: Number(row.amount),
    category: row.category,
    effectiveMonth: row.effective_month,
    notes: row.notes,
    recordedById: row.recorded_by_id,
    recordedByName: row.recorded_by_name,
    recordedAt: row.recorded_at,
    editedAt: row.edited_at ?? null,
    editedByName: row.edited_by_name ?? null,
  };
}

function jsonResp(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: AUTH_HEADERS });
}
