import React, { useState, useEffect, useCallback, useRef, useMemo } from "react";
import styles from "./Fund.module.css";
import { fmtIsk } from "../../lib/format.js";

function fmtDate(ts) {
  if (!ts) return "—";
  return new Date(ts).toLocaleString("en-US", {
    year: "numeric", month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit", hour12: false,
  });
}

function tierLabel(t) {
  return ({
    associate:           "Associate",
    shareholder:         "Shareholder",
    senior_shareholder:  "Senior Shareholder",
    partner:             "Partner",
  })[t] ?? t;
}

function kindLabel(k) {
  return ({
    deposit:    "Deposit",
    withdrawal: "Withdrawal",
    interest:   "Interest",
    adjustment: "Adjustment",
  })[k] ?? k;
}

function tierClass(t) {
  return ({
    associate:           styles.tierAssociate,
    shareholder:         styles.tierShareholder,
    senior_shareholder:  styles.tierSenior_shareholder,
    partner:             styles.tierPartner,
  })[t] ?? styles.tierAssociate;
}

function kindClass(k) {
  return ({
    deposit:    styles.kindDeposit,
    withdrawal: styles.kindWithdrawal,
    interest:   styles.kindInterest,
    adjustment: styles.kindAdjustment,
  })[k] ?? styles.kindAdjustment;
}

function nextMonth(yyyymm) {
  const [y, m] = yyyymm.split("-").map(Number);
  const next = new Date(Date.UTC(y, m, 1));
  const ny = next.getUTCFullYear();
  const nm = String(next.getUTCMonth() + 1).padStart(2, "0");
  return `${ny}-${nm}`;
}

