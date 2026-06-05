// GET  /api/projects/:corpId            → read the cached snapshot
// GET  /api/projects/:corpId?refresh=1  → refresh the snapshot from ESI
// POST /api/projects/:corpId            → refresh AND archive the current LP
//                                         project(s) — the "Archive" button
//   → {
//       corpId,
//       syncedAt,            // ISO string | null  (when the snapshot was last refreshed)
//       syncedBy,            // character name | null
//       fromCache,           // true unless this response just refreshed from ESI
//       refreshError,        // string | undefined  — set when a refresh/archive attempt failed
//       archived,            // true | undefined    — set when this response just archived
//       truncated,           // true if some projects were skipped when scanning contributors
//       lpProject,           // lifetime LP summary (or null):
//                            //   { name, lpGenerated, iskPaidOut, contributorCount, projectCount }
//       leaderboard: [{ characterId, characterName, lpGenerated, iskPaidOut }],
//                            //   lifetime totals across every "Auto Pay Out" project, sorted desc
//       archivedProjects: [{ projectId, projectName, archivedAt, archivedBy, lpGenerated,
//                            iskPaidOut, pilotCount, leaderboard: [...] }],   // frozen finished projects
//       projects:    [{ id, name, state, progressPct, createdBy, iskRewarded, rewardPool,
//                       contributorCount, topContributors: [{ characterId, characterName, amount }] }],
//     }
//
// Auth: EVE SSO bearer token; corp membership is enforced by verifyEveAuth.
//
// Refreshing (`?refresh=1`) and archiving (POST) call ESI's Corporation
// Projects routes with the *caller's* access token. Those routes need a corp
// Director (and the token must carry esi-corporations.read_projects.v1) — so
// only a Director can refresh or archive; everyone else reads whatever a
// Director last synced.
//
// The LP leaderboard shows *lifetime* totals: the active "Auto Pay Out" project
// summed together with every project a Director has archived (frozen into
// corp_lp_project_archive). Archiving lets a finished project's numbers survive
// after EVE drops it, so spinning up a fresh project doesn't reset the board.
//
// Note: the Corporation Projects routes are the "new ESI" (Data Hub) endpoints
// — no /latest/ prefix, an X-Compatibility-Date header instead of a route
// version, and cursor-based pagination. List routes return { items, cursor }
// and default to just 10 records per page; esiList() asks for the max page size
// (100) and follows cursor.after to the end so the leaderboard isn't capped.

import { getServiceClient } from "../_supabase.js";
import { verifyEveAuth, AUTH_HEADERS } from "../_auth.js";
import { resolveMain } from "./_alts.js";

const ESI_BASE = "https://esi.evetech.net";
const ESI_COMPAT_DATE = "2026-01-01";
const UA = "met0-trade/0.6.0 (corp-projects)";

// Bound the subrequest fan-out (Cloudflare caps subrequests per invocation).
const MAX_PROJECTS_SCANNED = 25;          // projects we fetch contributor lists for
const MAX_PROJECT_LIST_PAGES = 5;
const TOP_CONTRIBUTORS_PER_PROJECT = 100;

export async function onRequestGet({ request, env, params }) {
  const ctx = await prepare(request, env, params);
  if (ctx.error) return jsonResp({ error: ctx.error }, ctx.status);

  const wantRefresh = new URL(request.url).searchParams.get("refresh") === "1";
  if (!wantRefresh) return jsonResp({ corpId: ctx.corpId, ...ctx.cached });
  if (!ctx.token) return jsonResp({ corpId: ctx.corpId, ...ctx.cached, refreshError: "No access token" });

  return refreshSnapshot(ctx, { archive: false });
}

// POST = the "Archive" button: refresh from ESI, then freeze the current LP
// project(s) into corp_lp_project_archive so their numbers persist after EVE
// retires them. Do this when a project is finished and a new one is starting.
export async function onRequestPost({ request, env, params }) {
  const ctx = await prepare(request, env, params);
  if (ctx.error) return jsonResp({ error: ctx.error }, ctx.status);
  if (!ctx.token) return jsonResp({ corpId: ctx.corpId, ...ctx.cached, refreshError: "No access token" });

  return refreshSnapshot(ctx, { archive: true });
}

