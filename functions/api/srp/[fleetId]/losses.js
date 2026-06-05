// Submit a loss to an SRP fleet.
//
//   POST /api/srp/:fleetId/losses
//     body { zkillUrl, notes? }
//     → { loss: { id, characterName, shipName, lossValue, status, ... } }
//
// Steps:
//   1. Parse kill ID from the zKillboard URL.
//   2. Fetch zKillboard API for killmail_id, killmail_hash, fittedValue.
//      We deliberately use zkb.fittedValue (hull + fitted modules) rather than
//      totalValue so looted cargo a pilot was hauling doesn't inflate the SRP
//      payout or the monthly stats.
//   3. Fetch ESI killmail to confirm victim + get ship_type_id.
//   4. Look up ship name from item_cache (fallback: ESI /universe/types).
//   5. Upsert into srp_losses (unique on fleet_id + kill_id).
//
// Auth: EVE SSO bearer token; corp membership enforced by verifyEveAuth.

import { getServiceClient } from "../../_supabase.js";
import { verifyEveAuth, AUTH_HEADERS } from "../../_auth.js";

const ESI_BASE = "https://esi.evetech.net/latest";
const ZKILL_BASE = "https://zkillboard.com/api";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function onRequestPost({ request, env, params }) {
  const auth = await verifyEveAuth(request, env);
  if (auth.error) return jsonResp({ error: auth.error }, auth.status);

  const body = await request.json().catch(() => ({}));
  const zkillUrl = body?.zkillUrl?.trim();
  const notes = body?.notes?.trim() || null;
  const altAccount = !!body?.altAccount;

  if (!zkillUrl) return jsonResp({ error: "zkillUrl required" }, 400);

  // Parse kill ID from URL like https://zkillboard.com/kill/12345678/
  const killIdMatch = zkillUrl.match(/\/kill\/(\d+)/i);
  if (!killIdMatch) return jsonResp({ error: "Could not parse kill ID from zKillboard URL" }, 400);
  const killId = parseInt(killIdMatch[1], 10);

  // Resolve fleet by UUID or slug
  const db = getServiceClient(env);
  const fleetId = params.fleetId;
  const corpId = parseInt(env.EVE_CORP_ID, 10);

  const isUuid = UUID_RE.test(fleetId);
  const { data: fleet, error: fleetErr } = await (isUuid
    ? db.from("srp_fleets").select("id, status").eq("id", fleetId).eq("corp_id", corpId).single()
    : db.from("srp_fleets").select("id, status").eq("slug", fleetId).eq("corp_id", corpId).single());

  if (fleetErr || !fleet) return jsonResp({ error: "Fleet not found" }, 404);
  if (fleet.status !== "open") return jsonResp({ error: "This fleet is closed and no longer accepting losses" }, 409);

  // Fetch zKillboard for killmail hash + ISK value
  let killmailId, killmailHash, lossValue;
  try {
    const zkRes = await fetch(`${ZKILL_BASE}/kills/killID/${killId}/`, {
      headers: { "User-Agent": "met0-trade/1.0 (+https://met0.trade)" },
      signal: AbortSignal.timeout(10000),
    });
    if (!zkRes.ok) throw new Error(`zKillboard returned ${zkRes.status}`);
    const zkData = await zkRes.json();
    const entry = Array.isArray(zkData) ? zkData[0] : null;
    if (!entry) throw new Error("Kill not found on zKillboard");
    killmailId = entry.killmail_id;
    killmailHash = entry.zkb?.hash;
    // Hull + fitted modules only — excludes cargo hold contents on purpose.
    lossValue = entry.zkb?.fittedValue ?? null;
  } catch (err) {
    const msg = err.name === "TimeoutError" ? "zKillboard timed out" : err.message;
    return jsonResp({ error: `zKillboard lookup failed: ${msg}` }, 502);
  }

  // Fetch ESI killmail to confirm victim character + get ship type
  let shipTypeId, victimCharacterId, victimCorpId;
  try {
    const esiRes = await fetch(
      `${ESI_BASE}/killmails/${killmailId}/${killmailHash}/?datasource=tranquility`,
      { signal: AbortSignal.timeout(8000) }
    );
    if (!esiRes.ok) throw new Error(`ESI returned ${esiRes.status}`);
    const km = await esiRes.json();
    shipTypeId = km?.victim?.ship_type_id ?? null;
    victimCharacterId = km?.victim?.character_id ?? null;
    victimCorpId = km?.victim?.corporation_id ?? null;
  } catch (err) {
    const msg = err.name === "TimeoutError" ? "ESI timed out" : err.message;
    return jsonResp({ error: `ESI killmail lookup failed: ${msg}` }, 502);
  }

  // Resolve which character this loss is recorded against. By default that's
  // the logged-in user, who must be the victim. If `altAccount` is set, allow
  // submitting on behalf of any other corp character — but verify that
  // character was in the corp at the time of the kill, and record the loss
  // under the victim's identity rather than the submitter's.
  let lossCharacterId = auth.characterId;
  let lossCharacterName = auth.characterName ?? "Unknown";
  if (altAccount) {
    if (!victimCharacterId) {
      return jsonResp({ error: "Could not determine victim character from killmail" }, 400);
    }
    const expectedCorp = parseInt(env.EVE_CORP_ID, 10);
    if (expectedCorp && victimCorpId !== expectedCorp) {
      return jsonResp({ error: "Victim was not in this corporation at the time of the kill" }, 403);
    }
    lossCharacterId = victimCharacterId;
    try {
      const charRes = await fetch(
        `${ESI_BASE}/characters/${victimCharacterId}/?datasource=tranquility`,
        { signal: AbortSignal.timeout(5000) }
      );
      if (charRes.ok) {
        const charData = await charRes.json();
        lossCharacterName = charData?.name ?? "Unknown";
      }
    } catch { /* best-effort; fall back to "Unknown" */ }
  } else if (victimCharacterId && victimCharacterId !== auth.characterId) {
    return jsonResp({
      error: "You can only submit losses for your own character. Check 'Alt account' to submit on behalf of another character on your account.",
    }, 403);
  }

  // Look up ship name — try item_cache first, fall back to ESI types
  let shipName = null;
  if (shipTypeId) {
    const { data: cached } = await db
      .from("item_cache")
      .select("name")
      .eq("type_id", shipTypeId)
      .maybeSingle();
    if (cached?.name) {
      shipName = cached.name;
    } else {
      try {
        const typeRes = await fetch(
          `${ESI_BASE}/universe/types/${shipTypeId}/?datasource=tranquility`,
          { signal: AbortSignal.timeout(5000) }
        );
        if (typeRes.ok) {
          const typeData = await typeRes.json();
          shipName = typeData?.name ?? null;
        }
      } catch { /* best-effort */ }
    }
  }

  // Upsert the loss row (idempotent on fleet_id + kill_id)
  const { data: loss, error: upsertErr } = await db
    .from("srp_losses")
    .upsert(
      {
        fleet_id: fleet.id,
        character_id: lossCharacterId,
        character_name: lossCharacterName,
        zkill_url: zkillUrl,
        kill_id: killId,
        ship_type_id: shipTypeId,
        ship_name: shipName,
        loss_value: lossValue,
        notes: notes ? String(notes).slice(0, 2000) : null,
        status: "pending",
      },
      { onConflict: "fleet_id,kill_id", ignoreDuplicates: false }
    )
    .select("id, character_id, character_name, zkill_url, kill_id, ship_type_id, ship_name, loss_value, payment_amount, rejection_reason, notes, status, created_at")
    .single();

  if (upsertErr) {
    if (upsertErr.message?.includes("unique") || upsertErr.code === "23505") {
      return jsonResp({ error: "This kill has already been submitted to this fleet" }, 409);
    }
    return jsonResp({ error: upsertErr.message }, 500);
  }

  return jsonResp({ loss: toLoss(loss) }, 201);
}

export async function onRequestOptions() {
  return new Response(null, { headers: AUTH_HEADERS });
}

function jsonResp(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: AUTH_HEADERS });
}

function toLoss(l) {
  return {
    id: l.id,
    characterId: l.character_id,
    characterName: l.character_name,
    zkillUrl: l.zkill_url,
    killId: l.kill_id,
    shipTypeId: l.ship_type_id,
    shipName: l.ship_name,
    lossValue: l.loss_value,
    paymentAmount: l.payment_amount,
    rejectionReason: l.rejection_reason,
    notes: l.notes,
    status: l.status,
    createdAt: l.created_at,
  };
}
