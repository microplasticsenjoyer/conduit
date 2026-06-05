// Per-character core trading preferences (default station, sales tax,
// broker fee, LP price, manufacturing tax). Anything outside this small set
// stays in localStorage. See functions/api/_auth.js for token validation.
//
//   GET /api/prefs   — returns the caller's prefs (or {} if none stored)
//   PUT /api/prefs   — body { defaultStationId?, salesTax?, brokerFee?, lpPrice?, mfgTax? }

import { getServiceClient } from "./_supabase.js";
import { verifyEveAuth, AUTH_HEADERS } from "./_auth.js";

const SELECT = "default_station_id, sales_tax, broker_fee, lp_price, mfg_tax, updated_at";

export async function onRequestGet({ request, env }) {
  const auth = await verifyEveAuth(request, env);
  if (auth.error) return jsonResp({ error: auth.error }, auth.status);

  const db = getServiceClient(env);
  const { data, error } = await db
    .from("user_preferences")
    .select(SELECT)
    .eq("character_id", auth.characterId)
    .maybeSingle();
  if (error) return jsonResp({ error: error.message }, 500);
  return jsonResp({ prefs: data ? toCamel(data) : {} });
}

export async function onRequestPut({ request, env }) {
  const auth = await verifyEveAuth(request, env);
  if (auth.error) return jsonResp({ error: auth.error }, auth.status);

  const body = await request.json().catch(() => ({}));
  const row = {
    character_id: auth.characterId,
    default_station_id: parseIntOrNull(body.defaultStationId),
    sales_tax:  parseNumOrNull(body.salesTax),
    broker_fee: parseNumOrNull(body.brokerFee),
    lp_price:   parseNumOrNull(body.lpPrice),
    mfg_tax:    parseNumOrNull(body.mfgTax),
    updated_at: new Date().toISOString(),
  };

  const db = getServiceClient(env);
  const { data, error } = await db
    .from("user_preferences")
    .upsert(row, { onConflict: "character_id" })
    .select(SELECT)
    .single();
  if (error) return jsonResp({ error: error.message }, 500);
  return jsonResp({ prefs: toCamel(data) });
}

export async function onRequestOptions() {
  return new Response(null, { headers: AUTH_HEADERS });
}

function jsonResp(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: AUTH_HEADERS });
}
function parseIntOrNull(v) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}
function parseNumOrNull(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function toCamel(row) {
  return {
    defaultStationId: row.default_station_id,
    salesTax:  row.sales_tax,
    brokerFee: row.broker_fee,
    lpPrice:   row.lp_price,
    mfgTax:    row.mfg_tax,
    updatedAt: row.updated_at,
  };
}
