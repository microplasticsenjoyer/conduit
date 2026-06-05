// Mutate a single SRP loss.
//
//   PATCH /api/srp/:fleetId/losses/:lossId
//     Two callers:
//     - Leadership: body { status, paymentAmount?, rejectionReason? } → decide a loss
//     - Loss owner: body { notes } on a pending loss only → fix a typo
//     → { loss: { ...lossFields } }
//
//   DELETE /api/srp/:fleetId/losses/:lossId
//     Loss owner can withdraw their own pending loss; leadership can delete any.
//     → 204
//
// Auth: EVE SSO bearer token; corp membership enforced by verifyEveAuth.

import { getServiceClient } from "../../../_supabase.js";
import { verifyEveAuth, isLeader, AUTH_HEADERS } from "../../../_auth.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NOTES_MAX = 2000;

async function resolveFleet(db, fleetId, corpId) {
  const isUuid = UUID_RE.test(fleetId);
  return isUuid
    ? db.from("srp_fleets").select("id").eq("id", fleetId).eq("corp_id", corpId).single()
    : db.from("srp_fleets").select("id").eq("slug", fleetId).eq("corp_id", corpId).single();
}

export async function onRequestPatch({ request, env, params }) {
  const auth = await verifyEveAuth(request, env);
  if (auth.error) return jsonResp({ error: auth.error }, auth.status);

  const body = await request.json().catch(() => ({}));
  const { status, paymentAmount, rejectionReason, notes } = body ?? {};

  const db = getServiceClient(env);
  const corpId = parseInt(env.EVE_CORP_ID, 10);
  const { fleetId, lossId } = params;

  const { data: fleet, error: fleetErr } = await resolveFleet(db, fleetId, corpId);
  if (fleetErr || !fleet) return jsonResp({ error: "Fleet not found" }, 404);

  // Owner-edit path: notes-only PATCH on a pending loss the caller owns.
  // We detect this by the body containing notes and no status. Leadership
  // still hits this branch when fixing notes themselves — the ownership
  // check below short-circuits for them.
  if (status == null && notes !== undefined) {
    const { data: loss, error: lookupErr } = await db
      .from("srp_losses")
      .select("character_id, status")
      .eq("id", lossId)
      .eq("fleet_id", fleet.id)
      .single();
    if (lookupErr || !loss) return jsonResp({ error: "Loss not found" }, 404);

    const isOwner = loss.character_id === auth.characterId;
    if (!isOwner && !(await isLeader(auth.characterId, env))) {
      return jsonResp({ error: "You can only edit your own losses" }, 403);
    }
    if (loss.status !== "pending") {
      return jsonResp({ error: "Only pending losses can be edited" }, 409);
    }

    const cleanNotes = notes === null ? null : String(notes).trim().slice(0, NOTES_MAX) || null;
    const { data, error } = await db
      .from("srp_losses")
      .update({ notes: cleanNotes })
      .eq("id", lossId)
      .eq("fleet_id", fleet.id)
      .select("id, character_id, character_name, zkill_url, kill_id, ship_type_id, ship_name, loss_value, payment_amount, rejection_reason, notes, status, created_at, paid_at, paid_by")
      .single();
    if (error) return jsonResp({ error: error.message }, 500);
    return jsonResp({ loss: toLoss(data) });
  }

  // Leadership decision path.
  if (!(await isLeader(auth.characterId, env))) {
    return jsonResp({ error: "Leadership only" }, 403);
  }

  if (status !== "approved" && status !== "rejected") {
    return jsonResp({ error: "status must be 'approved' or 'rejected'" }, 400);
  }

  const update = {
    status,
    payment_amount: status === "approved" ? (paymentAmount != null ? Number(paymentAmount) : null) : null,
    rejection_reason: status === "rejected" ? (String(rejectionReason ?? "").trim() || null) : null,
  };

  const { data, error } = await db
    .from("srp_losses")
    .update(update)
    .eq("id", lossId)
    .eq("fleet_id", fleet.id)
    .select("id, character_id, character_name, zkill_url, kill_id, ship_type_id, ship_name, loss_value, payment_amount, rejection_reason, notes, status, created_at")
    .single();

  if (error) {
    if (error.code === "PGRST116") return jsonResp({ error: "Loss not found" }, 404);
    return jsonResp({ error: error.message }, 500);
  }

  return jsonResp({ loss: toLoss(data) });
}

export async function onRequestDelete({ request, env, params }) {
  const auth = await verifyEveAuth(request, env);
  if (auth.error) return jsonResp({ error: auth.error }, auth.status);

  const db = getServiceClient(env);
  const corpId = parseInt(env.EVE_CORP_ID, 10);
  const { fleetId, lossId } = params;

  const { data: fleet, error: fleetErr } = await resolveFleet(db, fleetId, corpId);
  if (fleetErr || !fleet) return jsonResp({ error: "Fleet not found" }, 404);

  const { data: loss, error: lookupErr } = await db
    .from("srp_losses")
    .select("character_id, status")
    .eq("id", lossId)
    .eq("fleet_id", fleet.id)
    .single();
  if (lookupErr || !loss) return jsonResp({ error: "Loss not found" }, 404);

  const isOwner = loss.character_id === auth.characterId;
  const leader = (await isLeader(auth.characterId, env));
  if (!leader && !isOwner) {
    return jsonResp({ error: "You can only delete your own losses" }, 403);
  }
  // Owners can only withdraw while still pending; once leadership has
  // decided, the audit trail stays intact.
  if (!leader && loss.status !== "pending") {
    return jsonResp({ error: "Only pending losses can be withdrawn" }, 409);
  }

  const { error } = await db
    .from("srp_losses")
    .delete()
    .eq("id", lossId)
    .eq("fleet_id", fleet.id);
  if (error) return jsonResp({ error: error.message }, 500);

  return new Response(null, { status: 204, headers: AUTH_HEADERS });
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
