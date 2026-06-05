import { getServiceClient } from "./_supabase.js";
import { parseItemList } from "./_parser.js";
import { generateSlug } from "./_slug.js";
import { JITA_STATION, isSupportedStation } from "./_stations.js";
import { checkRateLimit, maybeReapStaleRows } from "./_rate_limit.js";
import { PRICE_TTL_MS, ITEM_TTL_MS } from "./_constants.js";
import { getVolumes } from "./_volumes.js";

// 30 appraisals per IP per 5 minutes. Generous for legit corp use, cheap
// to bypass for legitimate burst paste sessions, and tight enough that
// scripted abuse fills nothing meaningful before getting throttled.
const APPRAISE_RATE_LIMIT = 30;
const APPRAISE_RATE_WINDOW_MS = 5 * 60 * 1000;

const ESI_BASE = "https://esi.evetech.net/latest";
const FUZZWORK_BASE = "https://market.fuzzwork.co.uk/aggregates/";

export async function onRequestPost({ request, env }) {
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  };

  try {
    const db = getServiceClient(env);

    // Rate-limit before reading the body — cheap path for hostile callers.
    const rl = await checkRateLimit(db, request, {
      limit: APPRAISE_RATE_LIMIT,
      windowMs: APPRAISE_RATE_WINDOW_MS,
    });
    if (!rl.allowed) {
      return new Response(
        JSON.stringify({ error: "Rate limit exceeded; slow down a bit." }),
        {
          status: 429,
          headers: { ...headers, "Retry-After": String(rl.retryAfter) },
        }
      );
    }
    // Best-effort cleanup of long-idle IP rows (1% sampling so it's free per request).
    maybeReapStaleRows(db);

    const body = await request.json();
    const text = body?.text;
    if (!text?.trim()) {
      return new Response(JSON.stringify({ error: "text field required" }), { status: 400, headers });
    }
    // Hard cap on input size — even a fleet hangar dump fits comfortably under this.
    if (text.length > 100_000) {
      return new Response(JSON.stringify({ error: "Input too large (max 100k chars)" }), { status: 400, headers });
    }
    // Validate optional station; fall back to Jita 4-4 if missing or unsupported.
    const requestedStation = parseInt(body?.stationId, 10);
    const stationId = isSupportedStation(requestedStation) ? requestedStation : JITA_STATION;
    const parsed = parseItemList(text);
    if (parsed.length === 0) {
      return new Response(JSON.stringify({ error: "No recognizable items found" }), { status: 400, headers });
    }

    // ── 1. Resolve names → typeIDs (cache-first) ──────────────────────────
    const names = parsed.map((i) => i.name);
    const nameMap = await resolveNames(db, names);

    // ── 2. Fetch prices + volumes (cache-first) ───────────────────────────
    const typeIDs = Object.values(nameMap).filter(Boolean);
    const [priceMap, volumeMap] = await Promise.all([
      getPrices(db, typeIDs, stationId),
      getVolumes(db, typeIDs),
    ]);

    // ── 3. Build line items ───────────────────────────────────────────────
    let totalBuy = 0;
    let totalSell = 0;
    let pricesUpdatedAt = null;

    const items = parsed.map(({ name, quantity }) => {
      const typeID = nameMap[name.toLowerCase()] ?? null;
      const prices = typeID ? priceMap[typeID] : null;

      const sellEach = prices?.sell_min ?? 0;
      const buyEach = prices?.buy_max ?? 0;
      const sellTotal = sellEach * quantity;
      const buyTotal = buyEach * quantity;
      const volumeEach = (typeID != null ? volumeMap[typeID] : null) ?? null;
      const sellVolume = prices?.sell_volume ?? null;

      if (prices?.updated_at) {
        if (!pricesUpdatedAt || prices.updated_at < pricesUpdatedAt) {
          pricesUpdatedAt = prices.updated_at;
        }
      }

      totalBuy += buyTotal;
      totalSell += sellTotal;

      return {
        typeID, name, quantity, sellEach, buyEach, sellTotal, buyTotal,
        volumeEach, sellVolume,
        unknown: !typeID || !prices,
      };
    });

    // ── 4. Persist appraisal ──────────────────────────────────────────────
    const slug = await uniqueSlug(db);

    const { data: appraisal, error: appraisalErr } = await db
      .from("appraisals")
      .insert({
        slug, raw_input: text,
        total_buy: totalBuy, total_sell: totalSell,
        item_count: items.length,
        station_id: stationId,
      })
      .select("id, slug, created_at")
      .single();

    if (appraisalErr) throw appraisalErr;

    await db.from("appraisal_items").insert(
      items.map((item) => ({
        appraisal_id: appraisal.id,
        type_id: item.typeID,
        name: item.name,
        quantity: item.quantity,
        sell_each: item.sellEach,
        buy_each: item.buyEach,
        sell_total: item.sellTotal,
        buy_total: item.buyTotal,
        unknown: item.unknown,
      }))
    );

    return new Response(
      JSON.stringify({
        slug: appraisal.slug,
        createdAt: appraisal.created_at,
        stationId,
        items, totalBuy, totalSell, pricesUpdatedAt,
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

// ── Helpers ────────────────────────────────────────────────────────────────

async function resolveNames(db, names) {
  const lowerNames = names.map((n) => n.toLowerCase());

  // Check cache
  const { data: cached } = await db
    .from("item_cache")
    .select("name_lower, type_id, updated_at")
    .in("name_lower", lowerNames);

  const nameMap = {};
  const stale = [];
  const now = Date.now();

  for (const row of cached ?? []) {
    if (now - new Date(row.updated_at).getTime() < ITEM_TTL_MS) {
      nameMap[row.name_lower] = row.type_id;
    } else {
      stale.push(row.name_lower);
    }
  }

  const missing = lowerNames.filter((n) => !(n in nameMap));
  const toFetch = [...new Set([...missing, ...stale])];

  if (toFetch.length > 0) {
    // Map lowercase back to original casing for ESI
    const originalNames = names.filter((n) => toFetch.includes(n.toLowerCase()));
    const resolved = await esiResolveNames(originalNames);

    // Upsert into cache
    if (resolved.length > 0) {
      await db.from("item_cache").upsert(
        resolved.map((r) => ({ type_id: r.id, name: r.name, name_lower: r.name.toLowerCase(), updated_at: new Date().toISOString() })),
        { onConflict: "type_id" }
      );
      for (const r of resolved) nameMap[r.name.toLowerCase()] = r.id;
    }
  }

  // Build final map keyed by original name (case-insensitive)
  const result = {};
  for (const name of names) {
    result[name.toLowerCase()] = nameMap[name.toLowerCase()] ?? null;
  }
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
          console.warn(`[appraise:esi-ids] HTTP ${res.status} for chunk size ${c.length}`);
          return [];
        }
        const data = await res.json();
        return data.inventory_types ?? [];
      } catch (err) {
        console.warn(`[appraise:esi-ids] ${err.name === "TimeoutError" ? "timeout" : err.message} for chunk size ${c.length}`);
        return [];
      }
    })
  );
  return results.flat();
}

