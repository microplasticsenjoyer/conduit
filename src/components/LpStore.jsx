import React, { useEffect, useState, useMemo, useRef } from "react";
import styles from "./LpStore.module.css";
import { useCorpGroups } from "../lib/corps.js";
import { timeAgo } from "../lib/format.js";
import { showToast } from "../lib/toast.js";

// EVE category_id → friendly label for filter chips.
const CATEGORY_LABELS = {
  6: "Ships", 7: "Modules", 8: "Charges", 9: "Blueprints",
  16: "Skills", 17: "Commodities", 18: "Drones", 20: "Implants",
  22: "Deployables", 30: "Apparel", 32: "Subsystems", 65: "Structures",
};

function fmt(v) {
  if (v === 0) return "—";
  const abs = Math.abs(v);
  const sign = v < 0 ? "-" : "";
  if (abs >= 1e9) return sign + (abs / 1e9).toFixed(2) + "B";
  if (abs >= 1e6) return sign + (abs / 1e6).toFixed(2) + "M";
  if (abs >= 1e3) return sign + (abs / 1e3).toFixed(1) + "k";
  return v.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

function fmtIskPerLp(v) {
  if (!isFinite(v) || v === 0) return "—";
  return v.toLocaleString("en-US", { maximumFractionDigits: 0 });
}


// Bucket a value (`v`) against a sorted reference array using a 4-tier scale.
function volumeTier(v, sortedAll) {
  if (v == null || sortedAll.length === 0) return null;
  const n = sortedAll.length;
  const idx = lowerBound(sortedAll, v);
  const pct = idx / n;
  if (pct < 0.25) return "low";
  if (pct < 0.5) return "midLow";
  if (pct < 0.75) return "midHigh";
  return "high";
}

const STORAGE_PREFIX = "praxis:lpStore:";
function readStored(key) {
  try {
    return localStorage.getItem(STORAGE_PREFIX + key) ?? "0";
  } catch {
    return "0";
  }
}
function parseStored(key) {
  return Math.max(0, parseFloat(readStored(key)) || 0);
}
function writeStored(key, value) {
  try {
    localStorage.setItem(STORAGE_PREFIX + key, String(value ?? ""));
  } catch {
    /* storage unavailable — ignore */
  }
}

function lowerBound(arr, target) {
  let lo = 0, hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// URL params live alongside ?tab=lp so deep-links keep working.
function readUrlParam(key) {
  if (typeof window === "undefined") return null;
  return new URLSearchParams(window.location.search).get(key);
}
function writeUrlParams(updates) {
  if (typeof window === "undefined") return;
  const params = new URLSearchParams(window.location.search);
  for (const [k, v] of Object.entries(updates)) {
    if (v == null || v === "") params.delete(k);
    else params.set(k, String(v));
  }
  const qs = params.toString();
  const url = qs ? `?${qs}` : window.location.pathname;
  window.history.replaceState({}, "", url);
}

export default function LpStore({ onPrefsChange }) {
  const { groups: CORP_GROUPS, allCorps: ALL_CORPS, enabledCorps: ENABLED_CORPS, loading: corpsLoading } = useCorpGroups();

  // corpId starts null; resolved only after ALL_CORPS loads to avoid firing a
  // fetch with a stale URL param (e.g. old corp ID from a previous session).
  const [corpId, setCorpId] = useState(null);

  // Once the corp list arrives, pick the best starting corp:
  //   1. URL param if valid; 2. first enabled corp in the list.
  // Disabled (placeholder) corps are honoured if the URL points to one so
  // deep-links still work — the user just sees the "coming soon" panel.
  // Runs only when ALL_CORPS changes (not on every setCorpId) so routine
  // corp-selector changes don't re-trigger this guard.
  useEffect(() => {
    if (ALL_CORPS.length === 0) return;
    const fromUrl = parseInt(readUrlParam("corp") ?? "", 10);
    const preferred = Number.isFinite(fromUrl) ? fromUrl : null;
    const valid = preferred != null && ALL_CORPS.some((c) => c.id === preferred);
    const fallback = ENABLED_CORPS[0]?.id ?? ALL_CORPS[0].id;
    if (valid) {
      if (corpId !== preferred) setCorpId(preferred);
    } else if (corpId == null || !ALL_CORPS.some((c) => c.id === corpId)) {
      setCorpId(fallback);
    }
  }, [ALL_CORPS]); // eslint-disable-line react-hooks/exhaustive-deps

  const selectedCorp = ALL_CORPS.find((c) => c.id === corpId) ?? null;
  const corpDisabled = !!selectedCorp?.disabled;
  const [data, setData] = useState(null);
  const [history, setHistory] = useState({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  // Sort state — persisted across page loads and corp switches.
  const [sortKey, setSortKey] = useState(
    () => localStorage.getItem(STORAGE_PREFIX + "sortKey") ?? "iskPerLpSell"
  );
  const [sortDir, setSortDir] = useState(
    () => localStorage.getItem(STORAGE_PREFIX + "sortDir") ?? "desc"
  );

  const [search, setSearch] = useState(() => readUrlParam("q") ?? "");
  const [categoryFilter, setCategoryFilter] = useState(() => {
    const c = parseInt(readUrlParam("cat") ?? "", 10);
    return Number.isFinite(c) ? c : null;
  });

  // Persist filter/search/corp to URL for deep-linking.
  useEffect(() => {
    writeUrlParams({
      corp: corpId,
      cat: categoryFilter,
      q: search.trim() || null,
    });
  }, [corpId, categoryFilter, search]);

  // Advanced toggle — persisted to localStorage; falls back to viewport width.
  const [advanced, setAdvanced] = useState(() => {
    const s = localStorage.getItem(STORAGE_PREFIX + "advanced");
    return s !== null ? s === "true" : window.innerWidth >= 768;
  });

  // Group-by-item: collapse duplicate products to best ISK/LP offer.
  const [groupByItem, setGroupByItem] = useState(false);

  // Copy-to-clipboard feedback: stores the offerId that was just copied.
  const [copied, setCopied] = useState(null);

  // Draft strings (what the user types) — applied on Calculate.
  const [draftLpPrice, setDraftLpPrice] = useState(() => readStored("lpPrice"));
  const [draftSalesTax, setDraftSalesTax] = useState(() => readStored("salesTax"));
  const [draftMfgTax, setDraftMfgTax] = useState(() => readStored("mfgTax"));

  // Applied values used for computation.
  const [lpPrice, setLpPrice] = useState(() => parseStored("lpPrice"));
  const [salesTax, setSalesTax] = useState(() => parseStored("salesTax"));
  const [mfgTax, setMfgTax] = useState(() => parseStored("mfgTax"));

  const historyAbortRef = useRef(null);

  // Multi-corp comparison
  const [compareOffer, setCompareOffer] = useState(null);
  const [compareData, setCompareData] = useState({});
  const corpCacheRef = useRef(new Map());

  // Seed cache with current corp data as it loads.
  useEffect(() => {
    if (data && corpId != null) corpCacheRef.current.set(corpId, data);
  }, [data, corpId]);

  // Close compare panel when the user switches corp.
  useEffect(() => { setCompareOffer(null); }, [corpId]);

  // When comparison opens, initialise from cache and fetch any missing corps.
  useEffect(() => {
    if (!compareOffer || !ENABLED_CORPS.length) return;
    const cache = corpCacheRef.current;
    const initial = {};
    ENABLED_CORPS.forEach((c) => {
      initial[c.id] = cache.has(c.id)
        ? { loading: false, error: null, corpData: cache.get(c.id) }
        : { loading: true, error: null, corpData: null };
    });
    setCompareData(initial);
    ENABLED_CORPS.filter((c) => !cache.has(c.id)).forEach(async (c) => {
      try {
        const res = await fetch(`/api/lp/${c.id}`);
        const json = await res.json();
        if (!res.ok) throw new Error(json.error || "Request failed");
        cache.set(c.id, json);
        setCompareData((prev) => ({ ...prev, [c.id]: { loading: false, error: null, corpData: json } }));
      } catch (err) {
        setCompareData((prev) => ({ ...prev, [c.id]: { loading: false, error: err.message, corpData: null } }));
      }
    });
  }, [compareOffer]); // eslint-disable-line react-hooks/exhaustive-deps

  // Industry-system picker. ESI's manufacturing cost index for the selected
  // system maps to "extra cost as a fraction of input materials" — we feed
  // it into the existing MFG TAX field as a one-click prefill.
  const [industrySystems, setIndustrySystems] = useState([]);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/industry/indices")
      .then((r) => r.ok ? r.json() : null)
      .then((j) => { if (!cancelled && j?.systems) setIndustrySystems(j.systems); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  function applyIndustrySystem(systemIdStr) {
    const id = parseInt(systemIdStr, 10);
    if (!Number.isFinite(id)) return;
    const sys = industrySystems.find((s) => s.systemId === id);
    if (!sys) return;
    const pct = (sys.manufacturingIndex * 100).toFixed(2);
    setDraftMfgTax(pct);
  }

  function handleCalculate() {
    const lp = Math.max(0, parseFloat(draftLpPrice) || 0);
    const st = Math.max(0, parseFloat(draftSalesTax) || 0);
    const mt = Math.max(0, parseFloat(draftMfgTax) || 0);
    setLpPrice(lp);
    setSalesTax(st);
    setMfgTax(mt);
    writeStored("lpPrice", draftLpPrice);
    writeStored("salesTax", draftSalesTax);
    writeStored("mfgTax", draftMfgTax);
    onPrefsChange?.({ lpPrice: lp, mfgTax: mt });
  }

  function draftInput(value, setter) {
    return (
      <input
        type="text"
        inputMode="decimal"
        className={styles.numInput}
        value={value}
        placeholder="0"
        onChange={(e) => setter(e.target.value)}
        onFocus={(e) => e.target.select()}
        onKeyDown={(e) => { if (e.key === "Enter") handleCalculate(); }}
      />
    );
  }

  useEffect(() => {
    if (corpId == null) return;
    if (corpDisabled) {
      setLoading(false);
      setError(null);
      setData(null);
      setHistory({});
      return;
    }
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      setData(null);
      setHistory({});
      try {
        const res = await fetch(`/api/lp/${corpId}`);
        const json = await res.json();
        if (!res.ok) throw new Error(json.error || "Request failed");
        if (!cancelled) setData(json);
      } catch (err) {
        if (!cancelled) setError(err.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [corpId, corpDisabled]);

  // Background fetch: 30-day volume + price history for every product type.
  useEffect(() => {
    if (!data?.offers?.length) return;
    const typeIds = [...new Set(data.offers.map((o) => o.typeID))];
    const controller = new AbortController();
    historyAbortRef.current?.abort();
    historyAbortRef.current = controller;

    fetch("/api/lp/history", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ typeIds }),
      signal: controller.signal,
    })
      .then((r) => r.ok ? r.json() : null)
      .then((j) => { if (j?.history) setHistory(j.history); })
      .catch(() => { /* aborted or network error — silent */ });

    return () => controller.abort();
  }, [data]);

  function handleSort(key) {
    if (sortKey === key) {
      const next = sortDir === "asc" ? "desc" : "asc";
      setSortDir(next);
      writeStored("sortDir", next);
    } else {
      setSortKey(key);
      setSortDir("desc");
      writeStored("sortKey", key);
      writeStored("sortDir", "desc");
    }
  }

  function toggleAdvanced() {
    setAdvanced((a) => {
      writeStored("advanced", !a);
      return !a;
    });
  }

  const arrow = (key) => (sortKey === key ? (sortDir === "asc" ? " ▲" : " ▼") : "");

  // Step 1: apply profit adjustments on top of raw API data.
  const adjustedOffers = useMemo(() => {
    if (!data?.offers) return [];
    return data.offers.map((o) => {
      const materialCost = o.inputCost - o.iskCost;
      const adjMaterialCost = materialCost * (1 + mfgTax / 100);
      const adjTotalCost = o.iskCost + adjMaterialCost + o.lpCost * lpPrice;
      const adjRevenueSell = o.productSell * o.quantity * (1 - salesTax / 100);
      const adjProfitSell = adjRevenueSell - adjTotalCost;
      const adjProfitBuy = o.productBuy * o.quantity - adjTotalCost;
      return {
        ...o,
        adjMaterialCost,
        revenueSell: adjRevenueSell,
        profitSell: adjProfitSell,
        profitBuy: adjProfitBuy,
        iskPerLpSell: o.lpCost > 0 ? adjProfitSell / o.lpCost : 0,
        iskPerLpBuy: o.lpCost > 0 ? adjProfitBuy / o.lpCost : 0,
      };
    });
  }, [data, lpPrice, salesTax, mfgTax]);

  // Step 2: merge history data — avgDailyVol, daysOfSupply, priceHistory.
  const withHistory = useMemo(() => {
    return adjustedOffers.map((o) => {
      const h = history[o.typeID];
      const vols = h?.volume?.filter((v) => v > 0) ?? [];
      const avgDailyVol = vols.length > 0
        ? Math.round(vols.reduce((s, v) => s + v, 0) / vols.length)
        : null;
      const daysOfSupply =
        o.sellVolume != null && avgDailyVol != null && avgDailyVol > 0
          ? Math.round(o.sellVolume / avgDailyVol)
          : null;
      return { ...o, avgDailyVol, daysOfSupply, priceHistory: h };
    });
  }, [adjustedOffers, history]);

  // Step 3: collapse duplicate products to best-ISK/LP offer when grouping.
  const offersForDisplay = useMemo(() => {
    if (!groupByItem) return withHistory;
    const counts = new Map();
    for (const o of withHistory) counts.set(o.typeID, (counts.get(o.typeID) ?? 0) + 1);
    const bestByType = new Map();
    for (const o of withHistory) {
      const cur = bestByType.get(o.typeID);
      if (!cur || o.iskPerLpSell > cur.iskPerLpSell) bestByType.set(o.typeID, o);
    }
    return [...bestByType.values()].map((o) => ({
      ...o,
      offerCount: counts.get(o.typeID) ?? 1,
    }));
  }, [withHistory, groupByItem]);

  // Sorted sell-volume references for colour tiering (relative to current display set).
  const sortedVolumes = useMemo(() => {
    return offersForDisplay
      .map((o) => o.sellVolume)
      .filter((v) => v != null && v > 0)
      .sort((a, b) => a - b);
  }, [offersForDisplay]);

  // Sorted avg-daily-vol references — based on full withHistory so tier
  // thresholds are stable when toggling groupByItem.
  const sortedAvgVols = useMemo(() => {
    return withHistory
      .map((o) => o.avgDailyVol)
      .filter((v) => v != null && v > 0)
      .sort((a, b) => a - b);
  }, [withHistory]);

  // Top 20 movers: highest 7-day average daily volume across unique products.
  // Only computed once history has loaded; uses best offer per unique product.
  const topMovers = useMemo(() => {
    if (!Object.keys(history).length) return [];
    const bestByType = new Map();
    for (const o of withHistory) {
      const cur = bestByType.get(o.typeID);
      if (!cur || o.iskPerLpSell > cur.iskPerLpSell) bestByType.set(o.typeID, o);
    }
    return [...bestByType.values()]
      .map((o) => {
        const recent = o.priceHistory?.volume?.slice(-7).filter((v) => v > 0) ?? [];
        const vol7d = recent.length > 0
          ? Math.round(recent.reduce((s, v) => s + v, 0) / recent.length)
          : null;
        return { ...o, vol7d };
      })
      .filter((o) => o.vol7d != null && o.vol7d > 0)
      .sort((a, b) => (b.vol7d ?? 0) - (a.vol7d ?? 0))
      .slice(0, 20);
  }, [withHistory, history]);

  // ISK/LP for the selected item across every enabled corp.
  const compareResults = useMemo(() => {
    if (!compareOffer) return [];
    return ENABLED_CORPS.map((corp) => {
      const cd = compareData[corp.id];
      if (!cd || cd.loading) return { corp, loading: true };
      if (cd.error) return { corp, error: cd.error };
      const matching = (cd.corpData?.offers ?? []).filter((o) => o.typeID === compareOffer.typeID);
      if (!matching.length) return { corp, notAvailable: true };
      let best = null;
      for (const o of matching) {
        const adjMaterialCost = (o.inputCost - o.iskCost) * (1 + mfgTax / 100);
        const adjTotalCost = o.iskCost + adjMaterialCost + o.lpCost * lpPrice;
        const iskPerLpSell = o.lpCost > 0
          ? (o.productSell * o.quantity * (1 - salesTax / 100) - adjTotalCost) / o.lpCost
          : 0;
        const iskPerLpBuy = o.lpCost > 0
          ? (o.productBuy * o.quantity - adjTotalCost) / o.lpCost
          : 0;
        if (!best || iskPerLpSell > best.iskPerLpSell) best = { corp, iskPerLpSell, iskPerLpBuy };
      }
      return best;
    }).sort((a, b) => {
      if (a.loading && !b.loading) return 1;
      if (!a.loading && b.loading) return -1;
      const aOk = !a.notAvailable && !a.error && !a.loading;
      const bOk = !b.notAvailable && !b.error && !b.loading;
      if (!aOk && bOk) return 1;
      if (aOk && !bOk) return -1;
      return (b.iskPerLpSell ?? -Infinity) - (a.iskPerLpSell ?? -Infinity);
    });
  }, [compareOffer, compareData, mfgTax, lpPrice, salesTax, ENABLED_CORPS]);

  const presentCategories = useMemo(() => {
    const seen = new Map();
    for (const o of offersForDisplay) {
      if (o.categoryId != null && !seen.has(o.categoryId)) {
        seen.set(o.categoryId, CATEGORY_LABELS[o.categoryId] ?? `Cat ${o.categoryId}`);
      }
    }
    return [...seen.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [offersForDisplay]);

  const filtered = useMemo(() => {
    let result = offersForDisplay;
    const q = search.trim().toLowerCase();
    if (q) result = result.filter((o) => o.name.toLowerCase().includes(q));
    if (categoryFilter != null) result = result.filter((o) => o.categoryId === categoryFilter);
    return result;
  }, [offersForDisplay, search, categoryFilter]);

  const sorted = useMemo(() => {
    const arr = [...filtered];
    arr.sort((a, b) => {
      let av = a[sortKey], bv = b[sortKey];
      // Nulls always sink to the bottom regardless of sort direction.
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      if (typeof av === "string") av = av.toLowerCase();
      if (typeof bv === "string") bv = bv.toLowerCase();
      if (av < bv) return sortDir === "asc" ? -1 : 1;
      if (av > bv) return sortDir === "asc" ? 1 : -1;
      return 0;
    });
    return arr;
  }, [filtered, sortKey, sortDir]);

  function copyItem(offerId, name) {
    navigator.clipboard.writeText(name).catch(() => {});
    showToast("Copied to clipboard");
    setCopied(offerId);
    setTimeout(() => setCopied((prev) => (prev === offerId ? null : prev)), 1500);
  }

  // Copy this offer's input materials as a multibuy-friendly paste
  // (one "<qty> <name>" per line), so members can paste it into Jita
  // multibuy directly. Uses a distinct copied-token so the per-row
  // checkmark animation doesn't collide with copyItem's name-copy.
  function copyMultibuy(offerId, inputs) {
    if (!inputs?.length) return;
    const text = inputs.map((i) => `${i.quantity} ${i.name}`).join("\n");
    navigator.clipboard.writeText(text).catch(() => {});
    showToast("Copied to clipboard");
    const tag = `mb-${offerId}`;
    setCopied(tag);
    setTimeout(() => setCopied((prev) => (prev === tag ? null : prev)), 1500);
  }

  function exportTsv() {
    const headers = ["Item", "Category", "QTY", "LP Cost", "ISK Cost", "Input Cost",
      "On Market", "Sell Val", "Profit (Sell)", "ISK/LP (Sell)", "ISK/LP (Buy)"];
    const rows = sorted.map((o) => [
      o.name,
      CATEGORY_LABELS[o.categoryId] ?? "",
      o.quantity,
      o.lpCost,
      Math.round(o.iskCost),
      Math.round(o.adjMaterialCost),
      o.sellVolume ?? "",
      Math.round(o.revenueSell),
      Math.round(o.profitSell),
      Math.round(o.iskPerLpSell),
      Math.round(o.iskPerLpBuy),
    ]);
    const tsv = [headers, ...rows]
      .map((r) => r.map((v) => String(v ?? "").replace(/\t/g, " ")).join("\t"))
      .join("\n");
    const blob = new Blob([tsv], { type: "text/tab-separated-values" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `lp-${data?.corp?.name?.replace(/\s+/g, "-") ?? "store"}-${new Date().toISOString().slice(0, 10)}.tsv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  return (
    <>
      <div className={styles.controls}>
        {/* Group 1: corp selector + search filter */}
        <div className={styles.selectorGroup}>
          <div className={styles.field}>
            <label className={styles.label}>CORPORATION</label>
            <select
              className={styles.select}
              value={corpId ?? ""}
              onChange={(e) => setCorpId(parseInt(e.target.value, 10))}
              disabled={corpsLoading || CORP_GROUPS.length === 0}
            >
              {corpsLoading && <option value="">Loading…</option>}
              {CORP_GROUPS.map((g) => (
                <optgroup key={g.label} label={g.label}>
                  {g.corps.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name} — {c.faction}{c.disabled ? " (coming soon)" : ""}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </div>
          <div className={styles.field}>
            <label className={styles.label}>FILTER</label>
            <input
              className={styles.search}
              type="text"
              placeholder="search item name..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
        </div>

        {/* Group 2: tax inputs + calculate (always on same line) */}
        <div className={styles.taxGroup}>
          <div className={styles.field}>
            <label className={styles.label}>LP PRICE (ISK/LP)</label>
            {draftInput(draftLpPrice, setDraftLpPrice)}
          </div>
          <div className={styles.field}>
            <label className={styles.label}>SALES TAX %</label>
            {draftInput(draftSalesTax, setDraftSalesTax)}
          </div>
          <div className={styles.field}>
            <label className={styles.label}>MFG TAX %</label>
            {draftInput(draftMfgTax, setDraftMfgTax)}
          </div>
          {industrySystems.length > 0 && (
            <div className={styles.field}>
              <label className={styles.label}>MFG SYSTEM</label>
              <select
                className={styles.indexSelect}
                defaultValue=""
                onChange={(e) => { applyIndustrySystem(e.target.value); e.target.value = ""; }}
                title="Pick a system to prefill MFG TAX % from its current manufacturing index"
              >
                <option value="">prefill from system…</option>
                {industrySystems.map((s) => (
                  <option key={s.systemId} value={s.systemId}>
                    {s.systemName} — {(s.manufacturingIndex * 100).toFixed(2)}%
                  </option>
                ))}
              </select>
            </div>
          )}
          <div className={styles.field}>
            <label className={styles.label}>&nbsp;</label>
            <button className={styles.calcBtn} onClick={handleCalculate}>CALCULATE</button>
          </div>
        </div>
      </div>

      {corpDisabled && (
        <div className={styles.loading}>
          {selectedCorp?.name ?? "This LP store"} — coming soon. We're working on it.
        </div>
      )}

      {!corpDisabled && loading && <div className={styles.loading}>FETCHING LP STORE...</div>}
      {!corpDisabled && error && <div className={styles.error}>⚠ {error}</div>}

      {!corpDisabled && data && !loading && (
        <>
          {/* Top Movers — shown once history loads, highest 7-day avg daily volume */}
          {topMovers.length > 0 && (
            <div className={styles.topPicks}>
              <div className={styles.topPicksLabel}>TOP MOVERS — 7-DAY AVG DAILY VOLUME</div>
              <div className={styles.topPicksScroller}>
                <div className={styles.topPicksTrack}>
                  {[...topMovers, ...topMovers].map((o, i) => (
                    <div
                      key={`${o.offerId}-${i}`}
                      className={styles.topPickCard}
                    >
                      <a
                        href={`https://www.everef.net/type/${o.typeID}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className={styles.topPickName}
                        title={o.name}
                      >
                        {o.name}
                      </a>
                      <div className={styles.topPickStats}>
                        <div className={styles.topPickStat}>
                          <span className={styles.topPickVal}>{fmt(o.vol7d)}</span>
                          <span className={styles.topPickStatLabel}>7D AVG/DAY</span>
                        </div>
                        <div className={styles.topPickStat}>
                          <span className={o.iskPerLpSell < 0 ? styles.topPickValNeg : styles.topPickVolVal}>
                            {fmtIskPerLp(o.iskPerLpSell)}
                          </span>
                          <span className={styles.topPickStatLabel}>ISK/LP</span>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* Type filter chips */}
          {presentCategories.length > 1 && (
            <div className={styles.chipRow}>
              <button
                className={`${styles.chip} ${categoryFilter === null ? styles.chipActive : ""}`}
                onClick={() => setCategoryFilter(null)}
              >
                ALL
              </button>
              {presentCategories.map(([catId, label]) => (
                <button
                  key={catId}
                  className={`${styles.chip} ${categoryFilter === catId ? styles.chipActive : ""}`}
                  onClick={() => setCategoryFilter((prev) => prev === catId ? null : catId)}
                >
                  {label}
                </button>
              ))}
            </div>
          )}

          <div className={styles.tableToolbar}>
            <div className={styles.meta}>
              <div>{filtered.length} / {data.offers.length} offers</div>
              {data.offersUpdatedAt && (
                <div className={styles.cacheAge}>
                  offers {timeAgo(data.offersUpdatedAt)} · prices {timeAgo(data.pricesUpdatedAt)}
                </div>
              )}
            </div>
            <div className={styles.toolbarBtns}>
              <button
                className={`${styles.toggleBtn} ${groupByItem ? styles.toggleBtnActive : ""}`}
                onClick={() => setGroupByItem((g) => !g)}
                title="Show only the best offer per product (highest ISK/LP sell)"
              >
                {groupByItem ? "GROUPED" : "GROUP BY ITEM"}
              </button>
              <button className={styles.toggleBtn} onClick={toggleAdvanced}>
                {advanced ? "SIMPLIFIED" : "ADVANCED"}
              </button>
              <button className={styles.toggleBtn} onClick={exportTsv} title="Download as TSV (Excel/Sheets compatible)">
                EXPORT TSV
              </button>
            </div>
          </div>

          <div className={styles.wrapper}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th className={styles.thName} onClick={() => handleSort("name")}>ITEM{arrow("name")}</th>
                  {advanced && <th className={styles.thNum} onClick={() => handleSort("quantity")}>QTY{arrow("quantity")}</th>}
                  {advanced && <th className={styles.thNum} onClick={() => handleSort("lpCost")}>LP{arrow("lpCost")}</th>}
                  {advanced && <th className={styles.thNum} onClick={() => handleSort("iskCost")}>ISK COST{arrow("iskCost")}</th>}
                  {advanced && <th className={styles.thNum} onClick={() => handleSort("adjMaterialCost")}>INPUTS{arrow("adjMaterialCost")}</th>}
                  {advanced && (
                    <th
                      className={styles.thNum}
                      onClick={() => handleSort("sellVolume")}
                      title="Total quantity currently listed on Jita 4-4 sell orders (market depth, not daily sales)"
                    >
                      ON MARKET{arrow("sellVolume")}
                    </th>
                  )}
                  {advanced && <th className={styles.thNum} onClick={() => handleSort("revenueSell")}>SELL VAL{arrow("revenueSell")}</th>}
                  {advanced && <th className={styles.thNum} onClick={() => handleSort("profitSell")}>PROFIT (SELL){arrow("profitSell")}</th>}
                  <th className={`${styles.thNum} ${styles.thHighlight}`} onClick={() => handleSort("iskPerLpSell")}>
                    ISK/LP (SELL){arrow("iskPerLpSell")}
                  </th>
                  <th className={styles.thNum} onClick={() => handleSort("iskPerLpBuy")}>ISK/LP (BUY){arrow("iskPerLpBuy")}</th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((o) => {
                  const tier = volumeTier(o.sellVolume, sortedVolumes);
                  const volClass = tier ? styles[`vol_${tier}`] : "";
                  const isNegative = o.iskPerLpSell < 0;
                  return (
                    <tr
                      key={o.offerId}
                      className={[
                        o.unknown ? styles.unknown : "",
                        isNegative ? styles.rowNegative : "",
                      ].filter(Boolean).join(" ")}
                    >
                      <td className={styles.tdName}>
                        <div className={styles.nameRow}>
                          <a
                            href={`https://www.everef.net/type/${o.typeID}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className={styles.link}
                          >
                            {o.name}
                          </a>
                          <button
                            className={`${styles.copyBtn} ${copied === o.offerId ? styles.copyBtnDone : ""}`}
                            onClick={() => copyItem(o.offerId, o.name)}
                            title="Copy item name"
                          >
                            {copied === o.offerId ? "✓" : "⎘"}
                          </button>
                          <button
                            className={`${styles.compareBtn} ${compareOffer?.typeID === o.typeID ? styles.compareBtnActive : ""}`}
                            onClick={() => setCompareOffer(compareOffer?.typeID === o.typeID ? null : o)}
                            title="Compare ISK/LP across all corps"
                          >
                            ↔
                          </button>
                          {o.built && (
                            <span
                              className={styles.builtBadge}
                              title="Profit assumes you build the BPC and sell the finished product (ME0/TE0). Inputs include the BPC's LP-store cost plus manufacturing materials."
                            >
                              BUILT
                            </span>
                          )}
                          {groupByItem && (o.offerCount ?? 1) > 1 && (
                            <span className={styles.offerCount}>{o.offerCount} offers</span>
                          )}
                        </div>
                        {o.inputs.length > 0 && (
                          <div className={styles.inputs}>
                            <button
                              className={`${styles.multibuyBtn} ${copied === `mb-${o.offerId}` ? styles.multibuyBtnDone : ""}`}
                              onClick={() => copyMultibuy(o.offerId, o.inputs)}
                              title="Copy materials as multibuy paste"
                            >
                              {copied === `mb-${o.offerId}` ? "COPIED ✓" : "MULTIBUY"}
                            </button>
                            {o.inputs.map((i) => (
                              <span key={i.typeID} className={styles.input}>
                                {i.quantity}× {i.name}
                              </span>
                            ))}
                          </div>
                        )}
                      </td>
                      {advanced && <td className={styles.tdNum}>{o.quantity.toLocaleString()}</td>}
                      {advanced && <td className={styles.tdNum}>{o.lpCost.toLocaleString()}</td>}
                      {advanced && <td className={styles.tdNum}>{fmt(o.iskCost)}</td>}
                      {advanced && <td className={styles.tdNum}>{fmt(o.adjMaterialCost)}</td>}
                      {advanced && (
                        <td className={`${styles.tdNum} ${volClass}`}>
                          {o.sellVolume != null ? fmt(o.sellVolume) : "—"}
                        </td>
                      )}
                      {advanced && <td className={`${styles.tdNum} ${styles.sell}`}>{fmt(o.revenueSell)}</td>}
                      {advanced && (
                        <td className={`${styles.tdNum} ${o.profitSell >= 0 ? styles.sell : styles.danger}`}>
                          {fmt(o.profitSell)}
                        </td>
                      )}
                      <td className={`${styles.tdNum} ${styles.highlight} ${o.iskPerLpSell >= 0 ? styles.sell : styles.danger}`}>
                        {fmtIskPerLp(o.iskPerLpSell)}
                      </td>
                      <td className={`${styles.tdNum} ${o.iskPerLpBuy >= 0 ? styles.buy : styles.danger}`}>
                        {fmtIskPerLp(o.iskPerLpBuy)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* Cross-corp comparison overlay */}
      {compareOffer && (
        <div className={styles.compareOverlay} onClick={() => setCompareOffer(null)}>
          <div className={styles.compareModal} onClick={(e) => e.stopPropagation()}>
            <div className={styles.compareModalHeader}>
              <div>
                <div className={styles.compareModalTitle}>{compareOffer.name}</div>
                <div className={styles.compareModalSub}>CROSS-CORP ISK/LP COMPARISON</div>
              </div>
              <button className={styles.compareClose} onClick={() => setCompareOffer(null)}>✕</button>
            </div>
            <table className={styles.compareTable}>
              <thead>
                <tr>
                  <th className={styles.compareTh}>CORPORATION</th>
                  <th className={styles.compareTh}>FACTION</th>
                  <th className={`${styles.compareTh} ${styles.compareThR}`}>ISK/LP (SELL)</th>
                  <th className={`${styles.compareTh} ${styles.compareThR}`}>ISK/LP (BUY)</th>
                </tr>
              </thead>
              <tbody>
                {compareResults.map((r, i) => {
                  const isCurrent = r.corp?.id === corpId;
                  const isBest = i === 0 && !r.loading && !r.notAvailable && !r.error;
                  return (
                    <tr
                      key={r.corp?.id ?? i}
                      className={[
                        isCurrent ? styles.compareRowCurrent : "",
                        isBest ? styles.compareRowBest : "",
                      ].filter(Boolean).join(" ")}
                    >
                      <td className={styles.compareTd}>
                        <span
                          className={styles.compareCorpLink}
                          onClick={() => { setCompareOffer(null); setCorpId(r.corp.id); }}
                          title="Switch to this corp"
                          role="button"
                        >
                          {r.corp?.name}
                        </span>
                        {isCurrent && <span className={styles.compareCurrentBadge}>CURRENT</span>}
                      </td>
                      <td className={styles.compareTd} style={{ color: "var(--text-dim)" }}>
                        {r.corp?.faction ?? "—"}
                      </td>
                      <td className={`${styles.compareTd} ${styles.compareTdR}`}>
                        {r.loading
                          ? <span className={styles.compareSpinner}>…</span>
                          : r.error
                          ? <span className={styles.compareError} title={r.error}>ERR</span>
                          : r.notAvailable
                          ? <span className={styles.compareNA}>—</span>
                          : <span className={r.iskPerLpSell >= 0 ? styles.sell : styles.danger}>
                              {fmtIskPerLp(r.iskPerLpSell)}
                            </span>
                        }
                      </td>
                      <td className={`${styles.compareTd} ${styles.compareTdR}`}>
                        {!r.loading && !r.error && !r.notAvailable && (
                          <span className={r.iskPerLpBuy >= 0 ? styles.buy : styles.danger}>
                            {fmtIskPerLp(r.iskPerLpBuy)}
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <div className={styles.compareFooter}>
              LP {fmt(lpPrice)} ISK · Sales tax {salesTax}% · MFG tax {mfgTax}%
            </div>
          </div>
        </div>
      )}
    </>
  );
}
