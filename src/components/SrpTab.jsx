import React, { useState, useEffect, useCallback, useRef } from "react";
import styles from "./SrpTab.module.css";
import { showToast } from "../lib/toast.js";

// Corp SRP payout policy: pay 70% of fitted loss value, capped at 200M per loss.
// Leaders can override both in the bulk-approve dialog for special fleets.
const SRP_DEFAULT_PCT = 0.7;
const SRP_PAYOUT_CAP = 200_000_000;

// How far a killmail can sit from the fleet's date before we warn the pilot
// they may be submitting to the wrong fleet. Fleets run for hours, not days,
// so 48h comfortably clears a normal op while catching stale/misfiled kills.
const KILL_FLEET_GAP_MS = 48 * 60 * 60 * 1000;

function computePayout(lossValue, pct, cap) {
  const v = Math.max(0, Number(lossValue) || 0);
  const p = Math.max(0, Math.min(1, Number(pct) || 0));
  const c = cap == null || !isFinite(cap) ? Infinity : Math.max(0, Number(cap));
  return Math.round(Math.min(v * p, c));
}

function fmt(v) {
  if (v == null || !isFinite(Number(v))) return "—";
  const n = Number(v);
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (abs >= 1e9) return sign + (abs / 1e9).toFixed(2) + "B";
  if (abs >= 1e6) return sign + (abs / 1e6).toFixed(2) + "M";
  if (abs >= 1e3) return sign + (abs / 1e3).toFixed(1) + "k";
  return n.toLocaleString("en-US", { maximumFractionDigits: 0 });
}

function fmtDate(ts) {
  if (!ts) return "—";
  return new Date(ts).toLocaleString("en-US", {
    year: "numeric", month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit", hour12: false,
    timeZoneName: "short",
  });
}

function fmtMonth(yyyymm) {
  if (!yyyymm) return "—";
  return new Date(`${yyyymm}-01T00:00:00Z`).toLocaleString("en-US", {
    month: "long", year: "numeric", timeZone: "UTC",
  });
}

// Compact date for the loss table's "Lost" column, e.g. "May 14, 14:32".
function fmtKillDate(ts) {
  if (!ts) return "—";
  const d = new Date(ts);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-US", {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false,
  });
}

// 'YYYY-MM' (UTC) bucket for a timestamp — matches how the monthly roundup
// keys months — or null when unparseable. Used to flag off-month losses.
function monthKey(ts) {
  if (!ts) return null;
  const d = new Date(ts);
  return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 7);
}

function StatusBadge({ status }) {
  const cls = {
    open:     styles.badgeOpen,
    closed:   styles.badgeClosed,
    pending:  styles.badgePending,
    approved: styles.badgeApproved,
    rejected: styles.badgeRejected,
  }[status] ?? styles.badgeClosed;
  return <span className={`${styles.badge} ${cls}`}>{status}</span>;
}

function StatCard({ label, value, accent, wide }) {
  const accentCls = accent === "success" ? styles.statCardSuccess
    : accent === "warning" ? styles.statCardWarning
    : accent === "danger"  ? styles.statCardDanger
    : "";
  return (
    <div className={`${styles.statCard} ${accentCls} ${wide ? styles.statCardWide : ""}`}>
      <span className={styles.statLabel}>{label}</span>
      <span className={styles.statValue}>{value}</span>
    </div>
  );
}

