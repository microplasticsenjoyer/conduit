// GET  /api/fund/ledger?limit=50&characterId=<optional>
//   → { entries: [{ id, characterId, characterName, kind, amount, effectiveMonth,
//                   notes, recordedByName, recordedAt }] }
//
// POST /api/fund/ledger
//   body { characterName, characterId?, kind, amount, effectiveMonth?, notes? }
//   - Leadership-only (gated by isLeader / EVE_LEADERSHIP_IDS).
//   - If characterId is omitted, name is resolved via ESI strict search.
//   - Auto-creates fund_investors row on first deposit.
//   - amount sign convention: deposit/interest/adjustment positive,
//     withdrawal positive in payload but stored negative.
//   → { entry: {...} }

import { getServiceClient } from "../_supabase.js";
import { verifyEveAuth, isLeader, AUTH_HEADERS } from "../_auth.js";
import {
  ALL_KINDS,
  KIND_WITHDRAWAL,
  KIND_INTEREST,
  PER_PERSON_CAP,
  PRINCIPAL_KINDS,
  currentMonthString,
  isValidMonth,
  resolveCharacterByName,
} from "./_helpers.js";

export async function onRequestGet({ request, env }) {
  const auth = await verifyEveAuth(request, env);
  if (auth.error) return jsonResp({ error: auth.error }, auth.status);

  const url = new URL(request.url);
  const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "50", 10) || 50, 500);
  const characterIdParam = url.searchParams.get("characterId");

  const db = getServiceClient(env);
  let q = db
    .from("fund_ledger")
    .select("id, character_id, kind, amount, effective_month, notes, recorded_by_id, recorded_by_name, recorded_at, fund_investors!inner(character_name)")
    .order("recorded_at", { ascending: false })
    .limit(limit);

  if (characterIdParam) {
    const cid = parseInt(characterIdParam, 10);
    if (Number.isFinite(cid)) q = q.eq("character_id", cid);
  }

  const { data, error } = await q;
  if (error) return jsonResp({ error: error.message }, 500);

  return jsonResp({
    entries: (data ?? []).map((e) => ({
      id: e.id,
      characterId: e.character_id,
      characterName: e.fund_investors?.character_name ?? null,
      kind: e.kind,
      amount: Number(e.amount),
      effectiveMonth: e.effective_month,
      notes: e.notes,
      recordedByName: e.recorded_by_name,
      recordedAt: e.recorded_at,
    })),
  });
}

export async function onRequestPost({ request, env }) {
  const auth = await verifyEveAuth(request, env);
  if (auth.error) return jsonResp({ error: auth.error }, auth.status);
  if (!(await isLeader(auth.characterId, env))) {
    return jsonResp({ error: "Leadership only" }, 403);
  }

  const body = await request.json().catch(() => ({}));
  const kind = String(body?.kind ?? "").trim();
  if (!ALL_KINDS.includes(kind)) {
    return jsonResp({ error: `kind must be one of: ${ALL_KINDS.join(", ")}` }, 400);
  }

  const rawAmount = Number(body?.amount);
  if (!Number.isFinite(rawAmount) || rawAmount === 0) {
    return jsonResp({ error: "amount must be a non-zero number" }, 400);
  }
  // Stored amount: withdrawals go negative regardless of input sign so the
  // ledger reads cleanly when summed.
  const storedAmount = kind === KIND_WITHDRAWAL ? -Math.abs(rawAmount) : Math.abs(rawAmount);

  const effectiveMonth = body?.effectiveMonth ? String(body.effectiveMonth) : currentMonthString();
  if (!isValidMonth(effectiveMonth)) {
    return jsonResp({ error: "effectiveMonth must be YYYY-MM" }, 400);
  }

  // Resolve target character: prefer explicit ID, else look up name via ESI.
  let characterId = parseInt(body?.characterId, 10);
  let characterName = String(body?.characterName ?? "").trim();
  if (!Number.isFinite(characterId)) {
    if (!characterName) return jsonResp({ error: "characterName or characterId required" }, 400);
    const hit = await resolveCharacterByName(characterName);
    if (!hit) return jsonResp({ error: `Could not resolve character "${characterName}"` }, 404);
    characterId = hit.id;
    characterName = hit.name;
  }
  if (!characterName) {
    // Fall back to ESI character lookup if only ID was given.
    let r;
    try {
      r = await fetch(
        `https://esi.evetech.net/latest/characters/${characterId}/?datasource=tranquility`,
        { signal: AbortSignal.timeout(5000) }
      );
    } catch {
      return jsonResp({ error: "Could not load character info" }, 502);
    }
    if (!r.ok) return jsonResp({ error: "Could not load character info" }, 502);
    const c = await r.json();
    characterName = c?.name ?? `Character ${characterId}`;
  }

  const db = getServiceClient(env);

  // Upsert investor row (idempotent on character_id PK).
  const { error: upsertErr } = await db
    .from("fund_investors")
    .upsert({
      character_id: characterId,
      character_name: characterName,
      updated_at: new Date().toISOString(),
    }, { onConflict: "character_id" });
  if (upsertErr) return jsonResp({ error: upsertErr.message }, 500);

  // Per-person cap enforcement: only against principal kinds, not interest
  // payouts. Compute new balance after this entry and reject if it exceeds
  // the cap. Withdrawals & adjustments below cap are always fine.
  if (PRINCIPAL_KINDS.has(kind)) {
    const { data: existing, error: balErr } = await db
      .from("fund_ledger")
      .select("amount, effective_month, kind")
      .eq("character_id", characterId);
    if (balErr) return jsonResp({ error: balErr.message }, 500);
    const month = currentMonthString();
    let bal = 0;
    for (const r of (existing ?? [])) {
      if (PRINCIPAL_KINDS.has(r.kind) && r.effective_month <= month) {
        bal += Number(r.amount);
      }
    }
    const projected = bal + storedAmount;
    if (projected > PER_PERSON_CAP) {
      return jsonResp({
        error: `Per-person cap is ${PER_PERSON_CAP.toLocaleString()} ISK. This entry would put ${characterName} at ${projected.toLocaleString()}.`,
      }, 400);
    }
    if (projected < 0) {
      return jsonResp({
        error: `Withdrawal exceeds balance. ${characterName}'s balance is ${bal.toLocaleString()} ISK.`,
      }, 400);
    }
  }

  const notes = body?.notes ? String(body.notes).slice(0, 2000) : null;

  const { data: inserted, error: insertErr } = await db
    .from("fund_ledger")
    .insert({
      character_id: characterId,
      kind,
      amount: storedAmount,
      effective_month: effectiveMonth,
      notes,
      recorded_by_id: auth.characterId,
      recorded_by_name: auth.characterName ?? "Unknown",
    })
    .select("id, character_id, kind, amount, effective_month, notes, recorded_by_name, recorded_at")
    .single();

  if (insertErr) return jsonResp({ error: insertErr.message }, 500);

  return jsonResp({
    entry: {
      id: inserted.id,
      characterId: inserted.character_id,
      characterName,
      kind: inserted.kind,
      amount: Number(inserted.amount),
      effectiveMonth: inserted.effective_month,
      notes: inserted.notes,
      recordedByName: inserted.recorded_by_name,
      recordedAt: inserted.recorded_at,
    },
  }, 201);
}

export async function onRequestOptions() {
  return new Response(null, { headers: AUTH_HEADERS });
}

function jsonResp(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: AUTH_HEADERS });
}
