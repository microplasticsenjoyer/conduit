// Per-character saved hauling plans.
//
//   GET    /api/hauling/plans         — list plans for the authenticated char
//   POST   /api/hauling/plans         — create a new plan
//   PUT    /api/hauling/plans/:id     — update an existing plan (id in body)
//   DELETE /api/hauling/plans?id=...  — delete a plan
//
// Auth: EVE SSO bearer token. See functions/api/_auth.js for validation.

import { getServiceClient } from "../_supabase.js";
import { verifyEveAuth, AUTH_HEADERS } from "../_auth.js";

const FIELDS = [
  "id", "name", "source_station_id", "dest_station_id", "ship_id", "mode",
  "sales_tax", "collateral_isk", "reward", "budget", "cargo_text",
  "created_at", "updated_at",
];

export async function onRequestGet({ request, env }) {
  const auth = await verifyEveAuth(request, env);
  if (auth.error) return jsonResp({ error: auth.error }, auth.status);

  const db = getServiceClient(env);
  const { data, error } = await db
    .from("hauling_plans")
    .select(FIELDS.join(","))
    .eq("character_id", auth.characterId)
    .order("updated_at", { ascending: false })
    .limit(50);
  if (error) return jsonResp({ error: error.message }, 500);
  return jsonResp({ plans: data ?? [] });
}

export async function onRequestPost({ request, env }) {
  const auth = await verifyEveAuth(request, env);
  if (auth.error) return jsonResp({ error: auth.error }, auth.status);

  const body = await request.json().catch(() => ({}));
  const row = sanitize(body);
  if (!row.name) return jsonResp({ error: "name required" }, 400);

  const db = getServiceClient(env);
  const { data, error } = await db
    .from("hauling_plans")
    .insert({ ...row, character_id: auth.characterId })
    .select(FIELDS.join(","))
    .single();
  if (error) return jsonResp({ error: error.message }, 500);
  return jsonResp({ plan: data });
}

export async function onRequestPut({ request, env }) {
  const auth = await verifyEveAuth(request, env);
  if (auth.error) return jsonResp({ error: auth.error }, auth.status);

  const body = await request.json().catch(() => ({}));
  const id = body.id;
  if (!id) return jsonResp({ error: "id required" }, 400);
  const row = sanitize(body);

  const db = getServiceClient(env);
  const { data, error } = await db
    .from("hauling_plans")
    .update({ ...row, updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("character_id", auth.characterId)
    .select(FIELDS.join(","))
    .single();
  if (error) return jsonResp({ error: error.message }, 500);
  if (!data) return jsonResp({ error: "Plan not found" }, 404);
  return jsonResp({ plan: data });
}

export async function onRequestDelete({ request, env }) {
  const auth = await verifyEveAuth(request, env);
  if (auth.error) return jsonResp({ error: auth.error }, auth.status);

  const url = new URL(request.url);
  const id = url.searchParams.get("id");
  if (!id) return jsonResp({ error: "id required" }, 400);

  const db = getServiceClient(env);
  const { error } = await db
    .from("hauling_plans")
    .delete()
    .eq("id", id)
    .eq("character_id", auth.characterId);
  if (error) return jsonResp({ error: error.message }, 500);
  return jsonResp({ ok: true });
}

export async function onRequestOptions() {
  return new Response(null, { headers: AUTH_HEADERS });
}

function jsonResp(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: AUTH_HEADERS });
}

function sanitize(body) {
  const num = (v) => (v == null || v === "" ? null : Number(v));
  return {
    name: typeof body.name === "string" ? body.name.slice(0, 80).trim() : null,
    source_station_id: parseInt(body.sourceStationId, 10),
    dest_station_id:   parseInt(body.destStationId, 10),
    ship_id:           typeof body.shipId === "string" ? body.shipId.slice(0, 40) : null,
    mode:              body.mode === "courier" ? "courier" : "self",
    sales_tax:         num(body.salesTax),
    collateral_isk:    num(body.collateralISK),
    reward:            num(body.reward),
    budget:            num(body.budget),
    cargo_text:        typeof body.cargoText === "string" ? body.cargoText.slice(0, 100_000) : null,
  };
}
