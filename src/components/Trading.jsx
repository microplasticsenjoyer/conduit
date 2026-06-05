import React, { useState, useMemo } from "react";
import styles from "./Trading.module.css";
import PasteInput from "./appraise/PasteInput.jsx";

const STORAGE_PREFIX = "praxis:trading:";
function readStored(key, fallback = "") {
  try { return localStorage.getItem(STORAGE_PREFIX + key) ?? fallback; } catch { return fallback; }
}
function writeStored(key, value) {
  try { localStorage.setItem(STORAGE_PREFIX + key, String(value ?? "")); } catch {}
}
function parseFee(s, fallback) {
  const n = parseFloat(s);
  return Number.isFinite(n) && n >= 0 ? Math.min(n, 100) : fallback;
}

const DEFAULT_SALES_TAX  = 4.5;
const DEFAULT_BROKER_FEE = 2.5;

function fmt(v) {
  if (v == null || !Number.isFinite(v)) return "—";
  const abs = Math.abs(v);
  const sign = v < 0 ? "-" : "";
  if (abs >= 1e9) return sign + (abs / 1e9).toFixed(2) + "B";
  if (abs >= 1e6) return sign + (abs / 1e6).toFixed(2) + "M";
  if (abs >= 1e3) return sign + (abs / 1e3).toFixed(1) + "k";
  return v.toLocaleString("en-US", { maximumFractionDigits: 0 });
}

function fmtPct(v) {
  if (v == null || !Number.isFinite(v)) return "—";
  return (v >= 0 ? "+" : "") + v.toFixed(1) + "%";
}

