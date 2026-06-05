// Mark a pilot's approved SRP losses as paid — the "Paid" button in the
// Ready-to-Pay panel.
//
//   POST /api/srp/:fleetId/pay
//     body { characterName, paid? }   paid defaults to true
//     → { losses: [ ...updated lossFields ] }
//
// Stamps paid_at / paid_by on every approved loss for that pilot in the fleet.
// Marking paid skips losses already stamped (so an existing paid_at keeps its
// original time); un-marking (paid:false) clears every approved loss.
//
// Auth: EVE SSO bearer token; corp membership enforced by verifyEveAuth.
// Leadership only (EVE_LEADERSHIP_IDS) — same gate as approving a loss.

import { getServiceClient } from "../../_supabase.js";
import { verifyEveAuth, isLeader, AUTH_HEADERS } from "../../_auth.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOSS_COLS =
  "id, character_id, character_name, zkill_url, kill_id, ship_type_id, ship_name, loss_value, payment_amount, rejection_reason, notes, status, created_at, paid_at, paid_by";

async function resolveFleet(db, fleetId, corpId) {
  const isUuid = UUID_RE.test(fleetId);
  return isUuid
    ? db.from("srp_fleets").select("id").eq("id", fleetId).eq("corp_id", corpId).single()
    : db.from("srp_fleets").select("id").eq("slug", fleetId).eq("corp_id", corpId).single();
}

export async function onRequestPost({ request, env, params }) {
  const auth = await verifyEveAuth(request, env);
  if (auth.error) return jsonResp({ error: auth.error }, auth.status);
  if (!(await isLeader(auth.characterId, env))) {
    return jsonResp({ error: "Leadership only" }, 403);
  }

  const body = await request.json().catch(() => ({}));
  const characterName = typeof body?.characterName === "string" ? body.characterName.trim() : "";
  const paid = body?.paid !== false; // default true
  if (!characterName) return jsonResp({ error: "characterName is required" }, 400);

  const db = getServiceClient(env);
  const corpId = parseInt(env.EVE_CORP_ID, 10);
  const { fleetId } = params;

  const { data: fleet, error: fleetErr } = await resolveFleet(db, fleetId, corpId);
  if (fleetErr || !fleet) return jsonResp({ error: "Fleet not found" }, 404);

  // Only approved losses can be paid. When marking paid, skip rows already
  // stamped so an existing paid_at keeps its original time.
  let q = db
    .from("srp_losses")
    .update({
      paid_at: paid ? new Date().toISOString() : null,
      paid_by: paid ? (auth.characterName ?? null) : null,
    })
    .eq("fleet_id", fleet.id)
    .eq("character_name", characterName)
    .eq("status", "approved");
  if (paid) q = q.is("paid_at", null);

  const { data, error } = await q.select(LOSS_COLS);
  if (error) return jsonResp({ error: error.message }, 500);

  return jsonResp({ losses: (data ?? []).map(toLoss) });
}

export async function onRequestOptions() {
  return new Response(null, { headers: AUTH_HEADERS });
}

function jsonResp(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: AUTH_HEADERS });
}

function toLoss(l) {
  return {
    id: l.id,
    characterId: l.character_id,
    characterName: l.character_name,
    zkillUrl: l.zkill_url,
    killId: l.kill_id,
    shipTypeId: l.ship_type_id,
    shipName: l.ship_name,
    lossValue: l.loss_value,
    paymentAmount: l.payment_amount,
    rejectionReason: l.rejection_reason,
    notes: l.notes,
    status: l.status,
    createdAt: l.created_at,
    paidAt: l.paid_at,
    paidBy: l.paid_by,
  };
}
