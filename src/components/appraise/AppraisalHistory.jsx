import React, { useEffect, useState } from "react";
import styles from "./AppraisalHistory.module.css";
import { listHistory, removeHistoryEntry, setHistoryTitle, clearHistory } from "../../lib/history.js";
import { timeAgo } from "../../lib/format.js";

function fmt(v) {
  if (v >= 1e9) return (v / 1e9).toFixed(2) + "B";
  if (v >= 1e6) return (v / 1e6).toFixed(2) + "M";
  if (v >= 1e3) return (v / 1e3).toFixed(1) + "k";
  return v.toLocaleString("en-US", { maximumFractionDigits: 0 });
}

const STATION_SHORT = {
  60003760: "Jita",
  60008494: "Amarr",
  60011866: "Dodixie",
  60005686: "Hek",
  60004588: "Rens",
};

export default function AppraisalHistory({ onOpen, refreshKey }) {
  const [entries, setEntries] = useState(() => listHistory());
  const [editing, setEditing] = useState(null);
  const [draft, setDraft] = useState("");

  useEffect(() => {
    setEntries(listHistory());
  }, [refreshKey]);

  if (entries.length === 0) return null;

  function startEdit(slug, current) {
    setEditing(slug);
    setDraft(current ?? "");
  }
  function commitEdit() {
    if (editing) {
      setHistoryTitle(editing, draft.trim());
      setEntries(listHistory());
    }
    setEditing(null);
    setDraft("");
  }
  function remove(slug) {
    removeHistoryEntry(slug);
    setEntries(listHistory());
  }
  function clearAll() {
    if (!confirm("Clear all local history?")) return;
    clearHistory();
    setEntries([]);
  }

  return (
    <div className={styles.box}>
      <div className={styles.header}>
        <span className={styles.title}>RECENT APPRAISALS — local to this browser</span>
        <button className={styles.clearBtn} onClick={clearAll}>CLEAR ALL</button>
      </div>
      <ul className={styles.list}>
        {entries.map((e) => {
          const hub = STATION_SHORT[e.stationId];
          const isEdit = editing === e.slug;
          return (
            <li key={e.slug} className={styles.entry}>
              <a
                href={`?a=${e.slug}`}
                className={styles.slug}
                onClick={(ev) => {
                  ev.preventDefault();
                  if (onOpen) onOpen(e.slug);
                }}
                title="Open this appraisal"
              >
                {e.slug}
              </a>
              {isEdit ? (
                <input
                  className={styles.titleInput}
                  value={draft}
                  autoFocus
                  onChange={(ev) => setDraft(ev.target.value)}
                  onBlur={commitEdit}
                  onKeyDown={(ev) => {
                    if (ev.key === "Enter") commitEdit();
                    if (ev.key === "Escape") { setEditing(null); setDraft(""); }
                  }}
                  placeholder="add a title…"
                  maxLength={60}
                />
              ) : (
                <button
                  type="button"
                  className={styles.titleBtn}
                  onClick={() => startEdit(e.slug, e.title)}
                  title="Click to set a title"
                >
                  {e.title || <span className={styles.untitled}>(click to title)</span>}
                </button>
              )}
              <span className={styles.meta}>{e.itemCount} item{e.itemCount !== 1 ? "s" : ""}</span>
              {hub && <span className={styles.meta}>{hub}</span>}
              <span className={`${styles.value} ${styles.sell}`}>{fmt(e.totalSell)} sell</span>
              <span className={`${styles.value} ${styles.buy}`}>{fmt(e.totalBuy)} buy</span>
              <span className={styles.age}>{timeAgo(e.viewedAt ?? e.createdAt)}</span>
              <button className={styles.removeBtn} onClick={() => remove(e.slug)} title="Remove from history">×</button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