export default function Trading() {
  // ── Fee inputs (draft = typed, applied on Calculate) ──────────────────
  const [draftSalesTax,  setDraftSalesTax]  = useState(() => readStored("salesTax",  String(DEFAULT_SALES_TAX)));
  const [draftBrokerFee, setDraftBrokerFee] = useState(() => readStored("brokerFee", String(DEFAULT_BROKER_FEE)));
  const [salesTax,  setSalesTax]  = useState(() => parseFee(readStored("salesTax",  String(DEFAULT_SALES_TAX)),  DEFAULT_SALES_TAX));
  const [brokerFee, setBrokerFee] = useState(() => parseFee(readStored("brokerFee", String(DEFAULT_BROKER_FEE)), DEFAULT_BROKER_FEE));

  // ── Data / UI state ────────────────────────────────────────────────────
  const [items,   setItems]   = useState([]);
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState(null);
  const [cargoText, setCargoText] = useState(() => readStored("cargo", ""));
  const [sortKey, setSortKey] = useState("orderRoi");
  const [sortDir, setSortDir] = useState("desc");
  const [hideNegative, setHideNegative] = useState(false);
  const [minRoi, setMinRoi] = useState(() => parseFloat(readStored("minRoi", "0")) || 0);
  const [draftMinRoi, setDraftMinRoi] = useState(() => readStored("minRoi", "0"));

  function handleCalculate() {
    const st = parseFee(draftSalesTax,  DEFAULT_SALES_TAX);
    const bf = parseFee(draftBrokerFee, DEFAULT_BROKER_FEE);
    const mr = Math.max(0, parseFloat(draftMinRoi) || 0);
    setSalesTax(st);
    setBrokerFee(bf);
    setMinRoi(mr);
    writeStored("salesTax",  draftSalesTax);
    writeStored("brokerFee", draftBrokerFee);
    writeStored("minRoi",    String(mr));
  }

  async function handleAppraise(text) {
    setLoading(true);
    setError(null);
    setItems([]);
    writeStored("cargo", text);
    setCargoText(text);
    try {
      const res = await fetch("/api/appraise", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // Always Jita 4-4 — station trading hub
        body: JSON.stringify({ text, stationId: 60003760 }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Request failed");
      setItems(json.items ?? []);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  function handleClear() {
    setItems([]);
    setError(null);
    setCargoText("");
    writeStored("cargo", "");
  }

  // ── Enrichment ─────────────────────────────────────────────────────────
  // Station trading (order model):
  //   Buy side  — place a buy order at bid price; pay broker fee on the order
  //   Sell side — list at ask price; pay broker fee on listing + sales tax on fill
  //
  //   effectiveBuyPerUnit  = buyEach × (1 + brokerFee%)
  //   effectiveSellPerUnit = sellEach × (1 − salesTax% − brokerFee%)
  //   orderMargin          = effectiveSellPerUnit − effectiveBuyPerUnit
  //   orderRoi             = orderMargin / effectiveBuyPerUnit × 100
  //   breakEven            = effectiveBuyPerUnit / (1 − salesTax% − brokerFee%)
  //
  // Instant-sell column for comparison (buy at ask, no buy-order broker fee):
  //   effectiveInstantBuy  = sellEach (you pay the current ask)
  //   instantMargin        = effectiveSellPerUnit − effectiveInstantBuy
  //   instantRoi           = instantMargin / effectiveInstantBuy × 100
  const enriched = useMemo(() => {
    const stFrac = salesTax  / 100;
    const bfFrac = brokerFee / 100;
    const sellMult = 1 - stFrac - bfFrac;

    return items
      .filter((i) => !i.unknown && i.sellEach > 0 && i.buyEach > 0)
      .map((item) => {
        const effectiveBuy     = item.buyEach  * (1 + bfFrac);
        const effectiveSell    = item.sellEach * sellMult;
        const orderMargin      = effectiveSell - effectiveBuy;
        const orderRoi         = effectiveBuy > 0 ? (orderMargin / effectiveBuy) * 100 : null;
        const breakEven        = sellMult > 0 ? effectiveBuy / sellMult : null;
        const spread           = item.sellEach - item.buyEach;
        const spreadPct        = item.buyEach  > 0 ? (spread / item.buyEach) * 100 : null;

        // Instant-buy variant: you hit the sell order instead of placing a buy order
        const instantMargin    = effectiveSell - item.sellEach;
        const instantRoi       = item.sellEach > 0 ? (instantMargin / item.sellEach) * 100 : null;

        return {
          ...item,
          effectiveBuy,
          effectiveSell,
          orderMargin,
          orderRoi,
          breakEven,
          spread,
          spreadPct,
          instantMargin,
          instantRoi,
          orderMarginTotal: orderMargin * item.quantity,
        };
      });
  }, [items, salesTax, brokerFee]);

  const filtered = useMemo(() => {
    let result = enriched;
    if (hideNegative) result = result.filter((i) => i.orderRoi != null && i.orderRoi >= 0);
    if (minRoi > 0)   result = result.filter((i) => i.orderRoi != null && i.orderRoi >= minRoi);
    return result;
  }, [enriched, hideNegative, minRoi]);

  const sorted = useMemo(() => {
    const arr = [...filtered];
    arr.sort((a, b) => {
      let av = a[sortKey], bv = b[sortKey];
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      if (av < bv) return sortDir === "asc" ? -1 : 1;
      if (av > bv) return sortDir === "asc" ? 1 : -1;
      return 0;
    });
    return arr;
  }, [filtered, sortKey, sortDir]);

  // ── Aggregate totals ───────────────────────────────────────────────────
  const totals = useMemo(() => {
    const totalInvestment = sorted.reduce((s, i) => s + i.effectiveBuy * i.quantity, 0);
    const totalRevenue    = sorted.reduce((s, i) => s + i.effectiveSell * i.quantity, 0);
    const totalProfit     = totalRevenue - totalInvestment;
    const overallRoi      = totalInvestment > 0 ? (totalProfit / totalInvestment) * 100 : null;
    return { totalInvestment, totalRevenue, totalProfit, overallRoi };
  }, [sorted]);

  function handleSort(key) {
    setSortDir((d) => sortKey === key ? (d === "desc" ? "asc" : "desc") : "desc");
    setSortKey(key);
  }
  const arrow = (key) => sortKey === key ? (sortDir === "asc" ? " ▲" : " ▼") : "";

  const feeNote = `buy order: ${brokerFee}% broker · sell: ${salesTax}% tax + ${brokerFee}% broker`;

  return (
    <>
      {/* ── Controls ─────────────────────────────────────────────────── */}
      <div className={styles.controls}>
        <div className={styles.feeGroup}>
          <div className={styles.field}>
            <label className={styles.label}>SALES TAX %</label>
            <input
              type="text" inputMode="decimal" className={styles.numInput}
              value={draftSalesTax} placeholder={String(DEFAULT_SALES_TAX)}
              onChange={(e) => setDraftSalesTax(e.target.value)}
              onFocus={(e) => e.target.select()}
              onKeyDown={(e) => { if (e.key === "Enter") handleCalculate(); }}
            />
          </div>
          <div className={styles.field}>
            <label className={styles.label}>BROKER FEE %</label>
            <input
              type="text" inputMode="decimal" className={styles.numInput}
              value={draftBrokerFee} placeholder={String(DEFAULT_BROKER_FEE)}
              onChange={(e) => setDraftBrokerFee(e.target.value)}
              onFocus={(e) => e.target.select()}
              onKeyDown={(e) => { if (e.key === "Enter") handleCalculate(); }}
            />
          </div>
          <div className={styles.field}>
            <label className={styles.label}>MIN ROI %</label>
            <input
              type="text" inputMode="decimal" className={styles.numInput}
              value={draftMinRoi} placeholder="0"
              onChange={(e) => setDraftMinRoi(e.target.value)}
              onFocus={(e) => e.target.select()}
              onKeyDown={(e) => { if (e.key === "Enter") handleCalculate(); }}
              title="Hide items below this ROI threshold after clicking Calculate"
            />
          </div>
          <div className={styles.field}>
            <label className={styles.label}>&nbsp;</label>
            <button className={styles.calcBtn} onClick={handleCalculate}>CALCULATE</button>
          </div>
        </div>
        <div className={styles.noteGroup}>
          <span className={styles.feeNote}>{feeNote}</span>
        </div>
      </div>

      <PasteInput onAppraise={handleAppraise} onClear={handleClear} loading={loading} prefill={cargoText} />

      {error   && <div className={styles.error}>⚠ {error}</div>}
      {loading && <div className={styles.loading}>FETCHING PRICES...</div>}

      {sorted.length > 0 && !loading && (
        <>
          {/* Aggregate summary bar */}
          <div className={styles.summaryBar}>
            <div className={styles.summaryItem}>
              <span className={styles.summaryLabel}>ITEMS</span>
              <span className={styles.summaryValue}>{sorted.length}</span>
            </div>
            <div className={styles.summaryDivider} />
            <div className={styles.summaryItem}>
              <span className={styles.summaryLabel}>TOTAL INVESTMENT</span>
              <span className={styles.summaryValue}>{fmt(totals.totalInvestment)}</span>
              <span className={styles.summarySub}>at bid + broker</span>
            </div>
            <div className={styles.summaryDivider} />
            <div className={styles.summaryItem}>
              <span className={styles.summaryLabel}>TOTAL PROFIT</span>
              <span className={`${styles.summaryValue} ${totals.totalProfit >= 0 ? styles.sell : styles.danger}`}>
                {fmt(totals.totalProfit)}
              </span>
              <span className={styles.summarySub}>after all fees</span>
            </div>
            <div className={styles.summaryDivider} />
            <div className={styles.summaryItem}>
              <span className={styles.summaryLabel}>OVERALL ROI</span>
              <span className={`${styles.summaryValue} ${(totals.overallRoi ?? 0) >= 0 ? styles.sell : styles.danger}`}>
                {fmtPct(totals.overallRoi)}
              </span>
            </div>
          </div>

          {/* Toolbar */}
          <div className={styles.tableToolbar}>
            <span className={styles.meta}>{filtered.length} / {enriched.length} items</span>
            <div className={styles.toolbarBtns}>
              <button
                className={`${styles.toggleBtn} ${hideNegative ? styles.toggleBtnActive : ""}`}
                onClick={() => setHideNegative((h) => !h)}
              >
                {hideNegative ? "PROFITABLE ONLY" : "HIDE NEGATIVE"}
              </button>
            </div>
          </div>

          <div className={styles.wrapper}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th className={styles.thName} onClick={() => handleSort("name")}>ITEM{arrow("name")}</th>
                  <th className={styles.thNum}  onClick={() => handleSort("quantity")}>QTY{arrow("quantity")}</th>
                  <th className={styles.thNum}  onClick={() => handleSort("buyEach")} title="Current best buy-order price (bid)">BID{arrow("buyEach")}</th>
                  <th className={styles.thNum}  onClick={() => handleSort("sellEach")} title="Current lowest sell-order price (ask)">ASK{arrow("sellEach")}</th>
                  <th className={styles.thNum}  onClick={() => handleSort("spread")} title="Ask − bid (gross spread)">SPREAD{arrow("spread")}</th>
                  <th className={styles.thNum}  onClick={() => handleSort("spreadPct")}>SPREAD %{arrow("spreadPct")}</th>
                  <th className={styles.thNum}  onClick={() => handleSort("effectiveBuy")} title="What you effectively pay: bid + broker fee on your buy order">EFF. BUY{arrow("effectiveBuy")}</th>
                  <th className={styles.thNum}  onClick={() => handleSort("effectiveSell")} title="What you effectively receive: ask − sales tax − broker fee on sell order">EFF. SELL{arrow("effectiveSell")}</th>
                  <th className={styles.thNum}  onClick={() => handleSort("orderMargin")} title="Net profit per unit: eff. sell − eff. buy">MARGIN/UNIT{arrow("orderMargin")}</th>
                  <th className={styles.thNum}  onClick={() => handleSort("orderMarginTotal")} title="Net profit × quantity">MARGIN TOTAL{arrow("orderMarginTotal")}</th>
                  <th className={`${styles.thNum} ${styles.thHighlight}`} onClick={() => handleSort("orderRoi")} title="Return on investment: margin / eff. buy">ROI %{arrow("orderRoi")}</th>
                  <th className={styles.thNum}  onClick={() => handleSort("breakEven")} title="Minimum sell price to break even after all fees">BREAK-EVEN{arrow("breakEven")}</th>
                  <th className={styles.thNum}  onClick={() => handleSort("sellVolume")} title="Total units listed on sell orders (market depth)">ON MKT{arrow("sellVolume")}</th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((item, i) => {
                  const good = item.orderRoi != null && item.orderRoi >= 0;
                  const great = item.orderRoi != null && item.orderRoi >= 10;
                  return (
                    <tr
                      key={`${item.typeID ?? item.name}-${i}`}
                      className={great ? styles.rowGreat : !good ? styles.rowBad : ""}
                    >
                      <td className={styles.tdName}>
                        {item.typeID ? (
                          <a href={`https://www.everef.net/type/${item.typeID}`} target="_blank" rel="noopener noreferrer" className={styles.link}>
                            {item.name}
                          </a>
                        ) : item.name}
                      </td>
                      <td className={styles.tdNum}>{item.quantity.toLocaleString()}</td>
                      <td className={`${styles.tdNum} ${styles.buy}`}>{fmt(item.buyEach)}</td>
                      <td className={`${styles.tdNum} ${styles.sell}`}>{fmt(item.sellEach)}</td>
                      <td className={styles.tdNum}>{fmt(item.spread)}</td>
                      <td className={styles.tdNum}>{fmtPct(item.spreadPct)}</td>
                      <td className={`${styles.tdNum} ${styles.buy}`}>{fmt(item.effectiveBuy)}</td>
                      <td className={`${styles.tdNum} ${styles.sell}`}>{fmt(item.effectiveSell)}</td>
                      <td className={`${styles.tdNum} ${good ? styles.sell : styles.danger}`}>
                        {fmt(item.orderMargin)}
                      </td>
                      <td className={`${styles.tdNum} ${good ? styles.sell : styles.danger}`}>
                        {fmt(item.orderMarginTotal)}
                      </td>
                      <td className={`${styles.tdNum} ${styles.highlight} ${good ? styles.sell : styles.danger}`}>
                        {fmtPct(item.orderRoi)}
                      </td>
                      <td className={styles.tdNum}>{fmt(item.breakEven)}</td>
                      <td className={styles.tdNum}>
                        {item.sellVolume != null ? item.sellVolume.toLocaleString() : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}

      {enriched.length > 0 && sorted.length === 0 && !loading && (
        <>
          <div className={styles.tableToolbar}>
            <span className={styles.meta}>0 / {enriched.length} items</span>
            <div className={styles.toolbarBtns}>
              <button
                className={`${styles.toggleBtn} ${hideNegative ? styles.toggleBtnActive : ""}`}
                onClick={() => setHideNegative((h) => !h)}
              >
                {hideNegative ? "PROFITABLE ONLY" : "HIDE NEGATIVE"}
              </button>
            </div>
          </div>
          <div className={styles.empty}>No items match the current filter.</div>
        </>
      )}
    </>
  );
}
