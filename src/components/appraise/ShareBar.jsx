import React, { useState } from "react";
import styles from "./ShareBar.module.css";
import { showToast } from "../../lib/toast.js";

export default function ShareBar({ slug, createdAt }) {
  const [copied, setCopied] = useState(false);
  const url = `${window.location.origin}?a=${slug}`;

  async function handleCopy() {
    await navigator.clipboard.writeText(url);
    showToast("Copied to clipboard");
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  const date = createdAt
    ? new Date(createdAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
    : null;

  return (
    <div className={styles.bar}>
      <span className={styles.label}>SHAREABLE LINK</span>
      <span className={styles.url}>{url}</span>
      {date && <span className={styles.date}>{date}</span>}
      <button className={`${styles.btn} ${copied ? styles.copied : ""}`} onClick={handleCopy}>
        {copied ? "COPIED ✓" : "COPY"}
      </button>
    </div>
  );
}
