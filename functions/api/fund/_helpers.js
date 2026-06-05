// Shared helpers for /api/fund/* endpoints.

export const DEFAULT_RATE_PCT = 2.0;

// Tier thresholds (ISK). Matches the v2.1 restructure proposal — used for
// SRP cap / JF rate, not for interest. Derived at read time from balance.
const TIERS = [
  { key: "partner",            min: 20_000_000_000 },
  { key: "senior_shareholder", min: 12_000_000_000 },
  { key: "shareholder",        min:  5_000_000_000 },
  { key: "associate",          min:  0              },
];

// Per-person deposit cap from the proposal.
export const PER_PERSON_CAP = 30_000_000_000;

export function tierFor(balance) {
  const n = Number(balance ?? 0);
  for (const t of TIERS) if (n >= t.min) return t.key;
  return "associate";
}

export function currentMonthString(now = new Date()) {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
export function isValidMonth(s) { return typeof s === "string" && MONTH_RE.test(s); }

export const KIND_DEPOSIT    = "deposit";
export const KIND_WITHDRAWAL = "withdrawal";
export const KIND_INTEREST   = "interest";
export const KIND_ADJUSTMENT = "adjustment";
export const ALL_KINDS = [KIND_DEPOSIT, KIND_WITHDRAWAL, KIND_INTEREST, KIND_ADJUSTMENT];

// Kinds that move principal. Interest entries are ledger-only.
export const PRINCIPAL_KINDS = new Set([KIND_DEPOSIT, KIND_WITHDRAWAL, KIND_ADJUSTMENT]);

// Resolves a character name → id via ESI's POST /universe/ids endpoint.
// Returns { id, name } on a strict (case-insensitive) match, or null.
export async function resolveCharacterByName(name) {
  const trimmed = String(name ?? "").trim();
  if (!trimmed) return null;
  let res;
  try {
    res = await fetch("https://esi.evetech.net/latest/universe/ids/?datasource=tranquility", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify([trimmed]),
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  const data = await res.json().catch(() => ({}));
  const hit = (data?.characters ?? []).find(
    (c) => c.name?.toLowerCase() === trimmed.toLowerCase()
  );
  return hit ? { id: hit.id, name: hit.name } : null;
}
