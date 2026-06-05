import React, { useEffect, useState } from "react";
import styles from "./Toast.module.css";
import { subscribeToast } from "../../lib/toast.js";

export default function Toast() {
  const [toast, setToast] = useState(null);

  useEffect(() => {
    let timer;
    const unsub = subscribeToast((t) => {
      setToast(t);
      clearTimeout(timer);
      timer = setTimeout(() => setToast(null), 1800);
    });
    return () => {
      unsub();
      clearTimeout(timer);
    };
  }, []);

  if (!toast) return null;

  return (
    <div key={toast.id} className={styles.toast} role="status" aria-live="polite">
      {toast.message}
    </div>
  );
}
