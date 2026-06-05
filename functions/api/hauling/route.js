// POST /api/hauling/route
//
// Stateless companion to /api/appraise: parses a cargo paste, resolves typeIDs,
// and returns prices at BOTH a source and destination station so the Hauling
// tab can compute per-item arbitrage. No persistence — we don't want each
// ship-fitting tweak in the cargo planner to spawn a new appraisal slug.

import { getServiceClient } from "../_supabase.js";
import { parseItemList } from "../_parser.js";
import { JITA_STATION, isSupportedStation } from "../_stations.js";
import { checkRateLimit, maybeReapStaleRows } from "../_rate_limit.js";
import { getVolumes } from "../_volumes.js";

const ESI_BASE = "https://esi.evetech.net/latest";
const FUZZWORK_BASE = "https://market.fuzzwork.co.uk/aggregates/";

const PRICE_TTL_MS = 30 * 60 * 1000;
const ITEM_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// Same generosity as /api/appraise — Hauling will fire repeatedly while
// pilots iterate on ship/route choices.
const RATE_LIMIT = 60;
const RATE_WINDOW_MS = 5 * 60 * 1000;

export async function onRequestPost({ request, env }) {
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  };

  try {
    const db = getServiceClient(env);
    const rl = await checkRateLimit(db, request, { limit: RATE_LIMIT, windowMs: RATE_WINDOW_MS });
    if (!rl.allowed) {
      return new Response(
        JSON.stringify({ error: "Rate limit exceeded; slow down a bit." }),
        { status: 429, headers: { ...headers, "Retry-After": String(rl.retryAfter) } }
      );
    }
    maybeReapStaleRows(db);

    const body = await request.json();
    const text = body?.text;
    if (!text?.trim()) {
      return new Response(JSON.stringify({ error: "text field required" }), { status: 400, headers });
    }
    if (text.length > 100_000) {
      return new Response(JSON.stringify({ error: "Input too large (max 100k chars)" }), { status: 400, headers });
    }
    const src = isSupportedStation(parseInt(body?.sourceStationId, 10)) ? parseInt(body.sourceStationId, 10) : JITA_STATION;
    const dst = isSupportedStation(parseInt(body?.destStationId, 10))   ? parseInt(body.destStationId,   10) : JITA_STATION;

    const parsed = parseItemList(text);
    if (parsed.length === 0) {
      return new Response(JSON.stringify({ error: "No recognizable items found" }), { status: 400, headers });
    }

    const names = parsed.map((i) => i.name);
    const nameMap = await resolveNames(db, names);
    const typeIDs = [...new Set(Object.values(nameMap).filter(Boolean))];

    const [srcPrices, dstPrices, volumeMap] = await Promise.all([
      getPrices(db, typeIDs, src),
      src === dst ? Promise.resolve(null) : getPrices(db, typeIDs, dst),
      getVolumes(db, typeIDs),
    ]);
    // When src === dst, reuse the single price set for both sides; this is
    // useful e.g. for "appraise inventory before listing" workflows.
    const dst2 = dstPrices ?? srcPrices;

    let srcUpdatedAt = null;
    let dstUpdatedAt = null;

    const items = parsed.map(({ name, quantity }) => {
      const typeID = nameMap[name.toLowerCase()] ?? null;
      const sp = typeID ? srcPrices[typeID] : null;
      const dp = typeID ? dst2[typeID] : null;

      if (sp?.updated_at && (!srcUpdatedAt || sp.updated_at < srcUpdatedAt)) srcUpdatedAt = sp.updated_at;
      if (dp?.updated_at && (!dstUpdatedAt || dp.updated_at < dstUpdatedAt)) dstUpdatedAt = dp.updated_at;

      return {
        typeID, name, quantity,
        // Source: what you pay to acquire — sell_min is the lowest ask; buy_max is what you'd offer back.
        sourceSell: sp?.sell_min ?? 0,
        sourceBuy:  sp?.buy_max  ?? 0,
        // Destination: what you can flip for — sell_min is the listing price you'd undercut, buy_max is instant sale.
        destSell:   dp?.sell_min ?? 0,
        destBuy:    dp?.buy_max  ?? 0,
        // Listed market depth at destination — needed for the volume-aware cap.
        destSellVolume: dp?.sell_volume ?? null,
        srcSellVolume:  sp?.sell_volume ?? null,
        volumeEach: (typeID != null ? volumeMap[typeID] : null) ?? null,
        unknown: !typeID || !dp || !sp,
      };
    });

    return new Response(
      JSON.stringify({
        sourceStationId: src,
        destStationId: dst,
        items,
        sourceUpdatedAt: srcUpdatedAt,
        destUpdatedAt: dstUpdatedAt,
      }),
      { headers }
    );
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

// ── Helpers (mirrored from appraise.js; kept duplicated to avoid coupling
//    a stateless route to the appraisal pipeline) ───────────────────────────

async function resolveNames(db, names) {
  const lowerNames = names.map((n) => n.toLowerCase());
  const { data: cached } = await db
    .from("item_cache")
    .select("name_lower, type_id, updated_at")
    .in("name_lower", lowerNames);

  const nameMap = {};
  const stale = [];
  const now = Date.now();
  for (const row of cached ?? []) {
    if (now - new Date(row.updated_at).getTime() < ITEM_TTL_MS) nameMap[row.name_lower] = row.type_id;
    else stale.push(row.name_lower);
  }
  const missing = lowerNames.filter((n) => !(n in nameMap));
  const toFetch = [...new Set([...missing, ...stale])];
  if (toFetch.length > 0) {
    const originals = names.filter((n) => toFetch.includes(n.toLowerCase()));
    const resolved = await esiResolveNames(originals);
    if (resolved.length > 0) {
      await db.from("item_cache").upsert(
        resolved.map((r) => ({ type_id: r.id, name: r.name, name_lower: r.name.toLowerCase(), updated_at: new Date().toISOString() })),
        { onConflict: "type_id" }
      );
      for (const r of resolved) nameMap[r.name.toLowerCase()] = r.id;
    }
  }
  const result = {};
  for (const name of names) result[name.toLowerCase()] = nameMap[name.toLowerCase()] ?? null;
  return result;
}

async function esiResolveNames(names) {
  if (names.length === 0) return [];
  const chunks = chunk(names, 500);
  const results = await Promise.all(
    chunks.map(async (c) => {
      try {
        const res = await fetch(`${ESI_BASE}/universe/ids/?datasource=tranquility`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "User-Agent": "met0-trade/0.5.1" },
          body: JSON.stringify(c),
          signal: AbortSignal.timeout(8000),
        });
        if (!res.ok) {
          console.warn(`[hauling:esi-ids] HTTP ${res.status} for chunk size ${c.length}`);
          return [];
        }
        const data = await res.json();
        return data.inventory_types ?? [];
      } catch (err) {
        console.warn(`[hauling:esi-ids] ${err.name === "TimeoutError" ? "timeout" : err.message} for chunk size ${c.length}`);
        return [];
      }
    })
  );
  return results.flat();
}

