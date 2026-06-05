import React, { useEffect, useRef, useState } from "react";
import styles from "./Tabs.module.css";

function isGroupActive(group, value) {
  return (group.children ?? []).some((c) => c.value === value);
}

function GroupDropdown({ group, value, onChange }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    function onDocMouseDown(e) {
      if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false);
    }
    function onKey(e) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDocMouseDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocMouseDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const active = isGroupActive(group, value);

  return (
    <div className={styles.groupRoot} ref={rootRef}>
      <button
        type="button"
        className={`${styles.tab} ${active ? styles.active : ""}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {group.label}
        <span className={styles.caret} aria-hidden="true">{open ? " ▴" : " ▾"}</span>
      </button>
      {open && (
        <div className={styles.dropdown} role="menu">
          {(group.children ?? []).map((child) => (
            <button
              key={child.value}
              type="button"
              role="menuitem"
              className={`${styles.dropdownItem} ${value === child.value ? styles.dropdownItemActive : ""}`}
              onClick={() => { setOpen(false); onChange(child.value); }}
            >
              {child.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default function Tabs({ value, onChange, options, variant }) {
  const wrapClass = variant === "sub" ? `${styles.tabs} ${styles.tabsSub}` : styles.tabs;
  return (
    <div className={wrapClass} role="tablist">
      {options.map((opt, i) => {
        if (opt?.type === "group") {
          return (
            <GroupDropdown
              key={`group-${opt.label}-${i}`}
              group={opt}
              value={value}
              onChange={onChange}
            />
          );
        }
        return (
          <button
            key={opt.value}
            role="tab"
            aria-selected={value === opt.value}
            className={
              `${styles.tab} ` +
              `${value === opt.value ? styles.active : ""} ` +
              `${opt.highlight ? styles.tabHighlight : ""}`
            }
            onClick={() => onChange(opt.value)}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
