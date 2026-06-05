const HEADERS = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" };

// Exposes public EVE SSO config to the frontend. The client secret is never
// exposed here — PKCE flow requires only the client ID on the browser side.
export async function onRequestGet({ env }) {
  return new Response(
    JSON.stringify({
      eveClientId: env.EVE_CLIENT_ID ?? null,
      corpId: env.EVE_CORP_ID ?? null,
    }),
    { headers: HEADERS }
  );
}
