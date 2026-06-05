// Discord REST API helpers. Role management is pure REST — no gateway bot is
// needed. The bot token assigns/removes roles; the per-user OAuth code grant
// resolves which Discord account a member is linking.

const DISCORD_API = "https://discord.com/api/v10";

// Must exactly match the redirect registered on the Discord application.
export const DISCORD_REDIRECT_URI = "https://met0.trade/discord/callback";

// fetch wrapper that retries once or twice on a 429 rate-limit. `auth` selects
// the Authorization scheme: { botToken } for guild operations, { bearerToken }
// for the user identity lookup.
const DISCORD_TIMEOUT_MS = 8000;

async function discordFetch(path, init = {}, auth) {
  const headers = { ...(init.headers || {}) };
  if (auth?.botToken) headers.Authorization = `Bot ${auth.botToken}`;
  else if (auth?.bearerToken) headers.Authorization = `Bearer ${auth.bearerToken}`;

  let res;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      res = await fetch(`${DISCORD_API}${path}`, {
        ...init,
        headers,
        signal: AbortSignal.timeout(DISCORD_TIMEOUT_MS),
      });
    } catch (err) {
      // A timeout here is treated like the request failed — surface it to the
      // caller, who already handles thrown errors.
      throw new Error(`Discord ${path} ${err.name === "TimeoutError" ? "timed out" : "failed"}: ${err.message}`);
    }
    if (res.status !== 429) return res;
    const body = await res.clone().json().catch(() => ({}));
    const wait = Math.min(5, Number(body.retry_after) || 1);
    await new Promise((r) => setTimeout(r, wait * 1000));
  }
  return res;
}

// Exchanges an OAuth authorization code for the linked Discord user's identity.
export async function exchangeDiscordCode(env, code) {
  const tokenRes = await discordFetch("/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: DISCORD_REDIRECT_URI,
      client_id: env.DISCORD_CLIENT_ID,
      client_secret: env.DISCORD_CLIENT_SECRET,
    }),
  });
  if (!tokenRes.ok) throw new Error(`token exchange failed (${tokenRes.status})`);
  const tokens = await tokenRes.json();

  const meRes = await discordFetch("/users/@me", {}, { bearerToken: tokens.access_token });
  if (!meRes.ok) throw new Error(`identity lookup failed (${meRes.status})`);
  const me = await meRes.json();
  return {
    id: me.id,
    username: me.global_name || me.username || me.id,
  };
}

// The member's current role IDs, or null if they are not in the guild.
export async function getGuildMember(env, discordUserId) {
  const res = await discordFetch(
    `/guilds/${env.DISCORD_GUILD_ID}/members/${discordUserId}`,
    {},
    { botToken: env.DISCORD_BOT_TOKEN }
  );
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`member lookup failed (${res.status})`);
  const member = await res.json();
  return Array.isArray(member.roles) ? member.roles : [];
}

// Sets the linked member's guild nickname. Pass null to clear.
// Requires the bot to have the "Manage Nicknames" permission AND a role
// positioned above the target user's top role. Discord also refuses to rename
// the guild owner — those cases surface as 403 and the caller treats them as
// non-fatal.
export async function setGuildNickname(env, discordUserId, nickname) {
  const res = await discordFetch(
    `/guilds/${env.DISCORD_GUILD_ID}/members/${discordUserId}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nick: nickname }),
    },
    { botToken: env.DISCORD_BOT_TOKEN }
  );
  if (!res.ok) {
    const err = new Error(`set nickname failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
}

// Discord caps guild nicknames at 32 code points. EVE character names can be
// longer than that once a corp ticker prefix is added, so trim the character
// name (keeping the full "[TICKER] " prefix) and signal the cut with an
// ellipsis. The ellipsis is one code point, so it counts as 1 against the cap.
export function formatEveNickname(ticker, characterName) {
  const name = characterName ?? "";
  const prefix = ticker ? `[${ticker}] ` : "";
  const full = `${prefix}${name}`;
  if (full.length <= 32) return full;
  const room = 32 - prefix.length;
  if (room <= 1) return full.slice(0, 32);
  return prefix + name.slice(0, room - 1) + "…";
}

export async function addGuildRole(env, discordUserId, roleId) {
  const res = await discordFetch(
    `/guilds/${env.DISCORD_GUILD_ID}/members/${discordUserId}/roles/${roleId}`,
    { method: "PUT" },
    { botToken: env.DISCORD_BOT_TOKEN }
  );
  if (!res.ok) throw new Error(`add role ${roleId} failed (${res.status})`);
}

export async function removeGuildRole(env, discordUserId, roleId) {
  const res = await discordFetch(
    `/guilds/${env.DISCORD_GUILD_ID}/members/${discordUserId}/roles/${roleId}`,
    { method: "DELETE" },
    { botToken: env.DISCORD_BOT_TOKEN }
  );
  if (!res.ok) throw new Error(`remove role ${roleId} failed (${res.status})`);
}

// All roles in the guild, used by the admin panel to render role-name labels
// and a "pick a role" dropdown. Up to ~250 roles per guild — one subrequest.
export async function listGuildRoles(env) {
  if (!env.DISCORD_GUILD_ID || !env.DISCORD_BOT_TOKEN) return [];
  const res = await discordFetch(
    `/guilds/${env.DISCORD_GUILD_ID}/roles`,
    {},
    { botToken: env.DISCORD_BOT_TOKEN }
  );
  if (!res.ok) throw new Error(`list roles failed (${res.status})`);
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}
