# Running your own copy of Conduit

This is the full build-it-yourself guide: stand up your own deployment of
Conduit, configure it for your corp, and deploy it to Cloudflare. It also
includes the deep reference material (project structure, database schema, full
API surface) you'll want while operating it.

For *what Conduit is* — features, architecture overview, credits — see the
[README](../README.md).

> This is a public, **scrubbed** reference implementation. Identifiers, keys,
> branding, and corp-specific defaults have been replaced with `REPLACE_ME` /
> `TODO` placeholders. See [Configuration values](#configuration-values) below
> for everything you need to fill in to run your own copy.

## Table of contents

1. [Prerequisites](#prerequisites)
2. [Step-by-step setup](#step-by-step-setup)
   - [1. Get your own copy of the code (fork — no cloning of the upstream)](#1-get-your-own-copy-of-the-code)
   - [2. Install Node.js and the tooling](#2-install-nodejs-and-the-tooling)
   - [3. Create an EVE developer application](#3-create-an-eve-developer-application)
   - [4. Create a Supabase project + apply migrations](#4-create-a-supabase-project--apply-migrations)
   - [5. Create a Discord application + bot](#5-create-a-discord-application--bot)
   - [6. Fill in `wrangler.jsonc`](#6-fill-in-wranglerjsonc)
   - [7. Local secrets (`.dev.vars`)](#7-local-secrets-devvars)
   - [8. Configure corp-specific defaults](#8-configure-corp-specific-defaults)
   - [9. Run locally](#9-run-locally)
3. [Deploying to Cloudflare](#deploying-to-cloudflare)
4. [Discord-sync: how roles stay current (and the planned cron)](#discord-sync-how-roles-stay-current-and-the-planned-cron)
5. [Bootstrapping leadership / admins](#bootstrapping-leadership--admins)
6. [Configuration values (reference)](#configuration-values)
7. [Project structure](#project-structure)
8. [Database schema](#database-schema)
9. [API surface](#api-surface)
10. [Operational notes](#operational-notes)
11. [Troubleshooting](#troubleshooting)

---

## Prerequisites

| Tool | Purpose | Notes |
|---|---|---|
| GitHub account | Hosts **your** fork of the code | Free — https://github.com/join |
| Node.js 20+ | Build & dev | `node -v` to check; install from https://nodejs.org |
| `git` | Pull your fork down to your machine | Bundled with macOS/Linux; Windows: https://git-scm.com |
| `npm install -g wrangler` | Cloudflare CLI | v3+ |
| Cloudflare account | Hosting | Free tier is fine |
| Supabase account | Database | Free tier is fine |
| EVE developer app | SSO | https://developers.eveonline.com/ |
| Discord application + bot | Role sync (optional but recommended) | https://discord.com/developers/applications |
| `psql` *(optional)* | Apply migrations from the command line | Or just use the Supabase dashboard SQL editor — no install needed |

---

## Step-by-step setup

> **The short version:** fork the repo into your own GitHub account, pull your
> fork down locally, stand up a free Supabase project and (optionally) a Discord
> bot, paste the resulting IDs/keys into `wrangler.jsonc` + `.dev.vars`, then run
> locally and deploy to Cloudflare. Every step below is expanded for someone who
> has never touched these services. Budget ~30–45 minutes for a first run.

### 1. Get your own copy of the code

You are **not** cloning the upstream repo. You want your **own** copy on GitHub
so that (a) you can commit your config changes, and (b) Cloudflare can deploy
straight from your repo on every push. Pick whichever fits:

**Option A — Fork (recommended, keeps a link to upstream so you can pull updates):**

1. Open the upstream repo on GitHub and click **Fork** (top-right).
2. Choose your own account as the owner, leave the name as-is (or rename it),
   click **Create fork**. You now have `https://github.com/<you>/Conduit`.

**Option B — Use as template (a clean copy with no fork relationship / no git history):**

1. On the upstream repo click **Use this template → Create a new repository**.
2. Pick your account, name it, **Create repository**.

Either way, now pull *your* copy down to your machine so you can edit and build it:

```bash
# Replace <you> and the repo name with your fork's URL (Code → HTTPS on your repo page)
git clone https://github.com/<you>/Conduit.git
cd Conduit
```

> Yes, this still uses `git clone` — but it clones **your fork**, not the
> original. That's the bit that matters: your deploys, secrets, and edits all
> live in a repo you own. If you genuinely want zero git, you can instead use
> GitHub's **Code → Download ZIP** on your fork and unzip it, but you'll lose
> the one-click "push to deploy" wiring in [Deploying](#deploying-to-cloudflare).

Install the JS dependencies:

```bash
npm install
```

### 2. Install Node.js and the tooling

If `npm install` above failed with "command not found", you're missing Node.

1. Install **Node.js 20 or newer** from https://nodejs.org (the "LTS" download).
   Verify: `node -v` should print `v20.x` or higher.
2. Install the **Wrangler** CLI (Cloudflare's deploy tool) globally:
   ```bash
   npm install -g wrangler
   wrangler --version   # should be v3 or newer
   ```
3. Create the two **free accounts** you'll need now, so they're ready:
   - **Cloudflare** — https://dash.cloudflare.com/sign-up (hosts the app)
   - **Supabase** — https://supabase.com/dashboard (the database)

Re-run `npm install` in the project folder once Node is installed.

### 3. Create an EVE developer application

This is what lets corp members "Log in with EVE Online".

1. Visit https://developers.eveonline.com/applications, log in with your EVE
   account, and click **Create New Application**.
2. Give it any **Name** and **Description** (only you see these).
3. **Connection Type:** choose `Authentication & API Access`. (Plain
   "Authentication Only" won't expose the ESI scopes the app needs.)
4. **Permissions (scopes)** — add each of these (type to search, click to add).
   This is the full set for every feature:
   ```
   esi-characters.read_titles.v1
   esi-corporations.read_titles.v1
   esi-corporations.read_projects.v1
   esi-corporations.read_contracts.v1
   esi-contracts.read_character_contracts.v1
   esi-markets.structure_markets.v1
   esi-industry.read_corporation_jobs.v1
   esi-wallet.read_corporation_wallets.v1
   ```
   You can trim this if you only want some tabs — e.g. drop `read_projects.v1`
   if you don't need the Corp Projects tab. Adding scopes later means everyone
   re-authorizes, so it's easiest to add them all now.
5. **Callback URL** — where EVE sends users back after login. List both your
   local-dev and (eventual) production URLs, comma-separated:
   ```
   http://localhost:8787/, https://<your-domain>/
   ```
   - The SPA handles the SSO callback at the **root** (`/`), so the trailing
     slash matters — it must match exactly.
   - Don't have a domain yet? Just put `http://localhost:8787/` for now and add
     the production one later (Step in [Deploying](#deploying-to-cloudflare)).
6. **Create Application**, then open it and copy the **Client ID**. Save it —
   it becomes `EVE_CLIENT_ID` in `wrangler.jsonc`. There is **no client secret**
   to copy; this app uses PKCE.
7. **Find your corp ID** (`EVE_CORP_ID`): go to https://evewho.com, search your
   corporation name, open it — the number in the URL
   (`evewho.com/corporation/<this-number>`) is the ID.
8. **Find leadership character IDs** (`EVE_LEADERSHIP_IDS`): same site, search
   each leader's character name; the number in
   `evewho.com/character/<this-number>` is their ID. Collect at least your own.

### 4. Create a Supabase project + apply migrations

Supabase is the Postgres database. The free tier is plenty.

1. At https://supabase.com/dashboard click **New project**. Pick your org, give
   it a name, set a **database password** (save it — you'll need it for the
   `psql` option below), and choose a **region** near your members. Click
   **Create new project** and wait ~2 minutes for it to provision.
2. Once it's up, open **Project Settings** (gear icon) **→ API** and copy these
   four values somewhere safe:

   | Supabase value | Goes into | Where it ends up |
   |---|---|---|
   | **Project URL** (`https://abcd1234.supabase.co`) | `SUPABASE_URL` | `wrangler.jsonc` |
   | **Project Reference** (the `abcd1234` part of the URL) | — | used by the CLI option below |
   | **`anon` `public`** key | `SUPABASE_ANON_KEY` | `wrangler.jsonc` |
   | **`service_role` `secret`** key | `SUPABASE_SERVICE_KEY` | `.dev.vars` + Wrangler secret — **never** the browser |

   ⚠️ The `service_role` key bypasses all row-level security. Treat it like a
   password: it only ever lives server-side.

3. **Create the tables.** The schema lives in `supabase/migrations/*.sql`. Apply
   every file **in chronological order** (they're named `YYYYMMDD_...` so a plain
   alphabetical sort is the right order). Pick one method:

   **Option A — Dashboard SQL editor (no install, easiest for first-timers):**
   In the Supabase dashboard open **SQL Editor → New query**, then for each file
   under `supabase/migrations/` *in order*, paste its contents and click **Run**.
   There are ~30 small files; running them top-to-bottom takes a few minutes. If
   one errors with "already exists", you can safely skip it — the migrations use
   `create table if not exists`.

   **Option B — Supabase CLI (one command, recommended if comfortable):**
   ```bash
   npm install -g supabase
   supabase login                              # opens a browser to authorize
   supabase link --project-ref <your-project-ref>
   supabase db push                            # applies every migration in order
   ```

   **Option C — `psql` over the connection string:**
   ```bash
   # Connection string: Supabase → Project Settings → Database → Connection string
   # (use the "URI" form; it includes the password you set in step 1)
   export DATABASE_URL="postgresql://postgres:...@db.<ref>.supabase.co:5432/postgres"
   for f in $(ls supabase/migrations/*.sql | sort); do
     echo "Applying $f"
     psql "$DATABASE_URL" -f "$f"
   done
   ```

4. That's it — the migrations enable row-level security (RLS) on every table and
   set up the right policies. The `anon` key only gets read access where it's
   safe (e.g. shared appraisal lookups); every write goes through the
   `service_role` key on the server. No manual policy editing needed.

### 5. Create a Discord application + bot

This powers the Profile/Admin **role sync** (auto-granting Discord roles from
in-game corp titles + FW militia, and renaming members to `[TICKER] Name`).
**Skip this whole step if you don't want Discord integration** — the app runs
fine without it; you just lose the Profile/Admin sync features. Leave the
Discord vars as `REPLACE_ME`.

1. Go to https://discord.com/developers/applications → **New Application**, name
   it, **Create**.
2. On **General Information**, copy the **Application ID** → this is
   `DISCORD_CLIENT_ID`.
3. **OAuth2 → Redirects → Add Redirect**, add both:
   ```
   http://localhost:8787/discord/callback
   https://<your-domain>/discord/callback
   ```
   (Add the production one later if you don't have a domain yet.) **Save Changes.**
4. Still on **OAuth2**, copy the **Client Secret** (click **Reset Secret** if
   none is shown) → this is `DISCORD_CLIENT_SECRET`. It's a secret — it goes in
   `.dev.vars`, never `wrangler.jsonc`.
5. **Bot tab → Add Bot** (confirm). Under **Token**, click **Reset Token** and
   copy it → this is `DISCORD_BOT_TOKEN` (also a secret). Toggle **Public Bot**
   off if you don't want others inviting it. No privileged gateway intents are
   needed.
6. **Invite the bot to your server:** go to **OAuth2 → URL Generator**, tick the
   `bot` scope, then under the permissions that appear tick **Manage Roles**.
   Copy the generated URL at the bottom, open it in your browser, pick your
   server, **Authorize**.
7. **⚠️ Fix the role hierarchy — this is the #1 gotcha.** Discord only lets a bot
   manage roles positioned **below** the bot's own role. In your server go to
   **Server Settings → Roles** and drag the bot's auto-created role **above**
   every role you want it to grant. If you skip this, syncs run but silently
   grant nothing.
8. **Get your Guild (server) ID** → `DISCORD_GUILD_ID`: in Discord enable
   **Settings → Advanced → Developer Mode**, then right-click your server icon →
   **Copy Server ID**.
9. You'll wire up which title/militia maps to which role **later**, from the
   Admin tab, once you're logged in as a leadership character (see
   [Bootstrapping leadership / admins](#bootstrapping-leadership--admins)).

### 6. Fill in `wrangler.jsonc`

Open `wrangler.jsonc` in the project and replace every `REPLACE_ME` with the
values you collected above. These are **non-secret** — they intentionally end up
in the client bundle / public API responses, so don't put any secret here:

```jsonc
{
  "name": "Conduit",           // your Worker name (lowercase, no spaces)
  "vars": {
    "SUPABASE_URL": "https://<project-ref>.supabase.co",
    "SUPABASE_ANON_KEY": "<supabase anon public key>",
    "EVE_CLIENT_ID": "<EVE app client id>",
    "EVE_CORP_ID": "<your corp ID from evewho.com>",
    "EVE_LEADERSHIP_IDS": "<comma-separated character IDs, e.g. 91234567,99876543>",
    "DISCORD_CLIENT_ID": "<discord application id>",  // leave REPLACE_ME if skipping Discord
    "DISCORD_GUILD_ID": "<discord server id>"         // leave REPLACE_ME if skipping Discord
  }
}
```

> **Leave at least one trusted character ID in `EVE_LEADERSHIP_IDS`** before you
> deploy — it's the only way to bootstrap admin access. An empty list means
> *nobody* can perform leadership writes (fail-secure by design).

### 7. Local secrets (`.dev.vars`)

Secrets never go in `wrangler.jsonc` (which is committed). They live in a
git-ignored `.dev.vars` file for local dev, and are pushed separately to
Cloudflare at deploy time. Create it from the template:

```bash
cp .dev.vars.example .dev.vars
```

Open `.dev.vars` and fill it in:

```env
SUPABASE_SERVICE_KEY=<supabase service_role secret>
DISCORD_CLIENT_SECRET=<discord oauth client secret>   # omit if skipping Discord
DISCORD_BOT_TOKEN=<discord bot token>                 # omit if skipping Discord
CRON_SECRET=<any long random string>
```

- `CRON_SECRET` guards a *planned* Discord cron sweep; it isn't used by any live
  endpoint yet, but set it now so it's ready. Generate one with:
  ```bash
  openssl rand -hex 32
  ```
- `.dev.vars` is already in `.gitignore` — double-check it never gets committed.

### 8. Configure corp-specific defaults

Two values need to be set to whatever your corp's policy is — they're left as `0` in this mirror because there's no sensible global default:

**SRP payout policy** — `src/components/SrpTab.jsx`:
```js
const SRP_DEFAULT_PCT = 0; // TODO: set your default payout fraction, e.g. 0.7 for 70%
const SRP_PAYOUT_CAP = 0;  // TODO: set your per-loss ISK cap, e.g. 200_000_000 (200M) or Infinity for no cap
```
Leadership can still override both in the bulk-approve dialog per fleet, but these are the values members see when they submit a loss.

**Branding / copy** — see [Repurposing for a different corp or game](../README.md#repurposing-for-a-different-corp-or-game) in the README for the full list (logo, gate title, theme colors, package name).

### 9. Run locally

```bash
npm run build      # builds Vite client + compiles functions into dist/_worker.js
npm run dev        # wrangler dev — serves dist/ at http://localhost:8787
```

Or in one shot:

```bash
npm run preview    # build + dev (use this if dist/ is stale or missing)
```

Open `http://localhost:8787`. You should see the AuthGate; click "Log in with
EVE Online" and you'll be redirected through SSO. If your character isn't a
member of `EVE_CORP_ID`, you'll be rejected at the gate — this is intentional.
The public tabs (Appraise / LP) work without logging in.

**First-run checklist** — if something's off:
- *Blank page after EVE login* → the EVE app **Callback URL** doesn't exactly
  match `http://localhost:8787/` (scheme + host + port + trailing slash).
- *404 on `/api/*`* → you ran `npm run dev` without building first. Use
  `npm run preview`, which builds then serves.
- *"Not a member of corp"* → `EVE_CORP_ID` doesn't match your character's corp.
- See [Troubleshooting](#troubleshooting) for more.

Once it works locally, move on to [Deploying to Cloudflare](#deploying-to-cloudflare)
— since your code already lives in your own fork, you just connect that repo and
push.

---

## Deploying to Cloudflare

This deploys as a **Cloudflare Worker with Static Assets** — the Vite build lives in `dist/` and `functions/` is compiled into `dist/_worker.js/` by `wrangler pages functions build` (already wired into `npm run build`).

### Connect the repo (Workers Builds — recommended)

1. Dashboard → **Workers & Pages → Create → Connect to Git**. Pick your fork.
2. Build settings:

   | Setting | Value |
   |---|---|
   | Build command | `npm run build` |
   | Deploy command | `npx wrangler deploy` |
   | Root directory | `/` (default) |
3. **First deploy** will fail because secrets aren't set yet — that's fine, set them next.

### Set the production secrets

```bash
npx wrangler secret put SUPABASE_SERVICE_KEY
npx wrangler secret put DISCORD_CLIENT_SECRET
npx wrangler secret put DISCORD_BOT_TOKEN
npx wrangler secret put CRON_SECRET
```

Each command prompts for the value. Or do it via Dashboard → your Worker → **Settings → Variables and Secrets → Add → Secret**.

### Trigger a deploy

Push to your default branch (Workers Builds auto-deploys), or run manually:

```bash
npm run deploy
```

### Custom domain

Dashboard → your Worker → **Settings → Domains & Routes → Add Custom Domain**. After it provisions:
1. Update the EVE app callback URL (and Discord OAuth redirect) to the new domain.
2. No code change needed — EVE's PKCE flow uses `window.location.origin`.

---

## Discord-sync: how roles stay current (and the planned cron)

The app maintains Discord role state **lazily**: roles are reconciled on every Profile self-sync, every Admin force-sync, and on first link. For bulk reconciliation today, the Admin → Members **Sync All** button fans the per-member force-sync out across every linked account (deduped by Discord user) from the client, so each sync keeps its own subrequest budget. This is the current bulk-resync path.

> **Heads-up — the periodic cron sweep is planned, not yet implemented.** The scaffolding exists (the `discord_sync_cursor` table and the `CRON_SECRET` secret), and `_discord_sync.js` exposes `syncDiscordUser()` that a sweep would call per account, but there is **no scheduled handler / sweep endpoint in the repo yet**. Until it lands, use **Sync All**. When you build it:

1. Add a Cron trigger to `wrangler.jsonc`:
   ```jsonc
   "triggers": {
     "crons": ["0 */6 * * *"]   // every 6 hours
   }
   ```
2. Add a scheduled handler (or a `CRON_SECRET`-gated route) that walks the roster in chunks via the `discord_sync_cursor` table — chunking is what keeps each invocation under Cloudflare's per-invocation subrequest cap — calling `syncDiscordUser()` per linked account.
3. Redeploy after editing.

---

## Bootstrapping leadership / admins

The app has two overlapping permission tiers:

- **Leader** (`isLeader()` returns true) — character ID is in `EVE_LEADERSHIP_IDS` env var **OR** in the `admin_users` Postgres table. Gates SRP approvals/payouts, income statement edits, doctrine config edits, the entire Admin tab.
- **Director** (ESI role check) — required to refresh corp projects, since the underlying ESI endpoint demands it.

Initial bootstrap:

1. Put **at least one** trusted character ID in `EVE_LEADERSHIP_IDS` (in `wrangler.jsonc`) **before** the first deploy. Fail-secure default: empty list = nobody can write.
2. After deploy, that character logs in, opens the Admin tab → Admins sub-tab, and grants admin to other leaders at runtime (writes to `admin_users` — no redeploy needed).
3. From there, env-var admins and DB-row admins are equivalent; you can remove the env entry once at least one admin exists in the DB if you prefer.

---

## Configuration values

Quick reference of every var and where it goes.

### `wrangler.jsonc` plain vars (non-secret, end up in the client bundle / public API)

| Var | Where to find it | Notes |
|---|---|---|
| `SUPABASE_URL` | Supabase → Settings → API → Project URL | e.g. `https://abcdef.supabase.co` |
| `SUPABASE_ANON_KEY` | Supabase → Settings → API → anon public | Read-only role used by slug reads |
| `EVE_CLIENT_ID` | EVE developer app | PKCE — no client secret needed |
| `EVE_CORP_ID` | https://evewho.com | The corp whose members are allowed in |
| `EVE_LEADERSHIP_IDS` | https://evewho.com | Comma-separated character IDs |
| `DISCORD_CLIENT_ID` | Discord app → General Information | |
| `DISCORD_GUILD_ID` | Right-click guild → Copy Server ID | Dev Mode on |

### Wrangler secrets (set via `npx wrangler secret put <NAME>`)

| Secret | Where to find it |
|---|---|
| `SUPABASE_SERVICE_KEY` | Supabase → Settings → API → service_role secret |
| `DISCORD_CLIENT_SECRET` | Discord app → OAuth2 → Client Secret |
| `DISCORD_BOT_TOKEN` | Discord app → Bot → Reset Token |
| `CRON_SECRET` | Generate yourself: `openssl rand -hex 32` |

---

## Project structure

```
Conduit/
├── functions/
│   └── api/
│       ├── _auth.js                # EVE SSO verifier + isLeader() helper
│       ├── _constants.js           # TTLs (price/item/offers)
│       ├── _supabase.js            # Supabase client factory (public + service)
│       ├── _parser.js              # Item list parser
│       ├── _slug.js                # Slug generator
│       ├── _stations.js            # Supported trading hubs
│       ├── _rate_limit.js          # Per-IP rate limiter helper
│       ├── _volumes.js             # m³ helper
│       ├── _discord.js             # Low-level Discord REST helpers
│       ├── _discord_sync.js        # Role + nickname sync engine
│       ├── _corp_info.js           # Corp ticker lookup (cached) for nicknames
│       ├── _militias.js            # FW militia ID → name table
│       ├── stations.js             # GET  /api/stations
│       ├── appraise.js             # POST /api/appraise
│       ├── compare.js              # POST /api/compare
│       ├── prefs.js                # GET/PUT /api/prefs
│       ├── profile.js              # Profile endpoints
│       ├── appraisal/[slug].js     # GET  /api/appraisal/:slug
│       ├── admin/                  # Admin panel endpoints + refresh-titles
│       ├── discord/                # OAuth link + role config
│       ├── finances/income/        # Income statement
│       ├── fund/                   # Trust fund ledger, rates, summary
│       ├── hauling/                # Hauling route + saved plans
│       ├── industry/indices.js     # GET  /api/industry/indices
│       ├── inventory/              # Doctrine config + contracts mirror
│       ├── lp/                     # LP store endpoints + corp list
│       ├── projects/[corpId].js    # Corp project snapshots
│       └── srp/                    # Fleets + losses + mine (bulk PATCH, payment, summary)
├── src/
│   ├── components/                 # One per tab + shared (Header/Tabs/AuthGate/Toast/Fund/...)
│   ├── lib/                        # eveAuth, discordLink, admin, corps, userPrefs, stations, ...
│   ├── App.jsx                     # Top-level tab dispatch
│   ├── main.jsx
│   ├── index.css                   # Theme variables
│   └── App.module.css
├── supabase/
│   └── migrations/                 # Timestamped Postgres migrations
├── scripts/
│   └── audit-lp-faction-filter.mjs # One-off LP corp registry sanity-check
├── public/
│   └── logo.png                    # Supply your own (deleted from this scrubbed mirror)
├── index.html
├── vite.config.js
├── wrangler.jsonc                  # Worker config + non-secret vars
├── .dev.vars.example               # Template for local secrets
└── package.json
```

---

## Database schema

| Table | Purpose |
|---|---|
| `item_cache` | EVE item name → typeID + category + volume, 7-day TTL |
| `price_cache` | Per-station buy/sell prices, 30-min TTL |
| `market_history` | 7-day Jita volume + average per typeID, 24h TTL |
| `industry_indices` | ESI manufacturing cost-index per popular system, 1h TTL |
| `lp_offers` | LP store offers per corporation, 24h TTL |
| `blueprint_cache` | BPO/BPC material requirements for hauling/restock costing |
| `appraisals` / `appraisal_items` | Each paste submission with totals + slug, line items |
| `rate_limits` | Per-IP token bucket for `/api/appraise` |
| `user_preferences` | Synced settings (station, fees, taxes) per character |
| `hauling_plans` | Saved hauling trips |
| `srp_fleets` / `srp_losses` | SRP fleets and submitted losses (includes `alt_submitter`, `decided_by`/`decided_at`, `kill_time`) |
| `fund_investors` / `fund_ledger` / `fund_rates` | Trust fund investor registry, append-only transaction ledger, monthly rate overrides |
| `corp_doctrine` / `corp_doctrine_changelog` / `corp_doctrine_notes` / `corp_doctrine_sales` | Inventory doctrine config + audit log + bulletin notes + accumulated sales |
| `income_entries` | Income-statement inflow/outflow entries (soft-deleted via `deleted_at`) |
| `corp_project_snapshot` / `corp_lp_project_archive` | Cached corp-project leaderboard + frozen finished LP projects |
| `admin_users` | Runtime admin grants (supplements `EVE_LEADERSHIP_IDS`) |
| `discord_links` / `discord_sync_log` / `discord_sync_cursor` | Discord ↔ EVE character mapping + sync state |
| `title_role_map` / `militia_role_map` | EVE title / FW militia → Discord role mapping |
| `corp_ticker_cache` / `type_id_cache` | Misc ESI lookups |

RLS is on. Anon key has read-only access where appropriate; all writes go through the service role server-side. SRP / inventory / admin paths additionally check `isLeader()` before mutating.

---

## API surface

Routes follow the `functions/api/` file tree. `[param]` directories are dynamic segments. Auth tiers: **anon** (no token), **corp** (any verified corp member), **leader** (`isLeader()` required), **director** (ESI Director role required).

### Public (anon, rate-limited)
| Route | Methods | Purpose |
|---|---|---|
| `/api/appraise` | POST | Parse + price + persist a paste |
| `/api/appraisal/:slug` | GET | Load a saved appraisal |
| `/api/compare` | POST | Multi-station price comparison |
| `/api/stations` | GET | Supported trading hubs |
| `/api/lp/corps` | GET | Supported LP corps registry |
| `/api/lp/:corpId` | GET | LP offers for one corp |
| `/api/lp/history` | POST | Jita market-history sparklines for typeIDs |
| `/api/industry/indices` | GET | Manufacturing cost-index per system |
| `/api/inventory/config` | GET | EVE SSO config (`EVE_CLIENT_ID` + `EVE_CORP_ID`) |
| `/api/discord/config` | GET | Discord OAuth config (`DISCORD_CLIENT_ID`) |

### Corp-gated
| Route | Methods | Purpose |
|---|---|---|
| `/api/prefs` | GET / PUT | Synced settings |
| `/api/profile` | GET | Char + corp + Discord state |
| `/api/profile/sync` | POST | Re-run Discord sync for caller |
| `/api/hauling/route` | POST | Route quote |
| `/api/hauling/plans` | GET / POST / PUT / DELETE | Saved trips |
| `/api/inventory/doctrines` | GET / PUT / PATCH | Doctrine list + stock state; PUT replaces entries, PATCH upserts a bulletin note |
| `/api/inventory/type-ids` | POST | Shared name→typeID resolver (cache-first) |
| `/api/inventory/sales` | GET / POST | Doctrine sales history (GET = rollups, POST = log finished contracts) |
| `/api/srp/fleets` | GET / POST | List / create fleet |
| `/api/srp/:fleetId` | GET / PATCH / DELETE | Fleet detail; status change + delete are leader-gated |
| `/api/srp/:fleetId/losses` | POST | Submit a loss |
| `/api/srp/:fleetId/losses/:lossId` | PATCH | Owner edits own loss notes (leader approve/reject below) |
| `/api/srp/mine` | GET | My losses across all fleets |
| `/api/srp/summary` | GET | Monthly roundup |
| `/api/finances/income/list` | GET | Income statement (read) |
| `/api/fund/summary` | GET | Per-investor balances + principal |
| `/api/fund/ledger` | GET | Trust fund ledger (read; POST is leader) |
| `/api/fund/rates` | GET | Monthly interest rates (read; POST is leader) |
| `/api/discord/link` | POST / DELETE | Link / unlink Discord (OAuth code exchange) |

### Leader-only
| Route | Methods | Purpose |
|---|---|---|
| `/api/srp/:fleetId/losses/:lossId` | PATCH / DELETE | Approve / reject / delete a loss |
| `/api/srp/:fleetId/pay` | POST | Mark approved losses paid |
| `/api/finances/income/entry` | POST / PATCH / DELETE | Manual income entries |
| `/api/fund/ledger` | POST | Append a trust fund ledger entry |
| `/api/fund/ledger/:id` | PATCH / DELETE | Edit / soft-delete a ledger entry |
| `/api/fund/rates` | POST | Set a monthly interest rate override |
| `/api/admin/me` | GET | Returns `{ isAdmin: true/false }` |
| `/api/admin/overview` | GET | Linked-account browser bundle |
| `/api/admin/admins` | POST | Grant admin (name → character ID) |
| `/api/admin/admins/:characterId` | DELETE | Revoke admin |
| `/api/admin/members/:characterId` | POST | Per-member ops: sync / add / remove role |
| `/api/admin/refresh-titles` | POST | Force-refresh corp titles from ESI |
| `/api/admin/role-map` | POST / DELETE | Title→role map |
| `/api/admin/militia-map` | POST / DELETE | Militia→role map |

### Director-only
| Route | Methods | Purpose |
|---|---|---|
| `/api/projects/:corpId` | GET / POST | Read snapshot / refresh from ESI |

---

## Operational notes

**No tests, no linter configured.** The original project values shipping speed over CI. If you fork it for production use, adding `eslint` + a basic `vitest` setup is the obvious first move.

**Cache TTLs** are centralized in `functions/api/_constants.js`. Tune them if your traffic profile changes.

**ESI quirks worth knowing:**
- The JWKS endpoint occasionally times out; `_auth.js` keeps a stale copy of the public keys for an hour so a brief CCP outage doesn't lock everyone out.
- Corp affiliation is cached per-character for 5 minutes — corp-leave revocation is delayed by up to that window. Reduce in `_auth.js` if you need faster revocation.
- LP offers occasionally cross-leak between militias from ESI; `functions/api/lp/_corps.js` filters server-side.

**Rate limiting** is per-IP token bucket on `/api/appraise` and `/api/compare`, stored in the `rate_limits` table. Watch for that table growing unbounded — it's cleaned by a TTL check on insert, but consider a periodic `DELETE FROM rate_limits WHERE updated_at < now() - interval '1 day'` cron if you get heavy traffic.

**Discord role hierarchy** is the #1 source of "the sync ran but nothing happened" — make sure the bot's auto-created role sits above every managed role in the guild role list.

---

## Troubleshooting

**"Not a member of corp" on login** — your character's corp ID doesn't match `EVE_CORP_ID`. Check the value in `wrangler.jsonc` and on https://evewho.com.

**SSO callback shows a blank page** — the EVE app's Callback URL doesn't exactly match where the SPA was served. Must match scheme + host + port + trailing slash.

**`npm run dev` 404s on `/api/*`** — you didn't run `npm run build` first. `npm run dev` only serves the `dist/` output; the functions need to be compiled. Use `npm run preview` for a one-shot build+serve.

**Discord link succeeds but no roles applied** — bot role isn't above the managed roles in the guild role list, OR `DISCORD_BOT_TOKEN` is wrong / from a different bot than the one in the guild.

**"Permission denied" on a SQL migration** — you're not connected as the `postgres` role. Use the connection string from Supabase → Settings → Database (not the pooler URL).

**Workers Builds fails with "function bundle too large"** — Cloudflare's free tier caps Worker size. `npm run build` already excludes static assets from the function bundle via `.assetsignore`; check it includes anything large you've added under `dist/`.
