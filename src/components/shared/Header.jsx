import React, { useEffect, useRef, useState } from "react";
import styles from "./Header.module.css";

// The character chip doubles as an account menu: clicking it opens a dropdown
// with Profile, Admin (leadership only), and Disconnect. Profile and Admin
// used to live on the main tab bar but they're account-shaped concerns and
// belong with the avatar — matches the convention from every other app and
// keeps the primary nav focused on the corp tools themselves.
export default function Header({ auth, isAdmin, onNavigate }) {
  const { eveAuth, logout } = auth ?? {};
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

  function go(tab) {
    setOpen(false);
    onNavigate?.(tab);
  }

  return (
    <header className={styles.header}>
      <div className={styles.inner}>
        <div className={styles.brand}>
          <a href="/" className={styles.logo}>
            <span className={styles.logoAccent}>praxis</span>
            <span className={styles.logoDash}>-</span>
            <span className={styles.logoMain}>trade</span>
          </a>
          <div className={styles.sub}>various Eve tools · bug Tears</div>
        </div>
        {eveAuth && (
          <div className={styles.charRow} ref={rootRef}>
            <button
              type="button"
              className={styles.chip}
              aria-haspopup="menu"
              aria-expanded={open}
              onClick={() => setOpen((o) => !o)}
            >
              <img
                className={styles.portrait}
                src={`https://images.evetech.net/characters/${eveAuth.characterId}/portrait?size=32`}
                alt=""
              />
              <span className={styles.charName}>{eveAuth.characterName}</span>
              <span className={styles.caret} aria-hidden="true">{open ? "▴" : "▾"}</span>
            </button>
            {open && (
              <div className={styles.menu} role="menu">
                <button
                  type="button"
                  role="menuitem"
                  className={styles.menuItem}
                  onClick={() => go("profile")}
                >
                  Profile
                </button>
                {isAdmin && (
                  <button
                    type="button"
                    role="menuitem"
                    className={styles.menuItem}
                    onClick={() => go("admin")}
                  >
                    Admin
                  </button>
                )}
                <div className={styles.menuDivider} aria-hidden="true" />
                <button
                  type="button"
                  role="menuitem"
                  className={`${styles.menuItem} ${styles.menuItemDanger}`}
                  onClick={() => { setOpen(false); logout?.(); }}
                >
                  Disconnect
                </button>
              </div>
            )}
          </div>
        )}
      </div>
      <div className={styles.scanline} />
    </header>
  );
}
