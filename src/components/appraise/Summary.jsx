import React, { useState } from "react";
import styles from "./Summary.module.css";
import { timeAgo } from "../../lib/format.js";
import { STATION_SHORT_NAMES } from "../../lib/stations.js";

function fmt(v) {
  if (v >= 1e12) return (v / 1e12).toFixed(2) + " T";
  if (v >= 1e9)  return (v / 1e9).toFixed(2)  + " B";
  if (v >= 1e6)  return (v / 1e6).toFixed(2)  + " M";
  return v.toLocaleString("en-US", { maximumFractionDigits: 0 }) + " ISK";
}

function fmtVol(m3) {
  if (m3 >= 1e6) return (m3 / 1e6).toFixed(2) + " M m³";
  if (m3 >= 1e3) return (m3 / 1e3).toFixed(2) + " k m³";
  return m3.toLocaleString("en-US", { maximumFractionDigits: 2 }) + " m³";
}

const STORAGE_PREFIX = "praxis:appraise:";
function readStored(key, fallback) {
  try { return localStorage.getItem(STORAGE_PREFIX + key) ?? fallback; }
  catch { return fallback; }
}
function writeStored(key, val) {
  try { localStorage.setItem(STORAGE_PREFIX + key, String(val ?? "")); } catch {}
}
function parseTax(s, fallback) {
  const n = parseFloat(s);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.min(n, 100);
}

// EVE defaults: 4.5% sales tax (Accounting V), 2.5% broker fee (Broker
// Relations V at NPC stations). Members can tune to their own skills.
const DEFAULT_SALES_TAX = 4.5;
const DEFAULT_BROKER_FEE = 2.5;

function parseShares(s) {
  const n = parseInt(s, 10);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(n, 999);
}

export default function Summary({ totalBuy, totalSell, count, totalVolume, pricesUpdatedAt, stationId, onFeesChange }) {
  const [draftSales,  setDraftSales]  = useState(() => readStored("salesTax",  String(DEFAULT_SALES_TAX)));
  const [draftBroker, setDraftBroker] = useState(() => readStored("brokerFee", String(DEFAULT_BROKER_FEE)));
  const [salesTax,    setSalesTax]    = useState(() => parseTax(readStored("salesTax",  String(DEFAULT_SALES_TAX)),  DEFAULT_SALES_TAX));
  const [brokerFee,   setBrokerFee]   = useState(() => parseTax(readStored("brokerFee", String(DEFAULT_BROKER_FEE)), DEFAULT_BROKER_FEE));
  // Loot-split state lives alongside the tax state so corp mates can split
  // a payout immediately after appraising. Persisted so the same N is
  // remembered across paste-tweaks.
  const [draftShares, setDraftShares] = useState(() => readStored("shares", "1"));
  const [shares,      setShares]      = useState(() => parseShares(readStored("shares", "1")));

  function applyTaxes() {
    const s = parseTax(draftSales,  DEFAULT_SALES_TAX);
    const b = parseTax(draftBroker, DEFAULT_BROKER_FEE);
    const n = parseShares(draftShares);
    setSalesTax(s);
    setBrokerFee(b);
    setShares(n);
    writeStored("salesTax",  draftSales);
    writeStored("brokerFee", draftBroker);
    writeStored("shares",    String(n));
    onFeesChange?.({ salesTax: s, brokerFee: b });
  }

  const split = (totalBuy + totalSell) / 2;
  // Sell-via-listing: list at sell-min, pay broker fee on listing + sales tax on sale.
  const netSell = totalSell * (1 - (salesTax + brokerFee) / 100);
  // Sell-to-buy-orders: hit existing buy orders, pay sales tax only.
  const netBuy = totalBuy * (1 - salesTax / 100);
  // Per-share values use the post-fee nets so loot-split numbers reflect
  // what each member actually receives.
  const perShareSell = shares > 0 ? netSell / shares : netSell;
  const perShareBuy  = shares > 0 ? netBuy  / shares : netBuy;

  const ageLabel = timeAgo(pricesUpdatedAt);
  const hubLabel = stationId ? (STATION_SHORT_NAMES[stationId] ?? `station ${stationId}`) : null;

  return (
    <div className={styles.wrap}>
      <div className={styles.controls}>
        <div className={styles.field}>
          <label className={styles.cLabel}>SALES TAX %</label>
          <input
            className={styles.numInput}
            type="text"
            inputMode="decimal"
            value={draftSales}
            placeholder={String(DEFAULT_SALES_TAX)}
            onChange={(e) => setDraftSales(e.target.value)}
            onFocus={(e) => e.target.select()}
            onKeyDown={(e) => { if (e.key === "Enter") applyTaxes(); }}
          />
        </div>
        <div className={styles.field}>
          <label className={styles.cLabel}>BROKER FEE %</label>
          <input
            className={styles.numInput}
            type="text"
            inputMode="decimal"
            value={draftBroker}
            placeholder={String(DEFAULT_BROKER_FEE)}
            onChange={(e) => setDraftBroker(e.target.value)}
            onFocus={(e) => e.target.select()}
            onKeyDown={(e) => { if (e.key === "Enter") applyTaxes(); }}
          />
        </div>
        <div className={styles.field}>
          <label className={styles.cLabel}>SPLIT N WAYS</label>
          <input
            className={styles.numInput}
            type="text"
            inputMode="numeric"
            value={draftShares}
            placeholder="1"
            onChange={(e) => setDraftShares(e.target.value)}
            onFocus={(e) => e.target.select()}
            onKeyDown={(e) => { if (e.key === "Enter") applyTaxes(); }}
          />
        </div>
        <button className={styles.applyBtn} onClick={applyTaxes}>APPLY</button>
        <div className={styles.spacer} />
        <span className={styles.cacheAge}>
          {hubLabel ? `${hubLabel} · ` : ""}
          {ageLabel ? `prices ${ageLabel}` : "live prices"}
        </span>
      </div>

      <div className={styles.summary}>
        <div className={styles.stat}>
          <span className={styles.label}>ITEMS</span>
          <span className={styles.value}>{count}</span>
        </div>
        <div className={styles.divider} />
        <div className={styles.stat}>
          <span className={styles.label}>SELL (min)</span>
          <span className={`${styles.value} ${styles.sell}`}>{fmt(totalSell)}</span>
          <span className={styles.subValue}>net {fmt(netSell)}</span>
          {shares > 1 && (
            <span className={`${styles.subValue} ${styles.share}`}>{fmt(perShareSell)} / share</span>
          )}
        </div>
        <div className={styles.divider} />
        <div className={styles.stat}>
          <span className={styles.label}>SPLIT</span>
          <span className={`${styles.value} ${styles.split}`}>{fmt(split)}</span>
        </div>
        <div className={styles.divider} />
        <div className={styles.stat}>
          <span className={styles.label}>BUY (max)</span>
          <span className={`${styles.value} ${styles.buy}`}>{fmt(totalBuy)}</span>
          <span className={styles.subValue}>net {fmt(netBuy)}</span>
          {shares > 1 && (
            <span className={`${styles.subValue} ${styles.share}`}>{fmt(perShareBuy)} / share</span>
          )}
        </div>
        {totalVolume != null && (
          <>
            <div className={styles.divider} />
            <div className={styles.stat}>
              <span className={styles.label}>VOLUME</span>
              <span className={styles.value}>{fmtVol(totalVolume)}</span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
