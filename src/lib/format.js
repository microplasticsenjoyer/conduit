export function timeAgo(isoString) {
  if (!isoString) return null;
  const diffMs = Date.now() - new Date(isoString).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

export function fmtIsk(v) {
  if (v == null || !isFinite(Number(v))) return "—";
  const n = Number(v);
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (abs >= 1e12) return sign + (abs / 1e12).toFixed(2) + "T";
  if (abs >= 1e9)  return sign + (abs / 1e9).toFixed(2)  + "B";
  if (abs >= 1e6)  return sign + (abs / 1e6).toFixed(2)  + "M";
  if (abs >= 1e3)  return sign + (abs / 1e3).toFixed(1)  + "k";
  return n.toLocaleString("en-US", { maximumFractionDigits: 0 });
}
