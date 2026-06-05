// Shared item-volume resolver (cache-first against item_cache + ESI).
//
// Each uncached typeID costs 1 ESI fetch + 1 Supabase update. The previous
// uncapped Promise.all version blew past Cloudflare's 50-subrequest budget on
// any large paste of unfamiliar items, producing 500s on both Appraise and
// Hauling tabs. This module mirrors the bounded-concurrency / hard-cap
// pattern already used in lp/[corpId].js#resolveTypeCategories and
// lp/_blueprints.js — partial coverage on cold load is fine since callers
// treat null volumes gracefully and remaining rows fill in over a few visits.
//
// Budget: with MAX_VOLUME_FETCHES = 12 and concurrency 5, this function
// contributes at most ~24 subrequests, leaving headroom for the surrounding
// pipeline (names, prices, appraisal insert, etc.).

const ESI_BASE = "https://esi.evetech.net/latest";
const MAX_VOLUME_FETCHES = 12;
const FETCH_CONCURRENCY = 5;

export async function getVolumes(db, typeIDs) {
  if (typeIDs.length === 0) return {};

  const { data: cached } = await db
    .from("item_cache")
    .select("type_id, volume")
    .in("type_id", typeIDs)
    .not("volume", "is", null);

  const volumeMap = {};
  for (const row of cached ?? []) volumeMap[row.type_id] = Number(row.volume);

  const missing = typeIDs
    .filter((id) => !(id in volumeMap))
    .slice(0, MAX_VOLUME_FETCHES);
  if (missing.length === 0) return volumeMap;

  const fetched = [];
  let cursor = 0;
  async function worker() {
    while (cursor < missing.length) {
      const id = missing[cursor++];
      try {
        const r = await fetch(`${ESI_BASE}/universe/types/${id}/?datasource=tranquility`, {
          headers: { "User-Agent": "met0-trade/0.5.1" },
          signal: AbortSignal.timeout(8000),
        });
        if (!r.ok) {
          console.warn(`[volumes:esi-type] HTTP ${r.status} typeID=${id}`);
          continue;
        }
        const d = await r.json();
        if (d.volume != null) fetched.push({ typeID: id, volume: d.volume });
      } catch (err) {
        console.warn(`[volumes:esi-type] ${err.name === "TimeoutError" ? "timeout" : err.message} typeID=${id}`);
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(FETCH_CONCURRENCY, missing.length) }, worker)
  );

  for (const { typeID, volume } of fetched) volumeMap[typeID] = volume;

  // Bounded-concurrency drain on the writes so the per-row update fan-out is
  // also capped (Supabase calls count toward the same 50-subrequest budget).
  let wCursor = 0;
  async function writer() {
    while (wCursor < fetched.length) {
      const { typeID, volume } = fetched[wCursor++];
      try {
        await db.from("item_cache").update({ volume }).eq("type_id", typeID);
      } catch {}
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(FETCH_CONCURRENCY, fetched.length) }, writer)
  );

  return volumeMap;
}
