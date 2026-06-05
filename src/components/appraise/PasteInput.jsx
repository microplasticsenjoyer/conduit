import React, { useState, useRef, useEffect } from "react";
import styles from "./PasteInput.module.css";

const PLACEHOLDER = `Paste items here — cargo scan, contract, or manual list.

Examples:
  Tritanium x100000
  1000 Pyerite
  Damage Control II`;

export default function PasteInput({ onAppraise, onClear, loading, prefill }) {
  const [text, setText] = useState(prefill ?? "");
  const ref = useRef(null);

  useEffect(() => {
    if (prefill) setText(prefill);
  }, [prefill]);

  function handleSubmit() {
    if (text.trim()) onAppraise(text.trim());
  }

  function handleClear() {
    setText("");
    onClear();
    ref.current?.focus();
  }

  function handleKeyDown(e) {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      handleSubmit();
    }
  }

  const lineCount = text ? text.split("\n").filter((l) => l.trim()).length : 0;

  return (
    <div className={styles.container}>
      <div className={styles.toolbar}>
        <span className={styles.label}>ITEM LIST</span>
        {lineCount > 0 && <span className={styles.count}>{lineCount} line{lineCount !== 1 ? "s" : ""}</span>}
      </div>
      <textarea
        ref={ref}
        className={styles.textarea}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={PLACEHOLDER}
        spellCheck={false}
        autoCorrect="off"
        autoCapitalize="off"
      />
      <div className={styles.actions}>
        <span className={styles.hint}>Ctrl+Enter to appraise</span>
        <div className={styles.buttons}>
          <button className={styles.btnClear} onClick={handleClear} disabled={loading || !text}>CLEAR</button>
          <button className={styles.btnAppraise} onClick={handleSubmit} disabled={loading || !text.trim()}>
            {loading ? <span className={styles.spinner}>APPRAISING...</span> : "APPRAISE"}
          </button>
        </div>
      </div>
    </div>
  );
}
