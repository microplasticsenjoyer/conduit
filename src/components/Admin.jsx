import React, { useState, useEffect, useCallback, useMemo } from "react";
import styles from "./Admin.module.css";
import { showToast } from "../lib/toast.js";
import { MILITIAS } from "../lib/militias.js";

const MILITIA_OPTIONS = Object.entries(MILITIAS).map(([id, name]) => ({ id: Number(id), name }));

// Leadership-only control panel.
//
//   Members   browse every linked account; force-sync, add/remove Discord
//             roles on the fly for an in-flight override.
//   Role Map  edit the title→Discord-role table that drives auto-sync.
//   Admins    list / add / remove who has this access (env-listed admins
//             come from wrangler.jsonc and aren't removable here).
//
// Everything funnels through /api/admin/overview for reads and the three
// action endpoints for writes — see functions/api/admin/*.

const SUBTABS = [
  { value: "members", label: "Members" },
  { value: "roles",   label: "Role Map" },
  { value: "admins",  label: "Admins" },
];

export default function Admin({ auth, sub, onSubChange }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const token = await auth.getAccessToken();
      const r = await fetch("/api/admin/overview", {
        headers: { Authorization: `Bearer ${token}` },
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Failed to load admin data");
      setData(j);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [auth]);

  useEffect(() => { load(); }, [load]);

  if (loading && !data) return <div className={styles.loading}>LOADING ADMIN PANEL...</div>;
  if (error) {
    return (
      <div className={styles.admin}>
        <div className={styles.error}>⚠ {error}</div>
      </div>
    );
  }
  if (!data) return null;

  return (
    <div className={styles.admin}>
      <div className={styles.subtabs} role="tablist">
        {SUBTABS.map((t) => (
          <button
            key={t.value}
            type="button"
            role="tab"
            aria-selected={sub === t.value}
            className={`${styles.subtab} ${sub === t.value ? styles.subtabActive : ""}`}
            onClick={() => onSubChange(t.value)}
          >
            {t.label}
          </button>
        ))}
      </div>
      {sub === "members" && <MembersPanel auth={auth} data={data} onReload={load} />}
      {sub === "roles"   && <RolesPanel   auth={auth} data={data} onReload={load} />}
      {sub === "admins"  && <AdminsPanel  auth={auth} data={data} onReload={load} />}
    </div>
  );
}

// ── Members ────────────────────────────────────────────────────────────────

function MembersPanel({ auth, data, onReload }) {
  const [filter, setFilter] = useState("");
  const [busyId, setBusyId] = useState(null);
  const [syncingAll, setSyncingAll] = useState(false);
  const [syncProgress, setSyncProgress] = useState(null); // { done, total, failed }

  const roleById = useMemo(() => {
    const m = new Map();
    for (const r of data.guildRoles) m.set(r.id, r);
    return m;
  }, [data.guildRoles]);
  const roleName = (id) => roleById.get(id)?.name ?? id;

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return data.members;
    return data.members.filter((m) =>
      (m.characterName ?? "").toLowerCase().includes(q) ||
      (m.discordUsername ?? "").toLowerCase().includes(q)
    );
  }, [data.members, filter]);

  // Bare request — POSTs one member action and throws on a non-ok response.
  // No toast/reload so it can be reused by both the per-row buttons and Sync All.
  const postMemberAction = async (characterId, action, extra = {}) => {
    const token = await auth.getAccessToken();
    const r = await fetch(`/api/admin/members/${characterId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ action, ...extra }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || "Action failed");
    return j;
  };

  // Pull fresh in-game titles for the whole roster via a Director token before
  // syncing — otherwise syncDiscordUser reconciles against stale cached titles
  // and never picks up newly-granted titles. Returns silently on success; on a
  // missing-scope response it toasts guidance but lets the sync proceed against
  // cached titles (best-effort, never blocks the sync).
  const refreshTitles = async () => {
    try {
      const token = await auth.getAccessToken();
      const r = await fetch("/api/admin/refresh-titles", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      });
      const j = await r.json().catch(() => ({}));
      if (j?.needsReauth) showToast(j.error);
    } catch {
      /* best-effort — fall through to sync against cached titles */
    }
  };

  const callAction = async (characterId, action, extra = {}) => {
    setBusyId(characterId);
    try {
      if (action === "sync") await refreshTitles();
      await postMemberAction(characterId, action, extra);
      showToast(action === "sync" ? "Synced" : action === "addRole" ? "Role added" : "Role removed");
      await onReload();
    } catch (e) {
      showToast(e.message);
    } finally {
      setBusyId(null);
    }
  };

  // Sync All — fan out the per-member force-sync across every linked Discord
  // account. Members are deduped by discordUserId (main + alts share one Discord
  // account, and the endpoint syncs the whole account from any one of its
  // characters), then run through a small concurrency pool so each sync keeps
  // its own Cloudflare subrequest budget rather than blowing the per-invocation
  // cap in one server-side loop.
  const handleSyncAll = async () => {
    if (syncingAll) return;
    const seen = new Set();
    const targets = [];
    for (const m of data.members) {
      if (!m.discordUserId || seen.has(m.discordUserId)) continue;
      seen.add(m.discordUserId);
      targets.push(m.characterId);
    }
    if (!targets.length) { showToast("No linked accounts to sync"); return; }

    setSyncingAll(true);
    setSyncProgress({ done: 0, total: targets.length, failed: 0 });

    // Refresh every member's titles once up front (one Director-token ESI call)
    // so the per-member syncs below reconcile against fresh data.
    await refreshTitles();

    let failed = 0;
    let next = 0;
    const POOL = 4;
    const worker = async () => {
      while (next < targets.length) {
        const characterId = targets[next++];
        try {
          await postMemberAction(characterId, "sync");
        } catch {
          failed++;
        }
        setSyncProgress((p) => ({ ...p, done: p.done + 1, failed }));
      }
    };

    try {
      await Promise.all(
        Array.from({ length: Math.min(POOL, targets.length) }, worker)
      );
      const ok = targets.length - failed;
      showToast(
        failed
          ? `Synced ${ok}/${targets.length} accounts (${failed} failed)`
          : `Synced ${ok} account${ok === 1 ? "" : "s"}`
      );
      await onReload();
    } finally {
      setSyncingAll(false);
      setSyncProgress(null);
    }
  };

  return (
    <div className={styles.panel}>
      <div className={styles.toolbar}>
        <input
          className={styles.input}
          placeholder="Filter by character or Discord username..."
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <span className={styles.muted}>
          {filtered.length} of {data.members.length}
        </span>
        <button
          className={styles.btn}
          disabled={syncingAll}
          onClick={handleSyncAll}
          title="Force a Discord role sync for every linked account"
        >
          {syncingAll
            ? `Syncing ${syncProgress?.done ?? 0}/${syncProgress?.total ?? 0}…`
            : "Sync all"}
        </button>
      </div>

      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Character</th>
              <th>Discord</th>
              <th>Corp</th>
              <th>Militia</th>
              <th>Roles applied</th>
              <th>Last sync</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((m) => (
              <MemberRow
                key={m.characterId}
                m={m}
                busy={busyId === m.characterId || syncingAll}
                guildRoles={data.guildRoles}
                roleName={roleName}
                onAction={callAction}
              />
            ))}
            {!filtered.length && (
              <tr>
                <td colSpan={7} className={styles.muted}>No members match that filter.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function MemberRow({ m, busy, guildRoles, roleName, onAction }) {
  const [pickerOpen, setPickerOpen] = useState(false);

  const pickableRoles = useMemo(() => {
    const applied = new Set(m.appliedRoles ?? []);
    return guildRoles
      .filter((r) => r.name !== "@everyone" && !applied.has(r.id))
      .sort((a, b) => b.position - a.position);
  }, [guildRoles, m.appliedRoles]);

  return (
    <tr>
      <td>
        <div className={styles.charCell}>
          <img
            className={styles.portraitSm}
            src={`https://images.evetech.net/characters/${m.characterId}/portrait?size=32`}
            alt=""
          />
          <span>{m.characterName}</span>
        </div>
      </td>
      <td>{m.discordUsername ?? <span className={styles.muted}>—</span>}</td>
      <td>
        {m.inCorp
          ? <span className={styles.ok}>✓</span>
          : <span className={styles.muted}>—</span>}
      </td>
      <td>
        {m.factionId
          ? MILITIAS[m.factionId] ?? `Faction ${m.factionId}`
          : <span className={styles.muted}>—</span>}
      </td>
      <td>
        <div className={styles.chips}>
          {(m.appliedRoles ?? []).map((id) => (
            <span key={id} className={styles.chip}>
              {roleName(id)}
              {m.discordUserId && (
                <button
                  className={styles.chipX}
                  disabled={busy}
                  title="Remove role"
                  onClick={() => onAction(m.characterId, "removeRole", { roleId: id })}
                >×</button>
              )}
            </span>
          ))}
          {m.discordUserId && (
            <span className={styles.pickerRoot}>
              <button
                className={styles.btnSm}
                disabled={busy}
                onClick={() => setPickerOpen((o) => !o)}
              >+ role</button>
              {pickerOpen && (
                <div className={styles.picker} role="menu">
                  {pickableRoles.length ? (
                    pickableRoles.map((r) => (
                      <button
                        key={r.id}
                        role="menuitem"
                        className={styles.pickerItem}
                        onClick={() => {
                          setPickerOpen(false);
                          onAction(m.characterId, "addRole", { roleId: r.id });
                        }}
                      >
                        {r.name}
                      </button>
                    ))
                  ) : (
                    <div className={styles.pickerEmpty}>No more roles to add.</div>
                  )}
                </div>
              )}
            </span>
          )}
          {!m.appliedRoles?.length && !m.discordUserId && (
            <span className={styles.muted}>not linked</span>
          )}
        </div>
      </td>
      <td className={styles.muted}>
        {m.lastSyncedAt ? new Date(m.lastSyncedAt).toLocaleString() : "—"}
      </td>
      <td>
        {m.discordUserId && (
          <button
            className={styles.btnSm}
            disabled={busy}
            onClick={() => onAction(m.characterId, "sync")}
          >{busy ? "..." : "Sync"}</button>
        )}
      </td>
    </tr>
  );
}

