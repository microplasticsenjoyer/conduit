import React from "react";
import styles from "./Sparkline.module.css";

// Tiny inline-SVG sparkline. Color encodes the trend (linear-regression slope
// across the window): green if rising, red if falling, neutral if flat. The
// highest point in the window is marked with a green dot, the lowest with a
// red dot, and the most-recent point with a filled dot in the trend color.
//
//   <Sparkline values={[1.10, 1.12, 1.15, 1.18]} width={72} height={20} />
export default function Sparkline({ values, width = 72, height = 20, title }) {
  if (!values || values.length === 0) {
    return <span className={styles.empty}>—</span>;
  }
  if (values.length === 1) {
    const y = height / 2;
    return (
      <svg
        className={`${styles.spark} ${styles.flat}`}
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        {title && <title>{title}</title>}
        <line x1="0" y1={y} x2={width} y2={y} stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
        <circle cx={width} cy={y} r="1.6" fill="currentColor" />
      </svg>
    );
  }

  const max = Math.max(...values);
  const min = Math.min(...values);
  const range = max - min || 1;
  const stepX = width / (values.length - 1);
  const yOf = (v) => height - 2 - ((v - min) / range) * (height - 4);

  const points = values.map((v, i) => `${(i * stepX).toFixed(1)},${yOf(v).toFixed(1)}`);

  const slope = linregSlope(values);
  const meanV = values.reduce((a, b) => a + b, 0) / values.length;
  const normalized = meanV > 0 ? slope / meanV : 0;

  let trendClass = styles.flat;
  if (normalized > 0.02) trendClass = styles.up;
  else if (normalized < -0.02) trendClass = styles.down;

  const lastIdx = values.length - 1;
  const maxIdx = values.indexOf(max);
  const minIdx = values.indexOf(min);

  return (
    <svg
      className={`${styles.spark} ${trendClass}`}
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      {title && <title>{title}</title>}
      <polyline
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
        points={points.join(" ")}
      />
      {max !== min && (
        <>
          <circle cx={maxIdx * stepX} cy={yOf(max)} r="1.8" className={styles.markHigh} />
          <circle cx={minIdx * stepX} cy={yOf(min)} r="1.8" className={styles.markLow} />
        </>
      )}
      <circle cx={lastIdx * stepX} cy={yOf(values[lastIdx])} r="1.6" fill="currentColor" />
    </svg>
  );
}

function linregSlope(values) {
  const n = values.length;
  let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
  for (let i = 0; i < n; i++) {
    sumX += i;
    sumY += values[i];
    sumXY += i * values[i];
    sumXX += i * i;
  }
  const denom = n * sumXX - sumX * sumX;
  return denom === 0 ? 0 : (n * sumXY - sumX * sumY) / denom;
}
