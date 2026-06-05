import React from "react";
import styles from "./IncomeCharts.module.css";
import { fmtIsk } from "../../lib/format.js";

// Stacked inflow/outflow bars per month. data = [{ month, inflow, outflow, net }]
// oldest → newest, left → right.
export function MonthlyStackedBars({ data, height = 160 }) {
  if (!data || data.length === 0) {
    return <div className={styles.empty}>No data</div>;
  }
  const PAD_X = 28;
  const PAD_TOP = 8;
  const PAD_BOTTOM = 30;
  const barGap = 6;
  const innerH = height - PAD_TOP - PAD_BOTTOM;
  const maxAbs = Math.max(
    1,
    ...data.map((d) => Math.max(d.inflow, d.outflow)),
  );
  // Reserve some space (e.g. 30 px per bar). Width scales with bar count.
  const barW = 32;
  const width = PAD_X * 2 + data.length * (barW + barGap) - barGap;
  const yZero = PAD_TOP + innerH / 2;
  const halfH = innerH / 2;

  return (
    <svg
      className={styles.bars}
      width="100%"
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="xMidYMid meet"
    >
      {/* Zero baseline */}
      <line
        x1={PAD_X - 4}
        x2={width - PAD_X + 4}
        y1={yZero}
        y2={yZero}
        className={styles.axis}
      />
      {data.map((d, i) => {
        const x = PAD_X + i * (barW + barGap);
        const inH = (d.inflow  / maxAbs) * halfH;
        const outH = (d.outflow / maxAbs) * halfH;
        return (
          <g key={d.month}>
            {d.inflow > 0 && (
              <rect
                x={x}
                y={yZero - inH}
                width={barW}
                height={inH}
                className={styles.barInflow}
              >
                <title>{`${d.month} inflow: +${fmtIsk(d.inflow)}`}</title>
              </rect>
            )}
            {d.outflow > 0 && (
              <rect
                x={x}
                y={yZero}
                width={barW}
                height={outH}
                className={styles.barOutflow}
              >
                <title>{`${d.month} outflow: −${fmtIsk(d.outflow)}`}</title>
              </rect>
            )}
            {/* Net dot — small marker showing net result */}
            <circle
              cx={x + barW / 2}
              cy={yZero - (d.net / maxAbs) * halfH}
              r="2.5"
              className={d.net >= 0 ? styles.netDotPos : styles.netDotNeg}
            >
              <title>{`${d.month} net: ${d.net >= 0 ? "+" : "−"}${fmtIsk(Math.abs(d.net))}`}</title>
            </circle>
            <text
              x={x + barW / 2}
              y={height - 12}
              className={styles.axisLabel}
              textAnchor="middle"
            >
              {d.month.slice(2)}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

// Cumulative balance line. data = [{ ts, balance }] sorted ascending.
export function CumulativeBalanceLine({ data, height = 160 }) {
  if (!data || data.length < 2) {
    return <div className={styles.empty}>Need at least two entries</div>;
  }
  const PAD_X = 16;
  const PAD_TOP = 14;
  const PAD_BOTTOM = 24;
  const width = 520;
  const innerH = height - PAD_TOP - PAD_BOTTOM;
  const innerW = width - PAD_X * 2;

  const tMin = data[0].ts;
  const tMax = data[data.length - 1].ts;
  const tRange = tMax - tMin || 1;
  const maxAbs = Math.max(1, ...data.map((d) => Math.abs(d.balance)));
  const yZero = PAD_TOP + innerH / 2;
  const halfH = innerH / 2;

  const xOf = (t) => PAD_X + ((t - tMin) / tRange) * innerW;
  const yOf = (v) => yZero - (v / maxAbs) * halfH;

  const points = data.map((d) => `${xOf(d.ts).toFixed(1)},${yOf(d.balance).toFixed(1)}`);

  // Split polyline into segments so we can color sign changes. Simpler: one
  // line in accent color, plus an area fill split at zero.
  const last = data[data.length - 1];
  const trendClass = last.balance >= 0 ? styles.lineUp : styles.lineDown;

  return (
    <svg
      className={styles.line}
      width="100%"
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
    >
      <line
        x1={PAD_X}
        x2={width - PAD_X}
        y1={yZero}
        y2={yZero}
        className={styles.axis}
      />
      <polyline
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
        className={trendClass}
        points={points.join(" ")}
      />
      <circle
        cx={xOf(last.ts)}
        cy={yOf(last.balance)}
        r="3"
        className={trendClass}
        fill="currentColor"
      >
        <title>{`Balance: ${last.balance >= 0 ? "+" : "−"}${fmtIsk(Math.abs(last.balance))}`}</title>
      </circle>
      <text
        x={width - PAD_X}
        y={PAD_TOP + 4}
        className={`${styles.axisLabel} ${trendClass}`}
        textAnchor="end"
      >
        {last.balance >= 0 ? "+" : "−"}{fmtIsk(Math.abs(last.balance))}
      </text>
    </svg>
  );
}

// Two donuts side-by-side: inflows by category and outflows by category.
// slices = { inflow: [{category, amount}], outflow: [{category, amount}] }
export function CategoryDonut({ slices, size = 160 }) {
  if (!slices || (slices.inflow.length === 0 && slices.outflow.length === 0)) {
    return <div className={styles.empty}>No data for this month</div>;
  }

  return (
    <div className={styles.donutRow}>
      <DonutSingle
        title="Inflow"
        items={slices.inflow}
        palette={INFLOW_PALETTE}
        size={size}
        sign="+"
      />
      <DonutSingle
        title="Outflow"
        items={slices.outflow}
        palette={OUTFLOW_PALETTE}
        size={size}
        sign="−"
      />
    </div>
  );
}

const INFLOW_PALETTE  = ["#00e676", "#00b85a", "#5dd9a3", "#7ee8b8", "#2d8a59", "#9af3c7"];
const OUTFLOW_PALETTE = ["#ff4444", "#c53030", "#ff7878", "#e08585", "#9b2828", "#f4a5a5"];

function DonutSingle({ title, items, palette, size, sign }) {
  if (items.length === 0) {
    return (
      <div className={styles.donutWrap}>
        <div className={styles.donutTitle}>{title}</div>
        <div className={styles.empty} style={{ width: size, height: size }}>—</div>
      </div>
    );
  }
  const total = items.reduce((a, b) => a + b.amount, 0);
  const cx = size / 2;
  const cy = size / 2;
  const r = size / 2 - 4;
  const innerR = r * 0.6;

  let acc = 0;
  const slices = items.map((it, i) => {
    const startA = (acc / total) * Math.PI * 2 - Math.PI / 2;
    acc += it.amount;
    const endA = (acc / total) * Math.PI * 2 - Math.PI / 2;
    const path = donutSlicePath(cx, cy, r, innerR, startA, endA);
    return { path, color: palette[i % palette.length], item: it };
  });

  return (
    <div className={styles.donutWrap}>
      <div className={styles.donutTitle}>{title}</div>
      <div className={styles.donutBody}>
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
          {slices.map((s, i) => (
            <path key={i} d={s.path} fill={s.color}>
              <title>{`${s.item.category}: ${sign}${fmtIsk(s.item.amount)} (${((s.item.amount/total)*100).toFixed(1)}%)`}</title>
            </path>
          ))}
          <text x={cx} y={cy - 4} className={styles.donutCenter} textAnchor="middle">
            {sign}{fmtIsk(total)}
          </text>
          <text x={cx} y={cy + 12} className={styles.donutCenterSub} textAnchor="middle">
            {items.length} {items.length === 1 ? "category" : "categories"}
          </text>
        </svg>
        <ul className={styles.legend}>
          {slices.map((s, i) => (
            <li key={i}>
              <span className={styles.swatch} style={{ background: s.color }} />
              <span className={styles.legendCat}>{s.item.category}</span>
              <span className={styles.legendAmt}>{sign}{fmtIsk(s.item.amount)}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function donutSlicePath(cx, cy, rOut, rIn, startA, endA) {
  const x1 = cx + rOut * Math.cos(startA);
  const y1 = cy + rOut * Math.sin(startA);
  const x2 = cx + rOut * Math.cos(endA);
  const y2 = cy + rOut * Math.sin(endA);
  const x3 = cx + rIn * Math.cos(endA);
  const y3 = cy + rIn * Math.sin(endA);
  const x4 = cx + rIn * Math.cos(startA);
  const y4 = cy + rIn * Math.sin(startA);
  const largeArc = endA - startA > Math.PI ? 1 : 0;
  // Handle full-circle (single slice covers 100%): split into two halves.
  if (Math.abs(endA - startA - Math.PI * 2) < 1e-6) {
    const midA = startA + Math.PI;
    return [
      donutSlicePath(cx, cy, rOut, rIn, startA, midA),
      donutSlicePath(cx, cy, rOut, rIn, midA, endA),
    ].join(" ");
  }
  return [
    `M ${x1.toFixed(2)} ${y1.toFixed(2)}`,
    `A ${rOut} ${rOut} 0 ${largeArc} 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`,
    `L ${x3.toFixed(2)} ${y3.toFixed(2)}`,
    `A ${rIn} ${rIn} 0 ${largeArc} 0 ${x4.toFixed(2)} ${y4.toFixed(2)}`,
    "Z",
  ].join(" ");
}
