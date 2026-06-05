import React, { useState, useEffect } from "react";
import Header from "./components/shared/Header.jsx";
import PasteInput from "./components/appraise/PasteInput.jsx";
import ResultsTable from "./components/appraise/ResultsTable.jsx";
import MultiStationCompare from "./components/appraise/MultiStationCompare.jsx";
import Summary from "./components/appraise/Summary.jsx";
import ShareBar from "./components/appraise/ShareBar.jsx";
import Tabs from "./components/shared/Tabs.jsx";
import LpStore from "./components/LpStore.jsx";
import StationPicker, { readStoredStationId } from "./components/appraise/StationPicker.jsx";
import AppraisalHistory from "./components/appraise/AppraisalHistory.jsx";
import Inventory from "./components/Inventory.jsx";
import SrpTab from "./components/SrpTab.jsx";
import AllianceFinances from "./components/finances/AllianceFinances.jsx";
import AuthGate from "./components/shared/AuthGate.jsx";
import Profile from "./components/Profile.jsx";
import Admin from "./components/Admin.jsx";
import Toast from "./components/shared/Toast.jsx";
import { addHistoryEntry } from "./lib/history.js";
import { useEveAuth } from "./lib/eveAuth.js";
import { useDiscordLink } from "./lib/discordLink.js";
import { useIsAdmin } from "./lib/admin.js";
import { useSyncedPrefs } from "./lib/userPrefs.js";
import styles from "./App.module.css";

const DEFAULT_STATION = 60003760;

// Profile and Admin live in the Header's character-chip dropdown, not on the
// tab bar. Their tab values are still valid (URLs like ?tab=profile keep
// working) so the dropdown just calls handleTabChange like any other nav.
const TAB_OPTIONS = [
  { value: "appraise", label: "Appraise" },
  { value: "lp", label: "LP Store" },
  { value: "srp", label: "SRP", highlight: true },
  { value: "inventory", label: "Inventory" },
  { value: "finances", label: "Alliance Finances" },
];

const VALID_TABS = ["lp", "inventory", "srp", "finances", "profile", "admin"];
const VALID_SUBS = ["trustfund", "income", "projects"];
const VALID_INV_SUBS = ["doctrines", "status", "sales"];
const VALID_ADMIN_SUBS = ["members", "roles", "admins"];

const APPRAISE_PREFIX = "praxis:appraise:";
function readAppraiseFee(key, fallback) {
  try {
    const v = parseFloat(localStorage.getItem(APPRAISE_PREFIX + key) ?? "");
    return Number.isFinite(v) && v >= 0 ? v : fallback;
  } catch { return fallback; }
}

