import React, { useState, useEffect, useCallback, useRef } from "react";
import styles from "./CorpProjects.module.css";

const AUTO_REFRESH_MS = 24 * 60 * 60 * 1000;
const LS_KEY = "projects_last_auto_refresh";

// Compact number for contribution amounts (units mined, kills, ISK donated…).
function fmtAmount(n) {
  const v = Number(n) || 0;
  if (v >= 1e9) return (v / 1e9).toFixed(2).replace(/\.?0+$/, "") + "B";
  if (v >= 1e6) return (v / 1e6).toFixed(2).replace(/\.?0+$/, "") + "M";
  if (v >= 1e3) return (v / 1e3).toFixed(1).replace(/\.?0+$/, "") + "K";
  return v.toLocaleString("en-US");
}

function fmtIsk(n) {
  const v = Number(n) || 0;
  if (v >= 1e12) return (v / 1e12).toFixed(2) + "T";
  if (v >= 1e9) return (v / 1e9).toFixed(2) + "B";
  if (v >= 1e6) return (v / 1e6).toFixed(1) + "M";
  if (v >= 1e3) return (v / 1e3).toFixed(0) + "K";
  return v.toLocaleString("en-US");
}

function timeAgo(iso) {
  if (!iso) return null;
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "just now";
  const m = Math.floor(ms / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

// LP leaderboard table — shared by the lifetime board and each archived project.
function LeaderboardTable({ rows }) {
  const totalLp = rows.reduce((s, r) => s + r.lpGenerated, 0);
  return (
    <div className={styles.tableWrap}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th className={styles.rankCol}>#</th>
            <th>Pilot</th>
            <th className={styles.center}>LP generated</th>
            <th className={styles.center}>ISK paid out</th>
            <th className={`${styles.shareCell} ${styles.center}`}>Share</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const pct = totalLp ? (r.lpGenerated / totalLp) * 100 : 0;
            return (
              <tr key={r.characterId} className={i < 3 ? styles[`rank${i + 1}`] : undefined}>
                <td className={styles.rankCol}>{i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : i + 1}</td>
                <td>
                  <span className={styles.pilot}>
                    <img
                      className={styles.portrait}
                      src={`https://images.evetech.net/characters/${r.characterId}/portrait?size=32`}
                      alt=""
                    />
                    {r.characterName}
                  </span>
                </td>
                <td className={`${styles.center} ${styles.amount}`}>{fmtAmount(r.lpGenerated)}</td>
                <td className={styles.center}>{fmtIsk(r.iskPaidOut)}</td>
                <td className={styles.shareCell}>
                  <div className={styles.shareRow}>
                    <div className={styles.shareBar} title={`${pct.toFixed(1)}% of total LP`}>
                      <div className={styles.shareFill} style={{ width: `${pct}%` }} />
                    </div>
                    <span className={styles.sharePct}>{pct.toFixed(1)}%</span>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export default function CorpProjects({ auth, isAdmin }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [error, setError] = useState(null);
  const [countdown, setCountdown] = useState(null);
  const autoRefreshingRef = useRef(false);

  const load = useCallback(async (refresh) => {
    if (refresh) {
      setRefreshing(true);
      localStorage.setItem(LS_KEY, String(Date.now()));
    } else {
      setLoading(true);
    }
    setError(null);
    try {
      const token = await auth.getAccessToken();
      const res = await fetch(`/api/projects/${auth.corpId}${refresh ? "?refresh=1" : ""}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`);
      setData(json);
      // Seed the timer from the server's syncedAt on the initial load so the
      // countdown reflects actual data age rather than first visit time.
      if (!refresh && !localStorage.getItem(LS_KEY) && json.syncedAt) {
        localStorage.setItem(LS_KEY, String(new Date(json.syncedAt).getTime()));
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
      setRefreshing(false);
      autoRefreshingRef.current = false;
    }
  }, [auth]);

  // "Archive" — freezes the current LP project(s) so their numbers persist
  // after EVE retires the project. POST /api/projects/:corpId.
  const archive = useCallback(async () => {
    if (!window.confirm(
      "Archive the current LP project?\n\n" +
      "This freezes its leaderboard so the numbers are kept after EVE retires " +
      "the project. The lifetime leaderboard keeps combining archived projects " +
      "with the active one — do this when a project is finished and you're " +
      "about to start a new one."
    )) return;
    setArchiving(true);
    setError(null);
    try {
      const token = await auth.getAccessToken();
      const res = await fetch(`/api/projects/${auth.corpId}`, {
        method: "POST",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`);
      setData(json);
      localStorage.setItem(LS_KEY, String(Date.now()));
    } catch (err) {
      setError(err.message);
    } finally {
      setArchiving(false);
    }
  }, [auth]);

  useEffect(() => { load(false); }, [load]);

  // Auto-refresh every 24 h; update the countdown display every minute. Only
  // leadership refreshes (a non-Director's ESI read is empty and would wipe the
  // board) — so a non-admin browser shows the countdown but never fires a load.
  useEffect(() => {
    function tick() {
      const last = Number(localStorage.getItem(LS_KEY)) || 0;
      if (!last) return;
      const elapsed = Date.now() - last;
      if (elapsed >= AUTO_REFRESH_MS) {
        if (isAdmin && !autoRefreshingRef.current) {
          autoRefreshingRef.current = true;
          load(true);
        }
      } else {
        const remaining = AUTO_REFRESH_MS - elapsed;
        const totalMin = Math.ceil(remaining / 60000);
        const h = Math.floor(totalMin / 60);
        const m = totalMin % 60;
        setCountdown(h > 0 ? `${h}h ${m}m` : `${m}m`);
      }
    }
    tick();
    const id = setInterval(tick, 60000);
    return () => clearInterval(id);
  }, [load, isAdmin]);

  if (loading) return <div className={styles.loading}>LOADING CORP PROJECTS…</div>;
  if (error) return <div className={styles.errBox}>⚠ {error}</div>;
  if (!data) return null;

  const {
    projects = [],
    leaderboard = [],
    lpProject = null,
    archivedProjects = [],
    syncedAt,
    syncedBy,
    refreshError,
    truncated,
    fromCache,
  } = data;
  const everSynced = !!syncedAt;
  const busy = refreshing || archiving;

  return (
    <div className={styles.wrap}>
      <div className={styles.topBar}>
        <div>
          <div className={styles.title}>CORP PROJECTS</div>
          <div className={styles.subtitle}>
            {everSynced
              ? <>Snapshot synced {timeAgo(syncedAt)}{syncedBy ? ` · by ${syncedBy}` : ""}{!fromCache ? " · fresh from ESI" : ""}</>
              : <>Not synced yet — a corp Director needs to refresh from ESI</>}
            {countdown && <> · auto in {countdown}</>}
          </div>
        </div>
        {isAdmin && (
          <div className={styles.actions}>
            <button className={styles.btn} onClick={archive} disabled={busy || !lpProject}>
              {archiving ? "Archiving…" : "⤓ Archive LP project"}
            </button>
            <button className={styles.btn} onClick={() => load(true)} disabled={busy}>
              {refreshing ? "Syncing…" : "↻ Refresh from ESI"}
            </button>
          </div>
        )}
      </div>

      {refreshError && (
        <div className={styles.note}>
          {refreshError} Refreshing and archiving are leadership-only and require a corp Director login
          with the <code>esi-corporations.read_projects.v1</code> scope — if you are a Director, log out
          and back in to grant it. Showing the last synced snapshot below.
        </div>
      )}
      {truncated && (
        <div className={styles.note}>
          Only the first {projects.filter((p) => p.contributorCount != null).length} projects were scanned
          for contributors — the per-project contributor lists below may be incomplete.
        </div>
      )}

      {!everSynced ? (
        <div className={styles.empty}>No data yet. Once a Director hits “Refresh from ESI”, the leaderboard shows up here.</div>
      ) : (
        <>
          <section className={styles.section}>
            <h3 className={styles.h3}>{`${lpProject?.name ?? "Auto Pay Out"} — LP leaderboard`}</h3>
            {lpProject && (
              <div className={styles.lpTotals}>
                <span><strong>{fmtAmount(lpProject.lpGenerated)}</strong> LP generated</span>
                <span><strong>{fmtIsk(lpProject.iskPaidOut)}</strong> ISK paid out</span>
                {lpProject.contributorCount != null && (
                  <span className={styles.dim}>{lpProject.contributorCount} pilot{lpProject.contributorCount === 1 ? "" : "s"}</span>
                )}
                {lpProject.projectCount > 1 && (
                  <span className={styles.dim}>lifetime · {lpProject.projectCount} projects</span>
                )}
              </div>
            )}
            {!lpProject ? (
              <div className={styles.empty}>
                No “Auto Pay Out” LP project found in the latest sync — a corp Director may need to refresh from ESI.
              </div>
            ) : leaderboard.length === 0 ? (
              <div className={styles.empty}>No LP contributions recorded yet.</div>
            ) : (
              <LeaderboardTable rows={leaderboard} />
            )}
          </section>

          {archivedProjects.length > 0 && (
            <section className={styles.section}>
              <h3 className={styles.h3}>Archived projects ({archivedProjects.length})</h3>
              <div className={styles.archiveList}>
                {archivedProjects.map((p) => (
                  <details key={p.projectId} className={styles.archiveItem}>
                    <summary className={styles.archiveSummary}>
                      <span className={styles.archiveName}>{p.projectName}</span>
                      <span className={styles.archiveMeta}>
                        {fmtAmount(p.lpGenerated)} LP · {fmtIsk(p.iskPaidOut)} ISK · {p.pilotCount} pilot{p.pilotCount === 1 ? "" : "s"}
                        {p.archivedAt ? ` · archived ${timeAgo(p.archivedAt)}` : ""}
                        {p.archivedBy ? ` by ${p.archivedBy}` : ""}
                      </span>
                    </summary>
                    {p.leaderboard?.length > 0 ? (
                      <LeaderboardTable rows={p.leaderboard} />
                    ) : (
                      <div className={styles.empty}>No contributions recorded for this project.</div>
                    )}
                  </details>
                ))}
              </div>
            </section>
          )}

          <section className={styles.section}>
            <h3 className={styles.h3}>Projects ({projects.length})</h3>
            {projects.length === 0 ? (
              <div className={styles.empty}>No corp projects.</div>
            ) : (
              <div className={styles.projGrid}>
                {projects.map((p) => (
                  <div key={p.id} className={styles.projCard}>
                    <div className={styles.projHead}>
                      <span className={styles.projName}>{p.name}</span>
                      {p.state && <span className={styles.badge}>{String(p.state).replace(/_/g, " ")}</span>}
                    </div>
                    {(p.createdBy || p.contributorCount != null) && (
                      <div className={styles.projMeta}>
                        {p.createdBy && <span>by {p.createdBy}</span>}
                        {p.contributorCount != null && <span>{p.contributorCount} contributor{p.contributorCount === 1 ? "" : "s"}</span>}
                      </div>
                    )}
                    {typeof p.progressPct === "number" && (
                      <div className={styles.bar} title={`${p.progressPct.toFixed(1)}%`}>
                        <div className={styles.barFill} style={{ width: `${p.progressPct}%` }} />
                        <span className={styles.barLabel}>{p.progressPct.toFixed(0)}%</span>
                      </div>
                    )}
                    {(p.iskRewarded > 0 || p.rewardPool > 0) && (
                      <div className={styles.projStats}>
                        {p.iskRewarded > 0 && <span>{fmtIsk(p.iskRewarded)} ISK paid out</span>}
                        {p.rewardPool > 0 && <span className={styles.dim}>{fmtIsk(p.rewardPool)} ISK pool</span>}
                      </div>
                    )}
                    {p.topContributors?.length > 0 && (
                      <ol className={styles.miniList}>
                        {p.topContributors.map((c) => (
                          <li key={c.characterId}>
                            <span className={styles.miniName}>{c.characterName || `#${c.characterId}`}</span>
                            <span className={styles.amount}>{fmtAmount(c.amount)}</span>
                          </li>
                        ))}
                      </ol>
                    )}
                  </div>
                ))}
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}
