import React, { useState, useEffect, useCallback } from "react";
import styles from "./Profile.module.css";

// Self-service account view: confirms the site recognizes the member's EVE
// character and titles, links their Discord account, and shows whether their
// Discord roles match their in-game titles.
export default function Profile({ auth, discord }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const token = await auth.getAccessToken();
      if (!token) throw new Error("Your EVE session expired — log in again.");
      const res = await fetch("/api/profile", {
        headers: { Authorization: `Bearer ${token}` },
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed to load profile");
      setData(json);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [auth]);

  // Reload on mount and whenever a Discord link just completed.
  useEffect(() => { load(); }, [load, discord?.linkedJustNow]);

  const resync = useCallback(async () => {
    setSyncing(true);
    setSyncMsg(null);
    try {
      const token = await auth.getAccessToken();
      const res = await fetch("/api/profile/sync", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Sync failed");
      setSyncMsg("Roles synced.");
      await load();
    } catch (e) {
      setSyncMsg(e.message);
    } finally {
      setSyncing(false);
    }
  }, [auth, load]);

  const unlink = useCallback(async () => {
    if (!window.confirm("Unlink your Discord account from this character?")) return;
    try {
      const token = await auth.getAccessToken();
      const res = await fetch("/api/discord/link", {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(json.error || "Unlink failed");
      }
      await load();
    } catch (e) {
      setSyncMsg(e.message);
    }
  }, [auth, load]);

  if (loading && !data) return <div className={styles.loading}>LOADING PROFILE...</div>;
  if (error) return <div className={styles.error}>⚠ {error}</div>;
  if (!data) return null;

  const { character, titles, titlesError, discord: link, roles, lastSyncedAt } = data;

  return (
    <div className={styles.profile}>
      <section className={styles.card}>
        <div className={styles.cardHead}>EVE Character</div>
        <div className={styles.charRow}>
          <img
            className={styles.portrait}
            src={`https://images.evetech.net/characters/${character.id}/portrait?size=64`}
            alt=""
          />
          <div>
            <div className={styles.charName}>{character.name}</div>
            <div className={character.inCorp ? styles.ok : styles.bad}>
              {character.inCorp ? "✓ Verified corp member" : "✗ Not in corp"}
            </div>
            {character.militiaName && (
              <div className={styles.muted}>
                Militia: <span className={styles.tag}>{character.militiaName}</span>
              </div>
            )}
          </div>
        </div>
      </section>

      <section className={styles.card}>
        <div className={styles.cardHead}>In-game Titles</div>
        {titlesError === "reauth" ? (
          <div className={styles.notice}>
            <span>Your EVE login predates the titles permission.</span>
            <button className={styles.btn} onClick={auth.login}>Re-login with EVE</button>
          </div>
        ) : titlesError ? (
          <div className={styles.bad}>Could not read titles from EVE right now.</div>
        ) : titles.length ? (
          <div className={styles.tags}>
            {titles.map((t) => (
              <span key={t.title_id} className={styles.tag}>{t.name}</span>
            ))}
          </div>
        ) : (
          <div className={styles.muted}>No titles assigned in-game.</div>
        )}
      </section>

      <section className={styles.card}>
        <div className={styles.cardHead}>Discord</div>
        {discord?.linkError && <div className={styles.bad}>{discord.linkError}</div>}
        {link.linked ? (
          <div className={styles.notice}>
            <span className={styles.ok}>
              ✓ Linked to <strong>{link.username}</strong>
            </span>
            <button className={styles.btnGhost} onClick={unlink}>Unlink</button>
          </div>
        ) : (
          <div className={styles.notice}>
            <span>Discord is not linked yet.</span>
            <button
              className={styles.btn}
              onClick={discord?.linkDiscord}
              disabled={discord?.linking}
            >
              {discord?.linking ? "Linking..." : "Link Discord"}
            </button>
          </div>
        )}
      </section>

      {link.linked && (
        <section className={styles.card}>
          <div className={styles.cardHead}>Discord Roles</div>
          {!roles ? (
            <div className={styles.muted}>No role data.</div>
          ) : !roles.memberFound ? (
            <div className={styles.bad}>
              You're linked, but the bot can't find you in the Discord server —
              make sure you've joined it.
            </div>
          ) : (
            <>
              <div className={roles.inSync ? styles.ok : styles.warn}>
                {roles.inSync
                  ? "✓ Discord matches your titles"
                  : "⚠ Out of sync — hit Re-sync below"}
              </div>
              <table className={styles.roleTable}>
                <thead>
                  <tr>
                    <th>Title / Role</th>
                    <th>Should have</th>
                    <th>On Discord</th>
                  </tr>
                </thead>
                <tbody>
                  {roles.roles.length ? (
                    roles.roles.map((r) => (
                      <tr key={r.roleId}>
                        <td>
                          <span className={styles.kindBadge} data-kind={r.kind}>
                            {r.kind === "militia" ? "militia" : r.kind === "base" ? "base" : "title"}
                          </span>
                          {" "}{r.label}
                        </td>
                        <td>{r.desired ? "yes" : "—"}</td>
                        <td>{r.onDiscord == null ? "?" : r.onDiscord ? "yes" : "—"}</td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td colSpan={3} className={styles.muted}>
                        No roles configured yet.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </>
          )}
          <div className={styles.syncRow}>
            <button className={styles.btn} onClick={resync} disabled={syncing}>
              {syncing ? "Syncing..." : "Re-sync now"}
            </button>
            {lastSyncedAt && (
              <span className={styles.muted}>
                Last synced {new Date(lastSyncedAt).toLocaleString()}
              </span>
            )}
            {syncMsg && <span className={styles.muted}>{syncMsg}</span>}
          </div>
        </section>
      )}
    </div>
  );
}