export default function Fund({ auth }) {
  const [summary,      setSummary]      = useState(null);
  const [ledger,       setLedger]       = useState(null);
  const [error,        setError]        = useState(null);
  const [showForms,    setShowForms]    = useState(false);
  const [editingEntry, setEditingEntry] = useState(null);
  const [deletingId,   setDeletingId]   = useState(null);
  const abortRef = useRef(null);

  const load = useCallback(async () => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setError(null);
    try {
      const token = await auth.getAccessToken();
      const headers = { Authorization: `Bearer ${token}` };
      const [s, l] = await Promise.all([
        fetch("/api/fund/summary",    { headers, signal: ctrl.signal }).then((r) => r.json().then((j) => ({ ok: r.ok, j }))),
        fetch("/api/fund/ledger?limit=25", { headers, signal: ctrl.signal }).then((r) => r.json().then((j) => ({ ok: r.ok, j }))),
      ]);
      if (!s.ok) throw new Error(s.j.error || "Failed to load summary");
      if (!l.ok) throw new Error(l.j.error || "Failed to load ledger");
      setSummary(s.j);
      setLedger(l.j.entries ?? []);
    } catch (err) {
      if (err.name !== "AbortError") setError(err.message);
    }
  }, [auth]);

  useEffect(() => { load(); return () => abortRef.current?.abort(); }, [load]);

  const currentMonth = summary?.currentMonth ?? "";
  const paidThisMonth = useMemo(() => {
    if (!ledger || !currentMonth) return new Set();
    return new Set(
      ledger
        .filter(e => e.kind === "interest" && e.effectiveMonth === currentMonth)
        .map(e => e.characterName)
    );
  }, [ledger, currentMonth]);

  if (error) {
    return (
      <div className={styles.wrap}>
        <div className={styles.topBar}>
          <span className={styles.title}>#trustfund</span>
        </div>
        <div className={styles.error}>⚠ {error}</div>
      </div>
    );
  }

  if (!summary) {
    return (
      <div className={styles.wrap}>
        <div className={styles.topBar}>
          <span className={styles.title}>#trustfund</span>
        </div>
        <div className={styles.loading}>LOADING...</div>
      </div>
    );
  }

  const { currentRatePct, currentRateReason, isLeader, totals, investors, principalHistory } = summary;

  // Ledger columns: When / Character / Kind / Amount / Effective / Notes / By / (Actions if leader)
  const colCount = isLeader ? 8 : 7;

  return (
    <div className={styles.wrap}>
      <div className={styles.topBar}>
        <div>
          <span className={styles.title}>#trustfund</span>
          <span className={styles.subtitle}> · pooled investment ledger</span>
        </div>
        <div className={styles.actionGroup}>
          {isLeader && <span className={styles.leadershipBadge}>Leadership</span>}
          {isLeader && (
            <button className={styles.btn} onClick={() => setShowForms((v) => !v)}>
              {showForms ? "Hide tools" : "Edit fund"}
            </button>
          )}
        </div>
      </div>

      {/* Headline rate strip */}
      <div className={`${styles.panel} ${styles.panelLeadership} ${styles.headlinePanel}`}>
        <div className={styles.rateStrip}>
          <span className={styles.panelSubtitle}>Rate for {currentMonth}</span>
          <div className={styles.rateMonthRow}>
            <span className={styles.rateBig}>{Number(currentRatePct).toFixed(2)}%</span>
            <span className={styles.rateReason}>· {currentRateReason}</span>
          </div>
        </div>
        <PrincipalChart history={principalHistory ?? []} />
      </div>

      {/* Stats */}
      <div className={styles.statsRow}>
        <div className={`${styles.statCard} ${styles.statCardAccent}`}>
          <span className={styles.statLabel}>Total Principal</span>
          <span className={styles.statValue}>{fmtIsk(totals.principal)} ISK</span>
          <span className={styles.statSub}>{totals.investorCount} active investor{totals.investorCount === 1 ? "" : "s"}</span>
        </div>
        <div className={`${styles.statCard} ${styles.statCardSuccess}`}>
          <span className={styles.statLabel}>Monthly Obligation</span>
          <span className={styles.statValue}>{fmtIsk(totals.monthlyObligation)} ISK</span>
          <span className={styles.statSub}>at {Number(currentRatePct).toFixed(2)}%</span>
        </div>
        <div className={styles.statCard}>
          <span className={styles.statLabel}>Interest Paid YTD</span>
          <span className={styles.statValue}>{fmtIsk(totals.interestPaidYtd)} ISK</span>
          <span className={styles.statSub}>{currentMonth.slice(0, 4)}</span>
        </div>
      </div>

      {/* Leadership tools */}
      {isLeader && showForms && (
        <LeadershipPanel
          auth={auth}
          currentMonth={currentMonth}
          onChange={load}
        />
      )}

      {/* Investors */}
      <div className={styles.topBar}>
        <span className={styles.title}>Investors</span>
      </div>
      {investors.length === 0 && (
        <div className={styles.empty}>
          No investors yet. {isLeader ? "Click Edit fund to record the first deposit." : ""}
        </div>
      )}
      {investors.length > 0 && (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Character</th>
                <th>Tier</th>
                <th className={styles.right}>Deposit</th>
                <th className={styles.right}>Monthly @ {Number(currentRatePct).toFixed(2)}%</th>
                <th>Last activity</th>
                <th className={styles.right} title={`Interest recorded for ${currentMonth}`}>Paid {currentMonth.slice(5)}</th>
              </tr>
            </thead>
            <tbody>
              {investors.map((inv) => (
                <tr key={inv.characterId}>
                  <td>{inv.characterName}</td>
                  <td>
                    <span className={`${styles.tierBadge} ${tierClass(inv.tier)}`}>
                      {tierLabel(inv.tier)}
                    </span>
                  </td>
                  <td className={`${styles.right} ${styles.balance}`}>{fmtIsk(inv.balance)} ISK</td>
                  <td className={`${styles.right} ${styles.return}`}>{fmtIsk(inv.monthlyReturn)} ISK</td>
                  <td className={styles.dim}>{fmtDate(inv.lastActivityAt)}</td>
                  <td className={styles.right}>
                    {paidThisMonth.has(inv.characterName)
                      ? <span style={{ color: "var(--sell)" }}>✓</span>
                      : <span style={{ color: "var(--text-dim)" }}>—</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Ledger feed */}
      <div className={styles.topBar}>
        <span className={styles.title}>Recent activity</span>
      </div>
      {(!ledger || ledger.length === 0) && (
        <div className={styles.empty}>No entries yet.</div>
      )}
      {ledger && ledger.length > 0 && (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>When</th>
                <th>Character</th>
                <th>Kind</th>
                <th className={styles.right}>Amount</th>
                <th>Effective</th>
                <th>Notes</th>
                <th>By</th>
                {isLeader && <th></th>}
              </tr>
            </thead>
            <tbody>
              {ledger.map((e) => {
                if (editingEntry?.id === e.id) {
                  return (
                    <EditLedgerRow
                      key={e.id}
                      entry={editingEntry}
                      auth={auth}
                      colSpan={colCount}
                      onDone={() => { setEditingEntry(null); load(); }}
                      onCancel={() => setEditingEntry(null)}
                    />
                  );
                }
                if (deletingId === e.id) {
                  return (
                    <DeleteConfirmRow
                      key={e.id}
                      entry={e}
                      auth={auth}
                      colSpan={colCount}
                      onDone={() => { setDeletingId(null); load(); }}
                      onCancel={() => setDeletingId(null)}
                    />
                  );
                }
                return (
                  <tr key={e.id}>
                    <td className={styles.dim}>{fmtDate(e.recordedAt)}</td>
                    <td>{e.characterName ?? `#${e.characterId}`}</td>
                    <td>
                      <span className={`${styles.kindBadge} ${kindClass(e.kind)}`}>
                        {kindLabel(e.kind)}
                      </span>
                    </td>
                    <td className={`${styles.right} ${e.amount >= 0 ? styles.amountPositive : styles.amountNegative}`}>
                      {fmtIsk(e.amount)} ISK
                    </td>
                    <td className={styles.dim}>{e.effectiveMonth}</td>
                    <td className={styles.dim}>{e.notes ?? "—"}</td>
                    <td className={styles.dim}>{e.recordedByName}</td>
                    {isLeader && (
                      <td className={styles.actionsCell}>
                        <button
                          className={`${styles.btn} ${styles.btnGhost} ${styles.btnSm}`}
                          onClick={() => { setDeletingId(null); setEditingEntry(e); }}
                        >
                          Edit
                        </button>
                        <button
                          className={`${styles.btn} ${styles.btnDanger} ${styles.btnSm}`}
                          onClick={() => { setEditingEntry(null); setDeletingId(e.id); }}
                        >
                          Delete
                        </button>
                      </td>
                    )}
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

// ── Principal-over-time area chart ─────────────────────────────────────────

function PrincipalChart({ history }) {
  const data = (history ?? []).filter((p) => p && typeof p.month === "string");
  if (data.length < 2) {
    return (
      <div className={styles.chartWrap}>
        <span className={styles.chartLabel}>Principal — last 12 months</span>
        <div className={styles.chartEmpty}>Not enough history yet</div>
      </div>
    );
  }

  const W = 480;
  const H = 80;
  const padX = 4;
  const padY = 6;

  const values = data.map((p) => Number(p.principal ?? 0));
  const max = Math.max(...values);
  const min = Math.min(0, ...values);
  const range = max - min || 1;
  const stepX = (W - padX * 2) / (data.length - 1);
  const yOf = (v) => H - padY - ((v - min) / range) * (H - padY * 2);

  const points = data.map((p, i) => `${(padX + i * stepX).toFixed(1)},${yOf(p.principal).toFixed(1)}`);
  const areaPath = `M ${padX},${H - padY} L ${points.join(" L ")} L ${W - padX},${H - padY} Z`;
  const linePath = `M ${points.join(" L ")}`;

  const last = data[data.length - 1];
  const first = data[0];
  const delta = (last.principal ?? 0) - (first.principal ?? 0);
  const deltaCls = delta > 0 ? styles.deltaUp : delta < 0 ? styles.deltaDown : styles.dim;

  return (
    <div className={styles.chartWrap}>
      <div className={styles.chartHeader}>
        <span className={styles.chartLabel}>Principal · {first.month} → {last.month}</span>
        <span className={`${styles.chartDelta} ${deltaCls}`}>
          {delta >= 0 ? "+" : ""}{fmtIsk(delta)} ISK
        </span>
      </div>
      <svg
        className={styles.chart}
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`Total principal over the last ${data.length} months`}
      >
        <defs>
          <linearGradient id="trustfundFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="currentColor" stopOpacity="0.35" />
            <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={areaPath} fill="url(#trustfundFill)" />
        <path d={linePath} fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" strokeLinecap="round" />
        <circle
          cx={padX + (data.length - 1) * stepX}
          cy={yOf(last.principal)}
          r="2.4"
          fill="currentColor"
        />
      </svg>
    </div>
  );
}

// ── Leadership panel ───────────────────────────────────────────────────────

function LeadershipPanel({ auth, currentMonth, onChange }) {
  return (
    <div className={`${styles.panel} ${styles.panelLeadership}`}>
      <span className={styles.panelTitle}>Leadership tools</span>
      <RecordEntryForm  auth={auth} currentMonth={currentMonth} onChange={onChange} />
      <DeclareRateForm  auth={auth} currentMonth={currentMonth} onChange={onChange} />
    </div>
  );
}

function RecordEntryForm({ auth, currentMonth, onChange }) {
  const [characterName,  setCharacterName]  = useState("");
  const [kind,           setKind]           = useState("deposit");
  const [amount,         setAmount]         = useState("");
  const [effectiveMonth, setEffectiveMonth] = useState(nextMonth(currentMonth));
  const [notes,          setNotes]          = useState("");
  const [pendingEntry,   setPendingEntry]   = useState(null);
  const [submitting,     setSubmitting]     = useState(false);
  const [error,          setError]          = useState(null);
  const [success,        setSuccess]        = useState(null);

  function review(e) {
    e.preventDefault();
    if (!characterName.trim() || !amount) return;
    setError(null);
    setSuccess(null);
    setPendingEntry({ characterName: characterName.trim(), kind, amount: parseFloat(amount), effectiveMonth, notes: notes.trim() || undefined });
  }

  async function confirm() {
    setSubmitting(true);
    try {
      const token = await auth.getAccessToken();
      const res = await fetch("/api/fund/ledger", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(pendingEntry),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to record entry");
      setSuccess(`Recorded ${pendingEntry.kind} of ${Number(pendingEntry.amount).toLocaleString()} ISK for ${data.entry.characterName}.`);
      setCharacterName("");
      setAmount("");
      setNotes("");
      setPendingEntry(null);
      onChange?.();
    } catch (err) {
      setError(err.message);
      setPendingEntry(null);
    } finally {
      setSubmitting(false);
    }
  }

  if (pendingEntry) {
    return (
      <div className={styles.confirmBox}>
        <span className={styles.panelSubtitle}>Confirm entry</span>
        <div className={styles.confirmGrid}>
          <span className={styles.confirmKey}>Character</span>
          <span className={styles.confirmVal}>{pendingEntry.characterName}</span>
          <span className={styles.confirmKey}>Kind</span>
          <span className={styles.confirmVal}>{kindLabel(pendingEntry.kind)}</span>
          <span className={styles.confirmKey}>Amount</span>
          <span className={styles.confirmVal}>{Number(pendingEntry.amount).toLocaleString()} ISK</span>
          <span className={styles.confirmKey}>Effective</span>
          <span className={styles.confirmVal}>{pendingEntry.effectiveMonth}</span>
          {pendingEntry.notes && (
            <>
              <span className={styles.confirmKey}>Notes</span>
              <span className={styles.confirmVal}>{pendingEntry.notes}</span>
            </>
          )}
        </div>
        <div className={styles.formActions} style={{ marginTop: 14 }}>
          <button className={styles.btn} onClick={confirm} disabled={submitting}>
            {submitting ? "Saving…" : "Confirm"}
          </button>
          <button className={`${styles.btn} ${styles.btnGhost}`} onClick={() => setPendingEntry(null)} disabled={submitting}>
            Back
          </button>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={review}>
      <span className={styles.panelSubtitle}>Record a ledger entry</span>
      {error   && <div className={styles.error}>⚠ {error}</div>}
      {success && <div className={styles.success}>✓ {success}</div>}
      <div className={styles.formGrid} style={{ marginTop: 10 }}>
        <div className={styles.fieldRow}>
          <label className={styles.label}>Character (in-game name)</label>
          <input
            className={styles.input}
            type="text"
            value={characterName}
            onChange={(e) => setCharacterName(e.target.value)}
            placeholder="e.g. My Corporation"
            required
          />
        </div>
        <div className={styles.fieldRow}>
          <label className={styles.label}>Kind</label>
          <select className={styles.select} value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="deposit">Deposit</option>
            <option value="withdrawal">Withdrawal</option>
            <option value="interest">Interest payout</option>
            <option value="adjustment">Adjustment</option>
          </select>
        </div>
        <div className={styles.fieldRow}>
          <label className={styles.label}>Amount (ISK)</label>
          <input
            className={styles.input}
            type="number"
            min="0"
            step="any"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="5000000000"
            required
          />
        </div>
        <div className={styles.fieldRow}>
          <label className={styles.label}>Effective month</label>
          <input
            className={styles.input}
            type="text"
            pattern="\d{4}-\d{2}"
            value={effectiveMonth}
            onChange={(e) => setEffectiveMonth(e.target.value)}
            placeholder="YYYY-MM"
            required
          />
          <span className={styles.helperText}>Defaults to next month per the 1st-of-month processing rule.</span>
        </div>
      </div>
      <div className={styles.fieldRow} style={{ marginTop: 10 }}>
        <label className={styles.label}>Notes (optional)</label>
        <input
          className={styles.input}
          type="text"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          maxLength={2000}
          placeholder="e.g. wire from Bob's wallet, May 1"
        />
      </div>
      <div className={styles.formActions} style={{ marginTop: 14 }}>
        <button className={styles.btn} type="submit" disabled={!characterName.trim() || !amount}>
          Review entry
        </button>
      </div>
    </form>
  );
}

function DeclareRateForm({ auth, currentMonth, onChange }) {
  const [month,   setMonth]   = useState(currentMonth);
  const [ratePct, setRatePct] = useState("1.50");
  const [reason,  setReason]  = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error,   setError]   = useState(null);
  const [success, setSuccess] = useState(null);

  async function submit(e) {
    e.preventDefault();
    setError(null);
    setSuccess(null);
    setSubmitting(true);
    try {
      const token = await auth.getAccessToken();
      const res = await fetch("/api/fund/rates", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          month,
          ratePct: parseFloat(ratePct),
          reason: reason.trim(),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to declare rate");
      setSuccess(`Set ${month} to ${data.rate.ratePct}%.`);
      setReason("");
      onChange?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={submit} style={{ borderTop: "1px solid var(--border)", paddingTop: 14 }}>
      <span className={styles.panelSubtitle}>Declare a month's rate (override default 1.50%)</span>
      {error   && <div className={styles.error}>⚠ {error}</div>}
      {success && <div className={styles.success}>✓ {success}</div>}
      <div className={styles.formGrid} style={{ marginTop: 10 }}>
        <div className={styles.fieldRow}>
          <label className={styles.label}>Month</label>
          <input
            className={styles.input}
            type="text"
            pattern="\d{4}-\d{2}"
            value={month}
            onChange={(e) => setMonth(e.target.value)}
            required
          />
        </div>
        <div className={styles.fieldRow}>
          <label className={styles.label}>Rate %</label>
          <select className={styles.select} value={ratePct} onChange={(e) => setRatePct(e.target.value)}>
            <option value="1.00">1.00</option>
            <option value="1.50">1.50 (standard)</option>
            <option value="2.00">2.00</option>
            <option value="2.50">2.50</option>
          </select>
        </div>
        <div className={styles.fieldRow} style={{ gridColumn: "span 2" }}>
          <label className={styles.label}>Reason</label>
          <input
            className={styles.input}
            type="text"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. 1500+ kills milestone hit"
            maxLength={500}
            required
          />
        </div>
      </div>
      <div className={styles.formActions} style={{ marginTop: 14 }}>
        <button className={styles.btn} type="submit" disabled={submitting || !reason.trim()}>
          {submitting ? "Saving…" : "Declare rate"}
        </button>
      </div>
    </form>
  );
}

// ── Inline ledger row: edit ────────────────────────────────────────────────

function EditLedgerRow({ entry, auth, colSpan, onDone, onCancel }) {
  const [kind,           setKind]           = useState(entry.kind);
  const [amount,         setAmount]         = useState(String(Math.abs(entry.amount)));
  const [effectiveMonth, setEffectiveMonth] = useState(entry.effectiveMonth);
  const [notes,          setNotes]          = useState(entry.notes ?? "");
  const [submitting,     setSubmitting]     = useState(false);
  const [error,          setError]          = useState(null);

  async function save(e) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const token = await auth.getAccessToken();
      const res = await fetch(`/api/fund/ledger/${entry.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          kind,
          amount: parseFloat(amount),
          effectiveMonth,
          notes: notes.trim() || null,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to update entry");
      onDone();
    } catch (err) {
      setError(err.message);
      setSubmitting(false);
    }
  }

  return (
    <tr className={styles.editRow}>
      <td colSpan={colSpan}>
        <form onSubmit={save} className={styles.inlineForm}>
          <span className={styles.panelSubtitle}>
            Editing entry for {entry.characterName ?? `#${entry.characterId}`}
          </span>
          {error && <div className={styles.error}>⚠ {error}</div>}
          <div className={styles.formGrid} style={{ marginTop: 8 }}>
            <div className={styles.fieldRow}>
              <label className={styles.label}>Kind</label>
              <select className={styles.select} value={kind} onChange={(e) => setKind(e.target.value)}>
                <option value="deposit">Deposit</option>
                <option value="withdrawal">Withdrawal</option>
                <option value="interest">Interest payout</option>
                <option value="adjustment">Adjustment</option>
              </select>
            </div>
            <div className={styles.fieldRow}>
              <label className={styles.label}>Amount (ISK)</label>
              <input
                className={styles.input}
                type="number"
                min="0"
                step="any"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                required
              />
            </div>
            <div className={styles.fieldRow}>
              <label className={styles.label}>Effective month</label>
              <input
                className={styles.input}
                type="text"
                pattern="\d{4}-\d{2}"
                value={effectiveMonth}
                onChange={(e) => setEffectiveMonth(e.target.value)}
                required
              />
            </div>
            <div className={styles.fieldRow}>
              <label className={styles.label}>Notes</label>
              <input
                className={styles.input}
                type="text"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                maxLength={2000}
              />
            </div>
          </div>
          <div className={styles.formActions} style={{ marginTop: 10 }}>
            <button className={styles.btn} type="submit" disabled={submitting || !amount}>
              {submitting ? "Saving…" : "Save"}
            </button>
            <button
              type="button"
              className={`${styles.btn} ${styles.btnGhost}`}
              onClick={onCancel}
              disabled={submitting}
            >
              Cancel
            </button>
          </div>
        </form>
      </td>
    </tr>
  );
}

// ── Inline ledger row: delete confirmation ─────────────────────────────────

function DeleteConfirmRow({ entry, auth, colSpan, onDone, onCancel }) {
  const [submitting, setSubmitting] = useState(false);
  const [error,      setError]      = useState(null);

  async function doDelete() {
    setError(null);
    setSubmitting(true);
    try {
      const token = await auth.getAccessToken();
      const res = await fetch(`/api/fund/ledger/${entry.id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed to delete entry");
      }
      onDone();
    } catch (err) {
      setError(err.message);
      setSubmitting(false);
    }
  }

  return (
    <tr className={styles.deleteRow}>
      <td colSpan={colSpan}>
        <div className={styles.deleteConfirm}>
          <span>
            Delete {kindLabel(entry.kind).toLowerCase()} of{" "}
            <strong>{fmtIsk(entry.amount)} ISK</strong> for{" "}
            <strong>{entry.characterName ?? `#${entry.characterId}`}</strong>{" "}
            (effective {entry.effectiveMonth})?
          </span>
          {error && <span className={styles.deleteError}>⚠ {error}</span>}
          <div className={styles.formActions}>
            <button
              className={`${styles.btn} ${styles.btnDanger}`}
              onClick={doDelete}
              disabled={submitting}
            >
              {submitting ? "Deleting…" : "Delete"}
            </button>
            <button
              className={`${styles.btn} ${styles.btnGhost}`}
              onClick={onCancel}
              disabled={submitting}
            >
              Cancel
            </button>
          </div>
        </div>
      </td>
    </tr>
  );
}