export default function App() {
  const auth = useEveAuth();
  const prefsSync = useSyncedPrefs(auth);
  const discord = useDiscordLink(auth);
  const admin = useIsAdmin(auth);
  const [results, setResults] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [loadingShared, setLoadingShared] = useState(false);
  const [stationId, setStationId] = useState(() => readStoredStationId(DEFAULT_STATION));
  // Bumped to re-render AppraisalHistory after we record a new entry.
  const [historyVersion, setHistoryVersion] = useState(0);
  const [tab, setTab] = useState(() => {
    // The Discord OAuth callback lands on /discord/callback — surface Profile
    // immediately; useDiscordLink will then clean the URL.
    if (window.location.pathname === "/discord/callback") return "profile";
    const params = new URLSearchParams(window.location.search);
    if (params.get("a")) return "appraise";
    const t = params.get("tab") ?? params.get("returnTab");
    // Back-compat: legacy ?tab=fund and ?tab=projects map into Alliance Finances.
    if (t === "fund" || t === "projects") return "finances";
    if (VALID_TABS.includes(t)) return t;
    return "appraise";
  });
  const [appraiseFees, setAppraiseFees] = useState(() => ({
    salesTax: readAppraiseFee("salesTax", 4.5),
    brokerFee: readAppraiseFee("brokerFee", 2.5),
  }));
  const [financesSub, setFinancesSub] = useState(() => {
    const params = new URLSearchParams(window.location.search);
    const t = params.get("tab") ?? params.get("returnTab");
    const explicit = params.get("sub");
    if (explicit && VALID_SUBS.includes(explicit)) return explicit;
    // Legacy URL hooks: ?tab=fund -> trustfund, ?tab=projects -> projects.
    if (t === "fund") return "trustfund";
    if (t === "projects") return "projects";
    return "income";
  });
  const [inventorySub, setInventorySub] = useState(() => {
    const params = new URLSearchParams(window.location.search);
    if ((params.get("tab") ?? params.get("returnTab")) !== "inventory") return "doctrines";
    const s = params.get("sub");
    return VALID_INV_SUBS.includes(s) ? s : "doctrines";
  });
  const [adminSub, setAdminSub] = useState(() => {
    const params = new URLSearchParams(window.location.search);
    if ((params.get("tab") ?? params.get("returnTab")) !== "admin") return "members";
    const s = params.get("sub");
    return VALID_ADMIN_SUBS.includes(s) ? s : "members";
  });

  function handleFinancesSubChange(next) {
    setFinancesSub(next);
    if (tab === "finances") {
      const url = next === "income" ? `?tab=finances` : `?tab=finances&sub=${next}`;
      window.history.replaceState({}, "", url);
    }
  }

  function handleInventorySubChange(next) {
    setInventorySub(next);
    if (tab === "inventory") {
      const url = next === "doctrines" ? `?tab=inventory` : `?tab=inventory&sub=${next}`;
      window.history.replaceState({}, "", url);
    }
  }

  function handleAdminSubChange(next) {
    setAdminSub(next);
    if (tab === "admin") {
      const url = next === "members" ? `?tab=admin` : `?tab=admin&sub=${next}`;
      window.history.replaceState({}, "", url);
    }
  }

  // On load, check if URL has a slug (e.g. /?a=x7k2p)
  useEffect(() => {
    const slug = new URLSearchParams(window.location.search).get("a");
    if (slug) loadShared(slug);
  }, []);

  // After server prefs hydrate, re-read localStorage so the in-memory copies
  // pick up any server-overridden values (default station + tax/broker fees).
  useEffect(() => {
    if (!prefsSync.hydrated) return;
    setStationId(readStoredStationId(DEFAULT_STATION));
    setAppraiseFees({
      salesTax: readAppraiseFee("salesTax", 4.5),
      brokerFee: readAppraiseFee("brokerFee", 2.5),
    });
  }, [prefsSync.hydrated]);

  // Non-corp authenticated users are restricted to the Profile tab — every
  // other endpoint already 403s them, but the UI shouldn't dangle the tabs.
  // Clamping in an effect catches bookmarks and URL edits too.
  useEffect(() => {
    if (auth.isAuthReady && auth.eveAuth && !auth.isCorpMember && tab !== "profile") {
      setTab("profile");
      window.history.replaceState({}, "", "?tab=profile");
    }
  }, [auth.isAuthReady, auth.eveAuth, auth.isCorpMember, tab]);

  function handleTabChange(next) {
    setTab(next);
    let url;
    if (next === "appraise") {
      url = window.location.pathname;
    } else if (next === "finances") {
      url = financesSub === "income" ? `?tab=finances` : `?tab=finances&sub=${financesSub}`;
    } else if (next === "inventory") {
      url = inventorySub === "doctrines" ? `?tab=inventory` : `?tab=inventory&sub=${inventorySub}`;
    } else if (next === "admin") {
      url = adminSub === "members" ? `?tab=admin` : `?tab=admin&sub=${adminSub}`;
    } else if (VALID_TABS.includes(next)) {
      url = `?tab=${next}`;
    } else {
      url = window.location.pathname;
    }
    window.history.replaceState({}, "", url);
  }

  async function loadShared(slug) {
    setLoadingShared(true);
    setError(null);
    try {
      const res = await fetch(`/api/appraisal/${slug}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Not found");
      setResults({ ...data, slug });
      // Record locally so corp mates can find this appraisal in their history
      // even if they only ever opened a shared link.
      addHistoryEntry({
        slug,
        totalBuy: data.totalBuy,
        totalSell: data.totalSell,
        itemCount: data.items?.length ?? data.itemCount ?? 0,
        stationId: data.stationId ?? null,
        createdAt: data.createdAt,
      });
      setHistoryVersion((v) => v + 1);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoadingShared(false);
    }
  }

  // Programmatic open used by the history panel: sets the URL slug + loads.
  function openSlug(slug) {
    window.history.replaceState({}, "", `?a=${slug}`);
    loadShared(slug);
  }

  async function handleAppraise(text, overrideStationId) {
    setLoading(true);
    setError(null);
    setResults(null);
    // Clear slug from URL without reload
    window.history.replaceState({}, "", window.location.pathname);

    try {
      const res = await fetch("/api/appraise", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, stationId: overrideStationId ?? stationId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Request failed");
      // Update URL to shareable link
      window.history.replaceState({}, "", `?a=${data.slug}`);
      setResults(data);
      addHistoryEntry({
        slug: data.slug,
        totalBuy: data.totalBuy,
        totalSell: data.totalSell,
        itemCount: data.items?.length ?? 0,
        stationId: data.stationId ?? null,
        createdAt: data.createdAt,
      });
      setHistoryVersion((v) => v + 1);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  function handleClear() {
    setResults(null);
    setError(null);
    window.history.replaceState({}, "", window.location.pathname);
  }

  if (!auth.isAuthReady) {
    return (
      <div className={styles.app}>
        <Header auth={auth} />
        <main className={styles.main}>
          <div className={styles.loading}>LOADING...</div>
        </main>
      </div>
    );
  }

  if (!auth.eveAuth) {
    return (
      <div className={styles.app}>
        <Header auth={auth} isAdmin={admin.isAdmin} onNavigate={handleTabChange} />
        <main className={styles.main}>
          <AuthGate
            eveAuth={auth.eveAuth}
            ssoError={auth.ssoError}
            onLogin={auth.login}
            onLogout={auth.logout}
          />
        </main>
      </div>
    );
  }

  return (
    <div className={styles.app}>
      <Header auth={auth} isAdmin={admin.isAdmin} onNavigate={handleTabChange} />
      <main className={`${styles.main} ${(tab === "lp" || tab === "inventory" || tab === "srp" || tab === "finances" || tab === "admin") ? styles.mainWide : ""}`}>
        {auth.isCorpMember && <Tabs value={tab} onChange={handleTabChange} options={TAB_OPTIONS} />}
        {tab === "appraise" && (
          loadingShared ? (
            <div className={styles.loading}>LOADING APPRAISAL...</div>
          ) : (
            <>
              <div className={styles.stationRow}>
                <StationPicker
                  value={stationId}
                  onChange={(id) => {
                    setStationId(id);
                    prefsSync.pushPrefs({ defaultStationId: id });
                    if (results?.rawInput && !loading) handleAppraise(results.rawInput, id);
                  }}
                />
              </div>
              {!results?.slug && (
                <AppraisalHistory onOpen={openSlug} refreshKey={historyVersion} />
              )}
              <PasteInput
                onAppraise={handleAppraise}
                onClear={handleClear}
                loading={loading}
                prefill={results?.rawInput}
              />
              {error && <div className={styles.error}>⚠ {error}</div>}
              {results && (
                <>
                  <ShareBar slug={results.slug} createdAt={results.createdAt} />
                  <Summary
                    totalBuy={Number(results.totalBuy)}
                    totalSell={Number(results.totalSell)}
                    count={results.items.length}
                    pricesUpdatedAt={results.pricesUpdatedAt ?? null}
                    stationId={results.stationId ?? null}
                    onFeesChange={(fees) => { setAppraiseFees(fees); prefsSync.pushPrefs(fees); }}
                    totalVolume={(() => {
                      let vol = null;
                      for (const item of results.items) {
                        if (item.volumeEach != null) vol = (vol ?? 0) + item.quantity * item.volumeEach;
                      }
                      return vol;
                    })()}
                  />
                  <ResultsTable items={results.items} fees={appraiseFees} stationId={results.stationId ?? stationId} />
                  <MultiStationCompare items={results.items} />
                </>
              )}
            </>
          )
        )}
        {tab === "lp"        && <LpStore onPrefsChange={prefsSync.pushPrefs} />}
        {tab === "inventory" && <Inventory auth={auth} sub={inventorySub} onSubChange={handleInventorySubChange} />}
        {tab === "srp"       && <SrpTab auth={auth} />}
        {tab === "finances"  && (
          <AllianceFinances
            auth={auth}
            isAdmin={admin.isAdmin}
            sub={financesSub}
            onSubChange={handleFinancesSubChange}
          />
        )}
        {tab === "profile"   && <Profile auth={auth} discord={discord} />}
        {tab === "admin"     && <Admin auth={auth} sub={adminSub} onSubChange={handleAdminSubChange} />}
      </main>
      <footer className={styles.footer}>
        <span>praxis v{__APP_VERSION__}</span>
        <span>·</span>
        <span>Prices: <a href="https://market.fuzzwork.co.uk/" target="_blank" rel="noopener noreferrer">Fuzzwork</a> · <a href="https://esi.evetech.net/" target="_blank" rel="noopener noreferrer">EVE ESI</a></span>
        <span>·</span>
        <a href="https://auth.zuck.zone" target="_blank" rel="noopener noreferrer">auth.zuck.zone</a>
      </footer>
      <Toast />
    </div>
  );
}
