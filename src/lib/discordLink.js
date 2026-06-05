import { useState, useEffect, useCallback } from "react";

// Discord account linking, mirroring the EVE SSO flow in eveAuth.js. The user
// starts the OAuth from the Profile tab; Discord redirects back to
// /discord/callback, where this hook exchanges the code via /api/discord/link
// (server-side, so the client secret never touches the browser).

const DISCORD_AUTHORIZE = "https://discord.com/oauth2/authorize";
// Must exactly match the redirect registered on the Discord application and the
// DISCORD_REDIRECT_URI constant in functions/api/_discord.js.
const REDIRECT_URI = "https://your-domain.example/discord/callback";
const STATE_KEY = "praxis:discord:state";

export function useDiscordLink(auth) {
  const [config, setConfig] = useState(null);
  const [linkError, setLinkError] = useState(null);
  const [linking, setLinking] = useState(false);
  // Bumped after a successful link so the Profile tab refetches.
  const [linkedJustNow, setLinkedJustNow] = useState(0);

  useEffect(() => {
    fetch("/api/discord/config")
      .then((r) => r.json())
      .then(setConfig)
      .catch(() => {});
  }, []);

  // Handle the Discord OAuth callback once on mount (lands on /discord/callback).
  useEffect(() => {
    if (window.location.pathname !== "/discord/callback") return;

    const params = new URLSearchParams(window.location.search);
    const code = params.get("code");
    const state = params.get("state");
    const oauthErr = params.get("error");
    const stored = sessionStorage.getItem(STATE_KEY);
    sessionStorage.removeItem(STATE_KEY);

    // Clean the URL back to the Profile tab regardless of outcome.
    window.history.replaceState({}, "", "/?tab=profile");

    if (oauthErr) {
      setLinkError(`Discord linking was cancelled (${oauthErr}).`);
      return;
    }
    if (!code || !state || state !== stored) {
      setLinkError("Discord linking failed: state mismatch. Please try again.");
      return;
    }

    setLinking(true);
    (async () => {
      try {
        const token = await auth.getAccessToken();
        if (!token) throw new Error("Your EVE session expired — log in again.");
        const res = await fetch("/api/discord/link", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ code }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Linking failed");
        setLinkedJustNow((n) => n + 1);
      } catch (e) {
        setLinkError(e.message);
      } finally {
        setLinking(false);
      }
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const linkDiscord = useCallback(() => {
    setLinkError(null);
    if (!config?.discordClientId) {
      setLinkError("Discord is not configured — contact the site admin.");
      return;
    }
    const state = crypto.randomUUID();
    sessionStorage.setItem(STATE_KEY, state);
    const params = new URLSearchParams({
      response_type: "code",
      client_id: config.discordClientId,
      scope: "identify",
      state,
      redirect_uri: REDIRECT_URI,
    });
    window.location.href = `${DISCORD_AUTHORIZE}?${params}`;
  }, [config]);

  return { linkDiscord, linking, linkError, linkedJustNow, configReady: !!config };
}
