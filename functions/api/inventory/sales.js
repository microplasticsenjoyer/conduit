// Doctrine sales history for the Inventory tab's Sales sub-tab.
//
//   POST /api/inventory/sales
//     body { contracts: [<finished item_exchange contract>...] }
//     → matches each contract's title against the corp's current doctrine
//       entries, upserts the matches into corp_doctrine_sales. Idempotent —
//       keyed by (corp_id, contract_id), so repeated refreshes are no-ops.
//       Returns { matched: N }.
//
//   GET /api/inventory/sales
//     → rollups for the Sales sub-tab:
//       { totals: { total, totalIsk, lastMonth, lastMonthIsk,
//                   lastYear, lastYearIsk, thisMonth, thisMonthIsk,
//                   thisYear, thisYearIsk },
//         monthly: [{ month: "YYYY-MM", count, isk }],   // last 24 months
//         byDoctrine: [{ doctrine, count, isk }],         // all-time desc
//         byFit: [{ doctrine, name, count, isk }],        // all-time desc
//         recent: [{ contract_id, doctrine, entry_name, price, accepted_at }] }
//
// ESI only returns finished contracts for ~30 days, so the table accumulates
// history as long as someone refreshes the Inventory tab at least every month.

import { getServiceClient } from "../_supabase.js";
import { verifyEveAuth, AUTH_HEADERS } from "../_auth.js";

const MAX_CONTRACTS = 5000;
const UPSERT_CHUNK  = 500;

// Match contract titles to doctrine names tolerantly: NFKC normalize, strip
// zero-width chars, unify the various Unicode dashes to a plain hyphen, and
// collapse any whitespace run (including non-breaking spaces) to one space,
// then lowercase. Lets contract titles with stray U+00A0 / U+2013 / case
// quirks still match the corp's canonical "DOCTRINE - Name" doctrine row.
function normalizeTitle(s) {
  if (typeof s !== "string") return "";
  return s
    .normalize("NFKC")
    .replace(/[​-‏⁠﻿]/g, "") // zero-width chars + BOM
    .replace(/[‐-―−]/g, "-")      // unicode dashes -> hyphen
    .replace(/\s+/g, " ")                        // collapse whitespace
    .trim()
    .toLowerCase();
}

export async function onRequestPost({ request, env }) {
  const auth = await verifyEveAuth(request, env);
  if (auth.error) return jsonResp({ error: auth.error }, auth.status);
  if (!auth.corporationId) return jsonResp({ error: "No corp context" }, 403);

  const body = await request.json().catch(() => ({}));
  const contracts = Array.isArray(body.contracts) ? body.contracts : null;
  if (!contracts) return jsonResp({ error: "contracts[] required" }, 400);
  if (contracts.length > MAX_CONTRACTS) {
    return jsonResp({ error: `Too many contracts (max ${MAX_CONTRACTS})` }, 400);
  }

  const db = getServiceClient(env);
  const corpId = auth.corporationId;

  // Snapshot the corp's current doctrine titles so we can match by
  // "DOCTRINE - Fitting Name" and tag each row with the canonical pair.
  const { data: doctrineRows, error: docErr } = await db
    .from("corp_doctrine")
    .select("doctrine, name")
    .eq("corp_id", corpId);
  if (docErr) return jsonResp({ error: docErr.message }, 500);

  const docPatterns = new Map();
  for (const r of doctrineRows ?? []) {
    const key = normalizeTitle(`${r.doctrine} - ${r.name}`);
    docPatterns.set(key, { doctrine: r.doctrine, name: r.name });
  }
  if (docPatterns.size === 0) return jsonResp({ matched: 0 });

  const rows = [];
  for (const c of contracts) {
    if (!c || typeof c !== "object") continue;
    if (c.type !== "item_exchange") continue;
    if (c.status !== "finished") continue;
    const title = normalizeTitle(c.title);
    if (!title) continue;
    const match = docPatterns.get(title);
    if (!match) continue;
    const completedMs = c.date_completed ? Date.parse(c.date_completed) : NaN;
    if (!Number.isFinite(completedMs)) continue;
    const contractId = Number(c.contract_id);
    if (!Number.isFinite(contractId)) continue;
    rows.push({
      corp_id:     corpId,
      contract_id: contractId,
      doctrine:    match.doctrine,
      entry_name:  match.name,
      price:       Number.isFinite(c.price) ? c.price : null,
      accepted_at: new Date(completedMs).toISOString(),
      acceptor_id: Number.isFinite(c.acceptor_id) ? c.acceptor_id : null,
      issuer_id:   Number.isFinite(c.issuer_id)   ? c.issuer_id   : null,
    });
  }
  if (rows.length === 0) return jsonResp({ matched: 0 });

  for (let i = 0; i < rows.length; i += UPSERT_CHUNK) {
    const chunk = rows.slice(i, i + UPSERT_CHUNK);
    const { error } = await db
      .from("corp_doctrine_sales")
      .upsert(chunk, { onConflict: "corp_id,contract_id", ignoreDuplicates: false });
    if (error) return jsonResp({ error: error.message }, 500);
  }

  return jsonResp({ matched: rows.length });
}

