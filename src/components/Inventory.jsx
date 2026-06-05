import React, { useState, useEffect, useMemo, useRef } from "react";
import Tabs from "./shared/Tabs.jsx";
import styles from "./Inventory.module.css";
import { showToast } from "../lib/toast.js";

const INV_SUB_OPTIONS = [
  { value: "doctrines", label: "Doctrines" },
  { value: "status",    label: "Stock Status" },
  { value: "sales",     label: "Sales" },
];

const STORAGE_PREFIX = "praxis:inventory:";
const ESI_BASE = "https://esi.evetech.net/latest";
const FUZZWORK_BASE = "https://market.fuzzwork.co.uk/aggregates/";
const JITA_STATION = 60003760;
const PRICE_MARKUP = 1.10;
const PRICE_STALE_MS = 30 * 60 * 1000; // 30 min
const BURN_RATE_DAYS = 30; // burn rate window for stock projection

// Match contract titles to doctrine names tolerantly: lowercase, NFKC
// normalize (canonicalize composed/decomposed forms), strip zero-width
// chars, unify the various Unicode dashes to a plain hyphen, and collapse
// any whitespace run (including non-breaking spaces) to a single space.
// This is what lets "Wolfpack - Coercer Navy Issue" with a stray U+00A0
// or U+2013 match the corp's "WOLFPACK - Coercer Navy Issue" doctrine.
function normalizeTitle(s) {
  if (typeof s !== "string") return "";
  return s
    .normalize("NFKC")
    .replace(/[​-‏⁠﻿]/g, "") // zero-width chars + BOM
    .replace(/[‐-―−]/g, "-")      // unicode dashes -> hyphen
    .replace(/\s+/g, " ")                        // collapse whitespace
    .trim()
    .toLowerCase();
}

// ── Doctrine tag color palette ─────────────────────────────────────────────
// Deterministic: same doctrine string always maps to the same color.

const DOC_COLORS = [
  { color: "#00c8ff", borderColor: "rgba(0,200,255,0.35)",   backgroundColor: "rgba(0,200,255,0.07)"   }, // cyan
  { color: "#ff9f43", borderColor: "rgba(255,159,67,0.35)",  backgroundColor: "rgba(255,159,67,0.07)"  }, // orange
  { color: "#a29bfe", borderColor: "rgba(162,155,254,0.35)", backgroundColor: "rgba(162,155,254,0.07)" }, // purple
  { color: "#55efc4", borderColor: "rgba(85,239,196,0.35)",  backgroundColor: "rgba(85,239,196,0.07)"  }, // mint
  { color: "#fd79a8", borderColor: "rgba(253,121,168,0.35)", backgroundColor: "rgba(253,121,168,0.07)" }, // pink
  { color: "#ffeaa7", borderColor: "rgba(255,234,167,0.35)", backgroundColor: "rgba(255,234,167,0.07)" }, // yellow
  { color: "#74b9ff", borderColor: "rgba(116,185,255,0.35)", backgroundColor: "rgba(116,185,255,0.07)" }, // blue
  { color: "#ff7675", borderColor: "rgba(255,118,117,0.35)", backgroundColor: "rgba(255,118,117,0.07)" }, // red
  { color: "#81ecec", borderColor: "rgba(129,236,236,0.35)", backgroundColor: "rgba(129,236,236,0.07)" }, // teal
  { color: "#e17055", borderColor: "rgba(225,112,85,0.35)",  backgroundColor: "rgba(225,112,85,0.07)"  }, // burnt orange
  { color: "#b8e994", borderColor: "rgba(184,233,148,0.35)", backgroundColor: "rgba(184,233,148,0.07)" }, // lime
  { color: "#f368e0", borderColor: "rgba(243,104,224,0.35)", backgroundColor: "rgba(243,104,224,0.07)" }, // magenta
];

function docColor(tag) {
  let h = 0;
  const s = (tag ?? "").toUpperCase();
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return DOC_COLORS[h % DOC_COLORS.length];
}

// A doctrine's hex color (#rrggbb) → rgba() at the requested alpha, so the
// bulletin box can be tinted with the same hue as the doctrine heading.
function hexToRgba(hex, alpha) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

// ── Storage helpers ────────────────────────────────────────────────────────

function read(key, fallback = null) {
  try {
    const v = localStorage.getItem(STORAGE_PREFIX + key);
    return v !== null ? JSON.parse(v) : fallback;
  } catch { return fallback; }
}
function write(key, value) {
  try { localStorage.setItem(STORAGE_PREFIX + key, JSON.stringify(value)); } catch {}
}
function clear(key) {
  try { localStorage.removeItem(STORAGE_PREFIX + key); } catch {}
}

function useLocalState(key, initial) {
  const [v, setV] = useState(() => {
    const stored = read(key, undefined);
    return stored === undefined ? initial : stored;
  });
  const setAndPersist = (next) => {
    setV((prev) => {
      const value = typeof next === "function" ? next(prev) : next;
      write(key, value);
      return value;
    });
  };
  return [v, setAndPersist];
}

// ── Formatters ─────────────────────────────────────────────────────────────

function fmt(v) {
  if (v == null || !isFinite(v)) return "—";
  const abs = Math.abs(v);
  const sign = v < 0 ? "-" : "";
  if (abs >= 1e9) return sign + (abs / 1e9).toFixed(2) + "B";
  if (abs >= 1e6) return sign + (abs / 1e6).toFixed(2) + "M";
  if (abs >= 1e3) return sign + (abs / 1e3).toFixed(1) + "k";
  return v.toLocaleString("en-US", { maximumFractionDigits: 0 });
}

