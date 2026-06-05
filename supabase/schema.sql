-- ============================================================================
-- Conduit — consolidated schema
-- ============================================================================
-- This is a single-file snapshot of the full database schema. Running it once
-- against a fresh Supabase project produces exactly the same result as applying
-- every file in supabase/migrations/ in chronological order — the incremental
-- `add column` migrations have been folded into their CREATE TABLE statements,
-- and the one-off `TRUNCATE lp_offers` data fix (a production-only cleanup) is
-- omitted because it's a no-op on an empty database.
--
-- Use this for first-time setup (paste into the Supabase SQL editor, or
-- `psql "$DATABASE_URL" -f supabase/schema.sql`).
--
-- The timestamped files in supabase/migrations/ remain the source of truth and
-- the incremental history; keep adding new migrations there. If you change the
-- schema, either regenerate this file or stop relying on it and apply
-- migrations individually.
--
-- Safe to re-run: every object uses IF NOT EXISTS / OR REPLACE where possible.
-- ============================================================================

-- Shared trigger: bump updated_at on row UPDATE (used by the cache tables).
CREATE OR REPLACE FUNCTION touch_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$;


-- ── Appraisal & pricing caches ──────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS item_cache (
  type_id     INTEGER PRIMARY KEY,
  name        TEXT    NOT NULL UNIQUE,
  name_lower  TEXT    NOT NULL UNIQUE,
  category_id INTEGER,                       -- EVE category for LP Store filter chips
  volume      NUMERIC,                        -- packaged m³ for cargo volume display
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_item_cache_name_lower ON item_cache (name_lower);

CREATE TABLE IF NOT EXISTS price_cache (
  type_id     INTEGER PRIMARY KEY REFERENCES item_cache (type_id) ON DELETE CASCADE,
  sell_min    NUMERIC(20, 2) NOT NULL DEFAULT 0,
  sell_max    NUMERIC(20, 2) NOT NULL DEFAULT 0,
  buy_min     NUMERIC(20, 2) NOT NULL DEFAULT 0,
  buy_max     NUMERIC(20, 2) NOT NULL DEFAULT 0,
  sell_volume BIGINT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS appraisals (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  slug        TEXT        NOT NULL UNIQUE,
  raw_input   TEXT        NOT NULL,
  total_buy   NUMERIC(20, 2) NOT NULL DEFAULT 0,
  total_sell  NUMERIC(20, 2) NOT NULL DEFAULT 0,
  item_count  INTEGER     NOT NULL DEFAULT 0,
  station_id  INTEGER     NOT NULL DEFAULT 60003760,   -- trading hub priced against (default Jita 4-4)
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_appraisals_slug ON appraisals (slug);
CREATE INDEX IF NOT EXISTS idx_appraisals_created_at ON appraisals (created_at DESC);

CREATE TABLE IF NOT EXISTS appraisal_items (
  id            BIGSERIAL   PRIMARY KEY,
  appraisal_id  UUID        NOT NULL REFERENCES appraisals (id) ON DELETE CASCADE,
  type_id       INTEGER,
  name          TEXT        NOT NULL,
  quantity      INTEGER     NOT NULL DEFAULT 1,
  sell_each     NUMERIC(20, 2) NOT NULL DEFAULT 0,
  buy_each      NUMERIC(20, 2) NOT NULL DEFAULT 0,
  sell_total    NUMERIC(20, 2) NOT NULL DEFAULT 0,
  buy_total     NUMERIC(20, 2) NOT NULL DEFAULT 0,
  unknown       BOOLEAN     NOT NULL DEFAULT false
);

CREATE INDEX IF NOT EXISTS idx_appraisal_items_appraisal_id ON appraisal_items (appraisal_id);

-- LP store offers cache (per pirate FW corp), refreshed every 24h from ESI.
CREATE TABLE IF NOT EXISTS lp_offers (
  corporation_id  INTEGER     NOT NULL,
  offer_id        INTEGER     NOT NULL,
  type_id         INTEGER     NOT NULL,
  quantity        INTEGER     NOT NULL DEFAULT 1,
  isk_cost        BIGINT      NOT NULL DEFAULT 0,
  lp_cost         INTEGER     NOT NULL,
  ak_cost         INTEGER     NOT NULL DEFAULT 0,
  required_items  JSONB       NOT NULL DEFAULT '[]'::jsonb,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (corporation_id, offer_id)
);

CREATE INDEX IF NOT EXISTS idx_lp_offers_corp ON lp_offers (corporation_id);

-- 7-day market history cache (per typeID, The Forge region) for LP sparklines.
CREATE TABLE IF NOT EXISTS market_history (
  type_id     INTEGER     PRIMARY KEY REFERENCES item_cache (type_id) ON DELETE CASCADE,
  history     JSONB       NOT NULL DEFAULT '[]'::jsonb,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ESI manufacturing cost-index cache for popular industry systems (hourly).
CREATE TABLE IF NOT EXISTS industry_indices (
  system_id            INTEGER     PRIMARY KEY,
  system_name          TEXT        NOT NULL,
  manufacturing_index  NUMERIC(8, 6) NOT NULL DEFAULT 0,
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Blueprint manufacturing-recipe cache (Fuzzwork), long TTL.
CREATE TABLE IF NOT EXISTS blueprint_cache (
  blueprint_type_id INTEGER     PRIMARY KEY,
  product_type_id   INTEGER     NOT NULL,
  product_quantity  INTEGER     NOT NULL DEFAULT 1,
  materials         JSONB       NOT NULL DEFAULT '[]'::jsonb,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Shared name → type_id resolution cache (immutable, never invalidated).
CREATE TABLE IF NOT EXISTS type_id_cache (
  name        TEXT   PRIMARY KEY,        -- lowercased name (storage key)
  type_id     BIGINT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS type_id_cache_type_idx ON type_id_cache (type_id);

-- Corporation ticker cache (for Discord nicknames), 30-day TTL.
CREATE TABLE IF NOT EXISTS corp_ticker_cache (
  corporation_id BIGINT      PRIMARY KEY,
  ticker         TEXT        NOT NULL,
  name           TEXT,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);


-- ── Rate limiting (server-only) ─────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS rate_limits (
  ip              TEXT         PRIMARY KEY,
  tokens          INTEGER      NOT NULL DEFAULT 0,
  window_started  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_rate_limits_window_started ON rate_limits (window_started);


-- ── Per-character data ──────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS hauling_plans (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  character_id  BIGINT NOT NULL,
  name          TEXT NOT NULL,
  source_station_id  INTEGER NOT NULL,
  dest_station_id    INTEGER NOT NULL,
  ship_id       TEXT,
  mode          TEXT NOT NULL DEFAULT 'self',         -- 'self' | 'courier'
  sales_tax     NUMERIC,
  collateral_isk NUMERIC,
  reward        NUMERIC,
  budget        NUMERIC,
  cargo_text    TEXT,                                  -- raw paste; replayed on load
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS hauling_plans_char_idx ON hauling_plans (character_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS user_preferences (
  character_id      BIGINT PRIMARY KEY,
  default_station_id INTEGER,
  sales_tax         NUMERIC,
  broker_fee        NUMERIC,
  lp_price          NUMERIC,
  mfg_tax           NUMERIC,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);


-- ── Inventory / doctrines ───────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS corp_doctrine (
  id            UUID PRIMARY KEY,
  corp_id       BIGINT NOT NULL,
  doctrine      TEXT NOT NULL,
  name          TEXT NOT NULL,
  target        INTEGER NOT NULL DEFAULT 1,
  fitting       TEXT,
  updated_by_character_id  BIGINT,
  updated_by_character_name TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS corp_doctrine_corp_idx ON corp_doctrine (corp_id);

CREATE TABLE IF NOT EXISTS corp_doctrine_changelog (
  id                        UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  corp_id                   BIGINT      NOT NULL,
  changed_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  changed_by_character_id   BIGINT,
  changed_by_character_name TEXT,
  change_type               TEXT        NOT NULL,   -- 'added' | 'deleted' | 'edited'
  entry_id                  UUID,                    -- the corp_doctrine row this concerns
  doctrine                  TEXT        NOT NULL,
  name                      TEXT        NOT NULL,
  target                    INTEGER,
  fitting                   TEXT,                    -- snapshot of the fitting at the time
  changes                   JSONB                    -- 'edited' only: [{ field, from, to }]
);

CREATE INDEX IF NOT EXISTS corp_doctrine_changelog_corp_idx
  ON corp_doctrine_changelog (corp_id, changed_at DESC);

CREATE TABLE IF NOT EXISTS corp_doctrine_notes (
  corp_id      BIGINT      NOT NULL,
  doctrine     TEXT        NOT NULL,
  notes        TEXT        NOT NULL DEFAULT '',
  updated_by_character_id   BIGINT,
  updated_by_character_name TEXT,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (corp_id, doctrine)
);

-- Accumulated finished doctrine contracts (past ESI's ~30-day window).
CREATE TABLE IF NOT EXISTS corp_doctrine_sales (
  corp_id      BIGINT      NOT NULL,
  contract_id  BIGINT      NOT NULL,
  doctrine     TEXT        NOT NULL,
  entry_name   TEXT        NOT NULL,
  price        NUMERIC,
  accepted_at  TIMESTAMPTZ NOT NULL,
  acceptor_id  BIGINT,
  issuer_id    BIGINT,
  recorded_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (corp_id, contract_id)
);

CREATE INDEX IF NOT EXISTS corp_doctrine_sales_corp_accepted_idx
  ON corp_doctrine_sales (corp_id, accepted_at DESC);


-- ── SRP (Ship Replacement Program) ──────────────────────────────────────────

CREATE TABLE IF NOT EXISTS srp_fleets (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  slug              TEXT        NOT NULL UNIQUE,
  corp_id           BIGINT      NOT NULL,
  fc_character_id   BIGINT      NOT NULL,
  fc_character_name TEXT        NOT NULL,
  fleet_name        TEXT        NOT NULL,
  fleet_date        TIMESTAMPTZ NOT NULL,
  ping_text         TEXT,
  status            TEXT        NOT NULL DEFAULT 'open', -- 'open' | 'closed'
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS srp_fleets_corp_date_idx ON srp_fleets (corp_id, fleet_date DESC);

CREATE TABLE IF NOT EXISTS srp_losses (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  fleet_id          UUID        NOT NULL REFERENCES srp_fleets(id) ON DELETE CASCADE,
  character_id      BIGINT      NOT NULL,
  character_name    TEXT        NOT NULL,
  zkill_url         TEXT,
  kill_id           BIGINT,
  ship_type_id      INTEGER,
  ship_name         TEXT,
  loss_value        NUMERIC(20,2),
  notes             TEXT,
  status            TEXT        NOT NULL DEFAULT 'pending', -- 'pending'|'approved'|'rejected'
  payment_amount    NUMERIC(20,2),
  rejection_reason  TEXT,
  paid_at           TIMESTAMPTZ,
  paid_by           TEXT,
  submitted_by_id   BIGINT,                  -- corp member who filed an alt-account loss
  submitted_by_name TEXT,
  decided_by        TEXT,                    -- who approved/rejected
  decided_at        TIMESTAMPTZ,
  kill_time         TIMESTAMPTZ,             -- in-game killmail timestamp
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (fleet_id, kill_id)
);

CREATE INDEX IF NOT EXISTS srp_losses_fleet_idx ON srp_losses (fleet_id);


-- ── Trust fund ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS fund_investors (
  character_id    BIGINT      PRIMARY KEY,
  character_name  TEXT        NOT NULL,
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS fund_ledger (
  id                UUID           PRIMARY KEY DEFAULT gen_random_uuid(),
  character_id     BIGINT          NOT NULL REFERENCES fund_investors(character_id) ON DELETE RESTRICT,
  kind             TEXT            NOT NULL,  -- 'deposit'|'withdrawal'|'interest'|'adjustment'
  amount           NUMERIC(20,2)   NOT NULL,  -- signed; withdrawals stored as negative
  effective_month  TEXT            NOT NULL,  -- 'YYYY-MM' the entry applies to
  notes            TEXT,
  recorded_by_id   BIGINT          NOT NULL,
  recorded_by_name TEXT            NOT NULL,
  recorded_at      TIMESTAMPTZ     NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS fund_ledger_char_idx  ON fund_ledger (character_id, recorded_at DESC);
CREATE INDEX IF NOT EXISTS fund_ledger_month_idx ON fund_ledger (effective_month);

CREATE TABLE IF NOT EXISTS fund_rates (
  month            TEXT         PRIMARY KEY, -- 'YYYY-MM'
  rate_pct         NUMERIC(5,2) NOT NULL,
  reason           TEXT         NOT NULL,
  declared_by_id   BIGINT       NOT NULL,
  declared_by_name TEXT         NOT NULL,
  declared_at      TIMESTAMPTZ  NOT NULL DEFAULT now()
);


-- ── Alliance finances: income statement ─────────────────────────────────────

CREATE TABLE IF NOT EXISTS income_entries (
  id               UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  direction        TEXT          NOT NULL CHECK (direction IN ('inflow','outflow')),
  amount           NUMERIC(20,2) NOT NULL CHECK (amount > 0),
  category         TEXT          NOT NULL,
  effective_month  TEXT          NOT NULL,            -- 'YYYY-MM'
  notes            TEXT,
  recorded_by_id   BIGINT        NOT NULL,
  recorded_by_name TEXT          NOT NULL,
  recorded_at      TIMESTAMPTZ   NOT NULL DEFAULT now(),
  deleted_at       TIMESTAMPTZ,                        -- soft delete
  edited_at        TIMESTAMPTZ,
  edited_by_id     BIGINT,
  edited_by_name   TEXT
);

CREATE INDEX IF NOT EXISTS income_entries_month_idx    ON income_entries (effective_month);
CREATE INDEX IF NOT EXISTS income_entries_recorded_idx ON income_entries (recorded_at DESC);
CREATE INDEX IF NOT EXISTS income_entries_active_idx
  ON income_entries (recorded_at DESC)
  WHERE deleted_at IS NULL;


-- ── Corp projects leaderboard ───────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS corp_project_snapshot (
  corp_id         BIGINT      PRIMARY KEY,
  data            JSONB       NOT NULL,
  synced_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  synced_by_id    BIGINT,
  synced_by_name  TEXT
);

-- Frozen finished LP ("Auto Pay Out") projects, one row per archived project.
CREATE TABLE IF NOT EXISTS corp_lp_project_archive (
  corp_id      BIGINT      NOT NULL,
  project_id   TEXT        NOT NULL,
  project_name TEXT,
  data         JSONB       NOT NULL,
  archived_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_by  TEXT,
  PRIMARY KEY (corp_id, project_id)
);


-- ── Admins ──────────────────────────────────────────────────────────────────

-- Runtime-granted admins, supplementing EVE_LEADERSHIP_IDS.
CREATE TABLE IF NOT EXISTS admin_users (
  character_id              BIGINT      PRIMARY KEY,
  character_name            TEXT        NOT NULL,
  granted_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  granted_by_character_id   BIGINT,
  granted_by_character_name TEXT
);


-- ── Discord linking + role sync ─────────────────────────────────────────────

-- One row per EVE character. discord_user_id is NOT unique (main + alts share).
CREATE TABLE IF NOT EXISTS discord_links (
  character_id     BIGINT      PRIMARY KEY,
  character_name   TEXT        NOT NULL,
  corporation_id   BIGINT,
  faction_id       BIGINT,                                 -- FW militia faction
  discord_user_id  TEXT,
  discord_username TEXT,
  titles           JSONB       NOT NULL DEFAULT '[]'::jsonb,  -- last-known [{title_id,name}]
  in_corp          BOOLEAN     NOT NULL DEFAULT false,
  applied_roles    JSONB       NOT NULL DEFAULT '[]'::jsonb,  -- Discord role IDs last pushed
  last_synced_at   TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS discord_links_discord_user_idx ON discord_links (discord_user_id);

-- EVE title → Discord role. A null title_name row is the base "verified member"
-- role; the '__guest__' sentinel maps an out-of-corp guest role.
CREATE TABLE IF NOT EXISTS title_role_map (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  title_name      TEXT,                       -- null = base "verified member" role
  discord_role_id TEXT        NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS title_role_map_title_idx
  ON title_role_map (coalesce(title_name, ''));

-- Militia (FW faction) → Discord role. 500001 Caldari / 500002 Minmatar /
-- 500003 Amarr / 500004 Gallente.
CREATE TABLE IF NOT EXISTS militia_role_map (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  faction_id      BIGINT      NOT NULL UNIQUE,
  discord_role_id TEXT        NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Append-only sync audit (pruned to 30 days by the planned sweep).
CREATE TABLE IF NOT EXISTS discord_sync_log (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  character_id BIGINT,
  action       TEXT        NOT NULL,
  detail       TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS discord_sync_log_created_idx ON discord_sync_log (created_at);

-- Single-row cursor for the planned chunked cron sweep.
CREATE TABLE IF NOT EXISTS discord_sync_cursor (
  id         INTEGER     PRIMARY KEY DEFAULT 1,
  position   BIGINT      NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT discord_sync_cursor_singleton CHECK (id = 1)
);

INSERT INTO discord_sync_cursor (id, position) VALUES (1, 0)
  ON CONFLICT (id) DO NOTHING;


-- ============================================================================
-- Row-level security
-- ============================================================================
-- RLS is on for every table. Public caches expose an anon SELECT policy; all
-- writes (and all corp-gated reads) go through the service-role key server-side.
-- Tables with no anon policy are unreachable without the service role.

ALTER TABLE item_cache              ENABLE ROW LEVEL SECURITY;
ALTER TABLE price_cache             ENABLE ROW LEVEL SECURITY;
ALTER TABLE appraisals              ENABLE ROW LEVEL SECURITY;
ALTER TABLE appraisal_items         ENABLE ROW LEVEL SECURITY;
ALTER TABLE lp_offers               ENABLE ROW LEVEL SECURITY;
ALTER TABLE market_history          ENABLE ROW LEVEL SECURITY;
ALTER TABLE industry_indices        ENABLE ROW LEVEL SECURITY;
ALTER TABLE blueprint_cache         ENABLE ROW LEVEL SECURITY;
ALTER TABLE type_id_cache           ENABLE ROW LEVEL SECURITY;
ALTER TABLE corp_ticker_cache       ENABLE ROW LEVEL SECURITY;
ALTER TABLE rate_limits             ENABLE ROW LEVEL SECURITY;
ALTER TABLE hauling_plans           ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_preferences        ENABLE ROW LEVEL SECURITY;
ALTER TABLE corp_doctrine           ENABLE ROW LEVEL SECURITY;
ALTER TABLE corp_doctrine_changelog ENABLE ROW LEVEL SECURITY;
ALTER TABLE corp_doctrine_notes     ENABLE ROW LEVEL SECURITY;
ALTER TABLE corp_doctrine_sales     ENABLE ROW LEVEL SECURITY;
ALTER TABLE srp_fleets              ENABLE ROW LEVEL SECURITY;
ALTER TABLE srp_losses              ENABLE ROW LEVEL SECURITY;
ALTER TABLE fund_investors          ENABLE ROW LEVEL SECURITY;
ALTER TABLE fund_ledger             ENABLE ROW LEVEL SECURITY;
ALTER TABLE fund_rates              ENABLE ROW LEVEL SECURITY;
ALTER TABLE income_entries          ENABLE ROW LEVEL SECURITY;
ALTER TABLE corp_project_snapshot   ENABLE ROW LEVEL SECURITY;
ALTER TABLE corp_lp_project_archive ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin_users             ENABLE ROW LEVEL SECURITY;
ALTER TABLE discord_links           ENABLE ROW LEVEL SECURITY;
ALTER TABLE title_role_map          ENABLE ROW LEVEL SECURITY;
ALTER TABLE militia_role_map        ENABLE ROW LEVEL SECURITY;
ALTER TABLE discord_sync_log        ENABLE ROW LEVEL SECURITY;
ALTER TABLE discord_sync_cursor     ENABLE ROW LEVEL SECURITY;

-- Public-readable caches (anon SELECT).
CREATE POLICY "public read item_cache"        ON item_cache        FOR SELECT TO anon USING (true);
CREATE POLICY "public read price_cache"       ON price_cache       FOR SELECT TO anon USING (true);
CREATE POLICY "public read appraisals"        ON appraisals        FOR SELECT TO anon USING (true);
CREATE POLICY "public read appraisal_items"   ON appraisal_items   FOR SELECT TO anon USING (true);
CREATE POLICY "public read lp_offers"         ON lp_offers         FOR SELECT TO anon USING (true);
CREATE POLICY "public read market_history"    ON market_history    FOR SELECT TO anon USING (true);
CREATE POLICY "public read industry_indices"  ON industry_indices  FOR SELECT TO anon USING (true);
CREATE POLICY "public read blueprint_cache"   ON blueprint_cache   FOR SELECT TO anon USING (true);

-- Service-role full access on every table (server-side writes + corp-gated reads).
CREATE POLICY "service write item_cache"              ON item_cache              FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service write price_cache"             ON price_cache             FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service write appraisals"              ON appraisals              FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service write appraisal_items"         ON appraisal_items         FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service write lp_offers"               ON lp_offers               FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service write market_history"          ON market_history          FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service write industry_indices"        ON industry_indices        FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service write blueprint_cache"         ON blueprint_cache         FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service write type_id_cache"           ON type_id_cache           FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service write corp_ticker_cache"       ON corp_ticker_cache       FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service write rate_limits"             ON rate_limits             FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service write hauling_plans"           ON hauling_plans           FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service write user_preferences"        ON user_preferences        FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service write corp_doctrine"           ON corp_doctrine           FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service write corp_doctrine_changelog" ON corp_doctrine_changelog FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service write corp_doctrine_notes"     ON corp_doctrine_notes     FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service write corp_doctrine_sales"     ON corp_doctrine_sales     FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service write srp_fleets"              ON srp_fleets              FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service write srp_losses"              ON srp_losses              FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service write fund_investors"          ON fund_investors          FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service write fund_ledger"             ON fund_ledger             FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service write fund_rates"              ON fund_rates              FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service write income_entries"          ON income_entries          FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service write corp_project_snapshot"   ON corp_project_snapshot   FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service write corp_lp_project_archive" ON corp_lp_project_archive FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service write admin_users"             ON admin_users             FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service write discord_links"           ON discord_links           FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service write title_role_map"          ON title_role_map          FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service write militia_role_map"        ON militia_role_map        FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service write discord_sync_log"        ON discord_sync_log        FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service write discord_sync_cursor"     ON discord_sync_cursor     FOR ALL TO service_role USING (true) WITH CHECK (true);


-- ============================================================================
-- updated_at triggers (cache tables)
-- ============================================================================

CREATE TRIGGER trg_item_cache_updated_at      BEFORE UPDATE ON item_cache      FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER trg_price_cache_updated_at      BEFORE UPDATE ON price_cache      FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER trg_lp_offers_updated_at        BEFORE UPDATE ON lp_offers        FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER trg_market_history_updated_at   BEFORE UPDATE ON market_history   FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER trg_blueprint_cache_updated_at  BEFORE UPDATE ON blueprint_cache  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
