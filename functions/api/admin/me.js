// GET /api/admin/me — does the caller have admin/leadership rights?
// Used by the frontend to decide whether to show the Admin tab.

import { verifyEveAuth, isLeader, AUTH_HEADERS } from "../_auth.js";

export async function onRequestGet({ request, env }) {
  const auth = await verifyEveAuth(request, env);
  if (auth.error) return jsonResp({ error: auth.error }, auth.status);
  const isAdmin = await isLeader(auth.characterId, env);
  return jsonResp({ isAdmin });
}

export async function onRequestOptions() {
  return new Response(null, { headers: AUTH_HEADERS });
}

function jsonResp(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: AUTH_HEADERS });
}
