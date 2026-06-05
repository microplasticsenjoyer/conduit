import React, { useState, useEffect, useCallback, useRef, useMemo } from "react";
import styles from "./Fund.module.css";
import local from "./IncomeStatement.module.css";
import { fmtIsk } from "../../lib/format.js";
import { MonthlyStackedBars, CumulativeBalanceLine, CategoryDonut } from "./IncomeCharts.jsx";

const DIRECTIONS = [
  { value: "inflow",  label: "Inflow" },
  { value: "outflow", label: "Outflow" },
];

const CATEGORY_SUGGESTIONS = [
  "Ratting tax",
  "Donation",
  "Sales",
  "SRP payout",
  "Buyback payout",
  "Alliance dues",
  "Other",
];

const SCROLL_THRESHOLD = 15;
const TOAST_MS = 8000;

const SORT_COLS = {
  recordedAt:     { label: "Date",        get: (e) => e.recordedAt ? new Date(e.recordedAt).getTime() : 0 },
  direction:      { label: "Direction",   get: (e) => e.direction },
  category:       { label: "Category",    get: (e) => (e.category || "").toLowerCase() },
  amount:         { label: "Amount",      get: (e) => Number(e.amount) || 0 },
  recordedByName: { label: "Recorded by", get: (e) => (e.recordedByName || "").toLowerCase() },
};

