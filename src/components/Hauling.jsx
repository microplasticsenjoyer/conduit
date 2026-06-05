import React, { useState, useMemo, useEffect, useRef } from "react";
import styles from "./Hauling.module.css";
import PasteInput from "./appraise/PasteInput.jsx";
import { HAULING_SHIPS } from "../lib/haulingShips.js";
import { showToast } from "../lib/toast.js";

const STORAGE_PREFIX = "praxis:hauling:";
const FALLBACK_STATIONS = [
  { id: 60003760, name: "Jita 4-4",      region: "The Forge",      short: "Jita" },
  { id: 60008494, name: "Amarr VIII",    region: "Domain",         short: "Amarr" },
  { id: 60011866, name: "Dodixie IX-19", region: "Sinq Laison",    short: "Dodixie" },
  { id: 60005686, name: "Hek VIII-12",   region: "Metropolis",     short: "Hek" },
  { id: 60004588, name: "Rens VI-8",     region: "Heimatar",       short: "Rens" },
  { id: 60011884, name: "Huola IV",      region: "The Bleak Lands", short: "Huola" },
];

let stationsPromise = null;
function fetchStations() {
  if (!stationsPromise) {
    stationsPromise = fetch("/api/stations")
      .then((r) => r.ok ? r.json() : Promise.reject(new Error("stations fetch failed")))
      .then((j) => j.stations ?? FALLBACK_STATIONS)
      .catch(() => FALLBACK_STATIONS);
  }
  return stationsPromise;
}

function readStored(key, fallback = "") {
  try { return localStorage.getItem(STORAGE_PREFIX + key) ?? fallback; } catch { return fallback; }
}
function writeStored(key, value) {
  try { localStorage.setItem(STORAGE_PREFIX + key, String(value ?? "")); } catch {}
}
function parseStored(key, fallback = 0) {
  const v = parseFloat(readStored(key, String(fallback)));
  return Number.isFinite(v) && v >= 0 ? v : fallback;
}

