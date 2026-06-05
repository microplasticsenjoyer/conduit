import React, { useState } from "react";
import styles from "./MultiStationCompare.module.css";

function fmt(v) {
  if (v == null || !Number.isFinite(v) || v === 0) return "—";
  if (v >= 1e9) return (v / 1e9).toFixed(2) + "B";
  if (v >= 1e6) return (v / 1e6).toFixed(2) + "M";
  if (v >= 1e3) return (v / 1e3).toFixed(1) + "k";
  return v.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

// Side-by-side prices across all supported hubs for an appraisal's items.
// Lazy-loaded — only fetches when the user expands the section, since
// non-Jita hubs require live Fuzzwork calls per station.
export default function MultiStationCompare({ items }) {
  const [open, setOpen] = useState(false);
  const [side, setSide] = useState("sell"); // "sell" or "buy"
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  async function handleToggle() {
    if (!open && !data) {
      setLoading(true);
      setError(null);
      try {
        const typeIds = [...new Set(items.map((i) => i.typeID).filter(Boolean))];
        const res = await fetch("/api/compare", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ typeIds }),
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error || "Compare fetch failed");
        setData(json);
      } catch (err) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    }
    setOpen((v) => !v);
  }

  const stations = data?.stations ?? [];
  const prices = data?.prices ?? {};
  const fieldKey = side === "sell" ? "sell_min" : "buy_max";

  // Best price per row: lowest sell_min OR highest buy_max
  function bestStationFor(typeId) {
    const row = prices[typeId];
    if (!row) return null;
    let bestId = null, bestVal = null;
    for (const s of stations) {
      const v = row[s.id]?.[fieldKey];
      if (!Number.isFinite(v) || v <= 0) continue;
      if (bestVal == null || (side === "sell" ? v < bestVal : v > bestVal)) {
        bestVal = v;
        bestId = s.id;
      }
    }
    return bestId;
  }

  return (
    <div className={styles.section}>
      <div className={styles.header}>
        <button className={styles.toggle} onClick={handleToggle}>
          <span className={styles.caret}>{open ? "▾" : "▸"}</span>
          COMPARE ACROSS HUBS
          <span className={styles.subtle}>
            {open ? "(close)" : `· prices at all ${stations.length || 6} trading hubs`}
          </span>
        </button>
        {open && data && (
          <div className={styles.sideToggle} role="group" aria-label="Price side">
            <button
              className={`${styles.sideBtn} ${side === "sell" ? styles.sideBtnActive : ""}`}
              onClick={() => setSide("sell")}
            >SELL (LIST PRICE)</button>
            <button
              className={`${styles.sideBtn} ${side === "buy" ? styles.sideBtnActive : ""}`}
              onClick={() => setSide("buy")}
            >BUY (INSTANT SELL)</button>
          </div>
        )}
      </div>

      {open && loading && <div className={styles.loading}>FETCHING ALL HUB PRICES...</div>}
      {open && error && <div className={styles.error}>⚠ {error}</div>}

      {open && data && (
        <div className={styles.wrapper}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th className={styles.thName}>ITEM</th>
                {stations.map((s) => (
                  <th key={s.id} className={styles.thNum} title={`${s.name} — ${s.region}`}>
                    {s.short.toUpperCase()}
                  </th>
                ))}
                <th className={styles.thNum}>BEST</th>
              </tr>
            </thead>
            <tbody>
              {items.filter((i) => i.typeID).map((item, i) => {
                const bestId = bestStationFor(item.typeID);
                const bestStation = stations.find((s) => s.id === bestId);
                return (
                  <tr key={`${item.typeID}-${i}`}>
                    <td className={styles.tdName}>{item.name}</td>
                    {stations.map((s) => {
                      const v = prices[item.typeID]?.[s.id]?.[fieldKey];
                      const isBest = s.id === bestId && Number.isFinite(v) && v > 0;
                      return (
                        <td key={s.id} className={`${styles.tdNum} ${isBest ? styles.best : ""}`}>
                          {fmt(v)}
                        </td>
                      );
                    })}
                    <td className={`${styles.tdNum} ${styles.bestCol}`}>
                      {bestStation ? bestStation.short : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
