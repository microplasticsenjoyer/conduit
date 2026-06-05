// SRP monthly roundup — aggregates srp_fleets + srp_losses by calendar month.
//
//   GET /api/srp/summary
//     → {
//         currentMonth,                 // 'YYYY-MM' (UTC)
//         months: [{                    // newest first
//           month,                      // 'YYYY-MM' (UTC, from fleet_date)
//           fleetCount, lossCount,
//           pendingCount, approvedCount, rejectedCount,
//           totalRequested,             // Σ loss_value over all losses
//           totalPaid,                  // Σ payment_amount over approved losses
//           pilotCount,                 // distinct characters with a loss
//         }],
//         allTime: { ...same shape, summed across everything },
//       }
//
// Months are bucketed by the fleet's scheduled date (fleet_date), so a loss from
// a late-May fleet counts toward May even if it was approved in June.
//
// Auth: EVE SSO bearer token; corp membership enforced by verifyEveAuth.

import { getServiceClient } from "../_supabase.js";
import { verifyEveAuth, AUTH_HEADERS } from "../_auth.js";

export async function onRequestGet({ request, env }) {
  const auth = await verifyEveAuth(request, env);
  if (auth.error) return jsonResp({ error: auth.error }, auth.status);

  const db = getServiceClient(env);
  const corpId = parseInt(env.EVE_CORP_ID, 10);

  const { data, error } = await db
    .from("srp_fleets")
    .select("id, fleet_date, srp_losses(status, loss_value, payment_amount, character_id)")
    .eq("corp_id", corpId)
    .order("fleet_date", { ascending: false })
    .limit(2000);

  if (error) return jsonResp({ error: error.message }, 500);

  const byMonth = new Map();        // 'YYYY-MM' → bucket
  const allTime = makeBucket("");
  const allTimePilots = new Set();

  for (const f of data ?? []) {
    if (!f.fleet_date) continue;
    const d = new Date(f.fleet_date);
    if (isNaN(d.getTime())) continue;
    const month = d.toISOString().slice(0, 7);

    let bucket = byMonth.get(month);
    if (!bucket) { bucket = makeBucket(month); byMonth.set(month, bucket); }

    bucket.fleetCount += 1;
    allTime.fleetCount += 1;

    for (const l of f.srp_losses ?? []) {
      const value = Number(l.loss_value ?? 0);
      const paid = Number(l.payment_amount ?? 0);

      bucket.lossCount += 1;
      bucket.totalRequested += value;
      allTime.lossCount += 1;
      allTime.totalRequested += value;

      if (l.status === "approved") {
        bucket.approvedCount += 1;
        bucket.totalPaid += paid;
        allTime.approvedCount += 1;
        allTime.totalPaid += paid;
      } else if (l.status === "rejected") {
        bucket.rejectedCount += 1;
        allTime.rejectedCount += 1;
      } else {
        bucket.pendingCount += 1;
        allTime.pendingCount += 1;
      }

      if (l.character_id != null) {
        bucket._pilots.add(l.character_id);
        allTimePilots.add(l.character_id);
      }
    }
  }

  const months = [...byMonth.values()]
    .map(finalizeBucket)
    .sort((a, b) => (a.month < b.month ? 1 : a.month > b.month ? -1 : 0));

  allTime._pilots = allTimePilots;
  const allTimeOut = finalizeBucket(allTime);
  delete allTimeOut.month;

  return jsonResp({
    currentMonth: new Date().toISOString().slice(0, 7),
    months,
    allTime: allTimeOut,
  });
}

function makeBucket(month) {
  return {
    month,
    fleetCount: 0,
    lossCount: 0,
    pendingCount: 0,
    approvedCount: 0,
    rejectedCount: 0,
    totalRequested: 0,
    totalPaid: 0,
    _pilots: new Set(),
  };
}

function finalizeBucket(b) {
  const { _pilots, ...rest } = b;
  return { ...rest, pilotCount: _pilots.size };
}

export async function onRequestOptions() {
  return new Response(null, { headers: AUTH_HEADERS });
}

function jsonResp(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: AUTH_HEADERS });
}
