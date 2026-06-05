// Single SRP fleet — fetch detail + losses, update status, or delete.
//
//   GET    /api/srp/:fleetId   (fleetId = UUID or slug)
//     → { fleet: { ...fleetFields, losses: [...] } }
//
//   PATCH  /api/srp/:fleetId
//     body { status: 'open' | 'closed' }
//     → { fleet: { ...fleetFields } }
//
//   DELETE /api/srp/:fleetId
//     → 204; cascades to srp_losses via FK.
//
// Auth: EVE SSO bearer token; corp membership enforced by verifyEveAuth.
// PATCH and DELETE additionally require leadership (EVE_LEADERSHIP_IDS).

import { getServiceClient } from "../_supabase.js";
import { verifyEveAuth, isLeader, AUTH_HEADERS } from "../_auth.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function onRequestGet({ request, env, params }) {
  const auth = await verifyEveAuth(request, env);
  if (auth.error) return jsonResp({ error: auth.error }, auth.status);

  const db = getServiceClient(env);
  const fleetId = params.fleetId;
  const corpId = parseInt(env.EVE_CORP_ID, 10);

  const isUuid = UUID_RE.test(fleetId);
  const query = db
    .from("srp_fleets")
    .select("id, slug, fleet_name, fleet_date, ping_text, status, fc_character_id, fc_character_name, created_at, srp_losses(id, character_id, character_name, zkill_url, kill_id, ship_type_id, ship_name, loss_value, payment_amount, rejection_reason, notes, status, created_at, paid_at, paid_by)")
    .eq("corp_id", corpId)
    .order("created_at", { referencedTable: "srp_losses", ascending: true });

  const { data, error } = await (isUuid
    ? query.eq("id", fleetId).single()
    : query.eq("slug", fleetId).single());

  if (error) {
    if (error.code === "PGRST116") return jsonResp({ error: "Fleet not found" }, 404);
    return jsonResp({ error: error.message }, 500);
  }

  return jsonResp({ fleet: toFleetDetail(data, (await isLeader(auth.characterId, env))) });
}

export async function onRequestPatch({ request, env, params }) {
  const auth = await verifyEveAuth(request, env);
  if (auth.error) return jsonResp({ error: auth.error }, auth.status);
  if (!(await isLeader(auth.characterId, env))) {
    return jsonResp({ error: "Leadership only" }, 403);
  }

  const body = await request.json().catch(() => ({}));
  const newStatus = body?.status;
  if (newStatus !== "open" && newStatus !== "closed") {
    return jsonResp({ error: "status must be 'open' or 'closed'" }, 400);
  }

  const db = getServiceClient(env);
  const fleetId = params.fleetId;
  const corpId = parseInt(env.EVE_CORP_ID, 10);

  const isUuid = UUID_RE.test(fleetId);
  const lookup = isUuid
    ? db.from("srp_fleets").select("id").eq("id", fleetId).eq("corp_id", corpId).single()
    : db.from("srp_fleets").select("id").eq("slug", fleetId).eq("corp_id", corpId).single();

  const { data: existing, error: lookupErr } = await lookup;
  if (lookupErr || !existing) return jsonResp({ error: "Fleet not found" }, 404);

  const { data, error } = await db
    .from("srp_fleets")
    .update({ status: newStatus, updated_at: new Date().toISOString() })
    .eq("id", existing.id)
    .select("id, slug, fleet_name, fleet_date, ping_text, status, fc_character_name, created_at")
    .single();

  if (error) return jsonResp({ error: error.message }, 500);
  return jsonResp({ fleet: { ...toFleet(data), lossCount: 0 } });
}

export async function onRequestDelete({ request, env, params }) {
  const auth = await verifyEveAuth(request, env);
  if (auth.error) return jsonResp({ error: auth.error }, auth.status);
  if (!(await isLeader(auth.characterId, env))) {
    return jsonResp({ error: "Leadership only" }, 403);
  }

  const db = getServiceClient(env);
  const fleetId = params.fleetId;
  const corpId = parseInt(env.EVE_CORP_ID, 10);

  // Resolve by UUID or slug, scoped to this corp so leadership of one corp
  // can't delete another's fleets if the app ever serves multiple.
  const isUuid = UUID_RE.test(fleetId);
  const lookup = isUuid
    ? db.from("srp_fleets").select("id").eq("id", fleetId).eq("corp_id", corpId).single()
    : db.from("srp_fleets").select("id").eq("slug", fleetId).eq("corp_id", corpId).single();

  const { data: existing, error: lookupErr } = await lookup;
  if (lookupErr || !existing) return jsonResp({ error: "Fleet not found" }, 404);

  // srp_losses.fleet_id has ON DELETE CASCADE → losses removed automatically.
  const { error } = await db.from("srp_fleets").delete().eq("id", existing.id);
  if (error) return jsonResp({ error: error.message }, 500);

  return new Response(null, { status: 204, headers: AUTH_HEADERS });
}

export async function onRequestOptions() {
  return new Response(null, { headers: AUTH_HEADERS });
}

function jsonResp(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: AUTH_HEADERS });
}

function toFleet(f) {
  return {
    id: f.id,
    slug: f.slug,
    fleetName: f.fleet_name,
    fleetDate: f.fleet_date,
    pingText: f.ping_text,
    status: f.status,
    fcCharacterName: f.fc_character_name,
    createdAt: f.created_at,
  };
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

function toFleetDetail(f, canApprove) {
  return {
    ...toFleet(f),
    fcCharacterId: f.fc_character_id,
    canApprove,
    losses: (f.srp_losses ?? []).map(toLoss),
  };
}
