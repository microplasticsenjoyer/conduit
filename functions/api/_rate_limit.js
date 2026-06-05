// Per-IP fixed-window rate limiter backed by Supabase.
//
// `checkRateLimit(db, request, { limit, windowMs })` returns
//   { allowed: true,  remaining }  on accept
//   { allowed: false, retryAfter } on reject
//
// The fixed-window approach is intentionally simple: each IP gets a row
// with a window-start timestamp and a token counter; once the counter
// exceeds the limit within the window we reject; once the window expires
// we reset on the next request.
//
// Race condition: two concurrent requests can both read tokens=N before
// either writes back, briefly allowing one extra. That's acceptable for
// a write-abuse safety net — anyone hitting that hard is rate-limited
// promptly on the next request.

const FALLBACK_IP = "_unknown";
const ROW_TTL_MS = 24 * 60 * 60 * 1000;

export function getClientIp(request) {
  return (
    request.headers.get("CF-Connecting-IP") ||
    request.headers.get("X-Forwarded-For")?.split(",")[0]?.trim() ||
    FALLBACK_IP
  );
}

export async function checkRateLimit(db, request, { limit, windowMs }) {
  const ip = getClientIp(request);
  const now = Date.now();

  const { data: row } = await db
    .from("rate_limits")
    .select("tokens, window_started")
    .eq("ip", ip)
    .maybeSingle();

  let tokens = 0;
  let windowStartedAt = now;

  if (row) {
    windowStartedAt = new Date(row.window_started).getTime();
    if (now - windowStartedAt > windowMs) {
      // Window expired — reset.
      tokens = 0;
      windowStartedAt = now;
    } else {
      tokens = row.tokens ?? 0;
    }
  }

  if (tokens >= limit) {
    const retryAfter = Math.max(1, Math.ceil((windowStartedAt + windowMs - now) / 1000));
    return { allowed: false, retryAfter };
  }

  // Increment + persist. Single upsert keeps writes minimal.
  const newTokens = tokens + 1;
  await db.from("rate_limits").upsert(
    {
      ip,
      tokens: newTokens,
      window_started: new Date(windowStartedAt).toISOString(),
      updated_at: new Date(now).toISOString(),
    },
    { onConflict: "ip" }
  );

  return { allowed: true, remaining: Math.max(0, limit - newTokens) };
}

// Best-effort cleanup of rows whose window is far stale, called occasionally
// from a request handler so we don't accumulate a long tail of dead IPs.
// The 1% probability keeps the DB hit cost negligible per request.
export async function maybeReapStaleRows(db) {
  if (Math.random() > 0.01) return;
  try {
    const cutoff = new Date(Date.now() - ROW_TTL_MS).toISOString();
    await db.from("rate_limits").delete().lt("window_started", cutoff);
  } catch {
    // Cleanup is fire-and-forget.
  }
}
