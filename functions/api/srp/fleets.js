// SRP fleet management.
//
//   GET  /api/srp/fleets
//     → { fleets: [{ id, slug, fleetName, fleetDate, pingText, status,
//                    fcCharacterName, lossCount, createdAt }] }
//
//   POST /api/srp/fleets
//     body { fleetName, fleetDate, pingText? }
//     → { fleet: { id, slug, ... } }
//
// Auth: EVE SSO bearer token; corp membership enforced by verifyEveAuth.

import { getServiceClient } from "../_supabase.js";
import { verifyEveAuth, AUTH_HEADERS } from "../_auth.js";
import { generateSlug } from "../_slug.js";

export async function onRequestGet({ request, env }) {
  const auth = await verifyEveAuth(request, env);
  if (auth.error) return jsonResp({ error: auth.error }, auth.status);

  const db = getServiceClient(env);
  const corpId = parseInt(env.EVE_CORP_ID, 10);

  // Fetch fleets plus a count of submitted losses per fleet.
  const { data, error } = await db
    .from("srp_fleets")
    .select("id, slug, fleet_name, fleet_date, ping_text, status, fc_character_name, created_at, srp_losses(status)")
    .eq("corp_id", corpId)
    .order("fleet_date", { ascending: false })
    .limit(50);

  if (error) return jsonResp({ error: error.message }, 500);

  const fleets = (data ?? []).map((f) => {
    const losses = f.srp_losses ?? [];
    return {
      id: f.id,
      slug: f.slug,
      fleetName: f.fleet_name,
      fleetDate: f.fleet_date,
      pingText: f.ping_text,
      status: f.status,
      fcCharacterName: f.fc_character_name,
      lossCount: losses.length,
      pendingCount: losses.filter((l) => l.status === "pending").length,
      createdAt: f.created_at,
    };
  });

  return jsonResp({ fleets });
}

export async function onRequestPost({ request, env }) {
  const auth = await verifyEveAuth(request, env);
  if (auth.error) return jsonResp({ error: auth.error }, auth.status);

  const body = await request.json().catch(() => ({}));
  const fleetName = body?.fleetName?.trim();
  const fleetDate = body?.fleetDate;
  const pingText = body?.pingText?.trim() || null;
  if (!fleetName) return jsonResp({ error: "fleetName required" }, 400);
  if (!fleetDate || isNaN(Date.parse(fleetDate))) return jsonResp({ error: "fleetDate must be a valid ISO date" }, 400);

  const db = getServiceClient(env);
  const corpId = parseInt(env.EVE_CORP_ID, 10);

  // Retry slug generation on the rare collision.
  let slug, insertErr;
  for (let attempt = 0; attempt < 5; attempt++) {
    slug = generateSlug(6);
    const { error } = await db.from("srp_fleets").insert({
      slug,
      corp_id: corpId,
      fc_character_id: auth.characterId,
      fc_character_name: auth.characterName ?? "Unknown",
      fleet_name: String(fleetName).slice(0, 200),
      fleet_date: new Date(fleetDate).toISOString(),
      ping_text: pingText ? String(pingText).slice(0, 5000) : null,
      status: "open",
    });
    insertErr = error;
    if (!error) break;
    if (!error.message?.includes("unique")) break; // non-collision error, stop
  }
  if (insertErr) return jsonResp({ error: insertErr.message }, 500);

  const { data, error: fetchErr } = await db
    .from("srp_fleets")
    .select("id, slug, fleet_name, fleet_date, ping_text, status, fc_character_name, created_at")
    .eq("slug", slug)
    .single();
  if (fetchErr) return jsonResp({ error: fetchErr.message }, 500);

  return jsonResp({ fleet: toFleet(data) }, 201);
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
    lossCount: 0,
    pendingCount: 0,
    createdAt: f.created_at,
  };
}