async function getPrices(db, typeIDs, stationId) {
  if (typeIDs.length === 0) return {};

  const useCache = stationId === JITA_STATION;
  const priceMap = {};

  if (useCache) {
    const { data: cached } = await db
      .from("price_cache")
      .select("type_id, sell_min, sell_max, buy_min, buy_max, sell_volume, updated_at")
      .in("type_id", typeIDs);
    const now = Date.now();
    const stale = [];
    for (const row of cached ?? []) {
      if (now - new Date(row.updated_at).getTime() < PRICE_TTL_MS) priceMap[row.type_id] = row;
      else stale.push(row.type_id);
    }
    const missing = typeIDs.filter((id) => !(id in priceMap));
    const toFetch = [...new Set([...missing, ...stale])];
    if (toFetch.length > 0) {
      const fresh = await fuzzworkPrices(toFetch, stationId);
      const upsert = [];
      for (const [idStr, data] of Object.entries(fresh)) {
        const id = parseInt(idStr, 10);
        const row = {
          type_id: id,
          sell_min: parseFloat(data.sell.min),
          sell_max: parseFloat(data.sell.max),
          buy_min: parseFloat(data.buy.min),
          buy_max: parseFloat(data.buy.max),
          sell_volume: parseInt(data.sell.volume, 10) || null,
          updated_at: new Date().toISOString(),
        };
        priceMap[id] = row;
        upsert.push(row);
      }
      if (upsert.length > 0) await db.from("price_cache").upsert(upsert, { onConflict: "type_id" });
    }
    return priceMap;
  }

  const fresh = await fuzzworkPrices(typeIDs, stationId);
  const liveTimestamp = new Date().toISOString();
  for (const [idStr, data] of Object.entries(fresh)) {
    const id = parseInt(idStr, 10);
    priceMap[id] = {
      type_id: id,
      sell_min: parseFloat(data.sell.min),
      sell_max: parseFloat(data.sell.max),
      buy_min: parseFloat(data.buy.min),
      buy_max: parseFloat(data.buy.max),
      sell_volume: parseInt(data.sell.volume, 10) || null,
      updated_at: liveTimestamp,
    };
  }
  return priceMap;
}

async function fuzzworkPrices(typeIDs, stationId) {
  const out = {};
  const chunks = chunk(typeIDs, 200);
  const results = await Promise.all(
    chunks.map(async (c) => {
      const params = new URLSearchParams({ station: stationId, types: c.join(",") });
      try {
        const res = await fetch(`${FUZZWORK_BASE}?${params}`, {
          signal: AbortSignal.timeout(8000),
        });
        if (!res.ok) {
          console.warn(`[hauling:fuzzwork] HTTP ${res.status} for chunk size ${c.length}`);
          return null;
        }
        return await res.json();
      } catch (err) {
        console.warn(`[hauling:fuzzwork] ${err.name === "TimeoutError" ? "timeout" : err.message} for chunk size ${c.length}`);
        return null;
      }
    })
  );
  for (const r of results) if (r) Object.assign(out, r);
  return out;
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
