/**
 * Parse raw EVE item paste into { name, quantity } pairs.
 * Supports: cargo scans, contracts, "Name x Qty", "Qty Name", plain names.
 */
export function parseItemList(text) {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#") && !l.startsWith("//"));

  const merged = {};

  for (const line of lines) {
    const result = parseLine(line);
    if (!result) continue;
    const key = result.name.toLowerCase();
    if (merged[key]) {
      merged[key].quantity += result.quantity;
    } else {
      merged[key] = { name: result.name, quantity: result.quantity };
    }
  }

  return Object.values(merged);
}

function parseLine(line) {
  const normalized = line.replace(/,/g, "");

  // Tab-separated (cargo scan / contract): "Name\tQty" or "Qty\tName"
  if (normalized.includes("\t")) {
    const parts = normalized.split("\t").map((p) => p.trim()).filter(Boolean);
    if (parts.length >= 2) {
      if (/^\d+$/.test(parts[0])) return { name: clean(parts[1]), quantity: parseInt(parts[0], 10) };
      if (/^\d+$/.test(parts[1])) return { name: clean(parts[0]), quantity: parseInt(parts[1], 10) };
      return { name: clean(parts[0]), quantity: 1 };
    }
  }

  // "Name x Qty"
  const xMatch = normalized.match(/^(.+?)\s*[xX]\s*(\d+)\s*$/);
  if (xMatch) return { name: clean(xMatch[1]), quantity: parseInt(xMatch[2], 10) };

  // "Qty Name"
  const qtyFirst = normalized.match(/^(\d+)\s+(.+)$/);
  if (qtyFirst) return { name: clean(qtyFirst[2]), quantity: parseInt(qtyFirst[1], 10) };

  // Plain name
  const name = clean(normalized);
  return name.length > 0 ? { name, quantity: 1 } : null;
}

function clean(str) {
  return str.replace(/\*$/, "").replace(/\s+/g, " ").trim();
}
