// PATCH /api/fund/ledger/:id
//   body: { kind?, amount?, effectiveMonth?, notes? }
//   Leadership-only. Edits kind/amount/effectiveMonth/notes.
//   Re-runs per-person cap check (excluding this entry).
//   → { entry: {...} }
//
// DELETE /api/fund/ledger/:id
//   Leadership-only. Hard-deletes the ledger row.
//   → 204 No Content

import { getServiceClient } from "../../_supabase.js";
import { verifyEveAuth, isLeader, AUTH_HEADERS } from "../../_auth.js";
import {
  ALL_KINDS,
  KIND_WITHDRAWAL,
  PER_PERSON_CAP,
  PRINCIPAL_KINDS,
  currentMonthString,
  isValidMonth,
} from "../_helpers.js";

export async function onRequestPatch({ request, env, params }) {
  const auth = await verifyEveAuth(request, env);
  if (auth.error) return jsonResp({ error: auth.error }, auth.status);
  if (!(await isLeader(auth.characterId, env))) return jsonResp({ error: "Leadership only" }, 403);

  const id = parseInt(params.id, 10);
  if (!Number.isFinite(id)) return jsonResp({ error: "Invalid id" }, 400);

  const db = getServiceClient(env);

  const { data: existing, error: fetchErr } = await db
    .from("fund_ledger")
    .select("id, character_id, kind, amount, effective_month, notes")
    .eq("id", id)
    .single();
  if (fetchErr || !existing) return jsonResp({ error: "Entry not found" }, 404);

  const body = await request.json().catch(() => ({}));

  const kind = body?.kind !== undefined ? String(body.kind).trim() : existing.kind;
  if (!ALL_KINDS.includes(kind)) {
    return jsonResp({ error: `kind must be one of: ${ALL_KINDS.join(", ")}` }, 400);
  }

  const rawAmount = body?.amount !== undefined
    ? Number(body.amount)
    : Math.abs(Number(existing.amount));
  if (!Number.isFinite(rawAmount) || rawAmount === 0) {
    return jsonResp({ error: "amount must be a non-zero number" }, 400);
  }
  const storedAmount = kind === KIND_WITHDRAWAL ? -Math.abs(rawAmount) : Math.abs(rawAmount);

  const effectiveMonth = body?.effectiveMonth !== undefined
    ? String(body.effectiveMonth)
    : existing.effective_month;
  if (!isValidMonth(effectiveMonth)) {
    return jsonResp({ error: "effectiveMonth must be YYYY-MM" }, 400);
  }

  const notes = body?.notes !== undefined
    ? (body.notes ? String(body.notes).slice(0, 2000) : null)
    : existing.notes;

  // Re-run cap check excluding this entry
  if (PRINCIPAL_KINDS.has(kind)) {
    const { data: others, error: balErr } = await db
      .from("fund_ledger")
      .select("amount, effective_month, kind")
      .eq("character_id", existing.character_id)
      .neq("id", id);
    if (balErr) return jsonResp({ error: balErr.message }, 500);
    const month = currentMonthString();
    let bal = 0;
    for (const r of (others ?? [])) {
      if (PRINCIPAL_KINDS.has(r.kind) && r.effective_month <= month) {
        bal += Number(r.amount);
      }
    }
    const projected = bal + storedAmount;
    if (projected > PER_PERSON_CAP) {
      return jsonResp({
        error: `Per-person cap is ${PER_PERSON_CAP.toLocaleString()} ISK. This edit would bring the balance to ${projected.toLocaleString()}.`,
      }, 400);
    }
    if (projected < 0) {
      return jsonResp({
        error: `Edit would result in a negative balance (${projected.toLocaleString()} ISK).`,
      }, 400);
    }
  }

  const { data: updated, error: updateErr } = await db
    .from("fund_ledger")
    .update({ kind, amount: storedAmount, effective_month: effectiveMonth, notes })
    .eq("id", id)
    .select("id, character_id, kind, amount, effective_month, notes, recorded_by_name, recorded_at, fund_investors!inner(character_name)")
    .single();
  if (updateErr) return jsonResp({ error: updateErr.message }, 500);

  return jsonResp({
    entry: {
      id: updated.id,
      characterId: updated.character_id,
      characterName: updated.fund_investors?.character_name ?? null,
      kind: updated.kind,
      amount: Number(updated.amount),
      effectiveMonth: updated.effective_month,
      notes: updated.notes,
      recordedByName: updated.recorded_by_name,
      recordedAt: updated.recorded_at,
    },
  });
}

export async function onRequestDelete({ request, env, params }) {
  const auth = await verifyEveAuth(request, env);
  if (auth.error) return jsonResp({ error: auth.error }, auth.status);
  if (!(await isLeader(auth.characterId, env))) return jsonResp({ error: "Leadership only" }, 403);

  const id = parseInt(params.id, 10);
  if (!Number.isFinite(id)) return jsonResp({ error: "Invalid id" }, 400);

  const db = getServiceClient(env);
  const { error } = await db.from("fund_ledger").delete().eq("id", id);
  if (error) return jsonResp({ error: error.message }, 500);

  return new Response(null, { status: 204, headers: AUTH_HEADERS });
}

export async function onRequestOptions() {
  return new Response(null, { headers: AUTH_HEADERS });
}

function jsonResp(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: AUTH_HEADERS });
}