// ── Role Map ───────────────────────────────────────────────────────────────

function RolesPanel({ auth, data, onReload }) {
  // Title mappings: granted to corp members holding the named in-game title.
  const [titleName, setTitleName] = useState("");
  const [titleRoleId, setTitleRoleId] = useState("");
  const [titleBusy, setTitleBusy] = useState(false);
  // Militia mappings: granted to non-corp linked characters enlisted in the
  // selected militia. Corp members never receive militia roles.
  const [factionId, setFactionId] = useState("");
  const [militiaRoleId, setMilitiaRoleId] = useState("");
  const [militiaBusy, setMilitiaBusy] = useState(false);
  // Guest role: stored as a sentinel row in title_role_map with
  // title_name === "__guest__". Granted to every linked non-corp character,
  // stacking with any militia role they may also receive.
  const existingGuest = (data.titleRoleMap ?? []).find((m) => m.titleName === "__guest__");
  const [guestRoleId, setGuestRoleId] = useState(existingGuest?.discordRoleId ?? "");
  const [guestBusy, setGuestBusy] = useState(false);

  const roleById = useMemo(() => {
    const m = new Map();
    for (const r of data.guildRoles) m.set(r.id, r);
    return m;
  }, [data.guildRoles]);

  const sortedRoles = useMemo(() =>
    data.guildRoles
      .filter((r) => r.name !== "@everyone")
      .sort((a, b) => b.position - a.position),
    [data.guildRoles]);

  // Shared request helper — every form here just POSTs/DELETEs and reloads.
  const apiCall = async (url, init, okMsg, onSuccess) => {
    try {
      const token = await auth.getAccessToken();
      const headers = { ...(init.headers ?? {}), Authorization: `Bearer ${token}` };
      const r = await fetch(url, { ...init, headers });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || "Request failed");
      }
      if (onSuccess) onSuccess();
      showToast(okMsg);
      await onReload();
    } catch (e) {
      showToast(e.message);
    }
  };

  const saveTitle = async () => {
    if (!titleRoleId) { showToast("Pick a Discord role"); return; }
    setTitleBusy(true);
    await apiCall(
      "/api/admin/role-map",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          titleName: titleName.trim() || null,
          discordRoleId: titleRoleId,
        }),
      },
      "Saved",
      () => { setTitleName(""); setTitleRoleId(""); }
    );
    setTitleBusy(false);
  };

  const removeTitle = async (id) => {
    if (!window.confirm("Remove this title mapping?")) return;
    await apiCall(
      `/api/admin/role-map?id=${encodeURIComponent(id)}`,
      { method: "DELETE" },
      "Removed"
    );
  };

  const saveMilitia = async () => {
    if (!factionId) { showToast("Pick a militia"); return; }
    if (!militiaRoleId) { showToast("Pick a Discord role"); return; }
    setMilitiaBusy(true);
    await apiCall(
      "/api/admin/militia-map",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          factionId: Number(factionId),
          discordRoleId: militiaRoleId,
        }),
      },
      "Saved",
      () => { setFactionId(""); setMilitiaRoleId(""); }
    );
    setMilitiaBusy(false);
  };

  const saveGuest = async () => {
    if (!guestRoleId) { showToast("Pick a Discord role"); return; }
    setGuestBusy(true);
    await apiCall(
      "/api/admin/role-map",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          titleName: "__guest__",
          discordRoleId: guestRoleId,
        }),
      },
      "Saved"
    );
    setGuestBusy(false);
  };

  const removeGuest = async () => {
    if (!existingGuest) return;
    if (!window.confirm("Remove the guest role mapping?")) return;
    setGuestBusy(true);
    await apiCall(
      `/api/admin/role-map?id=${encodeURIComponent(existingGuest.id)}`,
      { method: "DELETE" },
      "Removed",
      () => setGuestRoleId("")
    );
    setGuestBusy(false);
  };

  const removeMilitia = async (id) => {
    if (!window.confirm("Remove this militia mapping?")) return;
    await apiCall(
      `/api/admin/militia-map?id=${encodeURIComponent(id)}`,
      { method: "DELETE" },
      "Removed"
    );
  };

  return (
    <div className={styles.panel}>
      <div className={styles.sectionHead}>Title mappings</div>
      <div className={styles.helpText}>
        Granted to corp members holding the named in-game title.
        Leave the title blank to set the base "verified member" role.
      </div>
      <div className={styles.formRow}>
        <input
          className={styles.input}
          placeholder="Title name — blank for base 'verified member' role"
          value={titleName}
          onChange={(e) => setTitleName(e.target.value)}
        />
        <select
          className={styles.input}
          value={titleRoleId}
          onChange={(e) => setTitleRoleId(e.target.value)}
        >
          <option value="">Pick a Discord role...</option>
          {sortedRoles.map((r) => (
            <option key={r.id} value={r.id}>{r.name}</option>
          ))}
        </select>
        <button className={styles.btn} disabled={titleBusy} onClick={saveTitle}>
          {titleBusy ? "Saving..." : "Save mapping"}
        </button>
      </div>

      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr><th>Title</th><th>Discord role</th><th></th></tr>
          </thead>
          <tbody>
            {data.titleRoleMap.map((m) => (
              <tr key={m.id}>
                <td>
                  {m.titleName == null ? (
                    <em className={styles.muted}>(base "verified member")</em>
                  ) : m.titleName === "__guest__" ? (
                    <em className={styles.muted}>(guest)</em>
                  ) : (
                    m.titleName
                  )}
                </td>
                <td>{roleById.get(m.discordRoleId)?.name ?? m.discordRoleId}</td>
                <td>
                  <button className={styles.btnGhost} onClick={() => removeTitle(m.id)}>
                    Remove
                  </button>
                </td>
              </tr>
            ))}
            {!data.titleRoleMap.length && (
              <tr>
                <td colSpan={3} className={styles.muted}>
                  No title mappings yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className={styles.sectionHead}>Guest role</div>
      <div className={styles.helpText}>
        Granted to every linked non-corp character so they can reach
        guest-only Discord channels. Stacks with any matching militia role
        below. Leave unset to grant no role at all to non-corp users.
      </div>
      <div className={styles.formRow}>
        <select
          className={styles.input}
          value={guestRoleId}
          onChange={(e) => setGuestRoleId(e.target.value)}
        >
          <option value="">Pick a Discord role...</option>
          {sortedRoles.map((r) => (
            <option key={r.id} value={r.id}>{r.name}</option>
          ))}
        </select>
        <button className={styles.btn} disabled={guestBusy} onClick={saveGuest}>
          {guestBusy ? "Saving..." : existingGuest ? "Update role" : "Save mapping"}
        </button>
        {existingGuest && (
          <button className={styles.btnGhost} disabled={guestBusy} onClick={removeGuest}>
            Remove
          </button>
        )}
      </div>

      <div className={styles.sectionHead}>Militia mappings</div>
      <div className={styles.helpText}>
        Granted to linked non-corp characters enlisted in the selected militia.
        Corp members never receive militia roles, even if their EVE character
        is enlisted.
      </div>
      <div className={styles.formRow}>
        <select
          className={styles.input}
          value={factionId}
          onChange={(e) => setFactionId(e.target.value)}
        >
          <option value="">Pick a militia...</option>
          {MILITIA_OPTIONS.map((o) => (
            <option key={o.id} value={o.id}>{o.name}</option>
          ))}
        </select>
        <select
          className={styles.input}
          value={militiaRoleId}
          onChange={(e) => setMilitiaRoleId(e.target.value)}
        >
          <option value="">Pick a Discord role...</option>
          {sortedRoles.map((r) => (
            <option key={r.id} value={r.id}>{r.name}</option>
          ))}
        </select>
        <button className={styles.btn} disabled={militiaBusy} onClick={saveMilitia}>
          {militiaBusy ? "Saving..." : "Save mapping"}
        </button>
      </div>

      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr><th>Militia</th><th>Discord role</th><th></th></tr>
          </thead>
          <tbody>
            {(data.militiaRoleMap ?? []).map((m) => (
              <tr key={m.id}>
                <td>{MILITIAS[m.factionId] ?? `Faction ${m.factionId}`}</td>
                <td>{roleById.get(m.discordRoleId)?.name ?? m.discordRoleId}</td>
                <td>
                  <button className={styles.btnGhost} onClick={() => removeMilitia(m.id)}>
                    Remove
                  </button>
                </td>
              </tr>
            ))}
            {!(data.militiaRoleMap?.length) && (
              <tr>
                <td colSpan={3} className={styles.muted}>
                  No militia mappings yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Admins ─────────────────────────────────────────────────────────────────

function AdminsPanel({ auth, data, onReload }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  const add = async () => {
    if (!name.trim()) return;
    setBusy(true);
    try {
      const token = await auth.getAccessToken();
      const r = await fetch("/api/admin/admins", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ characterName: name.trim() }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Add failed");
      setName("");
      showToast(`Added ${j.admin.characterName}`);
      await onReload();
    } catch (e) {
      showToast(e.message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (a) => {
    if (!window.confirm(`Remove ${a.characterName} as admin?`)) return;
    try {
      const token = await auth.getAccessToken();
      const r = await fetch(`/api/admin/admins/${a.characterId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || "Delete failed");
      }
      showToast("Removed");
      await onReload();
    } catch (e) {
      showToast(e.message);
    }
  };

  return (
    <div className={styles.panel}>
      <div className={styles.formRow}>
        <input
          className={styles.input}
          placeholder="EVE character name to add as admin"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") add(); }}
        />
        <button className={styles.btn} disabled={busy || !name.trim()} onClick={add}>
          {busy ? "Adding..." : "Add admin"}
        </button>
      </div>

      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Character</th><th>Source</th><th>Granted</th><th></th>
            </tr>
          </thead>
          <tbody>
            {data.admins.map((a) => (
              <tr key={a.characterId}>
                <td>
                  <div className={styles.charCell}>
                    <img
                      className={styles.portraitSm}
                      src={`https://images.evetech.net/characters/${a.characterId}/portrait?size=32`}
                      alt=""
                    />
                    <span>{a.characterName}</span>
                  </div>
                </td>
                <td>
                  {a.source === "env"
                    ? <span className={styles.muted}>env (wrangler.jsonc)</span>
                    : <span className={styles.ok}>db</span>}
                </td>
                <td className={styles.muted}>
                  {a.source === "db" && a.grantedAt
                    ? `${new Date(a.grantedAt).toLocaleDateString()} by ${a.grantedByName ?? "?"}`
                    : "—"}
                </td>
                <td>
                  {a.source === "db" && (
                    <button className={styles.btnGhost} onClick={() => remove(a)}>
                      Remove
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {!data.admins.length && (
              <tr>
                <td colSpan={4} className={styles.muted}>No admins listed.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
