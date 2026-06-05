// GET /api/fund/summary
//   → {
//       currentMonth,          // 'YYYY-MM' (UTC)
//       currentRatePct,        // number, default 2.0
//       currentRateReason,     // string|null — "standard" if no override
//       isLeader,              // bool — caller's leadership flag
//       totals: {
//         principal,           // sum of all investor balances
//         monthlyObligation,   // principal × currentRatePct/100
//         interestPaidYtd,     // sum of 'interest' entries in current calendar year
//         investorCount,
//       },
//       investors: [{ characterId, characterName, balance, tier, monthlyReturn,
//                     lastActivityAt, notes }],
//       principalHistory: [{ month, principal }], // last 12 months ending in currentMonth
//     }
//
// Auth: EVE SSO bearer token; corp membership enforced by verifyEveAuth.

import { getServiceClient } from "../_supabase.js";
import { verifyEveAuth, isLeader, AUTH_HEADERS } from "../_auth.js";
import {
  DEFAULT_RATE_PCT,
  PRINCIPAL_KINDS,
  KIND_INTEREST,
  tierFor,
  currentMonthString,
} from "./_helpers.js";

export async function onRequestGet({ request, env }) {
  const auth = await verifyEveAuth(request, env);
  if (auth.error) return jsonResp({ error: auth.error }, auth.status);

  const db = getServiceClient(env);
  const month = currentMonthString();

  const [investorsRes, ledgerRes, ratesRes] = await Promise.all([
    db.from("fund_investors")
      .select("character_id, character_name, notes, updated_at"),
    db.from("fund_ledger")
      .select("character_id, kind, amount, effective_month, recorded_at"),
    db.from("fund_rates")
      .select("month, rate_pct, reason")
      .eq("month", month)
      .maybeSingle(),
  ]);

  if (investorsRes.error) return jsonResp({ error: investorsRes.error.message }, 500);
  if (ledgerRes.error)    return jsonResp({ error: ledgerRes.error.message }, 500);
  if (ratesRes.error)     return jsonResp({ error: ratesRes.error.message }, 500);

  const ratePct = Number(ratesRes.data?.rate_pct ?? DEFAULT_RATE_PCT);
  const rateReason = ratesRes.data?.reason ?? "standard";

  // Aggregate balances + last-activity per investor and YTD interest paid.
  const balByChar = new Map();
  const lastActByChar = new Map();
  const yearPrefix = month.slice(0, 4) + "-";
  let interestPaidYtd = 0;

  for (const row of (ledgerRes.data ?? [])) {
    const cid = row.character_id;
    const amt = Number(row.amount ?? 0);
    const eff = String(row.effective_month ?? "");

    if (PRINCIPAL_KINDS.has(row.kind) && eff <= month) {
      balByChar.set(cid, (balByChar.get(cid) ?? 0) + amt);
    }
    if (row.kind === KIND_INTEREST && eff.startsWith(yearPrefix)) {
      interestPaidYtd += amt;
    }
    const recAt = row.recorded_at;
    const prev = lastActByChar.get(cid);
    if (!prev || recAt > prev) lastActByChar.set(cid, recAt);
  }

  const investors = (investorsRes.data ?? []).map((inv) => {
    const balance = balByChar.get(inv.character_id) ?? 0;
    return {
      characterId: inv.character_id,
      characterName: inv.character_name,
      balance,
      tier: tierFor(balance),
      monthlyReturn: balance * (ratePct / 100),
      lastActivityAt: lastActByChar.get(inv.character_id) ?? inv.updated_at,
      notes: inv.notes,
    };
  });

  // Sort by balance desc, then by name asc, so the table reads cleanly.
  investors.sort((a, b) => b.balance - a.balance || a.characterName.localeCompare(b.characterName));

  const principal = investors.reduce((s, i) => s + i.balance, 0);

  // Build a 12-month principal history (cumulative at end of each month).
  // Walk all principal-moving ledger entries once, bucketing by effective_month,
  // then accumulate forward through the trailing window.
  const principalByMonth = new Map();
  for (const row of (ledgerRes.data ?? [])) {
    if (!PRINCIPAL_KINDS.has(row.kind)) continue;
    const eff = String(row.effective_month ?? "");
    if (!eff) continue;
    principalByMonth.set(eff, (principalByMonth.get(eff) ?? 0) + Number(row.amount ?? 0));
  }
  const months = trailingMonths(month, 12);
  let running = 0;
  // Pre-seed with everything that occurred before the window.
  const windowStart = months[0];
  for (const [eff, delta] of principalByMonth) {
    if (eff < windowStart) running += delta;
  }
  const principalHistory = months.map((m) => {
    running += principalByMonth.get(m) ?? 0;
    return { month: m, principal: running };
  });

  return jsonResp({
    currentMonth: month,
    currentRatePct: ratePct,
    currentRateReason: rateReason,
    isLeader: (await isLeader(auth.characterId, env)),
    totals: {
      principal,
      monthlyObligation: principal * (ratePct / 100),
      interestPaidYtd,
      investorCount: investors.filter((i) => i.balance > 0).length,
    },
    investors,
    principalHistory,
  });
}

function trailingMonths(endMonth, count) {
  const [y, m] = endMonth.split("-").map(Number);
  const out = [];
  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(y, m - 1 - i, 1));
    const yy = d.getUTCFullYear();
    const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
    out.push(`${yy}-${mm}`);
  }
  return out;
}

export async function onRequestOptions() {
  return new Response(null, { headers: AUTH_HEADERS });
}

function jsonResp(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: AUTH_HEADERS });
}
