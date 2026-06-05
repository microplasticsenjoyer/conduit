// Exposes the public Discord OAuth config to the frontend. The client secret
// and bot token are never sent here — only the client ID (needed to build the
// authorize URL) and the guild ID.

const HEADERS = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" };

export async function onRequestGet({ env }) {
  return new Response(
    JSON.stringify({
      discordClientId: env.DISCORD_CLIENT_ID || null,
      guildId: env.DISCORD_GUILD_ID || null,
    }),
    { headers: HEADERS }
  );
}