// Verifies auth, validates the corp, and reads the last cached snapshot (used
// as the graceful fallback when an ESI refresh fails).
async function prepare(request, env, params) {
  const auth = await verifyEveAuth(request, env);
  if (auth.error) return { error: auth.error, status: auth.status };

  const corpId = parseInt(params.corpId, 10);
  const expectedCorp = env.EVE_CORP_ID ? parseInt(env.EVE_CORP_ID, 10) : null;
  if (!corpId || (expectedCorp && corpId !== expectedCorp)) {
    return { error: "Unsupported corporation", status: 400 };
  }

  const db = getServiceClient(env);
  const { data: row } = await db
    .from("corp_project_snapshot")
    .select("data, synced_at, synced_by_name")
    .eq("corp_id", corpId)
    .maybeSingle();

  const cached = {
    leaderboard: row?.data?.leaderboard ?? [],
    projects: row?.data?.projects ?? [],
    lpProject: row?.data?.lpProject ?? null,
    archivedProjects: row?.data?.archivedProjects ?? [],
    truncated: row?.data?.truncated ?? false,
    syncedAt: row?.synced_at ?? null,
    syncedBy: row?.synced_by_name ?? null,
    fromCache: true,
  };

  const token = (request.headers.get("Authorization") || "").match(/^Bearer\s+(.+)$/i)?.[1]?.trim() ?? null;
  return { db, corpId, auth, token, cached };
}

async function refreshSnapshot(ctx, { archive }) {
  const { db, corpId, auth, token, cached } = ctx;
  try {
    const built = await buildSnapshot(db, corpId, token, { archive, archivedBy: auth.characterName });
    const syncedAt = new Date().toISOString();
    const data = {
      leaderboard: built.leaderboard,
      projects: built.projects,
      lpProject: built.lpProject,
      archivedProjects: built.archivedProjects,
      truncated: built.truncated,
    };
    await db.from("corp_project_snapshot").upsert(
      { corp_id: corpId, data, synced_at: syncedAt, synced_by_id: auth.characterId, synced_by_name: auth.characterName },
      { onConflict: "corp_id" }
    );
    return jsonResp({
      corpId,
      ...data,
      syncedAt,
      syncedBy: auth.characterName,
      fromCache: false,
      archived: archive || undefined,
    });
  } catch (err) {
    // Most common cause: 403 — caller isn't a Director, or their token lacks
    // esi-corporations.read_projects.v1. Fall back to the last good snapshot.
    return jsonResp({ corpId, ...cached, refreshError: err.message });
  }
}

// ── ESI helpers ─────────────────────────────────────────────────────────────

async function esiGet(path, token, { query } = {}) {
  const url = new URL(`${ESI_BASE}${path}`);
  if (query) {
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, String(v));
  }
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      "X-Compatibility-Date": ESI_COMPAT_DATE,
      "Accept-Language": "en",
      "User-Agent": UA,
    },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    let detail = body.slice(0, 200);
    try { detail = JSON.parse(body).error ?? detail; } catch {}
    const err = new Error(`ESI ${res.status} (${path}): ${detail}`);
    err.status = res.status;
    throw err;
  }
  return { body: await res.json() };
}

// Reads a cursor-paginated "new ESI" list endpoint to the end. Each page is
// shaped { <items>: [...], cursor: { after } }; we request the maximum page
// size (default routes give only 10) and follow cursor.after until a short or
// empty page — or the `maxPages` safety bound — says there's no more data.
// Tolerates a bare JSON array too (a short page, so it stops after page one).
async function esiList(path, token, { limit = 100, maxPages = 20, query = {} } = {}) {
  const out = [];
  let after = "0";
  for (let page = 0; page < maxPages; page++) {
    const { body } = await esiGet(path, token, { query: { ...query, limit, after } });
    const before = out.length;
    collect(out, body);
    const got = out.length - before;
    const next = body?.cursor?.after;
    if (got < limit || !next || next === after) break;
    after = next;
  }
  return out;
}

