// GET /api/finances/income/list?limit=100&month=YYYY-MM
//   → { entries: [{ id, direction, amount, category, effectiveMonth, notes,
//                    recordedById, recordedByName, recordedAt,
//                    editedAt, editedByName }],
//       leader: boolean }
//
// Corp-member gated. Soft-deleted rows are filtered out. `leader` lets the
// frontend hide edit/delete UI when the viewer isn't in EVE_LEADERSHIP_IDS.

import { getServiceClient } from "../../_supabase.js";
import { verifyEveAuth, isLeader, AUTH_HEADERS } from "../../_auth.js";

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

export async function onRequestGet({ request, env }) {
  const auth = await verifyEveAuth(request, env);
  if (auth.error) return jsonResp({ error: auth.error }, auth.status);

  const url = new URL(request.url);
  const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "100", 10) || 100, 500);
  const month = url.searchParams.get("month");

  const db = getServiceClient(env);
  let query = db
    .from("income_entries")
    .select("id, direction, amount, category, effective_month, notes, recorded_by_id, recorded_by_name, recorded_at, edited_at, edited_by_id, edited_by_name")
    .is("deleted_at", null)
    .order("recorded_at", { ascending: false })
    .limit(limit);
  if (month && MONTH_RE.test(month)) {
    query = query.eq("effective_month", month);
  }

  const { data, error } = await query;
  if (error) return jsonResp({ error: error.message }, 500);

  return jsonResp({
    leader: (await isLeader(auth.characterId, env)),
    entries: (data ?? []).map((e) => ({
      id: e.id,
      direction: e.direction,
      amount: Number(e.amount),
      category: e.category,
      effectiveMonth: e.effective_month,
      notes: e.notes,
      recordedById: e.recorded_by_id,
      recordedByName: e.recorded_by_name,
      recordedAt: e.recorded_at,
      editedAt: e.edited_at ?? null,
      editedByName: e.edited_by_name ?? null,
    })),
  });
}

export async function onRequestOptions() {
  return new Response(null, { headers: AUTH_HEADERS });
}

function jsonResp(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: AUTH_HEADERS });
}