function currentMonthString(now = new Date()) {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

// "YYYY-MM" → epoch ms at the first of that month (UTC).
function monthToTs(month) {
  const [y, m] = String(month).split("-").map(Number);
  return Date.UTC(y, (m || 1) - 1, 1);
}

// Shift a "YYYY-MM" string by `delta` months.
function shiftMonth(month, delta) {
  const [y, m] = String(month).split("-").map(Number);
  const d = new Date(Date.UTC(y, (m || 1) - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

// The `n` calendar months ending at `end`, oldest → newest.
function lastNMonths(end, n) {
  const out = [];
  for (let i = n - 1; i >= 0; i--) out.push(shiftMonth(end, -i));
  return out;
}

function fmtDate(ts) {
  if (!ts) return "—";
  return new Date(ts).toLocaleString("en-US", {
    year: "numeric", month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit", hour12: false,
  });
}

function directionBadgeClass(d) {
  return `${local.dirBadge} ${d === "inflow" ? local.dirInflow : local.dirOutflow}`;
}

function directionAmountClass(d) {
  return d === "inflow" ? local.amountInflow : local.amountOutflow;
}

function directionRowClass(d) {
  return d === "inflow" ? local.rowInflow : local.rowOutflow;
}

const PAGE = 100;

export default function IncomeStatement({ auth }) {
  const [summary,    setSummary]    = useState(null); // whole-dataset rollup
  const [entries,    setEntries]    = useState(null); // current ledger page(s)
  const [hasMore,    setHasMore]    = useState(false);
  const [ledgerBusy, setLedgerBusy] = useState(false);
  const [leader,     setLeader]     = useState(false);
  const [error,      setError]      = useState(null);
  const [showForm,   setShowForm]   = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [formError,  setFormError]  = useState(null);
  const [formMsg,    setFormMsg]    = useState(null);
  const abortRef = useRef(null);

  const [direction, setDirection] = useState("inflow");
  const [amount,    setAmount]    = useState("");
  const [category,  setCategory]  = useState(CATEGORY_SUGGESTIONS[0]);
  const [effectiveMonth, setEffectiveMonth] = useState(currentMonthString());
  const [notes,     setNotes]     = useState("");

  const [sortKey, setSortKey] = useState("recordedAt");
  const [sortDir, setSortDir] = useState("desc");

  // Period for the summary strip + category breakdown:
  //   null = latest month (auto-tracks newest), "ytd", "all", or "YYYY-MM".
  const [breakdownSel, setBreakdownSel] = useState(null);

  // Ledger filters (applied server-side).
  const [filterDirection, setFilterDirection] = useState("");
  const [filterCategory,  setFilterCategory]  = useState("");
  const [filterMonth,     setFilterMonth]     = useState("");

  const [editingId, setEditingId] = useState(null);
  const [editDraft, setEditDraft] = useState(null);
  const [editError, setEditError] = useState(null);
  const [savingEdit, setSavingEdit] = useState(false);

  const [toast, setToast] = useState(null); // { id, message }
  const toastTimerRef = useRef(null);

  const ledgerParams = useCallback((offset) => {
    const p = new URLSearchParams({ limit: String(PAGE), offset: String(offset) });
    if (filterMonth)     p.set("month", filterMonth);
    if (filterDirection) p.set("direction", filterDirection);
    if (filterCategory)  p.set("category", filterCategory);
    return p;
  }, [filterMonth, filterDirection, filterCategory]);

  // Full load: whole-dataset summary + first ledger page for the current filters.
  const load = useCallback(async () => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setError(null);
    try {
      const token = await auth.getAccessToken();
      const headers = { Authorization: `Bearer ${token}` };
      const res = await fetch(`/api/finances/income/list?${ledgerParams(0)}`, { headers, signal: ctrl.signal });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed to load income statement");
      setSummary(json.summary ?? null);
      setEntries(json.entries ?? []);
      setHasMore(Boolean(json.hasMore));
      setLeader(Boolean(json.leader));
    } catch (err) {
      if (err.name !== "AbortError") setError(err.message);
    }
  }, [auth, ledgerParams]);

  useEffect(() => { load(); return () => abortRef.current?.abort(); }, [load]);
  useEffect(() => () => clearTimeout(toastTimerRef.current), []);

  async function loadMore() {
    if (ledgerBusy || !hasMore) return;
    setLedgerBusy(true);
    try {
      const token = await auth.getAccessToken();
      const headers = { Authorization: `Bearer ${token}` };
      const p = ledgerParams(entries?.length ?? 0);
      p.set("ledgerOnly", "1");
      const res = await fetch(`/api/finances/income/list?${p}`, { headers });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed to load more entries");
      setEntries((prev) => [...(prev ?? []), ...(json.entries ?? [])]);
      setHasMore(Boolean(json.hasMore));
    } catch (err) {
      showToast(`Load failed: ${err.message}`);
    } finally {
      setLedgerBusy(false);
    }
  }

  const currentMonth = currentMonthString();
  const anyLedgerFilter = Boolean(filterCategory || filterDirection || filterMonth);
  const partialTotals = Boolean(filterCategory || filterDirection); // narrows within a month

  // Chart inputs derived from the (small) whole-dataset summary.
  const view = useMemo(() => {
    if (!summary) {
      return { months: [], monthMap: new Map(), chartBars: [], chartCumulative: [], latestMonth: null };
    }
    const months = summary.months ?? [];
    const monthMap = new Map(months.map((m) => [m.month, m]));
    const latestMonth = months[0]?.month ?? null;

    // Stacked bars: a contiguous 12-calendar-month window ending at the latest
    // month with data — gaps filled with zeros, leading empty months trimmed.
    let bars = lastNMonths(latestMonth ?? currentMonth, 12).map((mo) => {
      const v = monthMap.get(mo);
      return { month: mo, inflow: v?.inflow || 0, outflow: v?.outflow || 0, net: v?.net || 0 };
    });
    const firstData = bars.findIndex((b) => b.inflow || b.outflow);
    if (firstData > 0) bars = bars.slice(firstData);

    // Cumulative balance ordered by effective month (computed server-side).
    const chartCumulative = (summary.cumulative ?? []).map((c) => ({
      ts: monthToTs(c.month), balance: c.balance,
    }));

    return { months, monthMap, chartBars: bars, chartCumulative, latestMonth };
  }, [summary, currentMonth]);

  const { months, monthMap, chartBars, chartCumulative, latestMonth } = view;
  const currentYear = summary?.currentYear ?? currentMonth.slice(0, 4);
  const categoryHints = summary?.categoryHints ?? [];

  // Period (drives both the summary strip and the breakdown). null → latest month.
  const effectiveSel = breakdownSel ?? latestMonth;
  const periodLabel =
    effectiveSel === "ytd" ? `Year to date ${currentYear}` :
    effectiveSel === "all" ? "All time" :
    effectiveSel ?? "—";

  const breakdownSlices = (() => {
    if (!summary) return { inflow: [], outflow: [] };
    if (effectiveSel === "ytd") return summary.categories.ytd;
    if (effectiveSel === "all") return summary.categories.all;
    return summary.categories.byMonth[effectiveSel] ?? { inflow: [], outflow: [] };
  })();

  const periodTotals = (() => {
    if (!summary) return { inflow: 0, outflow: 0, net: 0 };
    if (effectiveSel === "ytd") return summary.totals.ytd;
    if (effectiveSel === "all") return summary.totals.all;
    const m = monthMap.get(effectiveSel);
    return m ? { inflow: m.inflow, outflow: m.outflow, net: m.net } : { inflow: 0, outflow: 0, net: 0 };
  })();

  // Group the loaded ledger page(s) by month for display.
  const loadedGroups = useMemo(() => {
    if (!entries) return [];
    const buckets = new Map();
    for (const e of entries) {
      const m = typeof e.effectiveMonth === "string" ? e.effectiveMonth : "—";
      if (!buckets.has(m)) buckets.set(m, []);
      buckets.get(m).push(e);
    }
    return [...buckets.entries()]
      .map(([month, rows]) => ({ month, rows }))
      .sort((a, b) => (a.month < b.month ? 1 : a.month > b.month ? -1 : 0));
  }, [entries]);

  function handleSort(key) {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir(key === "recordedAt" || key === "amount" ? "desc" : "asc");
    }
  }

  function sortedEntries(rows) {
    const col = SORT_COLS[sortKey];
    if (!col) return rows;
    const mul = sortDir === "asc" ? 1 : -1;
    return [...rows].sort((a, b) => {
      const av = col.get(a);
      const bv = col.get(b);
      if (av < bv) return -1 * mul;
      if (av > bv) return  1 * mul;
      return 0;
    });
  }

  function showToast(message) {
    clearTimeout(toastTimerRef.current);
    const id = Date.now();
    setToast({ id, message });
    toastTimerRef.current = setTimeout(() => setToast((t) => (t?.id === id ? null : t)), TOAST_MS);
  }

  async function submitEntry(e) {
    e.preventDefault();
    setFormError(null);
    setFormMsg(null);
    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt <= 0) {
      setFormError("Amount must be a positive number");
      return;
    }
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(effectiveMonth)) {
      setFormError("Effective month must be YYYY-MM");
      return;
    }
    const cat = category.trim();
    if (!cat) { setFormError("Category required"); return; }

    setSubmitting(true);
    try {
      const token = await auth.getAccessToken();
      const res = await fetch("/api/finances/income/entry", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          direction,
          amount: amt,
          category: cat,
          effectiveMonth,
          notes: notes.trim() || null,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed to record entry");
      setFormMsg("Entry recorded");
      setAmount("");
      setNotes("");
      await load();
    } catch (err) {
      setFormError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  function startEdit(e) {
    setEditingId(e.id);
    setEditError(null);
    setEditDraft({
      direction: e.direction,
      amount: String(e.amount),
      category: e.category,
      effectiveMonth: e.effectiveMonth,
      notes: e.notes ?? "",
    });
  }

  function cancelEdit() {
    setEditingId(null);
    setEditDraft(null);
    setEditError(null);
  }

  async function saveEdit(id) {
    setEditError(null);
    const amt = Number(editDraft.amount);
    if (!Number.isFinite(amt) || amt <= 0) {
      setEditError("Amount must be a positive number");
      return;
    }
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(editDraft.effectiveMonth)) {
      setEditError("Effective month must be YYYY-MM");
      return;
    }
    const cat = editDraft.category.trim();
    if (!cat) { setEditError("Category required"); return; }

    setSavingEdit(true);
    try {
      const token = await auth.getAccessToken();
      const res = await fetch("/api/finances/income/entry", {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          id,
          direction: editDraft.direction,
          amount: amt,
          category: cat,
          effectiveMonth: editDraft.effectiveMonth,
          notes: editDraft.notes.trim() ? editDraft.notes.trim() : null,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed to update entry");
      cancelEdit();
      await load();
      showToast("Entry updated");
    } catch (err) {
      setEditError(err.message);
    } finally {
      setSavingEdit(false);
    }
  }

  async function deleteEntry(entry) {
    if (!window.confirm(`Delete this entry?\n\n${entry.direction.toUpperCase()} ${fmtIsk(entry.amount)} · ${entry.category}\n${entry.notes ?? ""}`)) {
      return;
    }
    try {
      const token = await auth.getAccessToken();
      const res = await fetch("/api/finances/income/entry", {
        method: "DELETE",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ id: entry.id }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed to delete entry");
      // Optimistically remove for instant feedback, then refresh so the
      // whole-dataset summary (charts/totals) reflects the deletion.
      setEntries((prev) => prev ? prev.filter((e) => e.id !== entry.id) : prev);
      showUndo(entry.id);
      load();
    } catch (err) {
      showToast(`Delete failed: ${err.message}`);
    }
  }

  function showUndo(id) {
    clearTimeout(toastTimerRef.current);
    const toastId = Date.now();
    setToast({ id: toastId, message: "Entry deleted", undoId: id });
    toastTimerRef.current = setTimeout(() => setToast((t) => (t?.id === toastId ? null : t)), TOAST_MS);
  }

  async function undoDelete(id) {
    clearTimeout(toastTimerRef.current);
    setToast(null);
    try {
      const token = await auth.getAccessToken();
      const res = await fetch("/api/finances/income/entry", {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ id, restore: true }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed to restore entry");
      await load();
      showToast("Entry restored");
    } catch (err) {
      showToast(`Restore failed: ${err.message}`);
    }
  }

  if (error) {
    return <div className={styles.error}>⚠ {error}</div>;
  }

  if (entries === null) {
    return <div className={styles.loading}>LOADING INCOME STATEMENT...</div>;
  }

  const periodNetPositive = periodTotals.net >= 0;
  const categoryDatalistOptions = uniq([...categoryHints, ...CATEGORY_SUGGESTIONS]);
  const hasData = months.length > 0;

  return (
    <div className={`${styles.wrap} ${local.wrap}`}>
      <div className={styles.topBar}>
        <div>
          <div className={styles.title}>Income Statement</div>
          <div className={styles.subtitle}>Manually-recorded corp inflows and outflows · {currentMonth}</div>
        </div>
        <div className={styles.actionGroup}>
          <button
            type="button"
            className={`${styles.btn} ${styles.btnGhost}`}
            onClick={() => { setShowForm((s) => !s); setFormError(null); setFormMsg(null); }}
          >
            {showForm ? "Close form" : "Add entry"}
          </button>
        </div>
      </div>

      <div className={local.ytdStrip}>
        <div className={local.periodControl}>
          <span className={styles.dim}>Period</span>
          <select
            className={styles.select}
            value={effectiveSel ?? ""}
            onChange={(e) => setBreakdownSel(e.target.value)}
            aria-label="Summary period"
            disabled={!hasData}
          >
            <option value="all">All time</option>
            <option value="ytd">Year to date ({currentYear})</option>
            {months.map((m) => (
              <option key={m.month} value={m.month}>{m.month}</option>
            ))}
          </select>
        </div>
        {hasData && (
          <div className={local.periodTotals}>
            <span className={local.valueInflow}>+{fmtIsk(periodTotals.inflow)}</span>
            <span className={styles.dim}>·</span>
            <span className={local.valueOutflow}>−{fmtIsk(periodTotals.outflow)}</span>
            <span className={styles.dim}>·</span>
            <span className={`${local.ytdValue} ${periodNetPositive ? local.valueInflow : local.valueOutflow}`}>
              net {periodNetPositive ? "+" : "−"}{fmtIsk(Math.abs(periodTotals.net))}
            </span>
          </div>
        )}
      </div>

      {hasData && (
        <>
          <div className={local.chartsRow}>
            <div className={`${styles.panel} ${local.chartPanel}`}>
              <div className={local.chartTitle}>Monthly inflow vs outflow · last {chartBars.length} months</div>
              <MonthlyStackedBars data={chartBars} />
            </div>
            <div className={`${styles.panel} ${local.chartPanel}`}>
              <div className={local.chartTitle}>Cumulative balance</div>
              <CumulativeBalanceLine data={chartCumulative} />
            </div>
          </div>
          <div className={`${styles.panel} ${local.chartPanel}`}>
            <div className={local.chartTitle}>Category breakdown · {periodLabel}</div>
            <CategoryDonut slices={breakdownSlices} />
          </div>
        </>
      )}

      {showForm && (
        <div className={`${styles.panel} ${styles.panelLeadership}`}>
          <div>
            <div className={styles.panelTitle}>Record entry</div>
            <div className={styles.panelSubtitle}>Leadership only — server will reject non-leadership submissions</div>
          </div>
          <form className={styles.inlineForm} onSubmit={submitEntry}>
            <div className={styles.formGrid}>
              <div className={styles.fieldRow}>
                <label className={styles.label}>Direction</label>
                <select className={styles.select} value={direction} onChange={(e) => setDirection(e.target.value)}>
                  {DIRECTIONS.map((d) => <option key={d.value} value={d.value}>{d.label}</option>)}
                </select>
              </div>
              <div className={styles.fieldRow}>
                <label className={styles.label}>Amount (ISK)</label>
                <input
                  className={styles.input}
                  type="number"
                  step="0.01"
                  min="0"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  placeholder="e.g. 1000000000"
                  required
                />
              </div>
              <div className={styles.fieldRow}>
                <label className={styles.label}>Category</label>
                <input
                  className={styles.input}
                  list="incomeCategoryList"
                  value={category}
                  onChange={(e) => setCategory(e.target.value)}
                  placeholder="Ratting tax, donation, …"
                  required
                />
                <datalist id="incomeCategoryList">
                  {categoryDatalistOptions.map((c) => <option key={c} value={c} />)}
                </datalist>
              </div>
              <div className={styles.fieldRow}>
                <label className={styles.label}>Effective month</label>
                <input
                  className={styles.input}
                  type="month"
                  value={effectiveMonth}
                  onChange={(e) => setEffectiveMonth(e.target.value)}
                  required
                />
              </div>
            </div>
            <div className={styles.fieldRow}>
              <label className={styles.label}>Notes (optional)</label>
              <textarea
                className={styles.textarea}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Context, source, related operation…"
              />
            </div>
            {formError && <div className={styles.error}>⚠ {formError}</div>}
            {formMsg && <div className={styles.success}>{formMsg}</div>}
            <div className={styles.formActions}>
              <button type="submit" className={styles.btn} disabled={submitting}>
                {submitting ? "Saving…" : "Record entry"}
              </button>
              <span className={styles.helperText}>Stored in the audit log; visible to all corp members.</span>
            </div>
          </form>
        </div>
      )}

      <div className={local.filterBar}>
        <span className={styles.dim}>Ledger</span>
        <select
          className={styles.select}
          value={filterDirection}
          onChange={(e) => setFilterDirection(e.target.value)}
          aria-label="Filter by direction"
        >
          <option value="">All directions</option>
          {DIRECTIONS.map((d) => <option key={d.value} value={d.value}>{d.label}</option>)}
        </select>
        <select
          className={styles.select}
          value={filterCategory}
          onChange={(e) => setFilterCategory(e.target.value)}
          aria-label="Filter by category"
        >
          <option value="">All categories</option>
          {categoryHints.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <input
          className={styles.input}
          type="month"
          value={filterMonth}
          onChange={(e) => setFilterMonth(e.target.value)}
          aria-label="Filter by month"
        />
        {anyLedgerFilter && (
          <button
            type="button"
            className={`${styles.btn} ${styles.btnGhost}`}
            onClick={() => { setFilterDirection(""); setFilterCategory(""); setFilterMonth(""); }}
          >
            Clear filters
          </button>
        )}
      </div>

      {entries.length === 0 ? (
        <div className={styles.panel}>
          <div>
            <div className={styles.panelTitle}>Ledger</div>
            <div className={styles.panelSubtitle}>Append-only record of corp inflows and outflows</div>
          </div>
          <div className={styles.empty}>
            {anyLedgerFilter ? "No entries match these filters" : "No entries recorded yet"}
          </div>
        </div>
      ) : (
        loadedGroups.map((g) => {
          const rows = sortedEntries(g.rows);
          const overflow = rows.length > SCROLL_THRESHOLD;
          const mt = monthMap.get(g.month);
          return (
            <div key={g.month} className={styles.panel}>
              <div className={local.monthHeader}>
                <div className={local.monthLabel}>{g.month}</div>
                {partialTotals ? (
                  <div className={local.monthTotals}>
                    <span className={styles.dim}>{rows.length} matching</span>
                  </div>
                ) : mt && (
                  <div className={local.monthTotals}>
                    <span className={local.valueInflow}>+{fmtIsk(mt.inflow)}</span>
                    <span className={styles.dim}>·</span>
                    <span className={local.valueOutflow}>−{fmtIsk(mt.outflow)}</span>
                    <span className={styles.dim}>·</span>
                    <span className={mt.net >= 0 ? local.valueInflow : local.valueOutflow}>
                      net {mt.net >= 0 ? "+" : "−"}{fmtIsk(Math.abs(mt.net))}
                    </span>
                  </div>
                )}
              </div>
              <div className={`${styles.tableWrap} ${overflow ? local.scrollBody : ""}`}>
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <SortHeader col="recordedAt"     sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
                      <SortHeader col="direction"      sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
                      <SortHeader col="category"       sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
                      <SortHeader col="amount"         sortKey={sortKey} sortDir={sortDir} onSort={handleSort} right />
                      <SortHeader col="recordedByName" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
                      <th>Notes</th>
                      {leader && <th className={local.actionsCell}>Actions</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((e) => (
                      editingId === e.id ? (
                        <EditRow
                          key={e.id}
                          entry={e}
                          draft={editDraft}
                          setDraft={setEditDraft}
                          onSave={() => saveEdit(e.id)}
                          onCancel={cancelEdit}
                          saving={savingEdit}
                          errorMsg={editError}
                          showActions={leader}
                        />
                      ) : (
                        <tr key={e.id} className={directionRowClass(e.direction)}>
                          <td className={styles.dim}>
                            {fmtDate(e.recordedAt)}
                            {e.editedAt && (
                              <span
                                className={local.editedMark}
                                title={`edited ${fmtDate(e.editedAt)}${e.editedByName ? ` by ${e.editedByName}` : ""}`}
                              >
                                (edited)
                              </span>
                            )}
                          </td>
                          <td>
                            <span className={directionBadgeClass(e.direction)}>{e.direction}</span>
                          </td>
                          <td>{e.category}</td>
                          <td className={`${styles.right} ${directionAmountClass(e.direction)}`}>
                            {e.direction === "inflow" ? "+" : "−"}{fmtIsk(e.amount)}
                          </td>
                          <td className={styles.dim}>{e.recordedByName}</td>
                          <td className={styles.dim}>{e.notes ?? "—"}</td>
                          {leader && (
                            <td className={local.actionsCell}>
                              <button
                                type="button"
                                className={local.iconBtn}
                                title="Edit entry"
                                aria-label="Edit entry"
                                onClick={() => startEdit(e)}
                              >
                                ✎
                              </button>
                              <button
                                type="button"
                                className={`${local.iconBtn} ${local.iconBtnDanger}`}
                                title="Delete entry"
                                aria-label="Delete entry"
                                onClick={() => deleteEntry(e)}
                              >
                                ✕
                              </button>
                            </td>
                          )}
                        </tr>
                      )
                    ))}
                  </tbody>
                </table>
              </div>
              {overflow && (
                <div className={local.scrollFooter}>
                  Showing {rows.length} entries — scroll within the table
                </div>
              )}
            </div>
          );
        })
      )}

      {hasMore && (
        <div className={local.loadMoreRow}>
          <button
            type="button"
            className={`${styles.btn} ${styles.btnGhost}`}
            onClick={loadMore}
            disabled={ledgerBusy}
          >
            {ledgerBusy ? "Loading…" : "Load more"}
          </button>
        </div>
      )}

      {toast && (
        <div className={local.toast}>
          <span className={local.toastText}>{toast.message}</span>
          {toast.undoId && (
            <button type="button" className={local.toastBtn} onClick={() => undoDelete(toast.undoId)}>
              Undo
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function SortHeader({ col, sortKey, sortDir, onSort, right }) {
  const meta = SORT_COLS[col];
  if (!meta) return <th>{col}</th>;
  const active = sortKey === col;
  const arrow = active ? (sortDir === "asc" ? "▲" : "▼") : "";
  const cls = [local.sortable, right ? styles.right : "", active ? local.sortActive : ""].filter(Boolean).join(" ");
  return (
    <th className={cls} onClick={() => onSort(col)}>
      {meta.label}
      <span className={local.sortArrow}>{arrow || "·"}</span>
    </th>
  );
}

function EditRow({ entry, draft, setDraft, onSave, onCancel, saving, errorMsg, showActions }) {
  return (
    <tr className={`${directionRowClass(draft.direction)} ${local.editingRow}`}>
      <td className={styles.dim}>{fmtDate(entry.recordedAt)}</td>
      <td>
        <select
          className={local.editInput}
          value={draft.direction}
          onChange={(e) => setDraft({ ...draft, direction: e.target.value })}
        >
          {DIRECTIONS.map((d) => <option key={d.value} value={d.value}>{d.label}</option>)}
        </select>
      </td>
      <td>
        <input
          className={local.editInput}
          value={draft.category}
          list="incomeCategoryList"
          onChange={(e) => setDraft({ ...draft, category: e.target.value })}
        />
      </td>
      <td className={styles.right}>
        <input
          className={local.editInput}
          type="number"
          step="0.01"
          min="0"
          value={draft.amount}
          onChange={(e) => setDraft({ ...draft, amount: e.target.value })}
        />
      </td>
      <td colSpan={2}>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <input
            className={local.editInput}
            type="month"
            value={draft.effectiveMonth}
            onChange={(e) => setDraft({ ...draft, effectiveMonth: e.target.value })}
            style={{ width: 130 }}
          />
          <input
            className={local.editInput}
            value={draft.notes}
            placeholder="Notes"
            onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
          />
        </div>
        {errorMsg && <div className={styles.error} style={{ marginTop: 4 }}>⚠ {errorMsg}</div>}
      </td>
      {showActions && (
        <td className={local.actionsCell}>
          <button
            type="button"
            className={local.iconBtn}
            title="Save"
            aria-label="Save"
            onClick={onSave}
            disabled={saving}
          >
            ✓
          </button>
          <button
            type="button"
            className={local.iconBtn}
            title="Cancel"
            aria-label="Cancel"
            onClick={onCancel}
            disabled={saving}
          >
            ↩
          </button>
        </td>
      )}
    </tr>
  );
}

function uniq(arr) {
  return [...new Set(arr.filter(Boolean))];
}