function collect(into, body) {
  if (Array.isArray(body)) { into.push(...body); return; }
  if (body && typeof body === "object") {
    const arr =
      (Array.isArray(body.projects) && body.projects) ||
      (Array.isArray(body.contributors) && body.contributors) ||
      (Array.isArray(body.data) && body.data) ||
      (Array.isArray(body.items) && body.items) ||
      null;
    if (arr) into.push(...arr);
  }
}

// ── Snapshot builder ────────────────────────────────────────────────────────

// The corp's loyalty-point projects — a director named them "Auto Pay Out"
// in-game. There can be several over time as one finishes and the next begins;
// the leaderboard sums LP contributed → ISK paid back across all of them.
function isLpProject(p) {
  const name = String(p?.name ?? p?.title ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
  return name.includes("autopayout") || name.includes("autopay");
}

async function fetchContributors(corpId, projectId, token) {
  const raw = await esiList(`/corporations/${corpId}/projects/${projectId}/contributors`, token);
  return raw.map(parseContributor).filter((c) => c && c.characterId != null);
}

async function fetchProjectDetail(corpId, projectId, token) {
  const { body } = await esiGet(`/corporations/${corpId}/projects/${projectId}`, token);
  return body && typeof body === "object" ? body : {};
}

// ISK paid per unit of contribution — for the LP project this is ISK per loyalty
// point ("Reward per loyalty point earned" in the in-game project view).
function rewardPerContribution(detail) {
  return num(
    detail?.contribution?.reward_per_contribution ??
    detail?.contribution?.reward_per_unit ??
    detail?.reward_per_contribution ??
    detail?.reward?.per_contribution
  );
}

async function buildSnapshot(db, corpId, token, { archive = false, archivedBy = null } = {}) {
  // state=All so finished LP projects stay visible — both so the "Archive"
  // button can still freeze a just-completed one, and so they keep counting
  // toward the lifetime totals until (and after) they're archived.
  const rawProjects = await esiList(`/corporations/${corpId}/projects`, token, {
    maxPages: MAX_PROJECT_LIST_PAGES,
    query: { state: "All" },
  });

  const projects = [];
  const contributorsByProject = new Map(); // project id -> parsed contributors[]
  let truncated = false;

  for (let i = 0; i < rawProjects.length; i++) {
    const p = rawProjects[i] || {};
    const state = p.state ?? p.status ?? null;
    if (String(state).toLowerCase() === "deleted") continue; // skip retired projects

    const id = String(p.id ?? p.project_id ?? p.uuid ?? p.key ?? i);
    const name = p.name ?? p.title ?? `Project ${id}`;
    const createdBy =
      p.created_by?.name ?? p.creator?.name ?? p.owner?.name ?? p.created_by_name ?? p.creator_name ?? null;
    // ESI's Corporation Projects "reward" object is { initial, remaining } in ISK.
    // ISK paid out so far = what's left escrow into contributors' wallets =
    // initial pool minus what's still remaining. (Older speculative field names
    // kept as fallbacks in case the shape shifts.)
    const rewardPool = num(
      p.reward?.initial ?? p.reward_pool ?? p.rewards?.pool ?? p.reward?.pool ?? p.total_reward ?? p.reward?.total ?? p.isk_reward
    );
    const rewardRemaining = num(p.reward?.remaining);
    const iskRewarded =
      num(p.isk_rewarded ?? p.isk_rewarded_total ?? p.rewards?.isk_rewarded ?? p.reward?.isk_rewarded ?? p.isk_paid) ||
      Math.max(0, rewardPool - rewardRemaining);

    let topContributors = [];
    let contributorCount = null;

    if (projects.length < MAX_PROJECTS_SCANNED) {
      try {
        const parsed = await fetchContributors(corpId, id, token);
        contributorsByProject.set(id, parsed);
        contributorCount = parsed.length;
        topContributors = [...parsed].sort((a, b) => b.amount - a.amount).slice(0, TOP_CONTRIBUTORS_PER_PROJECT);
      } catch {
        // A single project's contributor list failing shouldn't sink the sync.
      }
    } else {
      truncated = true;
    }

    projects.push({
      id,
      name,
      state,
      progressPct: pickProgressPct(p),
      createdBy,
      iskRewarded,
      rewardPool,
      contributorCount,
      topContributors,
    });
  }

  // ── LP leaderboard — lifetime totals across every "Auto Pay Out" project ──

  // Each currently-live LP project, with raw contributors + its ISK/LP rate.
  const liveLp = [];
  for (const proj of projects) {
    if (!isLpProject(proj)) continue;
    let parsed = contributorsByProject.get(proj.id);
    if (!parsed) {
      // The LP project sat past the contributor-scan cap — fetch it anyway.
      try { parsed = await fetchContributors(corpId, proj.id, token); } catch { parsed = []; }
    }
    // The ISK/LP payout rate ("Reward per loyalty point earned") lives on the
    // project *detail* route, not the listing — fetch it for an exact payout.
    let rewardPerLp = 0;
    try { rewardPerLp = rewardPerContribution(await fetchProjectDetail(corpId, proj.id, token)); } catch {}
    const contributors = parsed.map((c) => ({
      characterId: c.characterId,
      characterName: c.characterName ?? `Character ${c.characterId}`,
      amount: c.amount,
    }));
    liveLp.push({
      projectId: proj.id,
      projectName: proj.name,
      rewardPerLp,
      iskRewarded: proj.iskRewarded,
      totalLp: contributors.reduce((s, c) => s + c.amount, 0),
      contributors,
    });
  }

  // The "Archive" button (POST) freezes the current LP project(s) so their
  // numbers survive after EVE drops the project. Re-archiving simply refreshes
  // the frozen copy while the project is still live.
  if (archive && liveLp.length) {
    const now = new Date().toISOString();
    const { error } = await db.from("corp_lp_project_archive").upsert(
      liveLp.map((p) => ({
        corp_id: corpId,
        project_id: p.projectId,
        project_name: p.projectName,
        data: {
          rewardPerLp: p.rewardPerLp,
          iskRewarded: p.iskRewarded,
          totalLp: p.totalLp,
          contributors: p.contributors,
        },
        archived_at: now,
        archived_by: archivedBy,
      })),
      { onConflict: "corp_id,project_id" }
    );
    if (error) throw new Error(`Archive write failed: ${error.message}`);
  }

  // Every LP project a Director has archived for this corp.
  const { data: archiveRows } = await db
    .from("corp_lp_project_archive")
    .select("project_id, project_name, data, archived_at, archived_by")
    .eq("corp_id", corpId);
  const archived = (archiveRows ?? []).map((r) => ({
    projectId: r.project_id,
    projectName: r.project_name,
    archivedAt: r.archived_at,
    archivedBy: r.archived_by,
    rewardPerLp: num(r.data?.rewardPerLp),
    iskRewarded: num(r.data?.iskRewarded),
    totalLp: num(r.data?.totalLp),
    contributors: Array.isArray(r.data?.contributors) ? r.data.contributors : [],
  }));

  // Lifetime set: every live LP project, plus archived projects EVE no longer
  // lists. A still-live project always uses fresh ESI data even if it's also
  // archived, so nothing is ever counted twice.
  const liveIds = new Set(liveLp.map((p) => p.projectId));
  const lifetimeProjects = [...liveLp, ...archived.filter((a) => !liveIds.has(a.projectId))];

  const leaderboard = buildLeaderboard(lifetimeProjects);

  let lpProject = null;
  if (lifetimeProjects.length) {
    const activeName = liveLp.length ? liveLp[liveLp.length - 1].projectName : archived[0]?.projectName;
    lpProject = {
      name: activeName ?? "Auto Pay Out",
      lpGenerated: lifetimeProjects.reduce((s, p) => s + p.totalLp, 0),
      iskPaidOut: leaderboard.reduce((s, r) => s + r.iskPaidOut, 0),
      contributorCount: leaderboard.length,
      projectCount: lifetimeProjects.length,
    };
  }

  // Each frozen project with its own folded leaderboard, for the history view.
  const archivedProjects = archived
    .map((a) => {
      const board = buildLeaderboard([a]);
      return {
        projectId: a.projectId,
        projectName: a.projectName,
        archivedAt: a.archivedAt,
        archivedBy: a.archivedBy,
        lpGenerated: a.totalLp,
        iskPaidOut: board.reduce((s, r) => s + r.iskPaidOut, 0),
        pilotCount: board.length,
        leaderboard: board,
      };
    })
    .sort((a, b) => String(b.archivedAt ?? "").localeCompare(String(a.archivedAt ?? "")));

  return { projects, leaderboard, lpProject, archivedProjects, truncated };
}

// Folds a set of LP projects' raw contributors into one leaderboard: farming
// alts merged into their mains (see _alts.js), LP and ISK summed per pilot,
// sorted descending by LP.
function buildLeaderboard(lpProjects) {
  const byMain = new Map(); // mainId -> { name, lp, isk }
  for (const proj of lpProjects) {
    const iskFor = iskForContribution(proj);
    for (const c of proj.contributors) {
      const amount = num(c.amount);
      const { id, name, isAlt } = resolveMain(c.characterId, c.characterName ?? `Character ${c.characterId}`);
      const e = byMain.get(id) ?? { name: null, lp: 0, isk: 0 };
      e.lp += amount;
      e.isk += iskFor(amount);
      if (name && (!e.name || !isAlt)) e.name = name; // a direct main contribution wins the label
      byMain.set(id, e);
    }
  }
  return [...byMain.entries()]
    .map(([id, e]) => ({
      characterId: id,
      characterName: e.name ?? `Character ${id}`,
      lpGenerated: e.lp,
      iskPaidOut: e.isk,
    }))
    .sort((a, b) => b.lpGenerated - a.lpGenerated || a.characterName.localeCompare(b.characterName));
}

// ISK paid per loyalty point for one project. An auto-payout project pays a
// fixed ISK/LP rate; if that rate is missing, fall back to splitting the
// project's total ISK rewarded proportionally by LP.
function iskForContribution(proj) {
  const rate = num(proj.rewardPerLp);
  if (rate > 0) return (lp) => lp * rate;
  const total = num(proj.totalLp);
  const pool = num(proj.iskRewarded);
  if (total > 0 && pool > 0) return (lp) => pool * (lp / total);
  return () => 0;
}

function parseContributor(c) {
  if (!c || typeof c !== "object") return null;
  const characterId =
    c.character?.id ?? c.character_id ?? c.contributor?.id ?? c.contributor_id ?? c.pilot?.id ?? c.id ?? null;
  const characterName =
    c.character?.name ?? c.character_name ?? c.contributor?.name ?? c.contributor_name ?? c.pilot?.name ?? c.name ?? null;
  const amount = num(
    c.contribution ?? c.contributed ?? c.amount ?? c.value ?? c.units ?? c.quantity ?? c.total ?? c.points ?? 0
  );
  if (characterId == null) return null;
  return { characterId: Number(characterId), characterName, amount };
}

function pickProgressPct(p) {
  if (!p || typeof p !== "object") return null;
  if (typeof p.progress_percentage === "number") return clampPct(p.progress_percentage);
  if (typeof p.completion === "number") return clampPct(p.completion <= 1 ? p.completion * 100 : p.completion);
  if (typeof p.progress === "number") return clampPct(p.progress <= 1 ? p.progress * 100 : p.progress);
  const cur = num(p.progress?.current ?? p.progress?.contributed ?? p.progress?.value ?? p.contributed ?? p.current);
  const tgt = num(p.progress?.desired ?? p.progress?.target ?? p.progress?.goal ?? p.progress?.max ?? p.target ?? p.goal);
  if (tgt > 0) return clampPct((cur / tgt) * 100);
  return null;
}

function clampPct(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return null;
  return Math.max(0, Math.min(100, v));
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export async function onRequestOptions() {
  return new Response(null, { headers: AUTH_HEADERS });
}

function jsonResp(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: AUTH_HEADERS });
}