async function getPrices(db, typeIDs, stationId) {
  if (typeIDs.length === 0) return {};

  // The price_cache table is keyed only by type_id and is reserved for the
  // default trading hub (Jita 4-4). For any other station we bypass the cache
  // and call Fuzzwork directly — those requests are uncommon, and we'd
  // otherwise need a composite (type_id, station_id) key + invalidation.
  const useCache = stationId === JITA_STATION;

  const priceMap = {};

  if (useCache) {
    const { data: cached } = await db
      .from("price_cache")
      .select("type_id, sell_min, sell_max, buy_min, buy_max, sell_volume, updated_at")
      .in("type_id", typeIDs);
    const now = Date.now();
    const stale = [];
    const staleRows = {}; // kept so we can fall back to old prices on Fuzzwork failure
    for (const row of cached ?? []) {
      if (now - new Date(row.updated_at).getTime() < PRICE_TTL_MS) {
        priceMap[row.type_id] = row;
      } else {
        stale.push(row.type_id);
        staleRows[row.type_id] = row;
      }
    }
    const missing = typeIDs.filter((id) => !(id in priceMap));
    const toFetch = [...new Set([...missing, ...stale])];
    if (toFetch.length > 0) {
      const fresh = await fuzzworkPrices(toFetch, stationId);
      const upsertRows = [];
      for (const [idStr, data] of Object.entries(fresh)) {
        const typeID = parseInt(idStr, 10);
        const row = {
          type_id: typeID,
          sell_min: parseFloat(data.sell.min),
          sell_max: parseFloat(data.sell.max),
          buy_min: parseFloat(data.buy.min),
          buy_max: parseFloat(data.buy.max),
          sell_volume: parseInt(data.sell.volume, 10) || null,
          updated_at: new Date().toISOString(),
        };
        priceMap[typeID] = row;
        upsertRows.push(row);
      }
      if (upsertRows.length > 0) {
        await db.from("price_cache").upsert(upsertRows, { onConflict: "type_id" });
      }
      // Stale typeIDs that Fuzzwork didn't return — fall back to the cached
      // (stale) row so the user sees their last known price rather than $0.
      // pricesUpdatedAt in the response surfaces the old timestamp so the UI
      // can flag the data as out of date.
      for (const id of stale) {
        if (!(id in priceMap) && staleRows[id]) priceMap[id] = staleRows[id];
      }
    }
    return priceMap;
  }

  // Non-Jita: live fetch only, no caching.
  const fresh = await fuzzworkPrices(typeIDs, stationId);
  const liveTimestamp = new Date().toISOString();
  for (const [idStr, data] of Object.entries(fresh)) {
    const typeID = parseInt(idStr, 10);
    priceMap[typeID] = {
      type_id: typeID,
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
  const chunks = chunk(typeIDs, 200);
  const out = {};
  const results = await Promise.all(
    chunks.map(async (c) => {
      const params = new URLSearchParams({ station: stationId, types: c.join(",") });
      try {
        const res = await fetch(`${FUZZWORK_BASE}?${params}`, {
          signal: AbortSignal.timeout(8000),
        });
        if (!res.ok) {
          console.warn(`[appraise:fuzzwork] HTTP ${res.status} for chunk size ${c.length}`);
          return null;
        }
        return await res.json();
      } catch (err) {
        console.warn(`[appraise:fuzzwork] ${err.name === "TimeoutError" ? "timeout" : err.message} for chunk size ${c.length}`);
        return null;
      }
    })
  );
  for (const r of results) if (r) Object.assign(out, r);
  return out;
}

async function uniqueSlug(db) {
  for (let i = 0; i < 10; i++) {
    const slug = generateSlug(6);
    const { data } = await db.from("appraisals").select("slug").eq("slug", slug).maybeSingle();
    if (!data) return slug;
  }
  return generateSlug(8); // fallback to longer slug
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
