import React, { useEffect, useState } from "react";
import styles from "./StationPicker.module.css";

const STORAGE_KEY = "praxis:appraise:stationId";
const FALLBACK_STATIONS = [
  { id: 60003760, name: "Jita 4-4", region: "The Forge", short: "Jita" },
];

let stationsPromise = null;
function fetchStations() {
  if (!stationsPromise) {
    stationsPromise = fetch("/api/stations")
      .then((r) => r.ok ? r.json() : Promise.reject(new Error("stations fetch failed")))
      .then((j) => j.stations ?? FALLBACK_STATIONS)
      .catch(() => FALLBACK_STATIONS);
  }
  return stationsPromise;
}

export default function StationPicker({ value, onChange }) {
  const [stations, setStations] = useState(FALLBACK_STATIONS);
  useEffect(() => {
    let cancelled = false;
    fetchStations().then((s) => { if (!cancelled) setStations(s); });
    return () => { cancelled = true; };
  }, []);

  return (
    <div className={styles.field}>
      <label className={styles.label}>STATION</label>
      <select
        className={styles.select}
        value={value}
        onChange={(e) => {
          const id = parseInt(e.target.value, 10);
          onChange(id);
          try { localStorage.setItem(STORAGE_KEY, String(id)); } catch {}
        }}
      >
        {stations.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name} — {s.region}
          </option>
        ))}
      </select>
    </div>
  );
}

export function readStoredStationId(fallback) {
  try {
    const v = parseInt(localStorage.getItem(STORAGE_KEY) ?? "", 10);
    return Number.isFinite(v) ? v : fallback;
  } catch {
    return fallback;
  }
}

export function stationLabel(stations, id) {
  const s = stations.find((x) => x.id === id);
  return s ? s.short : `station ${id}`;
}
