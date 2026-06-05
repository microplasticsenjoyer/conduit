import React from "react";
import styles from "../Inventory.module.css";

export default function AuthGate({ ssoError, onLogin }) {
  return (
    <div className={styles.gate}>
      <div className={styles.gateBox}>
        <div className={styles.gateTitle}>MET0 CORP TOOLS</div>
        <div className={styles.gateSub}>Log in with EVE to continue</div>
        {ssoError && <div className={styles.errInline}>{ssoError}</div>}
        <button className={styles.btnEve} onClick={onLogin}>
          ▶ Login with EVE Online
        </button>
      </div>
    </div>
  );
}