function timeAgo(ts) {
  if (!ts) return "—";
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

// ── EFT fitting header parser ──────────────────────────────────────────────

function parseEftHeader(text) {
  if (!text) return null;
  const firstLine = text.trim().split("\n")[0].trim();
  if (!firstLine.startsWith("[") || !firstLine.includes(",")) return null;
  const inner = firstLine.slice(1, firstLine.lastIndexOf("]"));
  const ci = inner.indexOf(",");
  const ship = inner.slice(0, ci).trim();
  const fitName = inner.slice(ci + 1).trim();
  return ship ? { ship, fitName } : null;
}

// ── Main component ─────────────────────────────────────────────────────────

export default function Inventory({ auth, sub = "doctrines", onSubChange }) {
  // EVE auth comes from the shared site-wide hook. Site already gated us
  // through AuthGate so eveAuth + isCorpMember are guaranteed truthy here.
  const { eveAuth, getAccessToken } = auth;

  // Doctrine config — corp-shared, served by /api/inventory/doctrines.
  // Each save replaces the whole list server-side; corp mates pick up
  // changes on next mount (or via the manual refresh button).
  const [doctrine, setDoctrine] = useState([]);
  const [doctrineLoading, setDoctrineLoading] = useState(true);
  const [doctrineSyncing, setDoctrineSyncing] = useState(false);
  const [doctrineSyncError, setDoctrineSyncError] = useState(null);
  const [doctrineLastSync, setDoctrineLastSync] = useState(null);
  const doctrineSaveTimer = useRef(null);
  const doctrineLatestRef = useRef([]);

  // Contract data
  const [contracts, setContracts] = useState(() => read("contracts"));
  const [lastRefreshed, setLastRefreshed] = useState(() => read("lastRefreshed"));
  const [loading, setLoading] = useState(false);
  const [fetchError, setFetchError] = useState(null);

  // Recent finished item-exchange contracts (last 30 days), used to compute
  // the per-doctrine burn rate so we can project how long current stock lasts.
  const [finishedContracts, setFinishedContracts] = useState(() => read("finishedContracts"));

  // Sales history — corp-shared, served by /api/inventory/sales. Server keeps
  // a durable record (ESI only returns ~30 days of finished contracts), so
  // monthly/yearly rollups span as long as someone refreshes the tab.
  const [sales, setSales] = useState(null);
  const [salesLoading, setSalesLoading] = useState(false);
  const [salesError, setSalesError] = useState(null);

  // Suggested prices keyed by "doctrine|name", with timestamp map for staleness
  const [suggestedPrices, setSuggestedPrices] = useState({});
  const [pricesComputedAt, setPricesComputedAt] = useState({});
  const [pricingInFlight, setPricingInFlight] = useState(new Set());

  // Contract-items cache (immutable once issued, so we keep them forever):
  // { [contract_id]: ESI items[] }. Persisted to localStorage so refreshes only
  // hit ESI for contracts we haven't seen before.
  const [contractItemsCache, setContractItemsCache] = useState(() => read("contractItems", {}) ?? {});

  // Resolved type IDs for each doctrine entry's fitting, keyed by entry.id.
  // { [entry.id]: { hash, items: [{type_id, qty, name}], unresolvedCount } }
  // `hash` invalidates the cache whenever the doctrine fitting text changes.
  const [doctrineTypeIds, setDoctrineTypeIds] = useState(() => read("doctrineTypeIds", {}) ?? {});

  // Per-contract item fetches currently in flight, deduped across rerenders.
  const validationInFlightRef = useRef(new Set());

  // Character-name cache for contract issuers, keyed by character_id. ESI names
  // rarely change so we keep them in localStorage essentially forever.
  const [characterNames, setCharacterNames] = useState(() => read("characterNames", {}) ?? {});
  const characterNameFetchInFlightRef = useRef(new Set());

  // Stock Status rows the user has expanded to see incomplete-contract detail.
  const [expandedStockRows, setExpandedStockRows] = useState(new Set());
  function toggleStockRowExpand(id) {
    setExpandedStockRows((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  // Tracks which incomplete-contract row just had its ping message copied,
  // so we can flip the button label briefly.
  const [copiedPingKey, setCopiedPingKey] = useState(null);

  // Change log — corp-wide, served alongside the doctrine config by
  // /api/inventory/doctrines. Covers adds, deletes, and per-field edits.
  const [changeLog, setChangeLog] = useState([]);

  // UI toggles — persisted across sessions
  const [showGuide, setShowGuide] = useLocalState("ui.showGuide", false);
  const [showConfig, setShowConfig] = useLocalState("ui.showConfig", false);
  const [showAllContracts, setShowAllContracts] = useLocalState("ui.showAllContracts", false);
  const [showChangeLog, setShowChangeLog] = useLocalState("ui.showDeletionLog", false);
  const [showStatusTable, setShowStatusTable] = useLocalState("ui.showStatusTable", true);

  // Sort state for main table
  const [sortCol, setSortCol] = useState("status");
  const [sortDir, setSortDir] = useState("asc");

  // Per-doctrine group collapse state for status table
  const [collapsedGroups, setCollapsedGroups] = useLocalState("ui.collapsedGroups", []);

  // Per-doctrine group collapse state for config table (independent)
  const [collapsedConfigGroups, setCollapsedConfigGroups] = useLocalState("ui.collapsedConfigGroups", []);
  const collapsedSet = useMemo(() => new Set(collapsedGroups), [collapsedGroups]);
  function toggleGroup(tag) {
    setCollapsedGroups((prev) => {
      const s = new Set(prev);
      if (s.has(tag)) s.delete(tag); else s.add(tag);
      return [...s];
    });
  }

  const collapsedConfigSet = useMemo(() => new Set(collapsedConfigGroups), [collapsedConfigGroups]);
  function toggleConfigGroup(tag) {
    setCollapsedConfigGroups((prev) => {
      const s = new Set(prev);
      if (s.has(tag)) s.delete(tag); else s.add(tag);
      return [...s];
    });
  }

  // Per-doctrine expand state for the fitting library — empty means every
  // group is collapsed, so the library defaults to collapsed as it grows.
  const [expandedLibGroups, setExpandedLibGroups] = useLocalState("ui.expandedLibGroups", []);
  const expandedLibSet = useMemo(() => new Set(expandedLibGroups), [expandedLibGroups]);
  function toggleLibGroup(tag) {
    setExpandedLibGroups((prev) => {
      const s = new Set(prev);
      if (s.has(tag)) s.delete(tag); else s.add(tag);
      return [...s];
    });
  }

  // Filter state for status table
  const [filterQ, setFilterQ] = useState("");
  const [filterStatuses, setFilterStatuses] = useState(new Set());
  function toggleFilterStatus(s) {
    setFilterStatuses((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s); else next.add(s);
      return next;
    });
  }

  // Bulk-selection state for doctrine config
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [bulkTargetDraft, setBulkTargetDraft] = useState("");
  function toggleSelected(id) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  // Fitting editor: which config entry is expanded for fitting edit
  const [editFittingId, setEditFittingId] = useState(null);

  // Inline edit state for doctrine config rows
  const [editingId, setEditingId] = useState(null);
  const [editDraft, setEditDraft] = useState(null);

  // Fitting preview expansion in config table (Set of entry IDs)
  const [expandedFittings, setExpandedFittings] = useState(new Set());

  function toggleFittingExpand(id) {
    setExpandedFittings((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  // Doctrines sub-tab: filter pill + text search + selected card
  const [docFilter, setDocFilter] = useState(null);
  const [docSearch, setDocSearch] = useState("");
  const [selectedFitId, setSelectedFitId] = useState(null);

  // Per-doctrine bulletin notes — corp-shared, keyed by doctrine tag, served
  // alongside the doctrine config by /api/inventory/doctrines.
  const [doctrineNotes, setDoctrineNotes] = useState({});
  const [editingNoteTag, setEditingNoteTag] = useState(null);
  const [noteDraft, setNoteDraft] = useState("");
  const [noteSaving, setNoteSaving] = useState(false);
  const [noteError, setNoteError] = useState(null);

  // Copy feedback: which row key just had fitting copied
  const [copiedKey, setCopiedKey] = useState(null);
  const [restockCopied, setRestockCopied] = useState(false);
  const copyTimerRef = useRef(null);

  // New-entry form — EFT-paste-first: the pasted fitting drives the name field
  // until the user manually edits it (newNameTouched).
  const [newDoc, setNewDoc] = useState("");
  const [newName, setNewName] = useState("");
  const [newNameTouched, setNewNameTouched] = useState(false);
  const [newTarget, setNewTarget] = useState("1");
  const [newKeepOnHand, setNewKeepOnHand] = useState(true);
  const [newFitting, setNewFitting] = useState("");

  // ── Contract fetch ───────────────────────────────────────────────────────

  async function fetchContracts() {
    setLoading(true);
    setFetchError(null);
    try {
      const token = await getAccessToken();
      if (!token) { setFetchError("Not connected to EVE. Log in first."); return; }

      const cId = eveAuth.corporationId;
      let all = [];
      let page = 1;
      while (true) {
        const res = await fetch(
          `${ESI_BASE}/corporations/${cId}/contracts/?datasource=tranquility&page=${page}`,
          { headers: { Authorization: `Bearer ${token}` } }
        );
        if (!res.ok) throw new Error(`ESI ${res.status}: ${await res.text()}`);
        const data = await res.json();
        all = all.concat(data);
        const totalPages = parseInt(res.headers.get("X-Pages") ?? "1", 10);
        if (page >= totalPages) break;
        page++;
      }

      const outstanding = all.filter(
        (c) => c.type === "item_exchange" && c.status === "outstanding"
      );

      // All finished item-exchange contracts in this ESI response. Everything
      // here gets shipped to the sales endpoint so it accumulates server-side
      // over time (ESI only returns ~30 days of finished contracts).
      const finishedAll = all.filter(
        (c) => c.type === "item_exchange" && c.status === "finished"
      );

      // Burn-rate projection: clip the finished list to the last N days. This
      // stays local (localStorage) since it's just the rolling stock-out rate.
      const windowMs = BURN_RATE_DAYS * 24 * 60 * 60 * 1000;
      const cutoff = Date.now() - windowMs;
      const finished = finishedAll.filter((c) => {
        const done = c.date_completed ? Date.parse(c.date_completed) : 0;
        return done > 0 && done >= cutoff;
      });

      write("contracts", outstanding);
      write("finishedContracts", finished);
      write("lastRefreshed", Date.now());
      setContracts(outstanding);
      setFinishedContracts(finished);
      setLastRefreshed(Date.now());

      // Best-effort: persist finished contracts to the sales table. The server
      // matches them against current doctrine titles and upserts by contract_id,
      // so this is idempotent across refreshes. Send a slimmed payload — the
      // server only needs the fields below.
      if (finishedAll.length > 0) {
        const slim = finishedAll.map((c) => ({
          contract_id:    c.contract_id,
          type:           c.type,
          status:         c.status,
          title:          c.title,
          price:          c.price,
          date_completed: c.date_completed,
          acceptor_id:    c.acceptor_id,
          issuer_id:      c.issuer_id,
        }));
        fetch("/api/inventory/sales", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({ contracts: slim }),
        })
          .then((res) => (res.ok ? loadSales() : null))
          .catch(() => {});
      }
      setSuggestedPrices({});
      setPricesComputedAt({});
      setPricingInFlight(new Set());
    } catch (err) {
      setFetchError(`Fetch failed: ${err.message}`);
    } finally {
      setLoading(false);
    }
  }

  // ── Sales rollup ─────────────────────────────────────────────────────────

  async function loadSales() {
    setSalesLoading(true);
    setSalesError(null);
    try {
      const token = await getAccessToken();
      if (!token) throw new Error("Not signed in");
      const res = await fetch("/api/inventory/sales", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || `sales ${res.status}`);
      }
      const json = await res.json();
      setSales(json);
    } catch (err) {
      setSalesError(err.message);
    } finally {
      setSalesLoading(false);
    }
  }

  // Lazy-load the sales rollup the first time the Sales sub-tab is opened.
  useEffect(() => {
    if (sub !== "sales") return;
    if (sales != null || salesLoading) return;
    loadSales();
  }, [sub]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── EFT fitting parser ───────────────────────────────────────────────────

  function parseEftFitting(text) {
    const lines = text.split("\n");
    const items = {};
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      if (line.startsWith("[") && line.endsWith("]")) {
        if (i === 0) {
          const commaIdx = line.indexOf(",");
          if (commaIdx > 1) {
            const shipName = line.slice(1, commaIdx).trim();
            if (shipName) items[shipName] = (items[shipName] || 0) + 1;
          }
        }
        continue;
      }
      if (line.startsWith("//") || line.startsWith("#")) continue;
      // Skip EFT empty-slot placeholders — not real items. Bracketed forms
      // ([Empty High slot]) are already dropped by the bracket handling above;
      // this catches the rare unbracketed variant so it isn't counted unresolved.
      if (/^empty\s+(high|med|mid|low|rig|subsystem)\s+slot$/i.test(line)) continue;
      const match = line.match(/^(.+?)\s+x(\d+)$/i);
      if (match) {
        const name = match[1].trim();
        const qty = parseInt(match[2], 10);
        if (name) items[name] = (items[name] || 0) + qty;
      } else {
        items[line] = (items[line] || 0) + 1;
      }
    }
    return Object.entries(items).map(([name, qty]) => ({ name, qty }));
  }

  // ── Doctrine-vs-contract item validation ────────────────────────────────
  //
  // Stock Status historically counted any title-matched contract as 1 in stock.
  // These helpers add a second check: the contract must also *contain* every
  // item listed in the doctrine fitting at ≥ the EFT qty. Extras are allowed.

  // Stable name → type_id cache. Type IDs never change for a given EVE item
  // name. The corp-shared cache lives in Supabase (so the first user to
  // resolve a name pays the ESI cost, everyone after gets it from the table);
  // localStorage acts as a per-browser fast path that avoids the API round
  // trip for names this browser has already seen.
  async function resolveTypeIds(names) {
    const cache = read("typeIdCache", {}) ?? {};
    const out = {};
    const missingOriginals = [];
    for (const n of names) {
      const k = n.toLowerCase();
      if (cache[k] != null) out[k] = cache[k];
      else missingOriginals.push(n);
    }
    if (missingOriginals.length === 0) return out;

    // Chunk by 500 — matches the backend's MAX_NAMES per request.
    const chunks = [];
    for (let i = 0; i < missingOriginals.length; i += 500) chunks.push(missingOriginals.slice(i, i + 500));
    try {
      const token = await getAccessToken();
      if (!token) return out;
      for (const chunk of chunks) {
        const res = await fetch("/api/inventory/type-ids", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({ names: chunk }),
        });
        if (!res.ok) continue;
        const data = await res.json();
        for (const [k, v] of Object.entries(data?.ids ?? {})) {
          out[k] = v;
          cache[k] = v;
        }
      }
    } catch {
      // best-effort — caller falls back to title-only validation
    }
    write("typeIdCache", cache);
    return out;
  }

  // Returns true if the contract contains ≥ qty of every required type.
  // `missing` enumerates shortfalls for the UI's expanded row.
  function validateContract(items, required) {
    const have = {};
    for (const it of items ?? []) {
      if (!it?.is_included) continue;
      have[it.type_id] = (have[it.type_id] ?? 0) + (it.quantity ?? 0);
    }
    const missing = [];
    for (const req of required) {
      const h = have[req.type_id] ?? 0;
      if (h < req.qty) missing.push({ name: req.name, type_id: req.type_id, need: req.qty, have: h });
    }
    return { complete: missing.length === 0, missing };
  }

  // Cheap stable hash of an EFT fitting string — used to invalidate the cached
  // type-id resolution when the doctrine's fitting changes.
  function fittingHash(text) {
    let h = 5381;
    for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
    return h.toString(16);
  }

  // Resolve character IDs to names via ESI POST /universe/names/. Results are
  // cached in localStorage; only previously-unseen IDs hit ESI. Used to show
  // "issued by X" in the incomplete-contract panel.
  async function resolveCharacterNames(ids) {
    const numericIds = [...new Set(ids.filter((id) => Number.isFinite(id) && id > 0))];
    const missing = numericIds.filter(
      (id) => characterNames[id] == null && !characterNameFetchInFlightRef.current.has(id)
    );
    if (missing.length === 0) return;
    missing.forEach((id) => characterNameFetchInFlightRef.current.add(id));

    // /universe/names/ accepts up to 1000 ids per call.
    const chunks = [];
    for (let i = 0; i < missing.length; i += 500) chunks.push(missing.slice(i, i + 500));

    const resolved = {};
    for (const chunk of chunks) {
      try {
        const res = await fetch(
          "https://esi.evetech.net/latest/universe/names/?datasource=tranquility",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(chunk),
          }
        );
        if (!res.ok) continue;
        const data = await res.json();
        for (const entry of data ?? []) {
          if (entry?.id && entry?.name) resolved[entry.id] = entry.name;
        }
      } catch {
        // best-effort — leave IDs unresolved, retry next refresh
      }
    }
    missing.forEach((id) => characterNameFetchInFlightRef.current.delete(id));
    if (Object.keys(resolved).length === 0) return;
    setCharacterNames((prev) => {
      const next = { ...prev, ...resolved };
      write("characterNames", next);
      return next;
    });
  }

  // Format a Discord-friendly nudge for an incomplete contract and copy it to
  // the clipboard. The receiver gets a one-paste, ready-to-send ping.
  function copyIncompletePing(row, contract, missing) {
    const pingKey = `${row.id}:${contract.contract_id}`;
    const issuer = characterNames[contract.issuer_id];
    const lines = [];
    lines.push(`⚠ **Incomplete contract** — \`${row.doctrine} - ${row.name}\``);
    if (issuer) lines.push(`Issuer: **${issuer}**`);
    else if (contract.issuer_id) lines.push(`Issuer ID: ${contract.issuer_id}`);
    lines.push(`Contract ID: \`${contract.contract_id}\``);
    lines.push(`Missing items:`);
    for (const m of missing) {
      lines.push(`• ${m.name} — need ${m.need}, have ${m.have} (short ${m.need - m.have})`);
    }
    const text = lines.join("\n");
    navigator.clipboard.writeText(text).catch(() => {});
    showToast("Copied Discord ping");
    setCopiedPingKey(pingKey);
    setTimeout(() => setCopiedPingKey((k) => (k === pingKey ? null : k)), 2000);
  }

  // ── Suggested price (background, per doctrine entry) ────────────────────

  async function calcSuggestedPrice(entry) {
    const key = `${entry.doctrine}|${entry.name}`;
    if (pricingInFlight.has(key) || suggestedPrices[key] != null) return;

    const matched = matchContracts(contracts, entry);
    if (matched.length === 0 && !entry.fitting) return;

    setPricingInFlight((prev) => new Set([...prev, key]));
    try {
      let typeItems; // [{type_id, quantity}]

      if (matched.length > 0) {
        const token = await getAccessToken();
        if (!token) return;
        const itemsRes = await fetch(
          `${ESI_BASE}/corporations/${eveAuth.corporationId}/contracts/${matched[0].contract_id}/items/`,
          { headers: { Authorization: `Bearer ${token}` } }
        );
        if (!itemsRes.ok) return;
        const contractItems = (await itemsRes.json()).filter((i) => i.is_included);
        if (contractItems.length === 0) return;
        typeItems = contractItems.map((i) => ({ type_id: i.type_id, quantity: i.quantity }));
      } else {
        const parsed = parseEftFitting(entry.fitting);
        if (parsed.length === 0) return;
        const names = parsed.map((p) => p.name);
        const idsRes = await fetch(
          "https://esi.evetech.net/latest/universe/ids/?datasource=tranquility",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(names),
          }
        );
        if (!idsRes.ok) return;
        const idsData = await idsRes.json();
        const nameToId = {};
        for (const t of idsData.inventory_types ?? []) {
          nameToId[t.name.toLowerCase()] = t.id;
        }
        typeItems = parsed
          .map((p) => ({ type_id: nameToId[p.name.toLowerCase()], quantity: p.qty }))
          .filter((i) => i.type_id != null);
        if (typeItems.length === 0) return;
      }

      const typeIds = [...new Set(typeItems.map((i) => i.type_id))];
      const chunks = [];
      for (let i = 0; i < typeIds.length; i += 100) chunks.push(typeIds.slice(i, i + 100));

      const priceMap = {};
      for (const chunk of chunks) {
        const p = new URLSearchParams({ station: JITA_STATION, types: chunk.join(",") });
        const pRes = await fetch(`${FUZZWORK_BASE}?${p}`);
        if (!pRes.ok) continue;
        Object.assign(priceMap, await pRes.json());
      }

      let total = 0;
      for (const item of typeItems) {
        const p = priceMap[item.type_id.toString()];
        if (p) total += parseFloat(p.sell.min) * item.quantity;
      }

      if (total > 0) {
        const ts = Date.now();
        setSuggestedPrices((prev) => ({ ...prev, [key]: total * PRICE_MARKUP }));
        setPricesComputedAt((prev) => ({ ...prev, [key]: ts }));
      }
    } catch {
      // best-effort
    } finally {
      setPricingInFlight((prev) => { const s = new Set(prev); s.delete(key); return s; });
    }
  }

  function refreshPrice(key) {
    setSuggestedPrices((prev) => { const n = { ...prev }; delete n[key]; return n; });
    setPricesComputedAt((prev) => { const n = { ...prev }; delete n[key]; return n; });
  }

  function refreshAllPrices() {
    setSuggestedPrices({});
    setPricesComputedAt({});
  }

  // ── Contract matching ────────────────────────────────────────────────────

  function matchContracts(contractList, entry) {
    if (!contractList) return [];
    const pattern = normalizeTitle(`${entry.doctrine} - ${entry.name}`);
    return contractList.filter((c) => normalizeTitle(c.title) === pattern);
  }

  // ── Sort helpers ─────────────────────────────────────────────────────────

  function toggleSort(col) {
    if (sortCol === col) {
      setSortDir((d) => d === "asc" ? "desc" : "asc");
    } else {
      setSortCol(col);
      setSortDir("asc");
    }
  }

  function sortIndicator(col) {
    if (sortCol !== col) return <span className={styles.sortNeutral}>⇅</span>;
    return <span className={styles.sortActive}>{sortDir === "asc" ? "▲" : "▼"}</span>;
  }

  // ── Computed rows ────────────────────────────────────────────────────────

  const rows = useMemo(() => {
    // Reference-only fits (target 0) live in the Doctrines library but are not
    // tracked for stock — keep them out of the status table, KPIs and pricing.
    const mapped = doctrine.filter((e) => e.target > 0).map((entry) => {
      const matched = matchContracts(contracts, entry);

      // Item-level validation: a title-matched contract only counts toward
      // stock if it also contains ≥ the required qty of every fitting item.
      // Falls back to title-only counting when we don't have validation data
      // yet (no fitting text, type-ids still resolving, items still fetching).
      const validation = doctrineTypeIds[entry.id];
      const validationAvailable = !!(
        entry.fitting && validation && Array.isArray(validation.items) && validation.items.length > 0
      );

      let completeContracts = matched;
      let incompleteContracts = [];
      let validationPending = false;

      if (validationAvailable) {
        completeContracts = [];
        for (const c of matched) {
          const items = contractItemsCache[c.contract_id];
          if (items == null) {
            // Items still being fetched — don't count this contract either way.
            validationPending = true;
            continue;
          }
          const r = validateContract(items, validation.items);
          if (r.complete) completeContracts.push(c);
          else incompleteContracts.push({ contract: c, missing: r.missing });
        }
      }

      const currentStock = completeContracts.length;
      const target = entry.target;
      const status = contracts == null ? null
        : currentStock >= target ? "in_stock"
        : currentStock > 0 ? "low"
        : "needed";
      const avgListed = matched.length > 0
        ? matched.reduce((s, c) => s + (c.price ?? 0), 0) / matched.length
        : null;
      return {
        ...entry,
        key: `${entry.doctrine}|${entry.name}`,
        currentStock,
        matchedCount: matched.length,
        incompleteContracts,
        validationAvailable,
        validationPending,
        unresolvedCount: validation?.unresolvedCount ?? 0,
        status,
        avgListed,
      };
    });

    return mapped.sort((a, b) => {
      let av, bv;
      switch (sortCol) {
        case "doctrine": av = a.doctrine; bv = b.doctrine; break;
        case "fitting":  av = a.name;     bv = b.name;     break;
        case "current":  av = a.currentStock; bv = b.currentStock; break;
        case "target":   av = a.target;   bv = b.target;   break;
        case "avg":      av = a.avgListed ?? -1; bv = b.avgListed ?? -1; break;
        case "suggested":
          av = suggestedPrices[a.key] ?? -1;
          bv = suggestedPrices[b.key] ?? -1;
          break;
        case "status":
        default: {
          const o = { needed: 0, low: 1, in_stock: 2 };
          av = o[a.status] ?? 3;
          bv = o[b.status] ?? 3;
          break;
        }
      }
      const cmp = typeof av === "string" ? av.localeCompare(bv) : av - bv;
      return sortDir === "asc" ? cmp : -cmp;
    });
  }, [doctrine, contracts, sortCol, sortDir, suggestedPrices, doctrineTypeIds, contractItemsCache]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Burn-rate projection ─────────────────────────────────────────────────
  // Group finished contracts by title (lowercased) and divide by the window
  // to get a per-day sales rate. Then for any doctrine matching that title,
  // estimate days-until-empty from current stock.

  const burnRateByKey = useMemo(() => {
    const map = new Map();
    if (!Array.isArray(finishedContracts) || finishedContracts.length === 0) return map;
    const counts = new Map();
    for (const c of finishedContracts) {
      const t = normalizeTitle(c?.title);
      if (!t) continue;
      counts.set(t, (counts.get(t) ?? 0) + 1);
    }
    for (const entry of doctrine) {
      if (entry.target <= 0) continue;
      const pattern = normalizeTitle(`${entry.doctrine} - ${entry.name}`);
      const sold = counts.get(pattern) ?? 0;
      if (sold === 0) continue;
      const perDay = sold / BURN_RATE_DAYS;
      map.set(`${entry.doctrine}|${entry.name}`, { sold, perDay });
    }
    return map;
  }, [finishedContracts, doctrine]);

  // ── Restock cost summary (item B1) ───────────────────────────────────────

  const restockCost = useMemo(() => {
    let total = 0; let known = 0; let unknown = 0;
    for (const r of rows) {
      const deficit = Math.max(0, r.target - r.currentStock);
      if (deficit === 0) continue;
      const px = suggestedPrices[r.key];
      if (px != null) { total += px * deficit; known++; }
      else unknown++;
    }
    return { total, known, unknown };
  }, [rows, suggestedPrices]);

  // ── KPI counts ───────────────────────────────────────────────────────────

  const kpi = useMemo(() => {
    let needed = 0, low = 0, inStock = 0, incomplete = 0;
    for (const r of rows) {
      if (r.status === "needed") needed++;
      else if (r.status === "low") low++;
      else if (r.status === "in_stock") inStock++;
      incomplete += r.incompleteContracts?.length ?? 0;
    }
    return { needed, low, inStock, incomplete };
  }, [rows]);

  // ── Config table display order — grouped by doctrine tag, then by name ─────

  const sortedDoctrine = useMemo(() => (
    [...doctrine].sort((a, b) => {
      const dt = a.doctrine.localeCompare(b.doctrine);
      return dt !== 0 ? dt : a.name.localeCompare(b.name);
    })
  ), [doctrine]);

  // Live stock state per tracked entry id — drives the pill on each fit card.
  const statusByEntryId = useMemo(() => {
    const m = new Map();
    for (const r of rows) m.set(r.id, r);
    return m;
  }, [rows]);

  // ── Config table groups ───────────────────────────────────────────────────

  const configGroups = useMemo(() => {
    const groups = new Map();
    for (const e of sortedDoctrine) {
      if (!groups.has(e.doctrine)) groups.set(e.doctrine, []);
      groups.get(e.doctrine).push(e);
    }
    return [...groups.entries()].map(([tag, entries]) => ({ tag, entries }));
  }, [sortedDoctrine]);

  // ── Filter applied to rows for the status table ──────────────────────────

  const filteredRows = useMemo(() => {
    const q = filterQ.trim().toLowerCase();
    return rows.filter((r) => {
      if (filterStatuses.size > 0 && !filterStatuses.has(r.status)) return false;
      if (q) {
        const hay = `${r.doctrine} ${r.name}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [rows, filterQ, filterStatuses]);

  // ── Group filtered rows by doctrine for the status table (item C1) ───────

  const groupedRows = useMemo(() => {
    if (sortCol === "doctrine") {
      // Preserve original flat alphabetical sort behaviour
      return null;
    }
    const groups = new Map();
    for (const r of filteredRows) {
      if (!groups.has(r.doctrine)) groups.set(r.doctrine, []);
      groups.get(r.doctrine).push(r);
    }
    return [...groups.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([tag, items]) => {
        let needed = 0, low = 0, inStock = 0, restock = 0, incomplete = 0;
        for (const r of items) {
          if (r.status === "needed") needed++;
          else if (r.status === "low") low++;
          else if (r.status === "in_stock") inStock++;
          incomplete += r.incompleteContracts?.length ?? 0;
          const deficit = Math.max(0, r.target - r.currentStock);
          const px = suggestedPrices[r.key];
          if (deficit > 0 && px != null) restock += deficit * px;
        }
        return { tag, items, needed, low, inStock, restock, incomplete };
      });
  }, [filteredRows, sortCol, suggestedPrices]);

  // ── All-contract groups (every outstanding corp contract, by title) ───────

  const allContractGroups = useMemo(() => {
    if (!contracts) return null;
    // Map normalized pattern → canonical "DOCTRINE - Name" so case-variant
    // (and stray-unicode) contract titles collapse into one row and inherit
    // the corp's blessed casing as the displayed title.
    const docPatterns = new Map(
      doctrine.map((e) => {
        const canonical = `${e.doctrine} - ${e.name}`.trim();
        return [normalizeTitle(canonical), canonical];
      })
    );
    const groups = {};
    for (const c of contracts) {
      const raw = c.title?.trim() || "(no title)";
      const key = normalizeTitle(raw) || raw;
      if (!groups[key]) {
        const canonical = docPatterns.get(key);
        groups[key] = {
          title: canonical ?? raw,
          count: 0,
          prices: [],
          isDoctrineMatch: docPatterns.has(key),
        };
      }
      groups[key].count++;
      if (c.price != null) groups[key].prices.push(c.price);
    }
    return Object.values(groups)
      .map((g) => ({
        ...g,
        avgPrice: g.prices.length > 0
          ? g.prices.reduce((s, p) => s + p, 0) / g.prices.length
          : null,
      }))
      .sort((a, b) => {
        if (a.isDoctrineMatch !== b.isDoctrineMatch) return a.isDoctrineMatch ? -1 : 1;
        return b.count - a.count;
      });
  }, [contracts, doctrine]);

  useEffect(() => {
    if (contracts == null) return;
    for (const row of rows) {
      calcSuggestedPrice(row);
    }
  }, [rows, contracts]); // eslint-disable-line react-hooks/exhaustive-deps

  // Resolve character names for any incomplete contracts' issuers so the
  // expanded panel can show "issued by X". Best-effort — falls back to the
  // raw issuer ID if ESI fails.
  useEffect(() => {
    if (!rows.length) return;
    const ids = new Set();
    for (const r of rows) {
      for (const { contract } of r.incompleteContracts ?? []) {
        if (contract.issuer_id) ids.add(contract.issuer_id);
      }
    }
    if (ids.size > 0) resolveCharacterNames([...ids]);
  }, [rows]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Background pass: resolve fitting type-ids + fetch contract items ────
  // Runs whenever contracts or doctrine change. Resolves doctrine fitting
  // items to type-ids (cached by a fitting hash) and fetches the items for
  // any title-matched contracts we haven't seen before. Contract items are
  // immutable post-issue, so previously cached contracts skip ESI entirely.
  useEffect(() => {
    if (contracts == null || doctrine.length === 0) return;
    let cancelled = false;

    (async () => {
      const tracked = doctrine.filter((e) => e.target > 0 && e.fitting);

      // 1) Resolve doctrine fittings → type IDs (skip ones already cached).
      for (const entry of tracked) {
        if (cancelled) return;
        const hash = fittingHash(entry.fitting);
        const existing = doctrineTypeIds[entry.id];
        // Re-resolve entries that previously cached zero items (e.g. a transient
        // backend/ESI failure, or the type_id_cache table not existing yet) so
        // they self-heal once the resolver works. Successful results still stick.
        if (existing && existing.hash === hash && existing.items?.length > 0) continue;

        const parsed = parseEftFitting(entry.fitting);
        if (parsed.length === 0) continue;
        try {
          const nameToId = await resolveTypeIds(parsed.map((p) => p.name));
          const items = [];
          let unresolvedCount = 0;
          for (const p of parsed) {
            const id = nameToId[p.name.toLowerCase()];
            if (id != null) items.push({ type_id: id, qty: p.qty, name: p.name });
            else unresolvedCount++;
          }
          if (cancelled) return;
          // Don't pin a wholly-empty resolution to localStorage — that's what
          // made every fit show "no validation" permanently. Leave it unset so
          // the next load retries instead of caching the failure.
          if (items.length === 0) continue;
          setDoctrineTypeIds((prev) => {
            const next = { ...prev, [entry.id]: { hash, items, unresolvedCount } };
            write("doctrineTypeIds", next);
            return next;
          });
        } catch {
          // best-effort — leave entry unresolved; row falls back to title-only
        }
      }

      // 2) Fetch items for any title-matched contracts not yet cached.
      const token = await getAccessToken();
      if (!token || cancelled) return;
      const corpId = eveAuth.corporationId;

      const toFetch = new Set();
      for (const entry of tracked) {
        const matched = matchContracts(contracts, entry);
        for (const c of matched) {
          if (!contractItemsCache[c.contract_id] && !validationInFlightRef.current.has(c.contract_id)) {
            toFetch.add(c.contract_id);
          }
        }
      }
      if (toFetch.size === 0) return;

      const ids = [...toFetch];
      ids.forEach((id) => validationInFlightRef.current.add(id));

      const CONCURRENCY = 5;
      let cursor = 0;
      async function worker() {
        while (cursor < ids.length && !cancelled) {
          const id = ids[cursor++];
          try {
            const res = await fetch(
              `${ESI_BASE}/corporations/${corpId}/contracts/${id}/items/`,
              { headers: { Authorization: `Bearer ${token}` } }
            );
            if (res.ok) {
              const items = await res.json();
              if (!cancelled) {
                setContractItemsCache((prev) => {
                  const next = { ...prev, [id]: items };
                  write("contractItems", next);
                  return next;
                });
              }
            }
          } catch {
            // best-effort
          } finally {
            validationInFlightRef.current.delete(id);
          }
        }
      }
      await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    })();

    return () => { cancelled = true; };
  }, [contracts, doctrine]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Doctrines sub-tab derived state ─────────────────────────────────────

  const selectedFitEntry = useMemo(() => {
    if (!selectedFitId) return null;
    return doctrine.find((e) => e.id === selectedFitId) ?? null;
  }, [selectedFitId, doctrine]);

  // Price the opened fit on demand so the detail panel shows a value even for
  // reference-only fits, which the status table never prices.
  useEffect(() => {
    if (selectedFitEntry?.fitting) calcSuggestedPrice(selectedFitEntry);
  }, [selectedFitEntry]); // eslint-disable-line react-hooks/exhaustive-deps

  // Price every fit visible in the library so each card can show its cost.
  // Mirrors the card grid's visibility rules (expanded group / active filter /
  // active search) so the ESI+Fuzzwork burst stays bounded to what's on screen.
  useEffect(() => {
    if (sub !== "doctrines" || doctrineLoading) return;
    const q = docSearch.trim().toLowerCase();
    for (const entry of doctrine) {
      if (!entry.fitting) continue;
      if (docFilter && entry.doctrine !== docFilter) continue;
      const groupShown = expandedLibSet.has(entry.doctrine) || docFilter === entry.doctrine || q.length > 0;
      if (!groupShown) continue;
      if (q) {
        const ship = (parseEftHeader(entry.fitting)?.ship ?? "").toLowerCase();
        if (!entry.name.toLowerCase().includes(q) && !ship.includes(q)) continue;
      }
      calcSuggestedPrice(entry);
    }
  }, [doctrine, expandedLibSet, docFilter, docSearch, contracts, sub, doctrineLoading]); // eslint-disable-line react-hooks/exhaustive-deps

  // EFT-paste-first add flow: keep the fitting-name field synced to the pasted
  // EFT header until the user types their own name (junk fit names like "test"
  // must not silently become the official doctrine name).
  useEffect(() => {
    if (newNameTouched) return;
    const h = parseEftHeader(newFitting);
    setNewName(h ? (h.fitName || h.ship) : "");
  }, [newFitting, newNameTouched]);

  // ── Doctrine config helpers ──────────────────────────────────────────────

  async function refreshDoctrine() {
    setDoctrineLoading(true);
    setDoctrineSyncError(null);
    try {
      const token = await getAccessToken();
      if (!token) throw new Error("Not signed in");
      const res = await fetch("/api/inventory/doctrines", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || `doctrines ${res.status}`);
      }
      const json = await res.json();
      const entries = json.entries ?? [];
      setDoctrine(entries);
      doctrineLatestRef.current = entries;
      setChangeLog(json.changelog ?? []);
      setDoctrineNotes(json.notes ?? {});
      setDoctrineLastSync(Date.now());
    } catch (err) {
      setDoctrineSyncError(err.message);
    } finally {
      setDoctrineLoading(false);
    }
  }

  // Initial load — server is the source of truth, no localStorage fallback.
  useEffect(() => {
    refreshDoctrine();
    return () => {
      if (doctrineSaveTimer.current) clearTimeout(doctrineSaveTimer.current);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Optimistic local update + debounced PUT of the whole list. Last writer
  // wins; for a small corp tool that's fine and avoids per-row diff tracking.
  function saveDoctrine(updated) {
    setDoctrine(updated);
    doctrineLatestRef.current = updated;
    if (doctrineSaveTimer.current) clearTimeout(doctrineSaveTimer.current);
    doctrineSaveTimer.current = setTimeout(async () => {
      setDoctrineSyncing(true);
      setDoctrineSyncError(null);
      try {
        const token = await getAccessToken();
        if (!token) throw new Error("Not signed in");
        const res = await fetch("/api/inventory/doctrines", {
          method: "PUT",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({ entries: doctrineLatestRef.current }),
        });
        if (!res.ok) {
          const j = await res.json().catch(() => ({}));
          throw new Error(j.error || `doctrines ${res.status}`);
        }
        const json = await res.json().catch(() => ({}));
        if (json.changelog) setChangeLog(json.changelog);
        setDoctrineLastSync(Date.now());
      } catch (err) {
        setDoctrineSyncError(err.message);
      } finally {
        setDoctrineSyncing(false);
      }
    }, 600);
  }

  function addEntry() {
    const d = newDoc.trim().toUpperCase();
    const n = newName.trim();
    if (!d || !n) return;
    const entry = {
      id: crypto.randomUUID(),
      doctrine: d,
      name: n,
      target: newKeepOnHand ? Math.max(1, parseInt(newTarget, 10) || 1) : 0,
      fitting: newFitting.trim() || null,
    };
    saveDoctrine([...doctrine, entry]);
    setNewDoc(""); setNewName(""); setNewNameTouched(false);
    setNewTarget("1"); setNewKeepOnHand(true); setNewFitting("");
  }

  function removeEntry(id) {
    saveDoctrine(doctrine.filter((e) => e.id !== id));
    if (editFittingId === id) setEditFittingId(null);
    if (editingId === id) { setEditingId(null); setEditDraft(null); }
    setSelectedIds((prev) => { const n = new Set(prev); n.delete(id); return n; });
  }

  function bulkDelete() {
    if (selectedIds.size === 0) return;
    saveDoctrine(doctrine.filter((e) => !selectedIds.has(e.id)));
    setSelectedIds(new Set());
  }

  function bulkSetTarget() {
    const n = parseInt(bulkTargetDraft, 10);
    if (!isFinite(n) || n < 0) return;
    saveDoctrine(doctrine.map((e) =>
      selectedIds.has(e.id) ? { ...e, target: n } : e
    ));
    setBulkTargetDraft("");
    setSelectedIds(new Set());
  }

  function selectAllVisible() {
    setSelectedIds(new Set(doctrine.map((e) => e.id)));
  }

  function startEdit(entry) {
    setEditingId(entry.id);
    setEditDraft({ doctrine: entry.doctrine, name: entry.name, target: String(entry.target), fitting: entry.fitting ?? "" });
    setEditFittingId(null);
  }

  function saveEdit(id) {
    const old = doctrine.find((e) => e.id === id);
    const newDoc = editDraft.doctrine.trim().toUpperCase();
    const newName = editDraft.name.trim();
    const newTarget = Math.max(0, parseInt(editDraft.target, 10) || 0);
    const newFitting = editDraft.fitting.trim() || null;
    const updated = { ...old, doctrine: newDoc, name: newName, target: newTarget, fitting: newFitting };
    saveDoctrine(doctrine.map((e) => e.id === id ? updated : e));
    setEditingId(null);
    setEditDraft(null);
  }

  function cancelEdit() {
    setEditingId(null);
    setEditDraft(null);
  }

  function restoreEntry(logEntry) {
    saveDoctrine([...doctrine, {
      id: crypto.randomUUID(),
      doctrine: logEntry.doctrine,
      name: logEntry.name,
      target: logEntry.target ?? 1,
      fitting: logEntry.fitting ?? null,
    }]);
  }

  function updateTarget(id, val) {
    saveDoctrine(doctrine.map((e) =>
      e.id === id ? { ...e, target: Math.max(0, parseInt(val, 10) || 0) } : e
    ));
  }

  // Keep on hand = tracked for stock (target > 0). Unchecking parks the fit as
  // library-only reference (target 0); re-checking restores a default target.
  function setKeepOnHand(id, on) {
    saveDoctrine(doctrine.map((e) =>
      e.id === id ? { ...e, target: on ? Math.max(1, e.target) : 0 } : e
    ));
  }

  function copyFitting(key, fitting) {
    navigator.clipboard.writeText(fitting).catch(() => {});
    showToast("Copied to clipboard");
    clearTimeout(copyTimerRef.current);
    setCopiedKey(key);
    copyTimerRef.current = setTimeout(() => setCopiedKey(null), 1500);
  }

  function exportRestockList() {
    const needed = rows.filter(r => r.status === "needed" || r.status === "low");
    if (needed.length === 0) return;
    const lines = needed.map(r => {
      const deficit = r.target - r.currentStock;
      const px = suggestedPrices[r.key];
      const pxStr = px != null ? ` (~${fmt(px)} ea)` : "";
      return `[${r.doctrine}] ${r.name} — need ${deficit}${pxStr}`;
    });
    const text = `Restock List — ${new Date().toISOString().slice(0, 10)}\n` + lines.join("\n");
    navigator.clipboard.writeText(text).catch(() => {});
    showToast("Copied to clipboard");
    setRestockCopied(true);
    setTimeout(() => setRestockCopied(false), 2000);
  }

  // ── Sub-renderers ────────────────────────────────────────────────────────

  function renderStatusRow(row) {
    const stamp = pricesComputedAt[row.key];
    const isStale = stamp != null && Date.now() - stamp > PRICE_STALE_MS;
    const incompleteCount = row.incompleteContracts?.length ?? 0;
    const expanded = expandedStockRows.has(row.id);
    const canExpand = incompleteCount > 0 || row.unresolvedCount > 0;
    const burn = burnRateByKey.get(row.key);
    let burnLabel = null;
    let burnUrgent = false;
    if (burn && burn.perDay > 0) {
      const daysLeft = row.currentStock / burn.perDay;
      const perWeek = burn.perDay * 7;
      const rateLabel = perWeek >= 1 ? `${perWeek.toFixed(1)}/wk` : `${burn.perDay.toFixed(2)}/day`;
      if (row.currentStock === 0) {
        burnLabel = `~${rateLabel} sold`;
      } else if (daysLeft < 7) {
        burnLabel = `~${Math.max(1, Math.round(daysLeft))}d left (${rateLabel})`;
        burnUrgent = true;
      } else if (daysLeft < 30) {
        burnLabel = `~${Math.round(daysLeft)}d left (${rateLabel})`;
      } else {
        burnLabel = `${rateLabel}`;
      }
    }
    return (
      <React.Fragment key={row.id}>
      <tr data-status={row.status}>
        <td><span className={styles.docTag} style={docColor(row.doctrine)}>{row.doctrine}</span></td>
        <td>
          <span className={styles.fittingName}>{row.name}</span>
          {row.fitting && (
            <button
              className={copiedKey === row.key ? styles.btnCopied : styles.btnCopyFit}
              onClick={() => copyFitting(row.key, row.fitting)}
              title="Copy EFT fitting to clipboard"
            >
              {copiedKey === row.key ? "✓ COPIED" : "COPY FIT"}
            </button>
          )}
        </td>
        <td className={styles.num}>
          {contracts == null ? (
            <span className={styles.dim}>—</span>
          ) : (
            <div className={styles.stockCell}>
              <span className={
                row.status === "needed" ? styles.stockRed :
                row.status === "low"    ? styles.stockYellow :
                                          styles.stockGreen
              }>
                {row.currentStock}
              </span>
              {incompleteCount > 0 && (
                <button
                  type="button"
                  className={styles.incompleteBadge}
                  onClick={() => toggleStockRowExpand(row.id)}
                  title="Show which contracts are missing items"
                >
                  ⚠ {incompleteCount} incomplete
                </button>
              )}
              {incompleteCount === 0 && row.unresolvedCount > 0 && (
                <button
                  type="button"
                  className={styles.unresolvedBadge}
                  onClick={() => toggleStockRowExpand(row.id)}
                  title="Some fitting items couldn't be resolved to an EVE type"
                >
                  ⚠ {row.unresolvedCount} unresolved
                </button>
              )}
              {row.validationPending && incompleteCount === 0 && (
                <span className={styles.validationPending} title="Fetching contract items…">…</span>
              )}
              {!row.validationAvailable && row.fitting && (
                <span className={styles.validationUnavailable} title="Items not validated — title-only match">
                  no validation
                </span>
              )}
              {burnLabel && (
                <span
                  className={burnUrgent ? styles.burnUrgent : styles.burn}
                  title={`Sold ${burn.sold} in the last ${BURN_RATE_DAYS} days`}
                >
                  {burnLabel}
                </span>
              )}
            </div>
          )}
        </td>
        <td className={styles.num}>{row.target}</td>
        <td className={styles.num}>
          {row.avgListed == null ? (
            <span className={styles.dim}>—</span>
          ) : (() => {
            const sp = suggestedPrices[row.key];
            const spiked = sp != null && row.avgListed > sp * 1.5;
            return (
              <span style={spiked ? { color: "var(--danger)" } : undefined}
                    title={spiked ? "Contract prices are 50%+ above suggested — possible market spike" : undefined}>
                {spiked && "⚠ "}
                {fmt(row.avgListed)}
              </span>
            );
          })()}
        </td>
        <td className={styles.num}>
          {suggestedPrices[row.key] != null ? (
            <div className={styles.priceCell}>
              <span>{fmt(suggestedPrices[row.key])}</span>
              <button
                className={styles.priceRefresh}
                onClick={() => refreshPrice(row.key)}
                title="Recalculate this price"
              >↻</button>
              {stamp != null && (
                <span className={isStale ? styles.priceStale : styles.priceStamp}>
                  {timeAgo(stamp)}
                </span>
              )}
            </div>
          ) : pricingInFlight.has(row.key) ? (
            <span className={styles.dim}>calculating…</span>
          ) : (
            <span className={styles.dim}>—</span>
          )}
        </td>
        <td>
          {row.status === "in_stock" && <span className={styles.pillGreen}>In Stock</span>}
          {row.status === "low"      && <span className={styles.pillYellow}>Low Stock</span>}
          {row.status === "needed"   && <span className={styles.pillRed}>RESTOCK NEEDED</span>}
          {row.status == null        && <span className={styles.dim}>—</span>}
        </td>
        <td>
          <button
            className={styles.btnDanger}
            title="Remove doctrine entry"
            onClick={() => removeEntry(row.id)}
          >
            ✕
          </button>
        </td>
      </tr>
      {expanded && canExpand && (
        <tr className={styles.incompleteDetailRow}>
          <td colSpan={8}>
            <div className={styles.incompleteDetail}>
              {row.unresolvedCount > 0 && (
                <div className={styles.incompleteWarn}>
                  ⚠ {row.unresolvedCount} fitting item{row.unresolvedCount === 1 ? "" : "s"} could not be resolved to an EVE type — those items are not checked against contracts. Fix typos in the EFT to enable full validation.
                </div>
              )}
              {incompleteCount > 0 && (
                <>
                  <div className={styles.incompleteHeader}>
                    Incomplete contracts ({incompleteCount}) — contain extra items but are missing required fitting items:
                  </div>
                  {row.incompleteContracts.map(({ contract, missing }) => {
                    const issuer = contract.issuer_id ? characterNames[contract.issuer_id] : null;
                    const pingKey = `${row.id}:${contract.contract_id}`;
                    return (
                      <div key={contract.contract_id} className={styles.incompleteContract}>
                        <div className={styles.incompleteContractTitle}>
                          <span className={styles.incompleteContractName}>{contract.title || "(no title)"}</span>
                          <span className={styles.incompleteContractId}>#{contract.contract_id}</span>
                          {issuer ? (
                            <span className={styles.incompleteIssuer}>by <strong>{issuer}</strong></span>
                          ) : contract.issuer_id ? (
                            <span className={styles.incompleteIssuer}>by #{contract.issuer_id}</span>
                          ) : null}
                          <button
                            type="button"
                            className={copiedPingKey === pingKey ? styles.btnCopied : styles.btnPing}
                            onClick={() => copyIncompletePing(row, contract, missing)}
                            title="Copy a Discord-ready ping with issuer + missing items"
                          >
                            {copiedPingKey === pingKey ? "✓ COPIED" : "📋 PING"}
                          </button>
                        </div>
                        <ul className={styles.missingList}>
                          {missing.map((m) => (
                            <li key={m.type_id}>
                              <span className={styles.missingName}>{m.name}</span>
                              <span className={styles.missingQty}>
                                need {m.need}, have {m.have}
                                <span className={styles.missingShortfall}> (short {m.need - m.have})</span>
                              </span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    );
                  })}
                </>
              )}
            </div>
          </td>
        </tr>
      )}
      </React.Fragment>
    );
  }

  // ── Doctrine bulletin notes ──────────────────────────────────────────────

  function startEditNote(tag) {
    setEditingNoteTag(tag);
    setNoteDraft(doctrineNotes[tag]?.notes ?? "");
    setNoteError(null);
  }

  function cancelEditNote() {
    setEditingNoteTag(null);
    setNoteDraft("");
    setNoteError(null);
  }

  // Notes are saved one doctrine at a time via PATCH, so concurrent edits to
  // different doctrines don't clobber each other (unlike the replace-all PUT).
  async function saveNote(tag) {
    setNoteSaving(true);
    setNoteError(null);
    try {
      const token = await getAccessToken();
      if (!token) throw new Error("Not signed in");
      const res = await fetch("/api/inventory/doctrines", {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ doctrine: tag, notes: noteDraft }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || `notes ${res.status}`);
      }
      const json = await res.json().catch(() => ({}));
      if (json.notes) setDoctrineNotes(json.notes);
      setEditingNoteTag(null);
      setNoteDraft("");
    } catch (err) {
      setNoteError(err.message);
    } finally {
      setNoteSaving(false);
    }
  }

  // The bulletin block shown under each doctrine heading in the library.
  function renderDoctrineNote(tag) {
    const note = doctrineNotes[tag];
    const text = note?.notes ?? "";

    // Tint the bulletin with the doctrine's own hue so it reads as part of
    // that doctrine and stands out from the dark page.
    const dc = docColor(tag);
    const noteStyle = {
      background: hexToRgba(dc.color, 0.13),
      borderColor: dc.borderColor,
      borderLeftColor: dc.color,
      boxShadow: `0 2px 14px ${hexToRgba(dc.color, 0.12)}`,
    };

    if (editingNoteTag === tag) {
      return (
        <div className={styles.docNotes} style={noteStyle}>
          <div className={styles.docNotesBar}>
            <span className={styles.docNotesLabel} style={{ color: dc.color }}>BULLETIN</span>
          </div>
          <textarea
            className={styles.fittingTextarea}
            value={noteDraft}
            rows={5}
            placeholder={"Game plan, tips & tricks, doctrine notes…"}
            onChange={(e) => setNoteDraft(e.target.value)}
            autoFocus
          />
          {noteError && <div className={styles.docNotesError}>{noteError}</div>}
          <div className={styles.docNotesActions}>
            <button className={styles.btnSm} onClick={() => saveNote(tag)} disabled={noteSaving}>
              {noteSaving ? "SAVING…" : "✓ SAVE"}
            </button>
            <button className={styles.btnSm} onClick={cancelEditNote} disabled={noteSaving}>
              CANCEL
            </button>
          </div>
        </div>
      );
    }

    if (!text.trim()) {
      return (
        <button
          className={styles.docNotesAdd}
          style={{ borderColor: dc.borderColor, color: dc.color, background: hexToRgba(dc.color, 0.07) }}
          onClick={() => startEditNote(tag)}
        >
          + Add bulletin notes for {tag}
        </button>
      );
    }

    return (
      <div className={styles.docNotes} style={noteStyle}>
        <div className={styles.docNotesBar}>
          <span className={styles.docNotesLabel} style={{ color: dc.color }}>BULLETIN</span>
          {note?.updatedBy && (
            <span className={styles.docNotesMeta}>
              {note.updatedBy}
              {note.updatedAt ? ` · ${timeAgo(new Date(note.updatedAt).getTime())}` : ""}
            </span>
          )}
          <button className={styles.docNotesEdit} onClick={() => startEditNote(tag)}>
            EDIT
          </button>
        </div>
        <div className={styles.docNotesBody}>{text}</div>
      </div>
    );
  }

  // ── Main view ────────────────────────────────────────────────────────────

  return (
    <div className={styles.root}>
      <Tabs value={sub} onChange={onSubChange} options={INV_SUB_OPTIONS} variant="sub" />

      {/* ══ DOCTRINES sub-tab ════════════════════════════════════════════════ */}
      {sub === "doctrines" && (
        <>

      {/* ── Fitting Library ──────────────────────────────────────────────── */}
      {doctrineLoading ? (
        <div className={styles.empty}>Loading doctrine fittings…</div>
      ) : doctrine.length === 0 ? (
        <div className={styles.fitLibraryEmpty}>
          No doctrines configured yet. Use <strong>Doctrine Configuration</strong> below to add fittings.
        </div>
      ) : (
        <>
          {/* Doctrine filter pills + text search */}
          <div className={styles.docFilterBar}>
            <span className={styles.docFilterLabel}>FILTER</span>
            <button
              className={`${styles.docFilterPill} ${!docFilter ? styles.docFilterPillActive : ""}`}
              onClick={() => { setDocFilter(null); setSelectedFitId(null); }}
            >ALL</button>
            {[...new Set(doctrine.map((e) => e.doctrine))].sort().map((tag) => (
              <button
                key={tag}
                className={`${styles.docFilterPill} ${docFilter === tag ? styles.docFilterPillActive : ""}`}
                style={docFilter === tag ? docColor(tag) : undefined}
                onClick={() => { setDocFilter(docFilter === tag ? null : tag); setSelectedFitId(null); }}
              >{tag}</button>
            ))}
            <span className={styles.docFilterSep} />
            <button
              className={styles.docFilterPill}
              onClick={() => setExpandedLibGroups([...new Set(doctrine.map((e) => e.doctrine))])}
              title="Expand every doctrine"
            >EXPAND ALL</button>
            <button
              className={styles.docFilterPill}
              onClick={() => setExpandedLibGroups([])}
              title="Collapse every doctrine"
            >COLLAPSE ALL</button>
            <input
              type="text"
              className={styles.docSearchInput}
              placeholder="Search ship or fitting name…"
              value={docSearch}
              onChange={(e) => setDocSearch(e.target.value)}
            />
          </div>

          {/* Fitting card grid — grouped by doctrine ticker */}
          <div className={styles.fitCardGroups}>
            {(() => {
              const q = docSearch.trim().toLowerCase();
              const visible = sortedDoctrine.filter((e) => {
                if (docFilter && e.doctrine !== docFilter) return false;
                if (!q) return true;
                const ship = (parseEftHeader(e.fitting)?.ship ?? "").toLowerCase();
                return e.name.toLowerCase().includes(q) || ship.includes(q);
              });
              if (visible.length === 0) {
                return (
                  <div className={styles.fitLibraryEmpty}>
                    No fittings match the current filter or search.
                  </div>
                );
              }
              const groups = new Map();
              for (const entry of visible) {
                if (!groups.has(entry.doctrine)) groups.set(entry.doctrine, []);
                groups.get(entry.doctrine).push(entry);
              }
              return [...groups.entries()].map(([tag, entries]) => {
                // Force-expand when filtering/searching so results stay visible.
                const expanded = expandedLibSet.has(tag) || docFilter === tag || q.length > 0;
                const needRestock = entries.reduce((n, e) => {
                  const s = statusByEntryId.get(e.id);
                  return n + (s && (s.status === "low" || s.status === "needed") ? 1 : 0);
                }, 0);
                return (
                <div key={tag} className={styles.fitCardGroup}>
                  <button
                    type="button"
                    className={styles.fitCardGroupHeader}
                    style={{ borderColor: docColor(tag).borderColor }}
                    onClick={() => toggleLibGroup(tag)}
                    aria-expanded={expanded}
                  >
                    <span className={styles.caret}>{expanded ? "▾" : "▸"}</span>
                    <span className={styles.docTag} style={docColor(tag)}>{tag}</span>
                    <span className={styles.fitCardGroupCount}>
                      {entries.length} {entries.length === 1 ? "fit" : "fits"}
                    </span>
                    {needRestock > 0 && (
                      <span className={styles.fitCardGroupAlert}>
                        {needRestock} need restock
                      </span>
                    )}
                  </button>
                  {renderDoctrineNote(tag)}
                  {expanded && (
                  <div className={styles.fitCardGrid}>
                    {entries.map((entry) => {
                      const header = parseEftHeader(entry.fitting);
                      const isSelected = selectedFitId === entry.id;
                      const referenceOnly = !(entry.target > 0);
                      const stockRow = statusByEntryId.get(entry.id);
                      const select = () => setSelectedFitId(isSelected ? null : entry.id);
                      return (
                        <div
                          key={entry.id}
                          role="button"
                          tabIndex={0}
                          className={`${styles.fitCard} ${isSelected ? styles.fitCardSelected : ""}`}
                          onClick={select}
                          onKeyDown={(e) => {
                            if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) {
                              e.preventDefault();
                              select();
                            }
                          }}
                        >
                          <div className={styles.fitCardTop}>
                            <span className={styles.docTag} style={docColor(entry.doctrine)}>{entry.doctrine}</span>
                            {!entry.fitting ? (
                              <span className={styles.fitCardNoEft}>no fit</span>
                            ) : (() => {
                              const priceKey = `${entry.doctrine}|${entry.name}`;
                              const price = suggestedPrices[priceKey];
                              if (price != null) {
                                return (
                                  <span className={styles.fitCardPrice} title="Estimated fit cost — Jita sell + 10% markup">
                                    ≈ {fmt(price)}
                                  </span>
                                );
                              }
                              return (
                                <span className={styles.fitCardPriceDim}>
                                  {pricingInFlight.has(priceKey) ? "pricing…" : "≈ —"}
                                </span>
                              );
                            })()}
                          </div>
                          <div className={styles.fitCardShip}>
                            {header?.ship ?? <span className={styles.dim}>—</span>}
                          </div>
                          <div className={styles.fitCardName}>{entry.name}</div>
                          <div className={styles.fitCardMeta}>
                            {referenceOnly ? (
                              <span className={styles.fitCardReference} title="Reference only — not tracked for stock">
                                REFERENCE
                              </span>
                            ) : stockRow?.status === "in_stock" ? (
                              <span className={styles.pillGreen}>In Stock {stockRow.currentStock}/{stockRow.target}</span>
                            ) : stockRow?.status === "low" ? (
                              <span className={styles.pillYellow}>Low {stockRow.currentStock}/{stockRow.target}</span>
                            ) : stockRow?.status === "needed" ? (
                              <span className={styles.pillRed}>Restock 0/{stockRow.target}</span>
                            ) : (
                              <span className={styles.dim}>stock unknown</span>
                            )}
                            {entry.fitting && (
                              <button
                                className={copiedKey === entry.id ? styles.btnCopied : styles.btnCopyFit}
                                onClick={(e) => { e.stopPropagation(); copyFitting(entry.id, entry.fitting); }}
                                title="Copy EFT fitting to clipboard"
                              >
                                {copiedKey === entry.id ? "✓ COPIED" : "COPY EFT"}
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  )}
                </div>
                );
              });
            })()}
          </div>

          {/* Detail panel — plain EFT copy/paste view of the selected fit */}
          {selectedFitEntry && (
            <div className={styles.fitDetailPanel}>
              <div className={styles.fitDetailHeader}>
                <span className={styles.docTag} style={docColor(selectedFitEntry.doctrine)}>
                  {selectedFitEntry.doctrine}
                </span>
                {(() => {
                  const h = parseEftHeader(selectedFitEntry.fitting);
                  return h ? <span className={styles.fitDetailShip}>{h.ship}</span> : null;
                })()}
                <span className={styles.fitDetailFitName}>{selectedFitEntry.name}</span>
                {(() => {
                  const key = `${selectedFitEntry.doctrine}|${selectedFitEntry.name}`;
                  const price = suggestedPrices[key];
                  if (price != null) {
                    return (
                      <span className={styles.fitDetailPrice} title="Suggested contract price (Jita sell + 10% markup)">
                        ≈ {fmt(price)} ISK
                      </span>
                    );
                  }
                  if (pricingInFlight.has(key)) {
                    return <span className={styles.fitDetailPriceDim}>calculating…</span>;
                  }
                  if (!selectedFitEntry.fitting) return null;
                  return <span className={styles.fitDetailPriceDim}>price pending</span>;
                })()}
                <div className={styles.fitDetailActions}>
                  {selectedFitEntry.fitting && (
                    <button
                      className={copiedKey === selectedFitEntry.id ? styles.btnCopied : styles.btnCopyFit}
                      style={{ marginLeft: 0 }}
                      onClick={() => copyFitting(selectedFitEntry.id, selectedFitEntry.fitting)}
                    >
                      {copiedKey === selectedFitEntry.id ? "✓ COPIED" : "COPY EFT"}
                    </button>
                  )}
                  <button className={styles.fitDetailClose} onClick={() => setSelectedFitId(null)}>✕</button>
                </div>
              </div>

              {selectedFitEntry.fitting ? (
                <pre className={styles.fitEftBlock}>{selectedFitEntry.fitting}</pre>
              ) : (
                <div className={styles.fitNoData}>
                  No fitting data — edit this entry in Doctrine Configuration below to add an EFT fitting.
                </div>
              )}
            </div>
          )}
        </>
      )}

      {/* ── Doctrine config ──────────────────────────────────────────────── */}
      <div className={styles.collapsible}>
        <button className={styles.collapseToggle} onClick={() => setShowConfig((v) => !v)}>
          <span className={styles.caret}>{showConfig ? "▾" : "▸"}</span>
          Doctrine Configuration
          <span className={styles.configCount}>{doctrine.length} {doctrine.length === 1 ? "entry" : "entries"}</span>
          <span className={styles.configCount} style={{ marginLeft: "auto" }}>
            {doctrineLoading ? "loading…"
              : doctrineSyncing ? "syncing…"
              : doctrineSyncError ? <span style={{ color: "var(--danger)" }}>sync error</span>
              : doctrineLastSync ? <>shared with corp · synced {timeAgo(doctrineLastSync)}</>
              : "shared with corp"}
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); refreshDoctrine(); }}
              className={styles.refreshSm}
              title="Refresh doctrine list from the server"
            >↻</button>
          </span>
        </button>
        {showConfig && (
          <div className={styles.configPanel}>
            {doctrine.length > 0 && (
              <table className={styles.configTable}>
                <thead>
                  <tr>
                    <th style={{ width: 28 }}>
                      <input
                        type="checkbox"
                        checked={selectedIds.size > 0 && selectedIds.size === doctrine.length}
                        onChange={(e) => {
                          if (e.target.checked) selectAllVisible();
                          else setSelectedIds(new Set());
                        }}
                        title="Select all"
                      />
                    </th>
                    <th>Doctrine</th>
                    <th>Fitting Name</th>
                    <th>Contract Title Pattern</th>
                    <th>Keep on hand</th>
                    <th>Ship Fitting</th>
                    <th></th>
                  </tr>
                </thead>
                {configGroups.map((g) => (
                  <tbody key={g.tag}>
                    <tr className={styles.configGroupHeader}>
                      <td colSpan={7}>
                        <button
                          className={styles.groupToggle}
                          onClick={() => toggleConfigGroup(g.tag)}
                        >
                          <span className={styles.caret}>
                            {collapsedConfigSet.has(g.tag) ? "▸" : "▾"}
                          </span>
                          <span className={styles.docTag} style={docColor(g.tag)}>{g.tag}</span>
                          <span className={styles.groupSummary}>
                            {g.entries.length} {g.entries.length === 1 ? "entry" : "entries"}
                          </span>
                        </button>
                      </td>
                    </tr>
                    {!collapsedConfigSet.has(g.tag) && g.entries.map((entry) => (
                      editingId === entry.id ? (
                        <React.Fragment key={entry.id}>
                          <tr className={styles.editRow}>
                            <td></td>
                            <td>
                              <input
                                className={styles.addInput}
                                value={editDraft.doctrine}
                                onChange={(e) => setEditDraft((d) => ({ ...d, doctrine: e.target.value.toUpperCase() }))}
                                style={{ width: 90 }}
                              />
                            </td>
                            <td>
                              <input
                                className={styles.addInput}
                                value={editDraft.name}
                                onChange={(e) => setEditDraft((d) => ({ ...d, name: e.target.value }))}
                                style={{ width: "100%" }}
                              />
                            </td>
                            <td className={styles.patternCell}>
                              <code>{editDraft.doctrine} - {editDraft.name}</code>
                            </td>
                            <td>
                              <label className={styles.keepLabel} title="Keep on hand — track this fit in Stock Status">
                                <input
                                  type="checkbox"
                                  checked={Number(editDraft.target) > 0}
                                  onChange={(e) => setEditDraft((d) => ({
                                    ...d,
                                    target: e.target.checked ? String(Math.max(1, parseInt(d.target, 10) || 0)) : "0",
                                  }))}
                                />
                                {Number(editDraft.target) > 0 ? (
                                  <input
                                    type="number"
                                    className={styles.targetInput}
                                    value={editDraft.target}
                                    min="1"
                                    onChange={(e) => setEditDraft((d) => ({ ...d, target: e.target.value }))}
                                  />
                                ) : (
                                  <span className={styles.keepRef}>reference</span>
                                )}
                              </label>
                            </td>
                            <td></td>
                            <td className={styles.editActions}>
                              <button className={styles.btnSm} onClick={() => saveEdit(entry.id)}>✓ SAVE</button>
                              <button className={styles.btnSm} onClick={cancelEdit}>CANCEL</button>
                            </td>
                          </tr>
                          <tr className={styles.fittingRow}>
                            <td colSpan={7} className={styles.fittingCell}>
                              <div className={styles.fittingEditor}>
                                <div className={styles.fittingLabel}>Ship Fitting (EFT format — paste from in-game fitting tool)</div>
                                <textarea
                                  className={styles.fittingTextarea}
                                  value={editDraft.fitting}
                                  placeholder={"[Ship Name, Fit Name]\n\nHigh slot 1\nHigh slot 2\n..."}
                                  rows={8}
                                  onChange={(e) => setEditDraft((d) => ({ ...d, fitting: e.target.value }))}
                                />
                              </div>
                            </td>
                          </tr>
                        </React.Fragment>
                      ) : (
                        <React.Fragment key={entry.id}>
                          <tr>
                            <td>
                              <input
                                type="checkbox"
                                checked={selectedIds.has(entry.id)}
                                onChange={() => toggleSelected(entry.id)}
                              />
                            </td>
                            <td><span className={styles.docTag} style={docColor(entry.doctrine)}>{entry.doctrine}</span></td>
                            <td>{entry.name}</td>
                            <td className={styles.patternCell}>
                              <code>{entry.doctrine} - {entry.name}</code>
                            </td>
                            <td>
                              <label className={styles.keepLabel} title="Keep on hand — track this fit in Stock Status">
                                <input
                                  type="checkbox"
                                  checked={entry.target > 0}
                                  onChange={(e) => setKeepOnHand(entry.id, e.target.checked)}
                                />
                                {entry.target > 0 ? (
                                  <input
                                    type="number"
                                    className={styles.targetInput}
                                    value={entry.target}
                                    min="1"
                                    onChange={(e) => updateTarget(entry.id, e.target.value)}
                                  />
                                ) : (
                                  <span className={styles.keepRef}>reference</span>
                                )}
                              </label>
                            </td>
                            <td>
                              {entry.fitting ? (
                                <button
                                  className={styles.fittingToggle}
                                  onClick={() => toggleFittingExpand(entry.id)}
                                >
                                  <span className={styles.caret}>{expandedFittings.has(entry.id) ? "▾" : "▸"}</span>
                                  {" FITTING"}
                                </button>
                              ) : (
                                <span className={styles.dim}>—</span>
                              )}
                            </td>
                            <td className={styles.editActions}>
                              <button className={styles.btnSm} onClick={() => startEdit(entry)}>EDIT</button>
                              <button className={styles.btnDanger} onClick={() => removeEntry(entry.id)}>✕</button>
                            </td>
                          </tr>
                          {expandedFittings.has(entry.id) && entry.fitting && (() => {
                            const header = parseEftHeader(entry.fitting);
                            const items = parseEftFitting(entry.fitting).filter(
                              (it) => !header || it.name !== header.ship
                            );
                            return (
                              <tr className={styles.fittingDropRow}>
                                <td colSpan={7} className={styles.fittingDropCell}>
                                  <div className={styles.fittingPreview}>
                                    {header && (
                                      <div className={styles.fittingPreviewHeader}>
                                        <span className={styles.fittingPreviewShip}>{header.ship}</span>
                                        {header.fitName && (
                                          <span className={styles.fittingPreviewFitName}>{header.fitName}</span>
                                        )}
                                      </div>
                                    )}
                                    <div className={styles.fittingPreviewItems}>
                                      {items.map((item, i) => (
                                        <span key={i} className={styles.fittingPreviewItem}>
                                          {item.qty > 1 && <span className={styles.fittingPreviewQty}>{item.qty}×</span>}
                                          {item.name}
                                        </span>
                                      ))}
                                    </div>
                                  </div>
                                </td>
                              </tr>
                            );
                          })()}
                        </React.Fragment>
                      )
                    ))}
                  </tbody>
                ))}
              </table>
            )}
            {selectedIds.size > 0 && (
              <div className={styles.bulkBar}>
                <span className={styles.bulkLabel}>{selectedIds.size} selected</span>
                <button className={styles.btnDanger} onClick={bulkDelete}>
                  🗑 DELETE {selectedIds.size}
                </button>
                <div className={styles.bulkTargetBlock}>
                  <input
                    type="number"
                    className={styles.targetInput}
                    placeholder="N"
                    value={bulkTargetDraft}
                    min="0"
                    onChange={(e) => setBulkTargetDraft(e.target.value)}
                    style={{ width: 60 }}
                  />
                  <button
                    className={styles.btnSm}
                    onClick={bulkSetTarget}
                    disabled={bulkTargetDraft === ""}
                  >
                    SET TARGET
                  </button>
                </div>
                <button className={styles.btnSm} onClick={() => setSelectedIds(new Set())}>
                  ☐ DESELECT ALL
                </button>
              </div>
            )}
            {/* EFT-paste-first add flow — paste a fit, the ship & name are
                detected from the EFT header; the name stays editable. */}
            <div className={styles.addPanel}>
              <div className={styles.addPanelTitle}>Add a fitting</div>
              <textarea
                className={styles.fittingTextarea}
                value={newFitting}
                placeholder={"Paste an EFT fitting here — ship & name are detected automatically\n\n[Ship Name, Fit Name]\nHigh slot 1\n..."}
                rows={5}
                onChange={(e) => setNewFitting(e.target.value)}
              />
              {(() => {
                const h = parseEftHeader(newFitting);
                if (h) {
                  return (
                    <div className={styles.addDetected}>
                      detected: <strong>{h.ship}</strong>
                      {h.fitName ? <> — {h.fitName}</> : null}
                    </div>
                  );
                }
                if (newFitting.trim()) {
                  return (
                    <div className={styles.addDetectedDim}>
                      no valid EFT header found — enter a fitting name manually below
                    </div>
                  );
                }
                return (
                  <div className={styles.addDetectedDim}>
                    optional — leave blank for a reference-only entry, or type a name below
                  </div>
                );
              })()}
              <datalist id="doctrine-tags">
                {[...new Set(doctrine.map((e) => e.doctrine))].sort().map((t) => (
                  <option key={t} value={t} />
                ))}
              </datalist>
              <div className={styles.addRow}>
                <input
                  className={styles.addInput}
                  placeholder="DOCTRINE"
                  list="doctrine-tags"
                  value={newDoc}
                  onChange={(e) => setNewDoc(e.target.value.toUpperCase())}
                  onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.nextElementSibling?.focus(); }}
                  style={{ width: 130 }}
                />
                <input
                  className={styles.addInput}
                  placeholder="Fitting Name"
                  value={newName}
                  onChange={(e) => { setNewName(e.target.value); setNewNameTouched(true); }}
                  onKeyDown={(e) => { if (e.key === "Enter" && newDoc.trim() && newName.trim()) addEntry(); }}
                  style={{ flex: 1, minWidth: 160 }}
                />
                <label className={styles.keepLabel} title="Keep on hand — track this fit in Stock Status">
                  <input
                    type="checkbox"
                    checked={newKeepOnHand}
                    onChange={(e) => setNewKeepOnHand(e.target.checked)}
                  />
                  Keep on hand
                </label>
                {newKeepOnHand && (
                  <input
                    type="number"
                    className={styles.targetInput}
                    placeholder="Target"
                    value={newTarget}
                    min="1"
                    onChange={(e) => setNewTarget(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter" && newDoc.trim() && newName.trim()) addEntry(); }}
                    style={{ width: 72 }}
                  />
                )}
                <button
                  className={styles.btn}
                  onClick={addEntry}
                  disabled={!newDoc.trim() || !newName.trim()}
                >
                  + ADD
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* ── Contract Naming Guide ────────────────────────────────────────── */}
      <div className={styles.collapsible}>
        <button className={styles.collapseToggle} onClick={() => setShowGuide((v) => !v)}>
          <span className={styles.caret}>{showGuide ? "▾" : "▸"}</span>
          Contract Naming Guide
        </button>
        {showGuide && (
          <div className={styles.guide}>
            <p>
              Contracts are matched by their <strong>title</strong> using the pattern below.
              The doctrine tag is case-insensitive; the fitting name must match exactly as configured.
            </p>
            <pre className={styles.guidePattern}>DOCTRINE - Fitting Name</pre>
            <table className={styles.guideTable}>
              <thead>
                <tr><th>Doctrine tag</th><th>Fitting name</th><th>Required contract title</th></tr>
              </thead>
              <tbody>
                <tr><td>AKITE</td><td>Sentinel Spendy</td><td><code>AKITE - Sentinel Spendy</code></td></tr>
                <tr><td>AKITE</td><td>Brutix Navy Issue</td><td><code>AKITE - Brutix Navy Issue</code></td></tr>
                <tr><td>ABRAWL</td><td>Exequror Navy Issue</td><td><code>ABRAWL - Exequror Navy Issue</code></td></tr>
              </tbody>
            </table>
            <ul className={styles.guideRules}>
              <li>Contract type must be <strong>Item Exchange</strong></li>
              <li>Contract status must be <strong>Outstanding</strong></li>
              <li>Availability must be <strong>My Corporation</strong></li>
              <li>Extra spaces in the title will break matching</li>
            </ul>
          </div>
        )}
      </div>

      {/* ── Recent Changes ──────────────────────────────────────────────── */}
      <div className={styles.collapsible}>
        <button className={styles.collapseToggle} onClick={() => setShowChangeLog((v) => !v)}>
          <span className={styles.caret}>{showChangeLog ? "▾" : "▸"}</span>
          Recent Changes
          <span className={styles.configCount}>{changeLog.length} {changeLog.length === 1 ? "entry" : "entries"}</span>
        </button>
        {showChangeLog && (
          <div className={styles.deletionLogPanel}>
            {changeLog.length === 0 ? (
              <div className={styles.allContractsEmpty}>No changes recorded yet.</div>
            ) : (
                <table className={styles.allContractsTable}>
                  <thead>
                    <tr>
                      <th>When</th>
                      <th>By</th>
                      <th>Action</th>
                      <th>Doctrine</th>
                      <th>Fitting</th>
                      <th>Changes</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {changeLog.map((entry) => {
                      const eftToMap = (text) => {
                        if (!text) return new Map();
                        const m = new Map();
                        for (const { name, qty } of parseEftFitting(text)) m.set(name, (m.get(name) ?? 0) + qty);
                        return m;
                      };
                      return (
                        <tr key={entry.logId}>
                          <td className={styles.logTime}>{timeAgo(entry.at)}</td>
                          <td className={styles.logBy}>{entry.by}</td>
                          <td>
                            <span className={`${styles.changeTypeBadge} ${styles["changeType_" + entry.type]}`}>
                              {entry.type.toUpperCase()}
                            </span>
                          </td>
                          <td><span className={styles.docTag} style={docColor(entry.doctrine)}>{entry.doctrine}</span></td>
                          <td>{entry.name}</td>
                          <td className={styles.changesCell}>
                            {entry.type !== "edited" ? (
                              <span className={styles.dim}>target {entry.target}{entry.fitting ? " · fit ✓" : ""}</span>
                            ) : (
                              (entry.changes ?? []).map((c, i) => {
                                if (c.field === "fitting") {
                                  const oldMap = eftToMap(c.from);
                                  const newMap = eftToMap(c.to);
                                  const added = [], removed = [];
                                  for (const [name, qty] of newMap) {
                                    const diff = qty - (oldMap.get(name) ?? 0);
                                    if (diff > 0) added.push(`${name} ×${diff}`);
                                  }
                                  for (const [name, qty] of oldMap) {
                                    const after = newMap.get(name) ?? 0;
                                    if (qty > after) removed.push(`${name} ×${qty - after}`);
                                  }
                                  if (added.length === 0 && removed.length === 0) {
                                    return <div key={i} className={styles.dim}>fitting updated</div>;
                                  }
                                  return (
                                    <div key={i} className={styles.fittingDiff}>
                                      {added.map((s, j) => <span key={"a" + j} className={styles.diffAdded}>+{s}</span>)}
                                      {removed.map((s, j) => <span key={"r" + j} className={styles.diffRemoved}>−{s}</span>)}
                                    </div>
                                  );
                                }
                                return (
                                  <div key={i} className={styles.changeField}>
                                    <span className={styles.changeFieldName}>{c.field}</span>
                                    <span className={styles.dim}>{String(c.from ?? "—")} → {String(c.to ?? "—")}</span>
                                  </div>
                                );
                              })
                            )}
                          </td>
                          <td>
                            {entry.type === "deleted" && (
                              <button className={styles.btnSm} onClick={() => restoreEntry(entry)}>
                                ↩ RESTORE
                              </button>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
            )}
          </div>
        )}
      </div>

        </> /* end doctrines */
      )}

      {/* ══ STOCK STATUS sub-tab ══════════════════════════════════════════ */}
      {sub === "status" && (
        <>

      {/* Top bar */}
      <div className={styles.topBar}>
        <span className={styles.refreshedAt}>
          Last refreshed: {lastRefreshed ? timeAgo(lastRefreshed) : "never"}
        </span>
        <button className={styles.btn} onClick={fetchContracts} disabled={loading}>
          {loading ? "LOADING..." : "↻ REFRESH"}
        </button>
      </div>

      {fetchError && (
        <div className={styles.errBar}>{fetchError}</div>
      )}

      {contracts == null && doctrine.length === 0 && !fetchError && (
        <div className={styles.firstRun}>
          <div className={styles.firstRunTitle}>WELCOME TO INVENTORY</div>
          <div className={styles.firstRunBody}>
            Track corp doctrine stock against live contracts in Jita.
            <ol className={styles.firstRunSteps}>
              <li>Add doctrines in the <strong>Doctrines</strong> tab — paste an EFT fitting and set a target stock.</li>
              <li>Hit <strong>↻ REFRESH</strong> above to pull current corp contracts from ESI.</li>
              <li>The status table will show what's stocked, low, or needs restocking.</li>
            </ol>
          </div>
        </div>
      )}

      {/* ── Sticky KPI bar ──────────────────────────────────────────────── */}
      <div className={styles.kpiBar}>
        <button
          className={`${styles.kpiTile} ${styles.kpiNeeded} ${filterStatuses.has("needed") ? styles.kpiActive : ""}`}
          onClick={() => toggleFilterStatus("needed")}
          title="Filter to NEEDED rows"
        >
          <span className={styles.kpiVal}>{contracts == null ? "—" : kpi.needed}</span>
          <span className={styles.kpiLabel}>Needed</span>
        </button>
        <button
          className={`${styles.kpiTile} ${styles.kpiLow} ${filterStatuses.has("low") ? styles.kpiActive : ""}`}
          onClick={() => toggleFilterStatus("low")}
          title="Filter to LOW rows"
        >
          <span className={styles.kpiVal}>{contracts == null ? "—" : kpi.low}</span>
          <span className={styles.kpiLabel}>Low</span>
        </button>
        <button
          className={`${styles.kpiTile} ${styles.kpiInStock} ${filterStatuses.has("in_stock") ? styles.kpiActive : ""}`}
          onClick={() => toggleFilterStatus("in_stock")}
          title="Filter to IN STOCK rows"
        >
          <span className={styles.kpiVal}>{contracts == null ? "—" : kpi.inStock}</span>
          <span className={styles.kpiLabel}>In Stock</span>
        </button>
        <div className={`${styles.kpiTile} ${styles.kpiIncomplete}`} title="Title-matched contracts that are missing required fitting items">
          <span className={styles.kpiVal}>
            {contracts == null ? "—" : kpi.incomplete}
          </span>
          <span className={styles.kpiLabel}>Incomplete</span>
        </div>
        <div className={`${styles.kpiTile} ${styles.kpiCost}`}>
          <span className={styles.kpiVal}>
            {contracts == null ? "—" : restockCost.total > 0 ? fmt(restockCost.total) : "0"}
          </span>
          <span className={styles.kpiLabel}>
            Restock Cost
            {restockCost.unknown > 0 && (
              <span className={styles.kpiPending}> · {restockCost.unknown} pending</span>
            )}
          </span>
        </div>
      </div>

      {/* ── Doctrine contract status table ───────────────────────────────── */}
      <div className={styles.collapsible}>
        <button className={styles.collapseToggle} onClick={() => setShowStatusTable((v) => !v)}>
          <span className={styles.caret}>{showStatusTable ? "▾" : "▸"}</span>
          Doctrine Status
          {contracts != null && rows.length > 0 && (
            <span className={styles.configCount}>
              <span className={styles.stockRed}>{kpi.needed} needed</span>
              {" · "}
              <span className={styles.stockYellow}>{kpi.low} low</span>
              {" · "}
              <span className={styles.stockGreen}>{kpi.inStock} in stock</span>
              {kpi.incomplete > 0 && (
                <>
                  {" · "}
                  <span className={styles.incompleteSummary}>⚠ {kpi.incomplete} incomplete</span>
                </>
              )}
              {restockCost.total > 0 && (
                <>
                  {" · Restock: "}
                  <span className={styles.stockRed}>{fmt(restockCost.total)}</span>
                  {" "}
                  <span className={styles.dim}>
                    ({restockCost.known} priced{restockCost.unknown > 0 ? `, ${restockCost.unknown} pending` : ""})
                  </span>
                </>
              )}
            </span>
          )}
        </button>
        {showStatusTable && (
          doctrine.length === 0 ? (
            <div className={styles.empty}>
              Add doctrine entries above to start tracking contracts.
            </div>
          ) : (
            <>
              <div className={styles.filterBar}>
                <input
                  type="text"
                  className={styles.filterInput}
                  placeholder="Filter by doctrine or fitting name…"
                  value={filterQ}
                  onChange={(e) => setFilterQ(e.target.value)}
                />
                <div className={styles.filterPills}>
                  {[
                    { key: "needed", label: "NEEDED", cls: styles.pillRed },
                    { key: "low", label: "LOW", cls: styles.pillYellow },
                    { key: "in_stock", label: "IN STOCK", cls: styles.pillGreen },
                  ].map((p) => (
                    <button
                      key={p.key}
                      className={`${styles.filterPill} ${p.cls} ${filterStatuses.has(p.key) ? styles.filterPillActive : ""}`}
                      onClick={() => toggleFilterStatus(p.key)}
                    >
                      {p.label}
                    </button>
                  ))}
                  {(filterStatuses.size > 0 || filterQ.trim()) && (
                    <button
                      className={styles.clearFilters}
                      onClick={() => { setFilterStatuses(new Set()); setFilterQ(""); }}
                      title="Clear all filters"
                    >
                      ✕ CLEAR
                    </button>
                  )}
                </div>
                <span className={styles.filterCount}>
                  Showing {filteredRows.length} of {rows.length}
                </span>
                <button className={styles.btnSm} onClick={refreshAllPrices} title="Recalculate all prices">
                  ↻ REFRESH PRICES
                </button>
                <button
                  className={styles.btnSm}
                  onClick={exportRestockList}
                  disabled={rows.filter(r => r.status === "needed" || r.status === "low").length === 0}
                  title="Copy restock list to clipboard"
                >
                  {restockCopied ? "✓ COPIED" : "⬇ SHOPPING LIST"}
                </button>
              </div>
              <div className={styles.tableScroll}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th className={styles.sortable} onClick={() => toggleSort("doctrine")}>
                      Doctrine {sortIndicator("doctrine")}
                    </th>
                    <th className={styles.sortable} onClick={() => toggleSort("fitting")}>
                      Fitting {sortIndicator("fitting")}
                    </th>
                    <th className={`${styles.num} ${styles.sortable}`} onClick={() => toggleSort("current")}>
                      Current {sortIndicator("current")}
                    </th>
                    <th className={`${styles.num} ${styles.sortable}`} onClick={() => toggleSort("target")}>
                      Target {sortIndicator("target")}
                    </th>
                    <th className={`${styles.num} ${styles.sortable}`} onClick={() => toggleSort("avg")}>
                      Avg Listed {sortIndicator("avg")}
                    </th>
                    <th className={`${styles.num} ${styles.sortable}`} onClick={() => toggleSort("suggested")}>
                      Suggested (+10%) {sortIndicator("suggested")}
                    </th>
                    <th className={styles.sortable} onClick={() => toggleSort("status")}>
                      Status {sortIndicator("status")}
                    </th>
                    <th></th>
                  </tr>
                </thead>
                {groupedRows == null ? (
                  <tbody>
                    {filteredRows.map(renderStatusRow)}
                  </tbody>
                ) : (
                  groupedRows.map((g) => (
                    <tbody key={g.tag}>
                      <tr className={styles.groupHeader}>
                        <td colSpan={8}>
                          <button
                            className={styles.groupToggle}
                            onClick={() => toggleGroup(g.tag)}
                          >
                            <span className={styles.caret}>
                              {collapsedSet.has(g.tag) ? "▸" : "▾"}
                            </span>
                            <span className={styles.docTag} style={docColor(g.tag)}>{g.tag}</span>
                            <span className={styles.groupSummary}>
                              {g.needed > 0 && <span className={styles.stockRed}>{g.needed} needed</span>}
                              {g.needed > 0 && (g.low > 0 || g.inStock > 0) && " · "}
                              {g.low > 0 && <span className={styles.stockYellow}>{g.low} low</span>}
                              {g.low > 0 && g.inStock > 0 && " · "}
                              {g.inStock > 0 && <span className={styles.stockGreen}>{g.inStock} in stock</span>}
                              {g.incomplete > 0 && (
                                <>
                                  {(g.needed > 0 || g.low > 0 || g.inStock > 0) && " · "}
                                  <span className={styles.incompleteSummary}>⚠ {g.incomplete} incomplete</span>
                                </>
                              )}
                              {g.restock > 0 && (
                                <>
                                  {" · Restock: "}
                                  <span className={styles.stockRed}>{fmt(g.restock)}</span>
                                </>
                              )}
                            </span>
                          </button>
                        </td>
                      </tr>
                      {!collapsedSet.has(g.tag) && g.items.map(renderStatusRow)}
                    </tbody>
                  ))
                )}
              </table>
              </div>
            </>
          )
        )}
      </div>

      {/* ── All corp contracts (grouped by title) ────────────────────────── */}
      <div className={styles.collapsible}>
        <button className={styles.collapseToggle} onClick={() => setShowAllContracts((v) => !v)}>
          <span className={styles.caret}>{showAllContracts ? "▾" : "▸"}</span>
          All Corp Contracts
          {contracts != null && (
            <span className={styles.configCount}>
              {contracts.length} outstanding · {allContractGroups?.length ?? 0} unique titles
            </span>
          )}
        </button>
        {showAllContracts && (
          <div className={styles.allContractsPanel}>
            {contracts == null ? (
              <div className={styles.allContractsEmpty}>
                Refresh contracts to see all corp listings.
              </div>
            ) : contracts.length === 0 ? (
              <div className={styles.allContractsEmpty}>No outstanding contracts found.</div>
            ) : (
              <table className={styles.allContractsTable}>
                <thead>
                  <tr>
                    <th>Contract Title</th>
                    <th className={styles.num}>Count</th>
                    <th className={styles.num}>Avg Price</th>
                    <th>Doctrine</th>
                  </tr>
                </thead>
                <tbody>
                  {allContractGroups.map((g) => (
                    <tr key={g.title} data-doctrine={g.isDoctrineMatch ? "true" : undefined}>
                      <td className={styles.contractTitle}>{g.title}</td>
                      <td className={styles.num}>
                        <span className={g.count > 1 ? styles.countBadge : styles.countSingle}>
                          {g.count}
                        </span>
                      </td>
                      <td className={styles.num}>
                        {g.avgPrice != null ? fmt(g.avgPrice) : <span className={styles.dim}>—</span>}
                      </td>
                      <td>
                        {g.isDoctrineMatch
                          ? <span className={styles.pillGreen}>Doctrine</span>
                          : <span className={styles.dim}>—</span>
                        }
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
      </div>

        </> /* end stock status */
      )}

      {/* ══ SALES sub-tab ═════════════════════════════════════════════════ */}
      {sub === "sales" && (
        <>
        <div className={styles.topBar}>
          <span className={styles.refreshedAt}>
            {salesLoading ? "Loading sales…" : sales
              ? <>{sales.totals.total.toLocaleString("en-US")} total sales tracked</>
              : "No sales loaded yet"}
          </span>
          <button className={styles.btn} onClick={loadSales} disabled={salesLoading}>
            {salesLoading ? "LOADING..." : "↻ REFRESH"}
          </button>
        </div>
        {salesError && <div className={styles.errBar}>{salesError}</div>}

        {sales && sales.totals.total === 0 ? (
          <div className={styles.firstRun}>
            <div className={styles.firstRunTitle}>NO SALES TRACKED YET</div>
            <div className={styles.firstRunBody}>
              Doctrine contract sales are recorded whenever someone hits
              <strong> ↻ REFRESH</strong> in the Stock Status tab. ESI only
              returns finished contracts for ~30 days, so this table starts
              accumulating from the next refresh onward.
            </div>
          </div>
        ) : sales ? (
          <>
            <div className={styles.kpiBar}>
              <div className={styles.kpiTile}>
                <span className={styles.kpiVal}>{sales.totals.total.toLocaleString("en-US")}</span>
                <span className={styles.kpiLabel}>All-Time Sales</span>
              </div>
              <div className={styles.kpiTile}>
                <span className={styles.kpiVal}>{sales.totals.thisMonth.toLocaleString("en-US")}</span>
                <span className={styles.kpiLabel}>This Month</span>
              </div>
              <div className={styles.kpiTile}>
                <span className={styles.kpiVal}>{sales.totals.thisYear.toLocaleString("en-US")}</span>
                <span className={styles.kpiLabel}>This Year ({new Date().getUTCFullYear()})</span>
              </div>
              <div className={`${styles.kpiTile} ${styles.kpiCost}`}>
                <span className={styles.kpiVal}>{fmt(sales.totals.totalIsk)}</span>
                <span className={styles.kpiLabel}>All-Time ISK</span>
              </div>
            </div>

            {/* Monthly bar chart — last 12 months */}
            <div className={styles.collapsible}>
              <div className={styles.collapseToggle} style={{ cursor: "default" }}>
                Sales by Month
                <span className={styles.configCount}>
                  last {Math.min(12, sales.monthly.length)} months
                </span>
              </div>
              <div className={styles.salesChartPanel}>
                <SalesMonthlyChart monthly={sales.monthly.slice(-12)} />
              </div>
            </div>

            {/* By doctrine */}
            <div className={styles.collapsible}>
              <div className={styles.collapseToggle} style={{ cursor: "default" }}>
                Sales by Doctrine
                <span className={styles.configCount}>{sales.byDoctrine.length} doctrines</span>
              </div>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>Doctrine</th>
                    <th className={styles.num}>Contracts</th>
                    <th className={styles.num}>ISK Total</th>
                    <th className={styles.num}>Avg Price</th>
                  </tr>
                </thead>
                <tbody>
                  {sales.byDoctrine.map((g) => (
                    <tr key={g.doctrine}>
                      <td><span className={styles.docTag} style={docColor(g.doctrine)}>{g.doctrine}</span></td>
                      <td className={styles.num}>{g.count.toLocaleString("en-US")}</td>
                      <td className={styles.num}>{fmt(g.isk)}</td>
                      <td className={styles.num}>{g.count > 0 ? fmt(g.isk / g.count) : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* By fit */}
            <div className={styles.collapsible}>
              <div className={styles.collapseToggle} style={{ cursor: "default" }}>
                Sales by Fit
                <span className={styles.configCount}>{sales.byFit.length} fits</span>
              </div>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>Doctrine</th>
                    <th>Fitting</th>
                    <th className={styles.num}>Contracts</th>
                    <th className={styles.num}>ISK Total</th>
                    <th className={styles.num}>Avg Price</th>
                  </tr>
                </thead>
                <tbody>
                  {sales.byFit.map((f) => (
                    <tr key={`${f.doctrine}|${f.name}`}>
                      <td><span className={styles.docTag} style={docColor(f.doctrine)}>{f.doctrine}</span></td>
                      <td>{f.name}</td>
                      <td className={styles.num}>{f.count.toLocaleString("en-US")}</td>
                      <td className={styles.num}>{fmt(f.isk)}</td>
                      <td className={styles.num}>{f.count > 0 ? fmt(f.isk / f.count) : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Recent sales */}
            <div className={styles.collapsible}>
              <div className={styles.collapseToggle} style={{ cursor: "default" }}>
                Recent Sales
                <span className={styles.configCount}>last {sales.recent.length}</span>
              </div>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Doctrine</th>
                    <th>Fitting</th>
                    <th className={styles.num}>Price</th>
                  </tr>
                </thead>
                <tbody>
                  {sales.recent.map((r) => (
                    <tr key={r.contract_id}>
                      <td>{timeAgo(Date.parse(r.accepted_at))}</td>
                      <td><span className={styles.docTag} style={docColor(r.doctrine)}>{r.doctrine}</span></td>
                      <td>{r.entry_name}</td>
                      <td className={styles.num}>{r.price != null ? fmt(r.price) : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        ) : null}
        </>
      )}
    </div>
  );
}

// Monthly sales bar chart — inline SVG so it doesn't drag in a chart lib.
// Each bar's height is proportional to that month's contract count; the ISK
// total appears in the tooltip.
function SalesMonthlyChart({ monthly }) {
  if (!monthly || monthly.length === 0) {
    return <div style={{ padding: "16px", color: "var(--text-dim)" }}>No monthly data yet.</div>;
  }
  const max = Math.max(1, ...monthly.map((m) => m.count));
  const width = Math.max(360, monthly.length * 56);
  const height = 160;
  const padTop = 12;
  const padBot = 26;
  const padLeft = 28;
  const padRight = 8;
  const innerH = height - padTop - padBot;
  const barW = (width - padLeft - padRight) / monthly.length;
  return (
    <div style={{ overflowX: "auto", padding: "10px 14px 14px" }}>
      <svg width={width} height={height} role="img" aria-label="Sales by month">
        {/* y-axis grid */}
        {[0, 0.5, 1].map((t) => {
          const y = padTop + innerH * (1 - t);
          return (
            <g key={t}>
              <line x1={padLeft} y1={y} x2={width - padRight} y2={y}
                    stroke="var(--border)" strokeDasharray="2 4" />
              <text x={4} y={y + 4} fontSize="10" fill="var(--text-dim)">
                {Math.round(max * t)}
              </text>
            </g>
          );
        })}
        {monthly.map((m, i) => {
          const h = (m.count / max) * innerH;
          const x = padLeft + i * barW + 4;
          const y = padTop + innerH - h;
          const bw = Math.max(2, barW - 8);
          const label = m.month.slice(2); // YY-MM
          return (
            <g key={m.month}>
              <rect x={x} y={y} width={bw} height={h}
                    fill="var(--accent)" opacity="0.7" rx="2">
                <title>{`${m.month} — ${m.count} sale${m.count === 1 ? "" : "s"} · ${formatIskShort(m.isk)} ISK`}</title>
              </rect>
              <text
                x={x + bw / 2}
                y={padTop + innerH + 14}
                fontSize="10"
                textAnchor="middle"
                fill="var(--text-dim)"
              >
                {label}
              </text>
              {m.count > 0 && (
                <text
                  x={x + bw / 2}
                  y={Math.max(padTop + 10, y - 4)}
                  fontSize="10"
                  textAnchor="middle"
                  fill="var(--text)"
                >
                  {m.count}
                </text>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function formatIskShort(v) {
  if (v == null || !isFinite(v)) return "—";
  const abs = Math.abs(v);
  const sign = v < 0 ? "-" : "";
  if (abs >= 1e9) return sign + (abs / 1e9).toFixed(2) + "B";
  if (abs >= 1e6) return sign + (abs / 1e6).toFixed(2) + "M";
  if (abs >= 1e3) return sign + (abs / 1e3).toFixed(1) + "k";
  return v.toLocaleString("en-US", { maximumFractionDigits: 0 });
}
