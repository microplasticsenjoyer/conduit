// Browser-local appraisal history. Stores up to MAX_ENTRIES recent slugs
// per device so corp mates can find their previous quotes without
// bookmarking every link. Lives in localStorage; never sent to the server.

const KEY = "praxis:appraisalHistory";
const MAX_ENTRIES = 25;

function safeRead() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function safeWrite(list) {
  try { localStorage.setItem(KEY, JSON.stringify(list)); } catch {}
}

export function listHistory() {
  return safeRead();
}

// Push or update an entry. Updates dedupe by slug — if the user reloads
// the same appraisal we don't add a duplicate; we just refresh `viewedAt`.
export function addHistoryEntry({ slug, title, totalBuy, totalSell, itemCount, stationId, createdAt }) {
  if (!slug) return;
  const now = Date.now();
  const list = safeRead().filter((e) => e.slug !== slug);
  list.unshift({
    slug,
    title: title ?? null,
    totalBuy: Number(totalBuy) || 0,
    totalSell: Number(totalSell) || 0,
    itemCount: Number(itemCount) || 0,
    stationId: stationId ?? null,
    createdAt: createdAt ?? new Date(now).toISOString(),
    viewedAt: new Date(now).toISOString(),
  });
  safeWrite(list.slice(0, MAX_ENTRIES));
}

export function setHistoryTitle(slug, title) {
  const list = safeRead();
  const idx = list.findIndex((e) => e.slug === slug);
  if (idx === -1) return;
  list[idx] = { ...list[idx], title: title || null };
  safeWrite(list);
}

export function removeHistoryEntry(slug) {
  safeWrite(safeRead().filter((e) => e.slug !== slug));
}

export function clearHistory() {
  safeWrite([]);
}
