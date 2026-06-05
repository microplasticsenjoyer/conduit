// Corporation info lookup with Supabase-backed cache.
//
// Discord nickname sync needs the corp ticker ("METO") to render
// `[METO] CharacterName`. Tickers are stable in practice, so cached rows live
// for 30 days before we re-check ESI. Returns null on lookup failure so the
// caller can fall back to a bare name without the prefix.

const ESI_BASE = "https://esi.evetech.net/latest";
const TTL_DAYS = 30;

export async function getCorporationTicker(db, corpId) {
  if (!corpId) return null;
  const id = Number(corpId);
  if (!Number.isFinite(id) || id <= 0) return null;

  const { data: row } = await db
    .from("corp_ticker_cache")
    .select("ticker, updated_at")
    .eq("corporation_id", id)
    .maybeSingle();

  if (row && row.ticker && !isStale(row.updated_at)) {
    return row.ticker;
  }

  try {
    const res = await fetch(
      `${ESI_BASE}/corporations/${id}/?datasource=tranquility`,
      { headers: { "User-Agent": "met0-trade/0.5.1" }, signal: AbortSignal.timeout(8000) }
    );
    if (!res.ok) return row?.ticker ?? null;
    const data = await res.json();
    const ticker = typeof data.ticker === "string" ? data.ticker : null;
    if (!ticker) return row?.ticker ?? null;

    try {
      await db.from("corp_ticker_cache").upsert(
        {
          corporation_id: id,
          ticker,
          name: typeof data.name === "string" ? data.name : null,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "corporation_id" }
      );
    } catch { /* cache write is best-effort */ }

    return ticker;
  } catch {
    return row?.ticker ?? null;
  }
}

function isStale(updatedAt) {
  if (!updatedAt) return true;
  const ts = new Date(updatedAt).getTime();
  if (!Number.isFinite(ts)) return true;
  return Date.now() - ts > TTL_DAYS * 24 * 60 * 60 * 1000;
}
