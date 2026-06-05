// Title → Discord role mapping editor.
//
//   POST   /api/admin/role-map      body { titleName, discordRoleId }   upsert by titleName
//   DELETE /api/admin/role-map?id=  remove a mapping
//
// titleName: null = the base "verified corp member" role granted to everyone
// whose linked account is still in the corp.

import { getServiceClient } from "../_supabase.js";
import { verifyEveAuth, isLeader, AUTH_HEADERS } from "../_auth.js";

export async function onRequestPost({ request, env }) {
  const auth = await verifyEveAuth(request, env);
  if (auth.error) return jsonResp({ error: auth.error }, auth.status);
  if (!(await isLeader(auth.characterId, env))) {
    return jsonResp({ error: "Leadership only" }, 403);
  }

  const body = await request.json().catch(() => ({}));
  const titleName = body?.titleName == null
    ? null
    : (String(body.titleName).trim().slice(0, 100) || null);
  const discordRoleId = typeof body?.discordRoleId === "string"
    ? body.discordRoleId.trim() : "";
  if (!discordRoleId) return jsonResp({ error: "discordRoleId required" }, 400);

  const db = getServiceClient(env);

  // Manual upsert because the unique index is over coalesce(title_name, '')
  // — Supabase JS upsert can't target an expression index.
  let q = db.from("title_role_map").select("id");
  q = titleName === null ? q.is("title_name", null) : q.eq("title_name", titleName);
  const { data: existing } = await q.maybeSingle();

  if (existing) {
    const { data, error } = await db
      .from("title_role_map")
      .update({ discord_role_id: discordRoleId })
      .eq("id", existing.id)
      .select("id, title_name, discord_role_id")
      .single();
    if (error) return jsonResp({ error: error.message }, 500);
    return jsonResp({ mapping: shape(data) });
  }

  const { data, error } = await db
    .from("title_role_map")
    .insert({ title_name: titleName, discord_role_id: discordRoleId })
    .select("id, title_name, discord_role_id")
    .single();
  if (error) return jsonResp({ error: error.message }, 500);
  return jsonResp({ mapping: shape(data) }, 201);
}

export async function onRequestDelete({ request, env }) {
  const auth = await verifyEveAuth(request, env);
  if (auth.error) return jsonResp({ error: auth.error }, auth.status);
  if (!(await isLeader(auth.characterId, env))) {
    return jsonResp({ error: "Leadership only" }, 403);
  }

  const id = new URL(request.url).searchParams.get("id");
  if (!id) return jsonResp({ error: "id required" }, 400);

  const db = getServiceClient(env);
  const { error } = await db.from("title_role_map").delete().eq("id", id);
  if (error) return jsonResp({ error: error.message }, 500);
  return new Response(null, { status: 204, headers: AUTH_HEADERS });
}

export async function onRequestOptions() {
  return new Response(null, { headers: AUTH_HEADERS });
}

function shape(r) {
  return { id: r.id, titleName: r.title_name, discordRoleId: r.discord_role_id };
}

function jsonResp(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: AUTH_HEADERS });
}
