// POST /api/lp/history
//
// Body: { typeIds: number[] }
// Returns: { history: { [typeId]: { volume: number[], avg: number[], updatedAt: string } } }
//
// 7-day Jita (The Forge) volume + average price history per typeID, cached
// in Supabase for 24h. The LP Store tab calls this in the background after
// the main offer fetch to render volume sparklines.

import { getServiceClient } from "../_supabase.js";

const ESI_BASE = "https://esi.evetech.net/latest";
const THE_FORGE = 10000002;
const HISTORY_TTL_MS = 24 * 60 * 60 * 1000;
const HISTORY_DAYS = 30;
const FETCH_CONCURRENCY = 20;
const MAX_TYPES_PER_REQUEST = 600;

export async function onRequestPost({ request, env }) {
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "public, max-age=900",
  };

  try {
    const body = await request.json().catch(() => ({}));
    const typeIds = Array.isArray(body.typeIds)
      ? [...new Set(body.typeIds.map((n) => parseInt(n, 10)).filter((n) => Number.isFinite(n) && n > 0))]
      : [];

    if (typeIds.length === 0) {
      return new Response(JSON.stringify({ history: {} }), { headers });
    }
    if (typeIds.length > MAX_TYPES_PER_REQUEST) {
      return new Response(
        JSON.stringify({ error: `Too many typeIds (max ${MAX_TYPES_PER_REQUEST})` }),
        { status: 400, headers }
      );
    }

    const db = getServiceClient(env);
    const result = {};

    const { data: cached } = await db
      .from("market_history")
      .select("type_id, history, updated_at")
      .in("type_id", typeIds);

    const now = Date.now();
    const stale = [];
    for (const row of cached ?? []) {
      if (now - new Date(row.updated_at).getTime() < HISTORY_TTL_MS) {
        result[row.type_id] = packHistory(row.history, row.updated_at);
      } else {
        stale.push(row.type_id);
      }
    }

    const missing = typeIds.filter((id) => !(id in result));
    const toFetch = [...new Set([...missing, ...stale])];

    if (toFetch.length > 0) {
      const fresh = await fetchEsiHistoryBatch(toFetch);
      const upsertRows = [];
      const freshTimestamp = new Date().toISOString();
      for (const typeID of toFetch) {
        const trimmed = fresh[typeID] ?? [];
        result[typeID] = packHistory(trimmed, freshTimestamp);
        upsertRows.push({ type_id: typeID, history: trimmed, updated_at: freshTimestamp });
      }
      if (upsertRows.length > 0) {
        await db.from("market_history").upsert(upsertRows, { onConflict: "type_id" });
      }
    }

    return new Response(JSON.stringify({ history: result }), { headers });
  } catch (err) {
    console.error(err);
    return new Response(
      JSON.stringify({ error: "Internal server error", detail: err.message }),
      { status: 500, headers }
    );
  }
}

function packHistory(rows, updatedAt) {
  const arr = Array.isArray(rows) ? rows : [];
  return {
    volume: arr.map((r) => Number(r.volume) || 0),
    avg: arr.map((r) => Number(r.average) || 0),
    updatedAt,
  };
}

async function fetchEsiHistoryBatch(typeIDs) {
  const out = {};
  let cursor = 0;
  async function worker() {
    while (cursor < typeIDs.length) {
      const idx = cursor++;
      const id = typeIDs[idx];
      try {
        const res = await fetch(
          `${ESI_BASE}/markets/${THE_FORGE}/history/?datasource=tranquility&type_id=${id}`,
          {
            headers: { "User-Agent": "met0-trade/0.5.1" },
            signal: AbortSignal.timeout(8000),
          }
        );
        if (!res.ok) { out[id] = []; continue; }
        const all = await res.json();
        const last = Array.isArray(all) ? all.slice(-HISTORY_DAYS) : [];
        out[id] = last.map((d) => ({
          date: d.date,
          volume: d.volume,
          average: d.average,
        }));
      } catch {
        out[id] = [];
      }
    }
  }
  const workers = Array.from({ length: Math.min(FETCH_CONCURRENCY, typeIDs.length) }, worker);
  await Promise.all(workers);
  return out;
}