function fmt(v) {
  if (!Number.isFinite(v)) return "—";
  if (v === 0) return "—";
  const abs = Math.abs(v);
  const sign = v < 0 ? "-" : "";
  if (abs >= 1e9) return sign + (abs / 1e9).toFixed(2) + "B";
  if (abs >= 1e6) return sign + (abs / 1e6).toFixed(2) + "M";
  if (abs >= 1e3) return sign + (abs / 1e3).toFixed(1) + "k";
  return v.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

function fmtVol(m3) {
  if (m3 == null || !Number.isFinite(m3)) return "—";
  if (m3 >= 1e6) return (m3 / 1e6).toFixed(2) + "M m³";
  if (m3 >= 1e3) return (m3 / 1e3).toFixed(1) + "k m³";
  if (m3 < 1) return m3.toFixed(4).replace(/\.?0+$/, "") + " m³";
  return m3.toLocaleString("en-US", { maximumFractionDigits: 2 }) + " m³";
}

const SHIP_GROUPS = (() => {
  const map = new Map();
  for (const ship of HAULING_SHIPS) {
    if (!map.has(ship.group)) map.set(ship.group, []);
    map.get(ship.group).push(ship);
  }
  return [...map.entries()];
})();

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

function parseStation(raw, fallback) {
  const v = parseInt(raw ?? "", 10);
  return Number.isFinite(v) ? v : fallback;
}

export default function Hauling({ auth }) {
  // ── Stations list ──────────────────────────────────────────────────────
  const [stations, setStations] = useState(FALLBACK_STATIONS);
  useEffect(() => {
    let cancelled = false;
    fetchStations().then((s) => { if (!cancelled) setStations(s); });
    return () => { cancelled = true; };
  }, []);

  // ── Route + ship state (URL > localStorage > default) ──────────────────
  const [sourceStationId, setSourceStationId] = useState(() =>
    parseStation(readUrlParam("from"), parseStation(readStored("from"), 60003760))
  );
  const [destStationId, setDestStationId] = useState(() =>
    parseStation(readUrlParam("to"),   parseStation(readStored("to"),   60003760))
  );

  const [shipId, setShipId]         = useState(() => readUrlParam("ship") ?? readStored("shipId", "bustard"));
  const [cargoOverride, setCargoOverride] = useState(() => readStored("cargo", ""));

  // ── Mode + cost inputs ─────────────────────────────────────────────────
  const [mode, setMode] = useState(() => {
    const m = readUrlParam("mode") ?? readStored("mode", "self");
    return m === "courier" ? "courier" : "self";
  });
  const [salesTax, setSalesTax]   = useState(() =>
    parseFloat(readUrlParam("tax") ?? "") || parseStored("salesTax", 3.6)
  );
  const [collateralISK, setCollateralISK] = useState(() =>
    parseFloat(readUrlParam("coll") ?? "") || parseStored("collateralISK", 0)
  );
  const [reward, setReward] = useState(() =>
    parseFloat(readUrlParam("rwd") ?? "") || parseStored("reward", 0)
  );

  // ── Budget + volume cap ────────────────────────────────────────────────
  const [budget, setBudget] = useState(() =>
    parseFloat(readUrlParam("bud") ?? "") || parseStored("budget", 0)
  );
  const [capByDepth, setCapByDepth] = useState(() => readStored("capByDepth", "1") !== "0");

  // ── Fuel cost (Jump Freighters only) ──────────────────────────────────
  const [fuelCost, setFuelCost] = useState(() => parseStored("fuelCost", 0));

  // ── Cargo paste ────────────────────────────────────────────────────────
  const [cargoText, setCargoText] = useState(() => readStored("cargo_text", ""));

  // ── Result data ────────────────────────────────────────────────────────
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState(null);
  const [slug, setSlug]       = useState(null);
  const [savingSlug, setSavingSlug] = useState(false);
  const [copiedShare, setCopiedShare] = useState(false);

  // ── Sort state for the per-item table ──────────────────────────────────
  const [sortKey, setSortKey]   = useState("netProfitPerM3");
  const [sortDir, setSortDir]   = useState("desc");

  // ── Saved plans (per-character, requires SSO) ──────────────────────────
  const [plans, setPlans] = useState([]);
  const [activePlanId, setActivePlanId] = useState(null);
  const [planSaving, setPlanSaving] = useState(false);
  const [planError, setPlanError] = useState(null);

  async function withAuth(fetcher) {
    const token = await auth?.getAccessToken?.();
    if (!token) throw new Error("Not signed in");
    return fetcher(token);
  }

  useEffect(() => {
    if (!auth?.eveAuth || !auth?.isCorpMember) return;
    let cancelled = false;
    (async () => {
      try {
        const list = await withAuth((token) =>
          fetch("/api/hauling/plans", { headers: { Authorization: `Bearer ${token}` } })
            .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`plans ${r.status}`))))
        );
        if (!cancelled) setPlans(list.plans ?? []);
      } catch {/* surface lazily on save */}
    })();
    return () => { cancelled = true; };
  }, [auth?.eveAuth?.characterId, auth?.isCorpMember]); // eslint-disable-line react-hooks/exhaustive-deps

  function applyPlan(plan) {
    if (!plan) return;
    setActivePlanId(plan.id);
    handleSourceChange(plan.source_station_id);
    handleDestChange(plan.dest_station_id);
    if (plan.ship_id) handleShipChange(plan.ship_id);
    handleModeChange(plan.mode === "courier" ? "courier" : "self");
    const salesT = Number(plan.sales_tax) || 0;
    const coll   = Number(plan.collateral_isk) || 0;
    const rwd    = Number(plan.reward) || 0;
    const bud    = Number(plan.budget) || 0;
    setSalesTax(salesT);       writeStored("salesTax", String(salesT));
    setCollateralISK(coll);    writeStored("collateralISK", String(coll));
    setReward(rwd);            writeStored("reward", String(rwd));
    setBudget(bud);            writeStored("budget", String(bud));
    if (plan.cargo_text) {
      setCargoText(plan.cargo_text);
      writeStored("cargo_text", plan.cargo_text);
      runRoute(plan.cargo_text);
    }
  }

  async function handleSavePlan() {
    const name = window.prompt("Name this plan:", plans.find((p) => p.id === activePlanId)?.name ?? "");
    if (!name?.trim()) return;
    setPlanSaving(true);
    setPlanError(null);
    try {
      const payload = {
        name: name.trim(),
        sourceStationId, destStationId, shipId, mode,
        salesTax, collateralISK, reward, budget,
        cargoText,
      };
      const existing = activePlanId ? plans.find((p) => p.id === activePlanId) : null;
      const isUpdate = existing && existing.name === name.trim();
      const result = await withAuth((token) =>
        fetch("/api/hauling/plans", {
          method: isUpdate ? "PUT" : "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify(isUpdate ? { ...payload, id: existing.id } : payload),
        }).then((r) => r.json().then((j) => (r.ok ? j : Promise.reject(new Error(j.error || `plan ${r.status}`)))))
      );
      const saved = result.plan;
      setPlans((prev) => {
        const filtered = prev.filter((p) => p.id !== saved.id);
        return [saved, ...filtered];
      });
      setActivePlanId(saved.id);
    } catch (err) {
      setPlanError(err.message);
    } finally {
      setPlanSaving(false);
    }
  }

  async function handleDeletePlan() {
    if (!activePlanId) return;
    if (!window.confirm("Delete this saved plan?")) return;
    try {
      await withAuth((token) =>
        fetch(`/api/hauling/plans?id=${activePlanId}`, {
          method: "DELETE",
          headers: { Authorization: `Bearer ${token}` },
        })
      );
      setPlans((prev) => prev.filter((p) => p.id !== activePlanId));
      setActivePlanId(null);
    } catch (err) {
      setPlanError(err.message);
    }
  }

  // ── Persist URL state whenever any planning input changes ──────────────
  useEffect(() => {
    writeUrlParams({
      tab: "hauling",
      a: slug,
      from: sourceStationId,
      to: destStationId,
      ship: shipId,
      mode: mode === "self" ? null : mode,
      tax: mode === "self" ? (salesTax || null) : null,
      coll: mode === "courier" && collateralISK ? collateralISK : null,
      rwd:  mode === "courier" && reward         ? reward         : null,
      bud:  budget || null,
    });
  }, [slug, sourceStationId, destStationId, shipId, mode, salesTax, collateralISK, reward, budget]);

  // ── If a slug is in the URL on mount, hydrate cargo from /api/appraisal ─
  // Bare `?a=<slug>` opens the Appraise tab (App.jsx); `?a=<slug>&tab=hauling`
  // means the user copied a hauling-share link.
  const initRanRef = useRef(false);
  useEffect(() => {
    if (initRanRef.current) return;
    initRanRef.current = true;
    const urlSlug = readUrlParam("a");
    if (urlSlug && readUrlParam("tab") === "hauling") {
      setSlug(urlSlug);
      setLoading(true);
      fetch(`/api/appraisal/${urlSlug}`)
        .then((r) => r.ok ? r.json() : Promise.reject(new Error("Appraisal not found")))
        .then((j) => {
          if (j.rawInput) {
            setCargoText(j.rawInput);
            return runRoute(j.rawInput);
          }
        })
        .catch((err) => setError(err.message))
        .finally(() => setLoading(false));
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Run the route fetch (does NOT persist) ─────────────────────────────
  async function runRoute(text) {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/hauling/route", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, sourceStationId, destStationId }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Request failed");
      setData(json);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  function handleAppraise(text) {
    writeStored("cargo_text", text);
    setCargoText(text);
    setSlug(null); // editing the cargo invalidates the saved slug
    runRoute(text);
  }

  function handleClear() {
    setData(null);
    setError(null);
    setCargoText("");
    setSlug(null);
    writeStored("cargo_text", "");
  }

  // Re-run the route when the source/dest changes and we already have cargo.
  useEffect(() => {
    if (!data || !cargoText) return;
    runRoute(cargoText);
  }, [sourceStationId, destStationId]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Save trip → /api/appraise, returns a slug; URL becomes shareable ──
  async function handleSaveTrip() {
    if (!cargoText) return;
    setSavingSlug(true);
    try {
      const res = await fetch("/api/appraise", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: cargoText, stationId: sourceStationId }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Save failed");
      setSlug(json.slug);
      // Copy the share URL automatically — the whole point of saving is sharing.
      const shareUrl = `${window.location.origin}${window.location.pathname}?${new URLSearchParams({
        tab: "hauling", a: json.slug,
        from: String(sourceStationId), to: String(destStationId),
        ship: shipId,
        ...(mode === "courier"
          ? { mode: "courier", ...(collateralISK ? { coll: String(collateralISK) } : {}), rwd: String(reward) }
          : { tax: String(salesTax) }),
        ...(budget ? { bud: String(budget) } : {}),
      }).toString()}`;
      try { await navigator.clipboard.writeText(shareUrl); showToast("Copied link to clipboard"); setCopiedShare(true); setTimeout(() => setCopiedShare(false), 2000); } catch {}
    } catch (err) {
      setError(err.message);
    } finally {
      setSavingSlug(false);
    }
  }

  // ── Persistors for typed inputs ────────────────────────────────────────
  function handleShipChange(id) {
    setShipId(id);
    setCargoOverride("");
    writeStored("shipId", id);
    writeStored("cargo", "");
  }
  function handleCargoOverride(val) { setCargoOverride(val); writeStored("cargo", val); }
  function handleNumChange(setter, storageKey) {
    return (val) => {
      const n = Math.max(0, parseFloat(val) || 0);
      setter(n);
      writeStored(storageKey, String(n));
    };
  }
  function handleSourceChange(id)   { setSourceStationId(id); writeStored("from", String(id)); }
  function handleDestChange(id)     { setDestStationId(id);   writeStored("to",   String(id)); }
  function handleModeChange(m)      { setMode(m); writeStored("mode", m); }
  function handleCapByDepth(v)      { setCapByDepth(v); writeStored("capByDepth", v ? "1" : "0"); }

  // ── Derived values ─────────────────────────────────────────────────────
  const currentShip = HAULING_SHIPS.find((s) => s.id === shipId) ?? HAULING_SHIPS[0];

  const effectiveCargo = useMemo(() => {
    const override = parseFloat(cargoOverride);
    return Number.isFinite(override) && override > 0 ? override : (currentShip?.cargo ?? 62500);
  }, [cargoOverride, currentShip]);

  const sourceStation = stations.find((s) => s.id === sourceStationId);
  const destStation   = stations.find((s) => s.id === destStationId);
  const sameStation   = sourceStationId === destStationId;

  // ── Step 1: per-item enrichment ────────────────────────────────────────
  // Uses sourceSell as buy-in cost, destSell as sale price, applies sales tax,
  // and caps qty by destSellVolume when capByDepth is on. Net profit per m³ is
  // the planner's primary sort key.
  const enrichedItems = useMemo(() => {
    if (!data?.items) return [];
    return data.items.map((item) => {
      const vol = item.volumeEach;
      if (item.unknown || vol == null || vol <= 0) {
        return {
          ...item,
          effQty: 0,
          volumeTotal: null,
          sourceCostPerUnit: null,
          destRevBase: null,
          destRevPerUnit: null,
          haulCostPerUnit: null,
          netProfitPerUnit: null,
          netProfitPerM3: null,
          netProfitTotal: null,
          isProfitable: false,
          depthLimited: false,
          sourceCostTotal: 0,
        };
      }

      // Cap each stack at destination market depth (when enabled). We cap at
      // 50% of listed sell volume — full depth is fiction once you start
      // pushing orders and other sellers undercut you.
      const depthCap = item.destSellVolume != null ? Math.floor(item.destSellVolume * 0.5) : null;
      const effQty = capByDepth && depthCap != null
        ? Math.max(0, Math.min(item.quantity, depthCap))
        : item.quantity;
      const depthLimited = capByDepth && depthCap != null && depthCap < item.quantity;

      const sourceCostPerUnit = item.sourceSell;
      const destRevBase       = item.destSell;

      const volumeTotal       = vol * effQty;
      const sourceCostTotal   = sourceCostPerUnit * effQty;

      return {
        ...item,
        effQty,
        volumeTotal,
        sourceCostPerUnit,
        destRevBase,
        sourceCostTotal,
        depthLimited,
        // Placeholders refined in step 2:
        destRevPerUnit: null,
        haulCostPerUnit: null,
        netProfitPerUnit: null,
        netProfitPerM3: null,
        netProfitTotal: null,
        isProfitable: false,
      };
    });
  }, [data, capByDepth]);

  // ── Step 2: apply sales tax and haul cost per item ─────────────────────
  // Self-haul: no haul cost; sales tax applied to dest revenue.
  // Courier: reward spread over cargo m³ is the only cost; no sales tax
  // (the cargo belongs to someone else, so you don't pocket the sale proceeds).
  const items = useMemo(() => {
    return enrichedItems.map((it) => {
      if (it.volumeTotal == null) return it;

      const destRevPerUnit = mode === "self"
        ? it.destRevBase * (1 - salesTax / 100)
        : it.destRevBase;

      let haulCostPerUnit;
      if (mode === "self") {
        haulCostPerUnit = 0;
      } else {
        const rewardPerM3 = effectiveCargo > 0 ? reward / effectiveCargo : 0;
        haulCostPerUnit   = it.volumeEach * rewardPerM3;
      }

      const fuelCostPerM3 = effectiveCargo > 0 ? fuelCost / effectiveCargo : 0;
      haulCostPerUnit += fuelCostPerM3 * it.volumeEach;

      const netProfitPerUnit = destRevPerUnit - it.sourceCostPerUnit - haulCostPerUnit;
      const netProfitPerM3   = netProfitPerUnit / it.volumeEach;
      const netProfitTotal   = netProfitPerUnit * it.effQty;

      return {
        ...it,
        destRevPerUnit,
        haulCostPerUnit,
        netProfitPerUnit,
        netProfitPerM3,
        netProfitTotal,
        isProfitable: netProfitPerUnit > 0,
      };
    });
  }, [enrichedItems, mode, salesTax, reward, effectiveCargo, fuelCost]);

  // ── Step 3: multi-trip cargo plan (greedy ISK/m³ fill, iterated) ──────
  // Each pass fills one shipload; leftover items feed the next trip.
  // Budget (if set) is shared across all trips. Caps at 20 trips.
  const multiTripPlan = useMemo(() => {
    const MAX_TRIPS = 20;
    if (!items.length || effectiveCargo <= 0) return [];

    let pool = items
      .filter((i) => i.isProfitable && i.volumeTotal != null && i.volumeEach > 0 && i.effQty > 0)
      .map((i) => ({ ...i, remainQty: i.effQty }))
      .sort((a, b) => b.netProfitPerM3 - a.netProfitPerM3);

    let budgetLeft = budget > 0 ? budget : Infinity;
    const trips = [];

    while (pool.length > 0 && trips.length < MAX_TRIPS) {
      let cargoLeft = effectiveCargo;
      let budgetThisTrip = budgetLeft;

      const tripInCargo = new Set();
      let tripPartialItem = null, tripPartialQty = 0, tripPartialFraction = 0;
      let tripCargoUsed = 0, tripProfit = 0, tripCost = 0, tripRevenue = 0, tripHaulCost = 0;

      for (const item of pool) {
        const maxByCargo  = item.volumeEach > 0       ? Math.floor(cargoLeft     / item.volumeEach)       : 0;
        const maxByBudget = item.sourceCostPerUnit > 0 ? Math.floor(budgetThisTrip / item.sourceCostPerUnit) : item.remainQty;
        const fits = Math.max(0, Math.min(item.remainQty, maxByCargo, maxByBudget));
        if (fits <= 0) continue;

        const isFull = fits >= item.remainQty;
        const qty    = isFull ? item.remainQty : fits;

        if (isFull) {
          tripInCargo.add(item.typeID);
        } else if (tripPartialItem == null) {
          tripPartialItem     = item.typeID;
          tripPartialQty      = qty;
          tripPartialFraction = qty / item.remainQty;
        } else {
          // A second partial would cause overlapping — skip to keep the plan
          // clean. The remaining units will appear in the next trip.
          continue;
        }

        cargoLeft      -= item.volumeEach * qty;
        budgetThisTrip -= item.sourceCostPerUnit * qty;
        tripCargoUsed  += item.volumeEach * qty;
        tripProfit     += item.netProfitPerUnit * qty;
        tripCost       += item.sourceCostPerUnit * qty;
        tripRevenue    += item.destRevPerUnit * qty;
        tripHaulCost   += item.haulCostPerUnit * qty;
      }

      if (tripCargoUsed === 0) break;

      // Reduce remaining quantities; drop fully-consumed items from the pool.
      pool = pool.map((item) => {
        if (tripInCargo.has(item.typeID))    return { ...item, remainQty: 0 };
        if (tripPartialItem === item.typeID) return { ...item, remainQty: item.remainQty - tripPartialQty };
        return item;
      }).filter((item) => item.remainQty > 0);

      if (budget > 0) budgetLeft -= tripCost;

      trips.push({
        num: trips.length + 1,
        inCargo: tripInCargo,
        partialItem: tripPartialItem,
        partialQty: tripPartialQty,
        partialFraction: tripPartialFraction,
        cargoUsed: tripCargoUsed,
        totalProfit: tripProfit,
        totalSourceCost: tripCost,
        totalRevenue: tripRevenue,
        totalHaulCost: tripHaulCost,
      });
    }

    return trips;
  }, [items, effectiveCargo, budget]);

  // ── Sorted view ────────────────────────────────────────────────────────
  const sortedItems = useMemo(() => {
    const arr = [...items];
    arr.sort((a, b) => {
      let av = a[sortKey], bv = b[sortKey];
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
  }, [items, sortKey, sortDir]);

  // Aggregate totals across all trips + per-item trip assignment lookup.
  const planTotals = useMemo(() => {
    let totalProfit = 0, totalCost = 0, totalHaulCost = 0;
    for (const t of multiTripPlan) {
      totalProfit   += t.totalProfit;
      totalCost     += t.totalSourceCost;
      totalHaulCost += t.totalHaulCost;
    }
    return { totalProfit, totalCost, totalHaulCost };
  }, [multiTripPlan]);

  // typeID → { tripNum, partial, fraction } for table rendering.
  const itemTripMap = useMemo(() => {
    const map = new Map();
    for (const t of multiTripPlan) {
      for (const id of t.inCargo) map.set(id, { tripNum: t.num, partial: false, fraction: 1 });
      if (t.partialItem != null)
        map.set(t.partialItem, { tripNum: t.num, partial: true, fraction: t.partialFraction });
    }
    return map;
  }, [multiTripPlan]);

  const summary = useMemo(() => {
    const totalVolume = items.reduce((s, i) => s + (i.volumeTotal ?? 0), 0);
    const profitableCount = items.filter((i) => i.isProfitable).length;
    const unknownCount = (data?.items?.length ?? 0) - items.filter((i) => !i.unknown).length;
    const firstTrip = multiTripPlan[0];
    const cargoFillPct = firstTrip && effectiveCargo > 0
      ? (firstTrip.cargoUsed / effectiveCargo) * 100 : 0;
    return { totalItems: items.length, unknownCount, totalVolume, profitableCount, cargoFillPct };
  }, [items, multiTripPlan, effectiveCargo, data]);

  // Items not assigned to any trip (unprofitable or pool exhausted by budget).
  const droppedNoMargin = useMemo(
    () => items.filter((i) => !i.isProfitable && i.netProfitPerM3 != null),
    [items]
  );

  function handleSort(key) {
    setSortDir((d) => sortKey === key ? (d === "desc" ? "asc" : "desc") : "desc");
    setSortKey(key);
  }
  function arr(key) {
    if (sortKey !== key) return null;
    return <span style={{ marginLeft: 4 }}>{sortDir === "desc" ? "▼" : "▲"}</span>;
  }

  const sourceShort = sourceStation?.short ?? "src";
  const destShort   = destStation?.short   ?? "dst";

  const isAuthed = !!auth?.eveAuth && !!auth?.isCorpMember;

  return (
    <>
      {isAuthed && (
        <div className={styles.plansBar}>
          <span className={styles.plansLabel}>SAVED PLANS</span>
          <select
            className={styles.plansSelect}
            value={activePlanId ?? ""}
            onChange={(e) => {
              const id = e.target.value || null;
              setActivePlanId(id);
              if (id) applyPlan(plans.find((p) => p.id === id));
            }}
          >
            <option value="">— pick a plan —</option>
            {plans.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
          <button
            className={styles.plansBtn}
            onClick={handleSavePlan}
            disabled={planSaving}
            title="Save current settings + cargo as a named plan"
          >
            {planSaving ? "SAVING…" : activePlanId ? "UPDATE / SAVE AS…" : "SAVE PLAN"}
          </button>
          {activePlanId && (
            <button
              className={`${styles.plansBtn} ${styles.plansBtnDanger}`}
              onClick={handleDeletePlan}
              title="Delete this saved plan"
            >DELETE</button>
          )}
          {planError && <span className={styles.plansErr}>{planError}</span>}
        </div>
      )}

      {/* ── Controls ─────────────────────────────────────────────────── */}
      <div className={styles.controls}>
        {/* Route */}
        <div className={styles.shipGroup}>
          <div className={styles.field}>
            <label className={styles.label}>FROM (BUY)</label>
            <select className={styles.select} value={sourceStationId} onChange={(e) => handleSourceChange(parseInt(e.target.value, 10))}>
              {stations.map((s) => <option key={s.id} value={s.id}>{s.name} — {s.region}</option>)}
            </select>
          </div>
          <div className={styles.field}>
            <label className={styles.label}>TO (SELL)</label>
            <select className={styles.select} value={destStationId} onChange={(e) => handleDestChange(parseInt(e.target.value, 10))}>
              {stations.map((s) => <option key={s.id} value={s.id}>{s.name} — {s.region}</option>)}
            </select>
          </div>
        </div>
        {/* Ship */}
        <div className={styles.shipGroup}>
          <div className={styles.field}>
            <label className={styles.label}>SHIP</label>
            <select className={styles.select} value={shipId} onChange={(e) => handleShipChange(e.target.value)}>
              {SHIP_GROUPS.map(([group, ships]) => (
                <optgroup key={group} label={group}>
                  {ships.map((s) => <option key={s.id} value={s.id}>{s.name} — {fmtVol(s.cargo)}</option>)}
                </optgroup>
              ))}
            </select>
          </div>
          <div className={styles.field}>
            <label className={styles.label}>CARGO (m³)</label>
            <input
              type="text"
              inputMode="decimal"
              className={styles.numInput}
              placeholder={String(currentShip?.cargo ?? "")}
              value={cargoOverride}
              onChange={(e) => handleCargoOverride(e.target.value)}
              onFocus={(e) => e.target.select()}
              style={{ width: 120 }}
            />
          </div>
        </div>
      </div>

      {/* Mode switch + cost inputs */}
      <div className={styles.controls}>
        <div className={styles.modeToggle} role="group" aria-label="Hauling cost model">
          <button
            className={`${styles.modeBtn} ${mode === "self" ? styles.modeBtnActive : ""}`}
            onClick={() => handleModeChange("self")}
          >SELF-HAUL</button>
          <button
            className={`${styles.modeBtn} ${mode === "courier" ? styles.modeBtnActive : ""}`}
            onClick={() => handleModeChange("courier")}
          >COURIER CONTRACT</button>
        </div>
        {mode === "self" ? (
          <div className={styles.costGroup}>
            <div className={styles.field}>
              <label className={styles.label}>SALES TAX %</label>
              <input type="text" inputMode="decimal" className={styles.numInput}
                value={salesTax || ""} placeholder="0"
                onChange={(e) => handleNumChange(setSalesTax, "salesTax")(e.target.value)}
                onFocus={(e) => e.target.select()} />
            </div>
          </div>
        ) : (
          <div className={styles.costGroup}>
            <div className={styles.field}>
              <label className={styles.label}>COLLATERAL (ISK)</label>
              <input type="text" inputMode="decimal" className={styles.numInput}
                value={collateralISK || ""} placeholder="0"
                onChange={(e) => handleNumChange(setCollateralISK, "collateralISK")(e.target.value)}
                onFocus={(e) => e.target.select()} style={{ width: 130 }}
                title="Flat ISK collateral to set on the contract — for reference only, does not affect profit calculation." />
            </div>
            <div className={styles.field}>
              <label className={styles.label}>REWARD (ISK)</label>
              <input type="text" inputMode="decimal" className={styles.numInput}
                value={reward || ""} placeholder="0"
                onChange={(e) => handleNumChange(setReward, "reward")(e.target.value)}
                onFocus={(e) => e.target.select()} style={{ width: 130 }} />
            </div>
          </div>
        )}
        <div className={styles.costGroup}>
          <div className={styles.field}>
            <label className={styles.label}>BUDGET (ISK)</label>
            <input type="text" inputMode="decimal" className={styles.numInput}
              value={budget || ""} placeholder="no cap"
              onChange={(e) => handleNumChange(setBudget, "budget")(e.target.value)}
              onFocus={(e) => e.target.select()} style={{ width: 130 }}
              title="Optional cap on total source-buy ISK. Leaves money for you to keep, in case you don't want to spend everything." />
          </div>
          <div className={styles.field}>
            <label className={styles.label}>&nbsp;</label>
            <button
              className={`${styles.toggleBtn} ${capByDepth ? styles.toggleBtnActive : ""}`}
              onClick={() => handleCapByDepth(!capByDepth)}
              title="Cap each stack at half of destination sell-side depth so the planner doesn't recommend dumps that the market can't absorb."
            >
              {capByDepth ? "DEPTH-AWARE ✓" : "DEPTH-AWARE"}
            </button>
          </div>
        </div>
        {currentShip?.fuel != null && (
          <div className={styles.costGroup}>
            <div className={styles.field}>
              <label className={styles.label}>JUMP FUEL COST (ISK)</label>
              <input
                type="text"
                inputMode="decimal"
                className={styles.numInput}
                value={fuelCost === 0 ? "" : fuelCost}
                placeholder="0"
                onChange={(e) => {
                  const v = Math.max(0, parseFloat(e.target.value) || 0);
                  setFuelCost(v);
                  writeStored("fuelCost", v);
                }}
                onFocus={(e) => e.target.select()}
                style={{ width: 130 }}
              />
              <span className={styles.labelHint}>total cost for this trip ({currentShip.fuel})</span>
            </div>
          </div>
        )}
      </div>

      {/* Ship info card — shows EHP / align / warp / fuel right under controls */}
      {currentShip && (
        <div className={styles.shipInfo}>
          <span className={styles.shipInfoName}>{currentShip.name}</span>
          <span className={styles.shipInfoStat}><span className={styles.shipInfoLabel}>EHP</span>{currentShip.ehp.toLocaleString()}</span>
          <span className={styles.shipInfoStat}><span className={styles.shipInfoLabel}>ALIGN</span>{currentShip.align.toFixed(1)} s</span>
          <span className={styles.shipInfoStat}><span className={styles.shipInfoLabel}>WARP</span>{currentShip.warp.toFixed(2)} AU/s</span>
          <span className={styles.shipInfoStat}><span className={styles.shipInfoLabel}>HOLD</span>{fmtVol(currentShip.cargo)}</span>
          {currentShip.fuel && (
            <span className={styles.shipInfoStat}><span className={styles.shipInfoLabel}>JUMP FUEL</span>{currentShip.fuel}</span>
          )}
        </div>
      )}

      {/* ── Paste input ──────────────────────────────────────────────── */}
      <PasteInput onAppraise={handleAppraise} onClear={handleClear} loading={loading} prefill={cargoText} />

      {error && <div className={styles.error}>⚠ {error}</div>}
      {loading && <div className={styles.loading}>FETCHING ROUTE PRICES...</div>}

      {!data && !loading && !error && !cargoText && (
        <div className={styles.firstRun}>
          <div className={styles.firstRunTitle}>HOW IT WORKS</div>
          <ol className={styles.firstRunSteps}>
            <li>Pick a <strong>FROM</strong> hub to buy at and a <strong>TO</strong> hub to sell at.</li>
            <li>Choose your hauler — cargo capacity drives the trip-packing math.</li>
            <li>Paste a cargo scan, contract dump, or item list above and hit <strong>APPRAISE</strong>.</li>
            <li>The planner sorts items by ISK/m³, caps each stack to half of destination depth, and packs trips greedily.</li>
          </ol>
          <div className={styles.firstRunHint}>
            Tip: turn on <strong>DEPTH-AWARE</strong> to avoid filling cargo with stacks the destination can't absorb.
          </div>
        </div>
      )}

      {/* ── Results ──────────────────────────────────────────────────── */}
      {data && !loading && (
        <>
          {sameStation && (
            <div className={styles.warnBanner}>
              FROM and TO are the same station — there's no arbitrage path. Pick different stations to plan a haul.
            </div>
          )}
          {/* Summary cards */}
          <div className={styles.summaryCards}>
            <div className={styles.summaryCard}>
              <span className={styles.cardLabel}>ROUTE</span>
              <span className={styles.cardValue}>{sourceShort} → {destShort}</span>
              <span className={styles.cardSub}>buy → sell</span>
            </div>
            <div className={styles.summaryCard}>
              <span className={styles.cardLabel}>ITEMS</span>
              <span className={styles.cardValue}>{summary.totalItems.toLocaleString()}</span>
              {summary.unknownCount > 0 && <span className={styles.cardSub}>{summary.unknownCount} unresolved</span>}
            </div>
            {multiTripPlan.length > 1 && (
              <div className={styles.summaryCard}>
                <span className={styles.cardLabel}>TRIPS</span>
                <span className={styles.cardValue}>{multiTripPlan.length}</span>
                <span className={styles.cardSub}>to move all cargo</span>
              </div>
            )}
            <div className={styles.summaryCard}>
              <span className={styles.cardLabel}>TOTAL BUY-IN</span>
              <span className={styles.cardValue}>{fmt(planTotals.totalCost)}</span>
              <span className={styles.cardSub}>at {sourceShort}</span>
            </div>
            {mode === "courier" && (
              <div className={styles.summaryCard}>
                <span className={styles.cardLabel}>TOTAL REWARD</span>
                <span className={styles.cardValue}>{fmt(planTotals.totalHaulCost)}</span>
                <span className={styles.cardSub}>courier reward</span>
              </div>
            )}
            <div className={styles.summaryCard}>
              <span className={styles.cardLabel}>{multiTripPlan.length > 1 ? "TOTAL PROFIT" : "TRIP PROFIT"}</span>
              <span className={`${styles.cardValue} ${planTotals.totalProfit >= 0 ? styles.cardValueSell : styles.danger}`}>
                {fmt(planTotals.totalProfit)}
              </span>
              <span className={styles.cardSub}>{mode === "self" ? "after sales tax" : "after courier reward"}</span>
            </div>
            <div className={styles.cargoCard}>
              <span className={styles.cardLabel}>TRIP 1 CARGO</span>
              <span className={styles.cardValue}>{fmtVol(multiTripPlan[0]?.cargoUsed ?? 0)} / {fmtVol(effectiveCargo)}</span>
              <div className={styles.progressBarWrap}>
                <div className={styles.progressFill} style={{ width: `${Math.min(summary.cargoFillPct, 100)}%` }} />
              </div>
              <span className={styles.cardSub}>{summary.cargoFillPct.toFixed(1)}% full</span>
            </div>
          </div>

          {/* Per-trip breakdown (only shown when > 1 trip) */}
          {multiTripPlan.length > 1 && (
            <div className={styles.tripBreakdown}>
              {multiTripPlan.map((t) => {
                const pct = effectiveCargo > 0 ? (t.cargoUsed / effectiveCargo) * 100 : 0;
                return (
                  <div key={t.num} className={styles.tripRow}>
                    <span className={styles.tripLabel}>TRIP {t.num}</span>
                    <span className={styles.tripStat}><span className={styles.tripStatLabel}>BUY-IN</span>{fmt(t.totalSourceCost)}</span>
                    <span className={`${styles.tripStat} ${t.totalProfit >= 0 ? styles.sell : styles.danger}`}><span className={styles.tripStatLabel}>PROFIT</span>{fmt(t.totalProfit)}</span>
                    <span className={styles.tripStat}><span className={styles.tripStatLabel}>CARGO</span>{fmtVol(t.cargoUsed)}</span>
                    <div className={styles.tripBarWrap}>
                      <div className={styles.tripBarFill} style={{ width: `${Math.min(pct, 100)}%` }} />
                    </div>
                    <span className={styles.tripBarPct}>{pct.toFixed(0)}%</span>
                  </div>
                );
              })}
            </div>
          )}

          {summary.profitableCount === 0 && (
            <div className={styles.warnBanner}>
              No items are profitable on this route at current settings.
            </div>
          )}

          {/* Save / share strip */}
          <div className={styles.tableToolbar}>
            <span className={styles.meta}>
              {items.length} items · {summary.profitableCount} profitable
              {summary.unknownCount > 0 && ` · ${summary.unknownCount} unresolved`}
            </span>
            <div className={styles.toolbarBtns}>
              <button
                className={styles.toggleBtn}
                onClick={handleSaveTrip}
                disabled={savingSlug || !cargoText}
                title="Save this trip and copy a shareable link to clipboard"
              >
                {savingSlug ? "SAVING…" : copiedShare ? "LINK COPIED ✓" : slug ? "RE-SAVE TRIP" : "SAVE TRIP"}
              </button>
              {slug && (
                <span className={styles.slugBadge} title="Trip slug — anyone with the URL can re-load this exact cargo + route">
                  /?a={slug}
                </span>
              )}
            </div>
          </div>

          {/* Per-item table */}
          <div className={styles.wrapper}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th className={styles.thName} onClick={() => handleSort("name")}>ITEM {arr("name")}</th>
                  <th className={styles.thNum}  onClick={() => handleSort("quantity")}>QTY {arr("quantity")}</th>
                  <th className={styles.thNum}  onClick={() => handleSort("volumeEach")}>VOL/UNIT {arr("volumeEach")}</th>
                  <th className={styles.thNum}  onClick={() => handleSort("sourceSell")}>{sourceShort.toUpperCase()} BUY {arr("sourceSell")}</th>
                  <th className={styles.thNum}  onClick={() => handleSort("destSell")}>{destShort.toUpperCase()} SELL {arr("destSell")}</th>
                  <th className={styles.thNum}  onClick={() => handleSort("destSellVolume")}>DEPTH {arr("destSellVolume")}</th>
                  {mode === "courier" && <th className={styles.thNum}  onClick={() => handleSort("haulCostPerUnit")}>HAUL {arr("haulCostPerUnit")}</th>}
                  <th className={styles.thNum}  onClick={() => handleSort("netProfitTotal")}>NET PROFIT {arr("netProfitTotal")}</th>
                  <th className={`${styles.thNum} ${styles.thHighlight}`} onClick={() => handleSort("netProfitPerM3")}>ISK/m³ {arr("netProfitPerM3")}</th>
                  <th className={styles.thCargo}>{multiTripPlan.length > 1 ? "TRIP" : "IN CARGO"}</th>
                </tr>
              </thead>
              <tbody>
                {sortedItems.map((item, i) => {
                  const assignment = itemTripMap.get(item.typeID);
                  const inPlan   = !!assignment;
                  const isPartial = assignment?.partial ?? false;
                  const tripNum   = assignment?.tripNum ?? null;
                  const marginPct = item.sourceCostPerUnit > 0
                    ? item.netProfitPerUnit / item.sourceCostPerUnit
                    : null;
                  const isThinMargin = item.isProfitable && marginPct != null && marginPct < 0.03;
                  const rowClass = [
                    inPlan && !isPartial                              ? styles.rowInCargo      : "",
                    isPartial                                         ? styles.rowPartial      : "",
                    !item.isProfitable && item.netProfitPerM3 != null ? styles.rowUnprofitable : "",
                    isThinMargin                                      ? styles.rowThinMargin   : "",
                  ].filter(Boolean).join(" ");
                  return (
                    <tr key={`${item.typeID}-${i}`} className={rowClass}>
                      <td className={styles.tdName}>
                        <a className={styles.link} href={`https://www.everef.net/type/${item.typeID}`} target="_blank" rel="noopener noreferrer">
                          {item.name}
                        </a>
                        {item.depthLimited && (
                          <span className={styles.depthBadge} title={`Capped to ${item.effQty.toLocaleString()} of ${item.quantity.toLocaleString()} — sell-side depth at ${destShort} is only ${item.destSellVolume?.toLocaleString() ?? 0}`}>
                            ✂ {item.effQty.toLocaleString()}/{item.quantity.toLocaleString()}
                          </span>
                        )}
                      </td>
                      <td className={styles.tdNum}>{item.quantity.toLocaleString()}</td>
                      <td className={styles.tdNum}>{item.volumeEach != null ? fmtVol(item.volumeEach) : "—"}</td>
                      <td className={styles.tdNum}>{fmt(item.sourceSell)}</td>
                      <td className={`${styles.tdNum} ${styles.sell}`}>{fmt(item.destSell)}</td>
                      <td className={styles.tdNum}>{item.destSellVolume != null ? fmt(item.destSellVolume) : "—"}</td>
                      {mode === "courier" && <td className={styles.tdNum}>{item.haulCostPerUnit != null ? fmt(item.haulCostPerUnit) : "—"}</td>}
                      <td className={`${styles.tdNum} ${item.netProfitTotal != null ? (item.netProfitTotal >= 0 ? styles.sell : styles.danger) : ""}`}>
                        {item.netProfitTotal != null ? fmt(item.netProfitTotal) : "—"}
                      </td>
                      <td className={`${styles.tdNum} ${styles.highlight} ${item.netProfitPerM3 != null ? (item.netProfitPerM3 >= 0 ? styles.sell : styles.danger) : ""}`}>
                        {item.netProfitPerM3 != null ? fmt(item.netProfitPerM3) : "—"}
                      </td>
                      <td className={styles.tdCargo}>
                        {inPlan && !isPartial && multiTripPlan.length > 1 && (
                          <span className={styles.inCargoCheck}>T{tripNum}</span>
                        )}
                        {inPlan && !isPartial && multiTripPlan.length === 1 && (
                          <span className={styles.inCargoCheck}>✓</span>
                        )}
                        {isPartial && (
                          <span className={styles.partialCheck}>
                            {multiTripPlan.length > 1 ? `T${tripNum} ` : ""}~{Math.round((assignment?.fraction ?? 0) * 100)}%
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Dropped items breakdown */}
          {droppedNoMargin.length > 0 && (
            <div className={styles.droppedPanel}>
              <div className={styles.droppedHeader}>LEFT BEHIND</div>
              <div className={styles.droppedRow}>
                <span className={styles.droppedLabel}>unprofitable:</span>
                <span className={styles.droppedQty}>{droppedNoMargin.length} item(s) priced under haul cost</span>
              </div>
            </div>
          )}
        </>
      )}
    </>
  );
}
