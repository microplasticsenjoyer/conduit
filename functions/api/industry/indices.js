// GET /api/industry/indices
//
// Returns manufacturing cost indices for a hardcoded set of popular industry
// systems. ESI publishes the full table at /industry/systems/ (~8k systems);
// we filter to the curated subset to keep the payload small and the picker
// useful for corp manufacturers.
//
// Cache: hourly TTL in `industry_indices`. The first request after the TTL
// expires re-fetches from ESI; concurrent requests during that window will
// see fresh data once the upsert completes.

import { getServiceClient } from "../_supabase.js";

const ESI_BASE = "https://esi.evetech.net/latest";
const TTL_MS = 60 * 60 * 1000; // 1 hour

// Popular Empire + low-sec industry systems. Add corp-relevant ones here.
// IDs are EVE solar_system_id; names are kept here for the picker dropdown.
const SYSTEMS = [
  { id: 30000142, name: "Jita" },
  { id: 30000144, name: "Perimeter" },
  { id: 30000139, name: "Sobaseki" },
  { id: 30000145, name: "New Caldari" },
  { id: 30002187, name: "Amarr" },
  { id: 30002053, name: "Hek" },
  { id: 30002510, name: "Rens" },
  { id: 30002659, name: "Dodixie" },
  { id: 30002780, name: "Stacmon" },
  { id: 30003715, name: "Oursulaert" },
  { id: 30001445, name: "Frarn" },
  { id: 30005196, name: "Itamo" },
  { id: 30002543, name: "Osmon" },
  { id: 30000157, name: "Urlen" },
];

const SYSTEM_IDS = [...new Set(SYSTEMS.map((s) => s.id))];
const SYSTEM_NAME_BY_ID = Object.fromEntries(SYSTEMS.map((s) => [s.id, s.name]));

export async function onRequestGet({ env }) {
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "public, max-age=900",
  };

  try {
    const db = getServiceClient(env);
    const { data: cached } = await db
      .from("industry_indices")
      .select("system_id, system_name, manufacturing_index, updated_at")
      .in("system_id", SYSTEM_IDS);

    const now = Date.now();
    const fresh = (cached ?? []).filter(
      (r) => now - new Date(r.updated_at).getTime() < TTL_MS
    );

    if (fresh.length === SYSTEM_IDS.length) {
      return new Response(JSON.stringify({ systems: fresh.map(toApi) }), { headers });
    }

    // Refresh from ESI: one call returns the entire table, we just project
    // the systems we care about.
    let all;
    try {
      all = await fetch(`${ESI_BASE}/industry/systems/?datasource=tranquility`, {
        headers: { "User-Agent": "met0-trade/0.5.1" },
        signal: AbortSignal.timeout(8000),
      });
    } catch (err) {
      console.warn(`[industry:esi] ${err.name === "TimeoutError" ? "timeout" : err.message}`);
      const fallback = (cached ?? []).map(toApi);
      return new Response(JSON.stringify({ systems: fallback, stale: true }), { headers });
    }
    if (!all.ok) {
      // ESI hiccup: serve whatever cache we have rather than failing.
      const fallback = (cached ?? []).map(toApi);
      return new Response(JSON.stringify({ systems: fallback, stale: true }), { headers });
    }
    const allJson = await all.json();
    const updatedAt = new Date().toISOString();

    const filtered = [];
    const upsertRows = [];
    for (const sys of allJson) {
      if (!SYSTEM_IDS.includes(sys.solar_system_id)) continue;
      const mfg = (sys.cost_indices ?? []).find((i) => i.activity === "manufacturing");
      if (!mfg) continue;
      const row = {
        system_id: sys.solar_system_id,
        system_name: SYSTEM_NAME_BY_ID[sys.solar_system_id] ?? `System ${sys.solar_system_id}`,
        manufacturing_index: Number(mfg.cost_index),
        updated_at: updatedAt,
      };
      upsertRows.push(row);
      filtered.push(toApi(row));
    }

    if (upsertRows.length > 0) {
      await db.from("industry_indices").upsert(upsertRows, { onConflict: "system_id" });
    }

    // Sort by index ascending — cheapest manufacturing first.
    filtered.sort((a, b) => a.manufacturingIndex - b.manufacturingIndex);

    return new Response(JSON.stringify({ systems: filtered }), { headers });
  } catch (err) {
    console.error(err);
    return new Response(
      JSON.stringify({ error: "Internal server error", detail: err.message }),
      { status: 500, headers }
    );
  }
}

function toApi(row) {
  return {
    systemId: row.system_id,
    systemName: row.system_name,
    manufacturingIndex: Number(row.manufacturing_index),
    updatedAt: row.updated_at,
  };
}
