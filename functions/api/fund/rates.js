// GET  /api/fund/rates?limit=24
//   → { rates: [{ month, ratePct, reason, declaredByName, declaredAt }] }
//
// POST /api/fund/rates
//   body { month: 'YYYY-MM', ratePct: number, reason: string }
//   Leadership-only. Upserts the row for that month.
//   → { rate: {...} }

import { getServiceClient } from "../_supabase.js";
import { verifyEveAuth, isLeader, AUTH_HEADERS } from "../_auth.js";
import { isValidMonth } from "./_helpers.js";

export async function onRequestGet({ request, env }) {
  const auth = await verifyEveAuth(request, env);
  if (auth.error) return jsonResp({ error: auth.error }, auth.status);

  const url = new URL(request.url);
  const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "24", 10) || 24, 240);

  const db = getServiceClient(env);
  const { data, error } = await db
    .from("fund_rates")
    .select("month, rate_pct, reason, declared_by_name, declared_at")
    .order("month", { ascending: false })
    .limit(limit);
  if (error) return jsonResp({ error: error.message }, 500);

  return jsonResp({
    rates: (data ?? []).map((r) => ({
      month: r.month,
      ratePct: Number(r.rate_pct),
      reason: r.reason,
      declaredByName: r.declared_by_name,
      declaredAt: r.declared_at,
    })),
  });
}

export async function onRequestPost({ request, env }) {
  const auth = await verifyEveAuth(request, env);
  if (auth.error) return jsonResp({ error: auth.error }, auth.status);
  if (!(await isLeader(auth.characterId, env))) {
    return jsonResp({ error: "Leadership only" }, 403);
  }

  const body = await request.json().catch(() => ({}));
  const month = String(body?.month ?? "").trim();
  if (!isValidMonth(month)) return jsonResp({ error: "month must be YYYY-MM" }, 400);

  const ratePct = Number(body?.ratePct);
  if (!Number.isFinite(ratePct) || ratePct < 0 || ratePct > 100) {
    return jsonResp({ error: "ratePct must be a percent between 0 and 100" }, 400);
  }
  const reason = String(body?.reason ?? "").trim();
  if (!reason) return jsonResp({ error: "reason required" }, 400);

  const db = getServiceClient(env);
  const { data, error } = await db
    .from("fund_rates")
    .upsert({
      month,
      rate_pct: ratePct,
      reason: reason.slice(0, 500),
      declared_by_id: auth.characterId,
      declared_by_name: auth.characterName ?? "Unknown",
      declared_at: new Date().toISOString(),
    }, { onConflict: "month" })
    .select("month, rate_pct, reason, declared_by_name, declared_at")
    .single();

  if (error) return jsonResp({ error: error.message }, 500);

  return jsonResp({
    rate: {
      month: data.month,
      ratePct: Number(data.rate_pct),
      reason: data.reason,
      declaredByName: data.declared_by_name,
      declaredAt: data.declared_at,
    },
  }, 201);
}

export async function onRequestOptions() {
  return new Response(null, { headers: AUTH_HEADERS });
}

function jsonResp(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: AUTH_HEADERS });
}
