import { getPublicClient } from "../_supabase.js";

export async function onRequestGet({ params, env }) {
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "public, max-age=300", // appraisals are immutable; cache 5 min on edge
  };

  const { slug } = params;
  if (!slug) {
    return new Response(JSON.stringify({ error: "slug required" }), { status: 400, headers });
  }

  const db = getPublicClient(env);

  const { data: appraisal, error } = await db
    .from("appraisals")
    .select("id, slug, total_buy, total_sell, item_count, created_at, raw_input, station_id")
    .eq("slug", slug)
    .single();

  if (error || !appraisal) {
    return new Response(JSON.stringify({ error: "Appraisal not found" }), { status: 404, headers });
  }

  const { data: items } = await db
    .from("appraisal_items")
    .select("type_id, name, quantity, sell_each, buy_each, sell_total, buy_total, unknown")
    .eq("appraisal_id", appraisal.id)
    .order("sell_total", { ascending: false });

  // Fetch m³ volumes from item_cache and current Jita listed sell_volume from
  // price_cache for known type IDs. pricesUpdatedAt is the oldest price-cache
  // timestamp across the items (most conservative freshness).
  const typeIDs = (items ?? []).map((i) => i.type_id).filter(Boolean);
  let volumeMap = {};
  let sellVolumeMap = {};
  let pricesUpdatedAt = null;
  if (typeIDs.length > 0) {
    const [{ data: vols }, { data: prices }] = await Promise.all([
      db.from("item_cache").select("type_id, volume").in("type_id", typeIDs).not("volume", "is", null),
      db.from("price_cache").select("type_id, sell_volume, updated_at").in("type_id", typeIDs),
    ]);
    for (const row of vols ?? []) volumeMap[row.type_id] = Number(row.volume);
    for (const row of prices ?? []) {
      if (row.sell_volume != null) sellVolumeMap[row.type_id] = Number(row.sell_volume);
      if (row.updated_at && (!pricesUpdatedAt || row.updated_at < pricesUpdatedAt)) {
        pricesUpdatedAt = row.updated_at;
      }
    }
  }

  return new Response(
    JSON.stringify({
      slug: appraisal.slug,
      totalBuy: appraisal.total_buy,
      totalSell: appraisal.total_sell,
      itemCount: appraisal.item_count,
      createdAt: appraisal.created_at,
      stationId: appraisal.station_id,
      pricesUpdatedAt,
      rawInput: appraisal.raw_input,
      items: (items ?? []).map((i) => ({
        typeID: i.type_id,
        name: i.name,
        quantity: i.quantity,
        sellEach: parseFloat(i.sell_each),
        buyEach: parseFloat(i.buy_each),
        sellTotal: parseFloat(i.sell_total),
        buyTotal: parseFloat(i.buy_total),
        volumeEach: volumeMap[i.type_id] ?? null,
        sellVolume: sellVolumeMap[i.type_id] ?? null,
        unknown: i.unknown,
      })),
    }),
    { headers }
  );
}