function ReadyToPay({ pilots, canApprove, onMarkPaid }) {
  const [copiedKey, setCopiedKey] = useState(null);
  const [busyKey, setBusyKey] = useState(null);
  const [payErr, setPayErr] = useState(null);
  const [expanded, setExpanded] = useState(new Set());
  const outstanding = pilots.reduce((s, p) => s + p.unpaidTotal, 0);
  const paidTotal = pilots.reduce((s, p) => s + p.paidTotal, 0);
  const paidCount = pilots.filter((p) => p.paid).length;

  function copyText(text, key) {
    navigator.clipboard.writeText(text).then(() => {
      showToast("Copied to clipboard");
      setCopiedKey(key);
      setTimeout(() => setCopiedKey((k) => (k === key ? null : k)), 1500);
    }).catch(() => {});
  }

  // Only emit what's still owed — skip pilots with nothing outstanding so the
  // paste matches exactly what leadership needs to transfer in-game.
  function copyAll() {
    const lines = pilots
      .filter((p) => p.unpaidTotal > 0)
      .map((p) => `${p.name}\t${Math.round(p.unpaidTotal)}`)
      .join("\n");
    if (!lines) { showToast("Nothing outstanding to copy"); return; }
    copyText(lines, "__all__");
  }

  // lossId present → pay just that loss; absent → the pilot's whole balance.
  // busyKey is the lossId or the pilot name so only the pressed control spins.
  async function mark(name, paid, lossId) {
    const key = lossId ?? name;
    setBusyKey(key);
    setPayErr(null);
    try {
      await onMarkPaid(name, paid, lossId);
    } catch (err) {
      setPayErr(err.message);
    } finally {
      setBusyKey(null);
    }
  }

  function toggleExpand(name) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  return (
    <div className={styles.panel}>
      <div className={styles.readyToPayHeader}>
        <span className={styles.panelTitle}>Ready to Pay</span>
        <span className={styles.dim}>
          {pilots.length} {pilots.length === 1 ? "pilot" : "pilots"} · {fmt(outstanding)} ISK outstanding
          {paidTotal > 0 && ` · ${fmt(paidTotal)} ISK already paid`}
          {paidCount > 0 && ` · ${paidCount}/${pilots.length} fully paid`}
        </span>
        <button
          type="button"
          className={`${styles.btn} ${copiedKey === "__all__" ? styles.btnSuccess : ""}`}
          onClick={copyAll}
        >
          {copiedKey === "__all__" ? "✓ Copied" : "Copy all (Name⇥Amount)"}
        </button>
      </div>
      {payErr && <div className={styles.error}>⚠ {payErr}</div>}
      <div className={styles.tableWrap}>
        <table className={`${styles.table} ${styles.tableStatic}`}>
          <thead>
            <tr>
              <th>Pilot</th>
              <th>Losses</th>
              <th>Amount</th>
              <th>Paid</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {pilots.map((p) => {
              const isOpen = expanded.has(p.name);
              return (
              <React.Fragment key={p.name}>
              <tr className={p.paid ? styles.rowPaid : ""}>
                <td>
                  <button
                    type="button"
                    className={styles.expandBtn}
                    onClick={() => toggleExpand(p.name)}
                    title={isOpen ? "Hide individual losses" : "Show individual losses"}
                    aria-expanded={isOpen}
                  >
                    {isOpen ? "▾" : "▸"}
                  </button>
                  {p.name}
                </td>
                <td className={styles.dim}>
                  {p.unpaidCount > 0 && p.paidCount > 0
                    ? `${p.unpaidCount} new / ${p.count}`
                    : p.count}
                </td>
                <td>
                  {p.unpaidTotal > 0 ? (
                    <>
                      <span className={styles.paymentAmt}>{fmt(p.unpaidTotal)} ISK</span>
                      {p.paidTotal > 0 && (
                        <span className={styles.paidEarlier}>{fmt(p.paidTotal)} ISK already paid</span>
                      )}
                    </>
                  ) : (
                    <span className={styles.dim}>{fmt(p.paidTotal)} ISK paid</span>
                  )}
                </td>
                <td>
                  {p.paid ? (
                    <span className={styles.paidCell}>
                      <span
                        className={styles.paidBadge}
                        title={p.paidBy ? `Marked paid by ${p.paidBy}` : "Marked paid"}
                      >
                        ✓ {fmtDate(p.paidAt)}
                      </span>
                      {canApprove && (
                        <button
                          type="button"
                          className={styles.linkBtn}
                          onClick={() => mark(p.name, false)}
                          disabled={busyKey === p.name}
                        >
                          {busyKey === p.name ? "…" : "undo all"}
                        </button>
                      )}
                    </span>
                  ) : canApprove ? (
                    <button
                      type="button"
                      className={`${styles.btnSm} ${styles.btnApprove}`}
                      onClick={() => mark(p.name, true)}
                      disabled={busyKey === p.name}
                      title="Record the whole outstanding balance as paid (stamps the current time)"
                    >
                      {busyKey === p.name
                        ? "Saving…"
                        : p.paidCount > 0 ? "Mark rest paid" : "Mark all paid"}
                    </button>
                  ) : (
                    <span className={styles.dim}>Unpaid</span>
                  )}
                </td>
                <td>
                  <button
                    type="button"
                    className={styles.btnSm}
                    onClick={() => copyText(String(Math.round(p.unpaidTotal > 0 ? p.unpaidTotal : p.total)), p.name)}
                    title={p.unpaidTotal > 0 ? "Copy outstanding ISK to clipboard" : "Copy ISK amount to clipboard"}
                  >
                    {copiedKey === p.name ? "✓" : "Copy ISK"}
                  </button>
                </td>
              </tr>
              {isOpen && p.losses.map((l) => (
                <tr key={l.id} className={styles.subRow}>
                  <td className={styles.subRowShip}>
                    {l.shipName ?? "Unknown ship"}
                    {l.killTime && <span className={styles.subRowDate}>{fmtKillDate(l.killTime)}</span>}
                  </td>
                  <td></td>
                  <td><span className={styles.paymentAmt}>{fmt(l.paymentAmount)} ISK</span></td>
                  <td>
                    {l.paidAt ? (
                      <span className={styles.paidCell}>
                        <span
                          className={styles.paidBadge}
                          title={l.paidBy ? `Paid by ${l.paidBy}` : "Paid"}
                        >
                          ✓ {fmtDate(l.paidAt)}
                        </span>
                        {canApprove && (
                          <button
                            type="button"
                            className={styles.linkBtn}
                            onClick={() => mark(p.name, false, l.id)}
                            disabled={busyKey === l.id}
                          >
                            {busyKey === l.id ? "…" : "undo"}
                          </button>
                        )}
                      </span>
                    ) : canApprove ? (
                      <button
                        type="button"
                        className={`${styles.btnSm} ${styles.btnApprove}`}
                        onClick={() => mark(p.name, true, l.id)}
                        disabled={busyKey === l.id}
                        title="Mark just this loss paid"
                      >
                        {busyKey === l.id ? "Saving…" : "Mark Paid"}
                      </button>
                    ) : (
                      <span className={styles.dim}>Unpaid</span>
                    )}
                  </td>
                  <td></td>
                </tr>
              ))}
              </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function computeStats(losses) {
  const pending  = losses.filter((l) => l.status === "pending").length;
  const approved = losses.filter((l) => l.status === "approved").length;
  const rejected = losses.filter((l) => l.status === "rejected").length;
  const totalRequested = losses.reduce((s, l) => s + Number(l.lossValue ?? 0), 0);
  const totalPayout    = losses.filter((l) => l.status === "approved")
    .reduce((s, l) => s + Number(l.paymentAmount ?? 0), 0);
  return { total: losses.length, pending, approved, rejected, totalRequested, totalPayout };
}

// ── Views ─────────────────────────────────────────────────────────────────

function MonthlyRoundup({ auth }) {
  const [data,  setData]  = useState(null);
  const [error, setError] = useState(null);
  const abortRef = useRef(null);

  const load = useCallback(async () => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setError(null);
    try {
      const token = await auth.getAccessToken();
      const res = await fetch("/api/srp/summary", {
        headers: { Authorization: `Bearer ${token}` },
        signal: ctrl.signal,
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "Failed to load roundup");
      setData(body);
    } catch (err) {
      if (err.name !== "AbortError") setError(err.message);
    }
  }, [auth]);

  useEffect(() => { load(); return () => abortRef.current?.abort(); }, [load]);

  const months = data?.months ?? [];
  const headline = months[0] ?? null;
  const isCurrent = headline && headline.month === data?.currentMonth;
  const avgLoss = headline?.lossCount > 0
    ? `${fmt(headline.totalRequested / headline.lossCount)} ISK` : "—";
  const avgPayout = headline?.approvedCount > 0
    ? `${fmt(headline.totalPaid / headline.approvedCount)} ISK` : "—";

  return (
    <div className={styles.panel}>
      <span className={styles.panelTitle}>Monthly Roundup</span>

      {error && <div className={styles.error}>⚠ {error}</div>}

      {!error && data === null && <span className={styles.dim}>Loading…</span>}

      {!error && data !== null && months.length === 0 && (
        <div className={styles.empty}>No SRP activity yet.</div>
      )}

      {headline && (
        <>
          <div className={styles.detailMeta}>
            <span>{fmtMonth(headline.month)}{isCurrent ? " · so far this month" : ""}</span>
          </div>
          <div className={styles.statsRow}>
            <StatCard label="Fleets"        value={headline.fleetCount} />
            <StatCard label="Losses"        value={headline.lossCount} />
            <StatCard label="Approved"      value={headline.approvedCount} accent="success" />
            <StatCard label="Rejected"      value={headline.rejectedCount} accent="danger" />
            <StatCard label="Pending"       value={headline.pendingCount}  accent="warning" />
            <StatCard label="Pilots"        value={headline.pilotCount} />
            <StatCard label="Ship Value"    value={`${fmt(headline.totalRequested)} ISK`} wide />
            <StatCard label="ISK Paid Back" value={`${fmt(headline.totalPaid)} ISK`} accent="success" wide />
            <StatCard label="Avg Loss"      value={avgLoss} wide />
            <StatCard label="Avg Payout"    value={avgPayout} accent="success" wide />
          </div>
        </>
      )}

      {months.length > 0 && (
        <div className={styles.tableWrap}>
          <table className={`${styles.table} ${styles.tableStatic}`}>
            <thead>
              <tr>
                <th>Month</th>
                <th>Fleets</th>
                <th>Losses</th>
                <th>Approved</th>
                <th>Rejected</th>
                <th>Pending</th>
                <th>Ship Value</th>
                <th>ISK Paid</th>
                <th>Pilots</th>
              </tr>
            </thead>
            <tbody>
              {months.map((m) => (
                <tr key={m.month} className={m.month === data.currentMonth ? styles.rowCurrentMonth : ""}>
                  <td>{fmtMonth(m.month)}</td>
                  <td className={styles.dim}>{m.fleetCount}</td>
                  <td>{m.lossCount}</td>
                  <td>{m.approvedCount}</td>
                  <td className={styles.dim}>{m.rejectedCount}</td>
                  <td className={styles.dim}>{m.pendingCount}</td>
                  <td>{fmt(m.totalRequested)} ISK</td>
                  <td><span className={styles.paymentAmt}>{fmt(m.totalPaid)} ISK</span></td>
                  <td className={styles.dim}>{m.pilotCount}</td>
                </tr>
              ))}
              {data?.allTime && months.length > 1 && (
                <tr className={styles.dim}>
                  <td>All time</td>
                  <td>{data.allTime.fleetCount}</td>
                  <td>{data.allTime.lossCount}</td>
                  <td>{data.allTime.approvedCount}</td>
                  <td>{data.allTime.rejectedCount}</td>
                  <td>{data.allTime.pendingCount}</td>
                  <td>{fmt(data.allTime.totalRequested)} ISK</td>
                  <td>{fmt(data.allTime.totalPaid)} ISK</td>
                  <td>{data.allTime.pilotCount}</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function FleetList({ auth, onSelect, onCreate, onViewMine }) {
  const [fleets,  setFleets]  = useState(null);
  const [error,   setError]   = useState(null);
  const [subTab,  setSubTab]  = useState("current"); // "current" | "historic"
  const abortRef = useRef(null);

  const load = useCallback(async () => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setError(null);
    try {
      const token = await auth.getAccessToken();
      const res = await fetch("/api/srp/fleets", {
        headers: { Authorization: `Bearer ${token}` },
        signal: ctrl.signal,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to load fleets");
      setFleets(data.fleets ?? []);
    } catch (err) {
      if (err.name !== "AbortError") setError(err.message);
    }
  }, [auth]);

  useEffect(() => { load(); return () => abortRef.current?.abort(); }, [load]);

  const currentFleets  = (fleets ?? []).filter((f) => f.status === "open");
  const historicFleets = (fleets ?? []).filter((f) => f.status === "closed");
  const displayed = subTab === "current" ? currentFleets : historicFleets;

  return (
    <div className={styles.wrap}>
      <div className={styles.topBar}>
        <span className={styles.title}>SRP Fleets</span>
        <div className={styles.topBarActions}>
          <button className={`${styles.btn} ${styles.btnGhost}`} onClick={onViewMine}>My SRP</button>
          <button className={styles.btn} onClick={onCreate}>+ Create Fleet</button>
        </div>
      </div>

      <MonthlyRoundup auth={auth} />

      <div className={styles.tabBar}>
        <button
          className={`${styles.tab} ${subTab === "current" ? styles.tabActive : ""}`}
          onClick={() => setSubTab("current")}
        >
          Current
          {currentFleets.length > 0 && (
            <span className={styles.tabCount}>{currentFleets.length}</span>
          )}
        </button>
        <button
          className={`${styles.tab} ${subTab === "historic" ? styles.tabActive : ""}`}
          onClick={() => setSubTab("historic")}
        >
          Historic
          {historicFleets.length > 0 && (
            <span className={styles.tabCount}>{historicFleets.length}</span>
          )}
        </button>
      </div>

      {error && <div className={styles.error}>⚠ {error}</div>}

      {fleets === null && !error && <div className={styles.loading}>LOADING...</div>}

      {fleets !== null && displayed.length === 0 && (
        <div className={styles.empty}>
          {subTab === "current"
            ? "No open fleets. Create one to get started."
            : "No closed fleets yet."}
        </div>
      )}

      {displayed.length > 0 && (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Fleet</th>
                <th>FC</th>
                <th>Date</th>
                <th>Status</th>
                <th>Losses</th>
                <th>Pending</th>
              </tr>
            </thead>
            <tbody>
              {displayed.map((f) => (
                <tr key={f.id} onClick={() => onSelect(f.id)}>
                  <td>
                    <span className={styles.clickLink}>{f.fleetName}</span>
                  </td>
                  <td className={styles.dim}>{f.fcCharacterName}</td>
                  <td className={styles.dim}>{fmtDate(f.fleetDate)}</td>
                  <td><StatusBadge status={f.status} /></td>
                  <td className={styles.dim}>{f.lossCount}</td>
                  <td>
                    {f.pendingCount > 0
                      ? <span className={styles.pendingBadge}>{f.pendingCount}</span>
                      : <span className={styles.dim}>—</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function CreateFleet({ auth, onCreated, onBack }) {
  const [fleetName, setFleetName] = useState("");
  const [fleetDate, setFleetDate] = useState("");
  const [pingText,  setPingText]  = useState("");
  const [loading,   setLoading]   = useState(false);
  const [error,     setError]     = useState(null);

  async function handleSubmit(e) {
    e.preventDefault();
    if (!fleetName.trim() || !fleetDate) return;
    setLoading(true);
    setError(null);
    try {
      const token = await auth.getAccessToken();
      const body = {
        fleetName: fleetName.trim(),
        fleetDate,
        pingText: pingText.trim() || undefined,
      };
      const res = await fetch("/api/srp/fleets", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to create fleet");
      onCreated(data.fleet.id);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className={styles.wrap}>
      <div className={styles.topBar}>
        <span className={styles.title}>Create SRP Fleet</span>
        <button className={`${styles.btn} ${styles.btnGhost}`} onClick={onBack}>← Back</button>
      </div>

      <form className={styles.panel} onSubmit={handleSubmit}>
        <span className={styles.panelTitle}>Fleet Details</span>

        {error && <div className={styles.error}>⚠ {error}</div>}

        <div className={styles.fieldRow}>
          <label className={styles.label}>Fleet Name</label>
          <input
            className={styles.input}
            type="text"
            placeholder="e.g. Wednesday EUTZ Cruisers"
            value={fleetName}
            onChange={(e) => setFleetName(e.target.value)}
            maxLength={200}
            required
          />
        </div>

        <div className={styles.fieldRow}>
          <label className={styles.label}>Fleet Date / Time</label>
          <input
            className={styles.input}
            type="datetime-local"
            value={fleetDate}
            onChange={(e) => setFleetDate(e.target.value)}
            required
          />
        </div>

        <div className={styles.fieldRow}>
          <label className={styles.label}>Ping Text (optional)</label>
          <textarea
            className={styles.textarea}
            placeholder="Paste the fleet ping here so members can verify they were on the fleet…"
            value={pingText}
            onChange={(e) => setPingText(e.target.value)}
            maxLength={5000}
          />
        </div>

        <div className={styles.formActions}>
          <button className={styles.btn} type="submit" disabled={loading || !fleetName.trim() || !fleetDate}>
            {loading ? "Creating…" : "Create Fleet"}
          </button>
          <button type="button" className={`${styles.btn} ${styles.btnGhost}`} onClick={onBack} disabled={loading}>
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}

function FleetDetail({ auth, fleetId, onBack }) {
  const [fleet,      setFleet]      = useState(null);
  const [error,      setError]      = useState(null);
  const [zkillUrl,   setZkillUrl]   = useState("");
  const [notes,      setNotes]      = useState("");
  const [altAccount, setAltAccount] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitErr,  setSubmitErr]  = useState(null);
  const [closing,    setClosing]    = useState(false);
  const [deleting,   setDeleting]   = useState(false);
  const [action,     setAction]     = useState(null); // { lossId, lossLabel, type, paymentAmount, rejectionReason, submitting, error }
  const [zkillPreview, setZkillPreview] = useState(null); // null | { loading } | { fittedValue, shipName } | { error }
  const [lossFilter, setLossFilter] = useState(new Set()); // empty = show all
  const [selectedLossIds, setSelectedLossIds] = useState(new Set());
  const abortRef = useRef(null);
  const actionPanelRef = useRef(null);

  useEffect(() => {
    if (action && actionPanelRef.current) {
      actionPanelRef.current.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }, [action?.lossId, action?.type]);

  const load = useCallback(async () => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setError(null);
    try {
      const token = await auth.getAccessToken();
      const res = await fetch(`/api/srp/${fleetId}`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: ctrl.signal,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to load fleet");
      setFleet(data.fleet);
    } catch (err) {
      if (err.name !== "AbortError") setError(err.message);
    }
  }, [auth, fleetId]);

  useEffect(() => { load(); return () => abortRef.current?.abort(); }, [load]);

  useEffect(() => {
    const url = zkillUrl.trim();
    const match = url.match(/zkillboard\.com\/kill\/(\d+)/i);
    if (!match) { setZkillPreview(null); return; }
    const killId = match[1];
    setZkillPreview({ loading: true });
    let cancelled = false;
    (async () => {
      try {
        const zkRes = await fetch(`https://zkillboard.com/api/kills/killID/${killId}/`);
        const zkData = await zkRes.json();
        if (cancelled) return;
        const kill = zkData?.[0];
        if (!kill) { setZkillPreview({ error: "Kill not found" }); return; }
        const fittedValue = kill.zkb?.fittedValue ?? 0;
        const hash = kill.zkb?.hash;
        let shipName = null;
        let killTime = null;
        if (hash) {
          const esiRes = await fetch(`https://esi.evetech.net/latest/killmails/${killId}/${hash}/?datasource=tranquility`);
          const esiKm = await esiRes.json();
          if (!cancelled) {
            killTime = esiKm?.killmail_time ?? null;
            if (esiKm?.victim?.ship_type_id) {
              const nameRes = await fetch("https://esi.evetech.net/latest/universe/names/?datasource=tranquility", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify([esiKm.victim.ship_type_id]),
              });
              const names = await nameRes.json();
              shipName = names?.[0]?.name ?? null;
            }
          }
        }
        if (!cancelled) setZkillPreview({ fittedValue, shipName, killTime });
      } catch {
        if (!cancelled) setZkillPreview({ error: "Preview unavailable" });
      }
    })();
    return () => { cancelled = true; };
  }, [zkillUrl]);

  async function handleSubmitLoss(e) {
    e.preventDefault();
    if (!zkillUrl.trim()) return;
    setSubmitting(true);
    setSubmitErr(null);
    try {
      const token = await auth.getAccessToken();
      const res = await fetch(`/api/srp/${fleetId}/losses`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          zkillUrl: zkillUrl.trim(),
          notes: notes.trim() || undefined,
          altAccount: altAccount || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Submission failed");
      setZkillUrl("");
      setNotes("");
      setAltAccount(false);
      load();
    } catch (err) {
      setSubmitErr(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  async function handleToggleStatus() {
    if (!fleet) return;
    const newStatus = fleet.status === "open" ? "closed" : "open";
    setClosing(true);
    try {
      const token = await auth.getAccessToken();
      const res = await fetch(`/api/srp/${fleetId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ status: newStatus }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Update failed");
      setFleet((prev) => ({ ...prev, status: newStatus }));
    } catch (err) {
      setError(err.message);
    } finally {
      setClosing(false);
    }
  }

  async function handleDelete() {
    if (!fleet) return;
    const lossCount = (fleet.losses ?? []).length;
    const tail = lossCount > 0
      ? ` and all ${lossCount} loss${lossCount === 1 ? "" : "es"}`
      : "";
    if (!window.confirm(`Delete fleet "${fleet.fleetName}"${tail}? This cannot be undone.`)) return;
    setDeleting(true);
    try {
      const token = await auth.getAccessToken();
      const res = await fetch(`/api/srp/${fleetId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Delete failed");
      }
      onBack();
    } catch (err) {
      setError(err.message);
      setDeleting(false);
    }
  }

  function openApprove(loss) {
    const defaultPay = computePayout(loss.lossValue, SRP_DEFAULT_PCT, SRP_PAYOUT_CAP);
    setAction({
      lossId: loss.id,
      lossLabel: `${loss.characterName}'s ${loss.shipName ?? "ship"}`,
      type: "approve",
      paymentAmount: String(defaultPay),
      rejectionReason: "",
      submitting: false,
      error: null,
    });
  }

  function openReject(loss) {
    setAction({
      lossId: loss.id,
      lossLabel: `${loss.characterName}'s ${loss.shipName ?? "ship"}`,
      type: "reject",
      paymentAmount: "",
      rejectionReason: "",
      submitting: false,
      error: null,
    });
  }

  function openEditPayment(loss) {
    setAction({
      lossId: loss.id,
      lossLabel: `${loss.characterName}'s ${loss.shipName ?? "ship"}`,
      type: "editPayment",
      paymentAmount: Number(loss.paymentAmount ?? 0).toFixed(0),
      rejectionReason: "",
      submitting: false,
      error: null,
    });
  }

  function openEditNotes(loss) {
    setAction({
      lossId: loss.id,
      lossLabel: `${loss.characterName}'s ${loss.shipName ?? "ship"}`,
      type: "editNotes",
      notesDraft: loss.notes ?? "",
      submitting: false,
      error: null,
    });
  }

  async function handleDeleteOwnLoss(loss) {
    if (!window.confirm(`Withdraw your loss for ${loss.shipName ?? "this ship"}? This cannot be undone.`)) return;
    try {
      const token = await auth.getAccessToken();
      const res = await fetch(`/api/srp/${fleetId}/losses/${loss.id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Delete failed");
      }
      setFleet((prev) => ({ ...prev, losses: prev.losses.filter((l) => l.id !== loss.id) }));
    } catch (err) {
      setError(err.message);
    }
  }

  function openBulkApprove(lossIds) {
    setAction({
      type: "bulkApprove",
      lossIds: [...lossIds],
      bulkPctStr: String(Math.round(SRP_DEFAULT_PCT * 100)),
      bulkCapMStr: String(Math.round(SRP_PAYOUT_CAP / 1_000_000)),
      submitting: false,
      error: null,
    });
  }

  async function handleConfirmAction(e) {
    e.preventDefault();
    if (!action) return;
    setAction((prev) => ({ ...prev, submitting: true, error: null }));
    try {
      const token = await auth.getAccessToken();

      if (action.type === "bulkApprove") {
        const lossesById = new Map((fleet.losses ?? []).map((l) => [l.id, l]));
        const pct = (parseFloat(action.bulkPctStr) || 0) / 100;
        const cap = (parseFloat(action.bulkCapMStr) || 0) * 1_000_000;
        const results = await Promise.allSettled(
          action.lossIds.map(async (id) => {
            const loss = lossesById.get(id);
            const paymentAmount = computePayout(loss?.lossValue ?? 0, pct, cap);
            const res = await fetch(`/api/srp/${fleetId}/losses/${id}`, {
              method: "PATCH",
              headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
              body: JSON.stringify({ status: "approved", paymentAmount }),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || "Update failed");
            return data.loss;
          })
        );
        const updated = new Map();
        const failures = [];
        results.forEach((r, i) => {
          if (r.status === "fulfilled") updated.set(r.value.id, r.value);
          else failures.push({ id: action.lossIds[i], reason: r.reason?.message ?? "Failed" });
        });
        setFleet((prev) => ({
          ...prev,
          losses: prev.losses.map((l) => updated.get(l.id) ?? l),
        }));
        setSelectedLossIds(new Set());
        if (failures.length > 0) {
          setAction((prev) => ({
            ...prev,
            submitting: false,
            error: `Approved ${updated.size} of ${action.lossIds.length}. ${failures.length} failed: ${failures[0].reason}`,
          }));
        } else {
          setAction(null);
        }
        return;
      }

      const body = {};
      if (action.type === "editNotes") {
        body.notes = action.notesDraft.trim() || null;
      } else {
        body.status = action.type === "reject" ? "rejected" : "approved";
        if (body.status === "approved") body.paymentAmount = parseFloat(action.paymentAmount) || 0;
        else body.rejectionReason = action.rejectionReason.trim() || undefined;
      }

      const res = await fetch(`/api/srp/${fleetId}/losses/${action.lossId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Update failed");
      setFleet((prev) => ({
        ...prev,
        losses: prev.losses.map((l) => l.id === action.lossId ? data.loss : l),
      }));
      setAction(null);
    } catch (err) {
      setAction((prev) => ({ ...prev, submitting: false, error: err.message }));
    }
  }

  function toggleLossSelection(lossId) {
    setSelectedLossIds((prev) => {
      const next = new Set(prev);
      if (next.has(lossId)) next.delete(lossId);
      else next.add(lossId);
      return next;
    });
  }

  // Mark (or un-mark) approved losses as paid. With a lossId, just that one
  // loss; otherwise every approved loss for the pilot. Throws on failure so the
  // Ready-to-Pay panel can surface the error inline.
  async function handleMarkPaid(characterName, paid, lossId) {
    const token = await auth.getAccessToken();
    const res = await fetch(`/api/srp/${fleetId}/pay`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(lossId ? { lossId, paid } : { characterName, paid }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Failed to update payment");
    const updated = new Map((data.losses ?? []).map((l) => [l.id, l]));
    setFleet((prev) => ({
      ...prev,
      losses: prev.losses.map((l) => updated.get(l.id) ?? l),
    }));
  }

  if (error) {
    return (
      <div className={styles.wrap}>
        <div className={styles.topBar}>
          <span className={styles.title}>SRP Fleet</span>
          <button className={`${styles.btn} ${styles.btnGhost}`} onClick={onBack}>← Back</button>
        </div>
        <div className={styles.error}>⚠ {error}</div>
      </div>
    );
  }

  if (!fleet) {
    return (
      <div className={styles.wrap}>
        <div className={styles.topBar}>
          <span className={styles.title}>SRP Fleet</span>
          <button className={`${styles.btn} ${styles.btnGhost}`} onClick={onBack}>← Back</button>
        </div>
        <div className={styles.loading}>LOADING...</div>
      </div>
    );
  }

  const losses = fleet.losses ?? [];
  // Pending first so leadership sees the work-to-do at the top, then approved,
  // then rejected. Stable within each bucket by creation order.
  const STATUS_ORDER = { pending: 0, approved: 1, rejected: 2 };
  const sortedLosses = [...losses].sort((a, b) => {
    const sa = STATUS_ORDER[a.status] ?? 99;
    const sb = STATUS_ORDER[b.status] ?? 99;
    if (sa !== sb) return sa - sb;
    return (a.createdAt ?? "").localeCompare(b.createdAt ?? "");
  });
  const displayedLosses = lossFilter.size === 0
    ? sortedLosses
    : sortedLosses.filter(l => lossFilter.has(l.status));
  const stats = computeStats(losses);
  const currentMonth = new Date().toISOString().slice(0, 7);
  const canApprove = fleet.canApprove ?? false;
  const viewerCharacterId = auth?.eveAuth?.characterId ?? null;
  const pendingDisplayed = displayedLosses.filter((l) => l.status === "pending");
  const allPendingSelected = pendingDisplayed.length > 0
    && pendingDisplayed.every((l) => selectedLossIds.has(l.id));

  // Ready-to-pay rollup: approved losses grouped by pilot, with paid state
  // folded in. paid_at is stamped per loss when leadership presses "Paid".
  // We track paid vs unpaid totals separately so the headline "Amount" is the
  // *outstanding* (still-owed) sum — a freshly-approved loss bundled in after
  // an earlier payout shows up as the new amount to send, not a confusing
  // grand total. A pilot row counts as fully paid once every approved loss is.
  const approvedByPilot = (() => {
    const m = new Map();
    for (const l of losses) {
      if (l.status !== "approved") continue;
      const amt = Number(l.paymentAmount ?? 0);
      if (!(amt > 0)) continue;
      const key = l.characterName ?? "Unknown";
      const cur = m.get(key) ?? {
        name: key, total: 0, count: 0,
        paidCount: 0, paidTotal: 0,
        unpaidCount: 0, unpaidTotal: 0,
        paidAt: null, paidBy: null,
        losses: [],
      };
      cur.total += amt;
      cur.count += 1;
      cur.losses.push(l);
      if (l.paidAt) {
        cur.paidCount += 1;
        cur.paidTotal += amt;
        if (!cur.paidAt || l.paidAt > cur.paidAt) {
          cur.paidAt = l.paidAt;
          cur.paidBy = l.paidBy ?? null;
        }
      } else {
        cur.unpaidCount += 1;
        cur.unpaidTotal += amt;
      }
      m.set(key, cur);
    }
    return [...m.values()]
      .map((p) => ({
        ...p,
        paid: p.count > 0 && p.paidCount === p.count,
        // Unpaid losses first within a pilot, then oldest-first — matches the
        // order leadership works through them.
        losses: p.losses.sort((a, b) =>
          (a.paidAt ? 1 : 0) - (b.paidAt ? 1 : 0) ||
          (a.createdAt ?? "").localeCompare(b.createdAt ?? "")
        ),
      }))
      // Biggest outstanding balance first; fully-paid pilots sink to the bottom.
      .sort((a, b) => (b.unpaidTotal - a.unpaidTotal) || (b.total - a.total));
  })();

  return (
    <div className={styles.wrap}>
      <div className={styles.topBar}>
        <span className={styles.title}>SRP Fleet</span>
        <button className={`${styles.btn} ${styles.btnGhost}`} onClick={onBack}>← Back to Fleets</button>
      </div>

      {/* Fleet info panel */}
      <div className={styles.panel}>
        <div className={styles.detailLayout}>
          <div className={styles.detailHeader}>
            <span className={styles.panelTitle}>{fleet.fleetName}</span>
            <div className={styles.detailMeta}>
              <span>FC: {fleet.fcCharacterName}</span>
              <span>{fmtDate(fleet.fleetDate)}</span>
              <StatusBadge status={fleet.status} />
            </div>
            {fleet.pingText && (
              <div className={styles.detailPing}>{fleet.pingText}</div>
            )}
          </div>
          {canApprove && (
            <div className={styles.detailActions}>
              <span className={styles.leaderTag} title="Only leadership can close or delete fleets">
                ★ Leadership only
              </span>
              <div className={styles.detailActionsRow}>
                <button
                  className={`${styles.btn} ${fleet.status === "open" ? styles.btnDanger : styles.btn}`}
                  onClick={handleToggleStatus}
                  disabled={closing || deleting}
                >
                  {closing ? "Updating…" : fleet.status === "open" ? "Close Fleet" : "Re-open Fleet"}
                </button>
                <button
                  className={`${styles.btn} ${styles.btnDanger}`}
                  onClick={handleDelete}
                  disabled={closing || deleting}
                  title="Permanently delete this fleet and all its losses"
                >
                  {deleting ? "Deleting…" : "Delete Fleet"}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Stats strip — always visible so reviewer counts stay in sight */}
      <div className={`${styles.statsRow} ${styles.statsRowDetail}`}>
        <StatCard label="Total Losses" value={stats.total} />
        <StatCard label="Pending" value={stats.pending} accent="warning" />
        <StatCard label="Approved" value={stats.approved} accent="success" />
        <StatCard label="Rejected" value={stats.rejected} accent="danger" />
        <StatCard label="Total Requested" value={`${fmt(stats.totalRequested)} ISK`} wide />
        <StatCard label="Total Payout" value={`${fmt(stats.totalPayout)} ISK`} accent="success" wide />
      </div>

      {/* Loss list */}
      <div className={styles.sectionTitle}>Submitted Losses</div>

      {!canApprove && losses.length > 0 && (
        <div className={styles.viewOnlyNotice}>
          View-only — only leadership can approve, reject, or edit payments.
        </div>
      )}

      {losses.length > 0 && (
        <div className={styles.lossFilterBar}>
          {["pending","approved","rejected"].map(s => (
            <button
              key={s}
              className={`${styles.statusPill} ${styles["pill_" + s]} ${lossFilter.has(s) ? styles.pillActive : ""}`}
              onClick={() => setLossFilter(prev => {
                const next = new Set(prev);
                if (next.has(s)) next.delete(s); else next.add(s);
                return next;
              })}
            >
              {s.toUpperCase()}
              {" "}({losses.filter(l => l.status === s).length})
            </button>
          ))}
          {lossFilter.size > 0 && (
            <button className={styles.pillClear} onClick={() => setLossFilter(new Set())}>✕ CLEAR</button>
          )}
        </div>
      )}

      {canApprove && selectedLossIds.size > 0 && (
        <div className={styles.bulkBar}>
          <span className={styles.bulkBarCount}>
            {selectedLossIds.size} selected
          </span>
          <button
            type="button"
            className={`${styles.btn} ${styles.btnSuccess}`}
            onClick={() => openBulkApprove(selectedLossIds)}
            disabled={!!action}
          >
            Approve {selectedLossIds.size} selected
          </button>
          <button
            type="button"
            className={`${styles.btn} ${styles.btnGhost}`}
            onClick={() => setSelectedLossIds(new Set())}
            disabled={!!action}
          >
            Clear
          </button>
        </div>
      )}

      {losses.length === 0 && (
        <div className={styles.empty}>
          {fleet.status === "open"
            ? "No losses submitted yet. Use the form below to claim payout for a loss."
            : "This fleet is closed. No losses were submitted."}
        </div>
      )}

      {losses.length > 0 && (
        <div className={styles.tableWrap}>
          <table className={`${styles.table} ${styles.tableStatic}`}>
            <thead>
              <tr>
                {canApprove && (
                  <th className={styles.checkboxCell} title="Select all visible pending losses">
                    <input
                      type="checkbox"
                      checked={allPendingSelected}
                      disabled={pendingDisplayed.length === 0 || !!action}
                      onChange={() => {
                        setSelectedLossIds((prev) => {
                          if (allPendingSelected) {
                            const next = new Set(prev);
                            for (const l of pendingDisplayed) next.delete(l.id);
                            return next;
                          }
                          const next = new Set(prev);
                          for (const l of pendingDisplayed) next.add(l.id);
                          return next;
                        });
                      }}
                    />
                  </th>
                )}
                <th>Character</th>
                <th>Ship</th>
                <th>Lost</th>
                <th>Loss Value</th>
                <th>Payment</th>
                <th>Status</th>
                <th>Notes</th>
                <th>Kill</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {displayedLosses.map((l) => {
                const isMine = viewerCharacterId != null &&
                  (l.characterId === viewerCharacterId || l.submittedById === viewerCharacterId);
                const submittedByOther = l.submittedById != null && l.submittedById !== l.characterId;
                return (
                <tr key={l.id} className={[
                  action?.lossId === l.id ? styles.rowActive : "",
                  styles["rowStatus_" + l.status] ?? "",
                  isMine ? styles.rowMine : "",
                ].filter(Boolean).join(" ")}>
                  {canApprove && (
                    <td className={styles.checkboxCell}>
                      {l.status === "pending" ? (
                        <input
                          type="checkbox"
                          checked={selectedLossIds.has(l.id)}
                          disabled={!!action}
                          onChange={() => toggleLossSelection(l.id)}
                        />
                      ) : null}
                    </td>
                  )}
                  <td>
                    {l.characterName}
                    {isMine && <span className={styles.youTag} title="This is you">YOU</span>}
                    {submittedByOther && (
                      <div className={styles.submittedBy}>
                        submitted by {l.submittedByName ?? "Unknown"}
                      </div>
                    )}
                  </td>
                  <td>{l.shipName ?? <span className={styles.dim}>Unknown</span>}</td>
                  <td className={styles.dim}>
                    {l.killTime ? (() => {
                      const offMonth = monthKey(l.killTime) !== currentMonth;
                      return (
                        <span
                          className={offMonth ? styles.killTimeOff : ""}
                          title={offMonth ? "Killed outside the current month" : undefined}
                        >
                          {fmtKillDate(l.killTime)}
                          {offMonth && <span className={styles.offMonthTag}>off-month</span>}
                        </span>
                      );
                    })() : "—"}
                  </td>
                  <td>{fmt(l.lossValue)} ISK</td>
                  <td>
                    {l.status === "approved"
                      ? <span className={styles.paymentAmt}>{fmt(l.paymentAmount)} ISK</span>
                      : <span className={styles.dim}>—</span>}
                  </td>
                  <td>
                    <StatusBadge status={l.status} />
                    {l.status === "rejected" && l.rejectionReason && (
                      <span className={styles.rejReasonInline}>{l.rejectionReason}</span>
                    )}
                    {(l.status === "approved" || l.status === "rejected") && l.decidedBy && (
                      <span
                        className={styles.decidedByInline}
                        title={l.decidedAt ? `${l.status === "approved" ? "Approved" : "Rejected"} by ${l.decidedBy} · ${fmtDate(l.decidedAt)}` : undefined}
                      >
                        by {l.decidedBy}
                      </span>
                    )}
                  </td>
                  <td className={`${styles.dim} ${styles.notesCell}`} title={l.notes ?? ""}>{l.notes ?? "—"}</td>
                  <td>
                    {l.zkillUrl
                      ? <a href={l.zkillUrl} target="_blank" rel="noopener noreferrer" className={styles.clickLink}>zKill ↗</a>
                      : "—"}
                  </td>
                  <td>
                    <div className={styles.actionBtns}>
                      {canApprove && l.status === "pending" && (
                        <>
                          <button
                            className={`${styles.btnSm} ${styles.btnApprove}`}
                            onClick={() => openApprove(l)}
                            disabled={!!action}
                            title="Approve"
                          >✓</button>
                          <button
                            className={`${styles.btnSm} ${styles.btnReject}`}
                            onClick={() => openReject(l)}
                            disabled={!!action}
                            title="Reject"
                          >✗</button>
                        </>
                      )}
                      {canApprove && l.status === "approved" && (
                        <button
                          className={styles.btnSm}
                          onClick={() => openEditPayment(l)}
                          disabled={!!action}
                          title="Edit payment amount"
                        >✎ Edit</button>
                      )}
                      {isMine && l.status === "pending" && (
                        <>
                          <button
                            className={styles.btnSm}
                            onClick={() => openEditNotes(l)}
                            disabled={!!action}
                            title="Edit your notes"
                          >✎ Notes</button>
                          <button
                            className={`${styles.btnSm} ${styles.btnReject}`}
                            onClick={() => handleDeleteOwnLoss(l)}
                            disabled={!!action}
                            title="Withdraw this loss"
                          >🗑</button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Approve / Reject / Edit-notes action panel */}
      {action && (
        <form ref={actionPanelRef} className={styles.actionPanel} onSubmit={handleConfirmAction}>
          <div className={styles.actionPanelHeader}>
            <span className={styles.actionPanelTitle}>
              {action.type === "bulkApprove"
                ? `Approve ${action.lossIds.length} losses`
                : `${
                    action.type === "approve" ? "Approve"
                    : action.type === "editPayment" ? "Edit Payment"
                    : action.type === "editNotes" ? "Edit Notes"
                    : "Reject"
                  }: ${action.lossLabel}`}
            </span>
            {action.type !== "editNotes" && (
              <span className={styles.leaderTag}>★ Leadership only</span>
            )}
          </div>

          {action.error && <div className={styles.error}>⚠ {action.error}</div>}

          {action.type === "bulkApprove" ? (() => {
            const pct = (parseFloat(action.bulkPctStr) || 0) / 100;
            const cap = (parseFloat(action.bulkCapMStr) || 0) * 1_000_000;
            const lossesById = new Map((fleet.losses ?? []).map((l) => [l.id, l]));
            let total = 0;
            let cappedCount = 0;
            for (const id of action.lossIds) {
              const loss = lossesById.get(id);
              const lv = Number(loss?.lossValue ?? 0);
              const raw = lv * pct;
              const pay = computePayout(lv, pct, cap);
              total += pay;
              if (raw > cap) cappedCount += 1;
            }
            return (
              <>
                <div className={styles.bulkFields}>
                  <div className={styles.fieldRow}>
                    <label className={styles.label}>Payout % of loss</label>
                    <input
                      className={styles.input}
                      type="number"
                      min="0"
                      max="100"
                      step="1"
                      value={action.bulkPctStr}
                      onChange={(e) => setAction((prev) => ({ ...prev, bulkPctStr: e.target.value }))}
                    />
                  </div>
                  <div className={styles.fieldRow}>
                    <label className={styles.label}>Cap per loss (M ISK)</label>
                    <input
                      className={styles.input}
                      type="number"
                      min="0"
                      step="1"
                      value={action.bulkCapMStr}
                      onChange={(e) => setAction((prev) => ({ ...prev, bulkCapMStr: e.target.value }))}
                    />
                  </div>
                </div>
                <div className={styles.bulkPreview}>
                  <span>
                    Total payout: <strong className={styles.paymentAmt}>{fmt(total)} ISK</strong>
                  </span>
                  {cappedCount > 0 && (
                    <span className={styles.dim}>
                      {cappedCount} of {action.lossIds.length} hits the {action.bulkCapMStr}M cap
                    </span>
                  )}
                </div>
                <span className={styles.dim} style={{ fontSize: 11 }}>
                  Each loss is paid at the percentage above, capped per-loss. Individual payments can be edited afterwards.
                </span>
              </>
            );
          })() : action.type === "editNotes" ? (
            <div className={styles.fieldRow}>
              <label className={styles.label}>Notes</label>
              <textarea
                className={styles.textarea}
                rows={3}
                placeholder="Add or fix your note for this loss…"
                value={action.notesDraft}
                onChange={(e) => setAction((prev) => ({ ...prev, notesDraft: e.target.value }))}
                maxLength={2000}
              />
            </div>
          ) : action.type !== "reject" ? (() => {
            const loss = (fleet.losses ?? []).find((l) => l.id === action.lossId);
            const lv = Number(loss?.lossValue ?? 0);
            const pay = parseFloat(action.paymentAmount) || 0;
            const pct = lv > 0 ? (pay / lv) * 100 : null;
            return (
              <div className={styles.fieldRow}>
                <label className={styles.label}>
                  Payment Amount (ISK)
                </label>
                <input
                  className={styles.input}
                  type="number"
                  min="0"
                  step="1"
                  value={action.paymentAmount}
                  onChange={(e) => setAction((prev) => ({ ...prev, paymentAmount: e.target.value }))}
                  required
                />
                {pay > 0 && (
                  <span className={styles.payHint}>
                    {fmt(pay)} ISK{pct != null ? ` · ${pct.toFixed(1)}% of loss` : ""}
                  </span>
                )}
              </div>
            );
          })() : (
            <div className={styles.fieldRow}>
              <label className={styles.label}>Reason (optional)</label>
              <textarea
                className={styles.textarea}
                rows={2}
                placeholder="e.g. Ship not on doctrine, not on fleet"
                value={action.rejectionReason}
                onChange={(e) => setAction((prev) => ({ ...prev, rejectionReason: e.target.value }))}
                maxLength={500}
              />
            </div>
          )}

          <div className={styles.formActions}>
            <button
              type="submit"
              className={`${styles.btn} ${action.type === "reject" ? styles.btnDanger : styles.btnSuccess}`}
              disabled={action.submitting}
            >
              {action.submitting
                ? "Saving…"
                : action.type === "approve" ? "Confirm Approve"
                : action.type === "editPayment" ? "Save Payment"
                : action.type === "editNotes" ? "Save Notes"
                : action.type === "bulkApprove" ? `Approve ${action.lossIds.length}`
                : "Confirm Reject"}
            </button>
            <button
              type="button"
              className={`${styles.btn} ${styles.btnGhost}`}
              onClick={() => setAction(null)}
              disabled={action.submitting}
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {/* Ready-to-pay rollup — approved losses grouped by pilot */}
      {approvedByPilot.length > 0 && (
        <ReadyToPay
          pilots={approvedByPilot}
          canApprove={canApprove}
          onMarkPaid={handleMarkPaid}
        />
      )}

      {/* Submit loss form — only when fleet is open */}
      {fleet.status === "open" && (
        <form className={`${styles.panel} ${styles.lossForm}`} onSubmit={handleSubmitLoss}>
          <span className={styles.lossFormTitle}>Submit My Loss</span>

          {submitErr && <div className={styles.error}>⚠ {submitErr}</div>}

          <div className={styles.fieldRow}>
            <label className={styles.label}>zKillboard URL</label>
            <input
              className={styles.input}
              type="url"
              placeholder="https://zkillboard.com/kill/12345678/"
              value={zkillUrl}
              onChange={(e) => setZkillUrl(e.target.value)}
              required
            />
          </div>
          {zkillPreview && (
            <div className={styles.zkillPreview}>
              {zkillPreview.loading && (
                <span className={styles.dim}>
                  <span className={styles.spinner} />Verifying kill…
                </span>
              )}
              {zkillPreview.error && <span className={styles.previewErr}>⚠ {zkillPreview.error}</span>}
              {zkillPreview.fittedValue != null && (
                <span className={styles.previewOk}>
                  ✓ {zkillPreview.shipName ?? "Unknown ship"} — {fmt(zkillPreview.fittedValue)} ISK fitted
                </span>
              )}
              {zkillPreview.fittedValue != null && zkillPreview.killTime && fleet.fleetDate &&
                Math.abs(new Date(zkillPreview.killTime) - new Date(fleet.fleetDate)) > KILL_FLEET_GAP_MS && (
                <span className={styles.previewWarn}>
                  ⚠ This kill is from {fmtKillDate(zkillPreview.killTime)}, but this fleet is dated{" "}
                  {fmtKillDate(fleet.fleetDate)}. Double-check you're submitting to the right fleet.
                </span>
              )}
            </div>
          )}

          <div className={styles.fieldRow}>
            <label className={styles.label}>Notes (optional)</label>
            <input
              className={styles.input}
              type="text"
              placeholder="e.g. Was primary, got alpha'd before reps landed"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              maxLength={2000}
            />
          </div>

          <label className={styles.checkboxRow}>
            <input
              type="checkbox"
              checked={altAccount}
              onChange={(e) => setAltAccount(e.target.checked)}
            />
            <span>
              Alt account
              <span className={styles.checkboxHint}>
                — submit on behalf of another character, including out-of-corp alts flown on specialized fleets
              </span>
            </span>
          </label>

          <div className={styles.formActions}>
            <button className={styles.btn} type="submit" disabled={submitting || !zkillUrl.trim()}>
              {submitting ? "Submitting…" : "Submit Loss"}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

function MyClaims({ auth, onBack, onSelect }) {
  const [data,  setData]  = useState(null);
  const [error, setError] = useState(null);
  const abortRef = useRef(null);

  const load = useCallback(async () => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setError(null);
    try {
      const token = await auth.getAccessToken();
      const res = await fetch("/api/srp/mine", {
        headers: { Authorization: `Bearer ${token}` },
        signal: ctrl.signal,
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "Failed to load your SRP");
      setData(body);
    } catch (err) {
      if (err.name !== "AbortError") setError(err.message);
    }
  }, [auth]);

  useEffect(() => { load(); return () => abortRef.current?.abort(); }, [load]);

  const summary = data?.summary ?? null;
  const losses = data?.losses ?? [];

  return (
    <div className={styles.wrap}>
      <div className={styles.topBar}>
        <span className={styles.title}>My SRP</span>
        <button className={`${styles.btn} ${styles.btnGhost}`} onClick={onBack}>← Back to Fleets</button>
      </div>

      {error && <div className={styles.error}>⚠ {error}</div>}

      {!error && data === null && <div className={styles.loading}>LOADING...</div>}

      {summary && (
        <div className={`${styles.statsRow} ${styles.statsRowDetail}`}>
          <StatCard label="Pending"      value={summary.pending}  accent="warning" />
          <StatCard label="Approved"     value={summary.approved} accent="success" />
          <StatCard label="Rejected"     value={summary.rejected} accent="danger" />
          <StatCard label="Approved ISK" value={`${fmt(summary.totalApproved)} ISK`} accent="success" wide />
          <StatCard label="Paid Out"     value={`${fmt(summary.totalPaid)} ISK`} accent="success" wide />
          <StatCard label="Outstanding"  value={`${fmt(summary.totalOutstanding)} ISK`} wide />
        </div>
      )}

      {data !== null && losses.length === 0 && !error && (
        <div className={styles.empty}>You haven't submitted any SRP losses yet.</div>
      )}

      {losses.length > 0 && (
        <div className={styles.tableWrap}>
          <table className={`${styles.table} ${styles.tableStatic}`}>
            <thead>
              <tr>
                <th>Fleet</th>
                <th>Ship</th>
                <th>Lost</th>
                <th>Loss Value</th>
                <th>Payment</th>
                <th>Status</th>
                <th>Paid</th>
              </tr>
            </thead>
            <tbody>
              {losses.map((l) => (
                <tr key={l.id} onClick={() => l.fleetId && onSelect(l.fleetId)}>
                  <td><span className={styles.clickLink}>{l.fleetName ?? "—"}</span></td>
                  <td>{l.shipName ?? <span className={styles.dim}>Unknown</span>}</td>
                  <td className={styles.dim}>{l.killTime ? fmtKillDate(l.killTime) : "—"}</td>
                  <td>{fmt(l.lossValue)} ISK</td>
                  <td>
                    {l.status === "approved"
                      ? <span className={styles.paymentAmt}>{fmt(l.paymentAmount)} ISK</span>
                      : <span className={styles.dim}>—</span>}
                  </td>
                  <td>
                    <StatusBadge status={l.status} />
                    {l.status === "rejected" && l.rejectionReason && (
                      <span className={styles.rejReasonInline}>{l.rejectionReason}</span>
                    )}
                  </td>
                  <td>
                    {l.status === "approved"
                      ? (l.paidAt
                          ? <span className={styles.paidBadge}>✓ {fmtDate(l.paidAt)}</span>
                          : <span className={styles.dim}>Awaiting payout</span>)
                      : <span className={styles.dim}>—</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── Main export ───────────────────────────────────────────────────────────

export default function SrpTab({ auth }) {
  const [view,    setView]    = useState("list");   // 'list' | 'create' | 'detail' | 'mine'
  const [fleetId, setFleetId] = useState(null);

  function openFleet(id) { setFleetId(id); setView("detail"); }
  function goBack()      { setView("list"); setFleetId(null); }

  if (view === "create") {
    return <CreateFleet auth={auth} onCreated={(id) => openFleet(id)} onBack={goBack} />;
  }
  if (view === "detail" && fleetId) {
    return <FleetDetail auth={auth} fleetId={fleetId} onBack={goBack} />;
  }
  if (view === "mine") {
    return <MyClaims auth={auth} onBack={goBack} onSelect={openFleet} />;
  }
  return (
    <FleetList
      auth={auth}
      onSelect={openFleet}
      onCreate={() => setView("create")}
      onViewMine={() => setView("mine")}
    />
  );
}