export async function onRequestGet({ request, env }) {
  const auth = await verifyEveAuth(request, env);
  if (auth.error) return jsonResp({ error: auth.error }, auth.status);
  if (!auth.corporationId) return jsonResp(emptyRollup());

  const db = getServiceClient(env);
  const { data, error } = await db
    .from("corp_doctrine_sales")
    .select("contract_id, doctrine, entry_name, price, accepted_at")
    .eq("corp_id", auth.corporationId)
    .order("accepted_at", { ascending: false });
  if (error) return jsonResp({ error: error.message }, 500);

  return jsonResp(buildRollup(data ?? []));
}

export async function onRequestOptions() {
  return new Response(null, { headers: AUTH_HEADERS });
}

// ── Rollup ──────────────────────────────────────────────────────────────────

function buildRollup(rows) {
  const now = new Date();
  const monthCutoff = now.getTime() - 30 * 24 * 60 * 60 * 1000;
  const yearCutoff  = now.getTime() - 365 * 24 * 60 * 60 * 1000;
  const thisMonthKey = monthKeyOf(now);
  const thisYearKey  = String(now.getUTCFullYear());

  let total = 0, totalIsk = 0;
  let lastMonth = 0, lastMonthIsk = 0;
  let lastYear = 0, lastYearIsk = 0;
  let thisMonth = 0, thisMonthIsk = 0;
  let thisYear = 0, thisYearIsk = 0;

  const monthMap = new Map();
  const docMap   = new Map();
  const fitMap   = new Map();

  for (const r of rows) {
    const ts = Date.parse(r.accepted_at);
    if (!Number.isFinite(ts)) continue;
    const isk = Number(r.price) || 0;
    total++; totalIsk += isk;
    if (ts >= monthCutoff) { lastMonth++; lastMonthIsk += isk; }
    if (ts >= yearCutoff)  { lastYear++;  lastYearIsk  += isk; }

    const d = new Date(ts);
    const mKey = monthKeyOf(d);
    if (mKey === thisMonthKey) { thisMonth++; thisMonthIsk += isk; }
    if (String(d.getUTCFullYear()) === thisYearKey) { thisYear++; thisYearIsk += isk; }

    const mEntry = monthMap.get(mKey) ?? { month: mKey, count: 0, isk: 0 };
    mEntry.count++; mEntry.isk += isk;
    monthMap.set(mKey, mEntry);

    const dEntry = docMap.get(r.doctrine) ?? { doctrine: r.doctrine, count: 0, isk: 0 };
    dEntry.count++; dEntry.isk += isk;
    docMap.set(r.doctrine, dEntry);

    const fKey = `${r.doctrine}|${r.entry_name}`;
    const fEntry = fitMap.get(fKey) ?? { doctrine: r.doctrine, name: r.entry_name, count: 0, isk: 0 };
    fEntry.count++; fEntry.isk += isk;
    fitMap.set(fKey, fEntry);
  }

  const monthly = [...monthMap.values()]
    .sort((a, b) => a.month.localeCompare(b.month))
    .slice(-24);
  const byDoctrine = [...docMap.values()].sort((a, b) => b.count - a.count);
  const byFit      = [...fitMap.values()].sort((a, b) => b.count - a.count);
  const recent     = rows.slice(0, 25);

  return {
    totals: {
      total, totalIsk,
      lastMonth, lastMonthIsk,
      lastYear,  lastYearIsk,
      thisMonth, thisMonthIsk,
      thisYear,  thisYearIsk,
    },
    monthly,
    byDoctrine,
    byFit,
    recent,
  };
}

function emptyRollup() {
  return {
    totals: {
      total: 0, totalIsk: 0,
      lastMonth: 0, lastMonthIsk: 0,
      lastYear: 0,  lastYearIsk: 0,
      thisMonth: 0, thisMonthIsk: 0,
      thisYear: 0,  thisYearIsk: 0,
    },
    monthly: [], byDoctrine: [], byFit: [], recent: [],
  };
}

function monthKeyOf(d) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function jsonResp(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: AUTH_HEADERS });
}
