// POST /api/compare
//
// Body: { typeIds: number[] }
// Returns: { stations: [{id, name, short, region}], prices: { [typeId]: { [stationId]: { sell_min, buy_max, sell_volume } } } }
//
// Side-by-side prices at all supported trading hubs for the given typeIDs.
// Jita reads from price_cache (30-min TTL); other hubs are live-fetched from
// Fuzzwork with no caching (matches the appraise.js policy).

import { getServiceClient } from "./_supabase.js";
import { JITA_STATION, STATIONS } from "./_stations.js";
import { checkRateLimit, maybeReapStaleRows } from "./_rate_limit.js";
import { PRICE_TTL_MS } from "./_constants.js";

const FUZZWORK_BASE = "https://market.fuzzwork.co.uk/aggregates/";
const RATE_LIMIT = 30;
const RATE_WINDOW_MS = 5 * 60 * 1000;
const MAX_TYPES = 200;

export async function onRequestPost({ request, env }) {
  const headers = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" };

  try {
    const db = getServiceClient(env);
    const rl = await checkRateLimit(db, request, { limit: RATE_LIMIT, windowMs: RATE_WINDOW_MS });
    if (!rl.allowed) {
      return new Response(JSON.stringify({ error: "Rate limit exceeded; slow down a bit." }),
        { status: 429, headers: { ...headers, "Retry-After": String(rl.retryAfter) } });
    }
    maybeReapStaleRows(db);

    const body = await request.json().catch(() => ({}));
    const typeIds = Array.isArray(body.typeIds)
      ? [...new Set(body.typeIds.map((n) => parseInt(n, 10)).filter((n) => Number.isFinite(n) && n > 0))]
      : [];
    if (typeIds.length === 0) {
      return new Response(JSON.stringify({ stations: STATIONS, prices: {} }), { headers });
    }
    if (typeIds.length > MAX_TYPES) {
      return new Response(JSON.stringify({ error: `Too many typeIds (max ${MAX_TYPES})` }), { status: 400, headers });
    }

    const stationFetches = STATIONS.map((s) =>
      s.id === JITA_STATION
        ? getJitaCachedPrices(db, typeIds).then((m) => [s.id, m])
        : fuzzworkPrices(typeIds, s.id).then((raw) => [s.id, normalize(raw)])
    );
    const settled = await Promise.all(stationFetches);

    const prices = {};
    for (const id of typeIds) prices[id] = {};
    for (const [stationId, priceMap] of settled) {
      for (const [tid, p] of Object.entries(priceMap)) {
        const id = parseInt(tid, 10);
        if (!(id in prices)) continue;
        prices[id][stationId] = p;
      }
    }

    return new Response(JSON.stringify({ stations: STATIONS, prices }), { headers });
  } catch (err) {
    console.error(err);
    return new Response(JSON.stringify({ error: "Internal server error", detail: err.message }), { status: 500, headers });
  }
}

export async function onRequestOptions() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
  });
}

async function getJitaCachedPrices(db, typeIds) {
  const { data: cached } = await db
    .from("price_cache")
    .select("type_id, sell_min, buy_max, sell_volume, updated_at")
    .in("type_id", typeIds);
  const out = {};
  const now = Date.now();
  const stale = [];
  for (const row of cached ?? []) {
    if (now - new Date(row.updated_at).getTime() < PRICE_TTL_MS) {
      out[row.type_id] = { sell_min: row.sell_min, buy_max: row.buy_max, sell_volume: row.sell_volume };
    } else {
      stale.push(row.type_id);
    }
  }
  const missing = typeIds.filter((id) => !(id in out));
  const toFetch = [...new Set([...missing, ...stale])];
  if (toFetch.length === 0) return out;

  const fresh = await fuzzworkPrices(toFetch, JITA_STATION);
  const upsert = [];
  for (const [idStr, data] of Object.entries(fresh)) {
    const id = parseInt(idStr, 10);
    const sell_min = parseFloat(data.sell.min);
    const buy_max = parseFloat(data.buy.max);
    const sell_volume = parseInt(data.sell.volume, 10) || null;
    out[id] = { sell_min, buy_max, sell_volume };
    upsert.push({
      type_id: id,
      sell_min,
      sell_max: parseFloat(data.sell.max),
      buy_min: parseFloat(data.buy.min),
      buy_max,
      sell_volume,
      updated_at: new Date().toISOString(),
    });
  }
  if (upsert.length > 0) await db.from("price_cache").upsert(upsert, { onConflict: "type_id" });
  return out;
}

function normalize(raw) {
  const out = {};
  for (const [idStr, data] of Object.entries(raw)) {
    out[idStr] = {
      sell_min: parseFloat(data.sell.min),
      buy_max: parseFloat(data.buy.max),
      sell_volume: parseInt(data.sell.volume, 10) || null,
    };
  }
  return out;
}

async function fuzzworkPrices(typeIDs, stationId) {
  const out = {};
  for (const c of chunk(typeIDs, 200)) {
    const params = new URLSearchParams({ station: stationId, types: c.join(",") });
    try {
      const res = await fetch(`${FUZZWORK_BASE}?${params}`, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) continue;
      Object.assign(out, await res.json());
    } catch (err) {
      console.warn(`[compare:fuzzwork] ${err.name === "TimeoutError" ? "timeout" : err.message} station=${stationId} chunk=${c.length}`);
    }
  }
  return out;
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
