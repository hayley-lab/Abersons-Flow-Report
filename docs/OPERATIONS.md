# Operations Runbook — Abersons Flow Report

This is the day-to-day guide for running the Flow Report. The first half is for
**everyday use** (no technical knowledge needed). The second half — "For the
technical maintainer" — covers token/password rotation and the local backfill
setup, and assumes access to Vercel and the store network.

---

## 1. How the numbers stay up to date

You normally don't have to do anything — the report keeps itself current three ways:

1. **Overnight full refresh** — every night the report re-reads *everything* from
   Lightspeed (products, purchase orders, vendor returns, sales). This is the
   complete, authoritative refresh.
2. **Sales top-up every ~10 minutes** — throughout the day a quick job pulls in
   just the newest sales, so the floor's sales show up fast.
3. **The page refreshes itself** — while you have the report open it quietly
   checks for new data and updates on screen. You do **not** need to reload the
   page to see new sales.

So in normal use: open the report and read it. The data is already fresh.

---

## 2. The two buttons (top-right of the report)

| Button | What it does | When to use it |
| --- | --- | --- |
| **⚡ Quick Refresh (sales only)** | Pulls in recent sales only. Takes a few seconds. | When you want the very latest sales *right now* and don't want to wait for the next automatic top-up. |
| **↺ Full Sync from LS** | Re-reads products, purchase orders, vendor returns, **and** sales. Takes several minutes. | After receiving a big delivery, entering vendor returns, or if a number looks wrong and you want a complete rebuild. |

Both are safe to run any time. Quick Refresh is the one you'll use most.

---

## 3. The health badge and the Data Health screen

In the top bar there's a **health badge** you can click to open **Data Health**:

- **Green** — everything reconciles within the expected tolerance. Good.
- **Amber ("Data coverage warning")** — the report is fine, but some numbers
  can't be independently double-checked against Lightspeed (for example
  historical data imported from the old POS, which Lightspeed never had). This is
  expected, not an error.
- **Red ("Drift detected")** — the report and Lightspeed disagree by more than
  the allowed amount. Open Data Health and read the details.

### The Sync Status card (top of Data Health)

It shows three things at a glance:

- **Lightspeed** — green dot = connected; **red dot = connection problem** (see §4).
- **Last sync** — what the most recent refresh was doing, and any error.
- **Data updated** — how long ago the data last changed.

If a sync ever seems stuck or failed, this card is the first place to look — you
don't need any developer tools or special links.

---

## 4. When something looks wrong

### Red banner: "Lightspeed connection problem"

This means the report could not log in to Lightspeed, so **new sales and updates
are not coming in**. The numbers on screen are the last good data, but they're
getting stale.

**Almost always this means the Lightspeed access token has expired and needs to
be renewed.** Hand this to the technical maintainer (§6 below). Until it's fixed,
treat the numbers as "as of the time shown in Data updated."

### "Live updates are paused" (amber)

The page couldn't reach the server to check for new data — usually a brief
internet/network blip. It keeps retrying on its own. If it doesn't clear in a few
minutes, reload the page. If it still won't clear, see the connection steps above.

### A Full Sync shows an error, or says "Sync did not finish"

- An error like `spring26: LS 401 ...` points at the Lightspeed connection (§6).
- "Sync did not finish — it ran the maximum number of steps without completing"
  means the rebuild ran long and stopped itself. Some data may be partially
  updated. Open Data Health, then click **Full Sync from LS** again. If it keeps
  not finishing, escalate to the maintainer.

---

# For the technical maintainer

Everything below needs access to the Vercel project (environment variables and
deploys) and, for backfills, the in-store network.

## 5. Where things run

- **Hosting:** Vercel project `abersons-flow-report` (Next.js).
- **Data store:** Vercel KV (Upstash Redis).
- **Source POS:** Lightspeed Retail (X-Series) API.
- **Schedules (GitHub Actions):** `nightly-scan.yml` (full rebuild),
  `delta-scan.yml` (sales top-up), `weekly-full-scan.yml`, and
  `nightly-validate.yml` (accuracy backstop). All hit the deployed app with the
  `CRON_SECRET` bearer token.

## 6. Renewing the Lightspeed connection (token rotation)

The app authenticates to Lightspeed with environment variables in Vercel
(Project → Settings → Environment Variables). Two modes:

- **Refresh-token (production):** `LS_CLIENT_ID`, `LS_CLIENT_SECRET`, and
  `LS_REFRESH_TOKEN`. The app automatically exchanges the refresh token for
  short-lived access tokens and caches them in KV (`ls:token`). A red connection
  banner usually means the **refresh token was revoked or expired** (e.g. the LS
  OAuth app/connection was reset).
- **Static token (local/emergency):** `LS_ACCESS_TOKEN` — a personal token used
  directly, no refresh.

Also required: `LS_DOMAIN_PREFIX` (the subdomain only, e.g. `abersons`, **not** a
full URL).

**To rotate:**

1. In Lightspeed, generate a fresh token (personal token for `LS_ACCESS_TOKEN`,
   or re-authorize the OAuth app to get a new `LS_REFRESH_TOKEN`).
2. Update the value in Vercel → Settings → Environment Variables (Production).
3. **Redeploy** so the new value takes effect (Vercel → Deployments → Redeploy,
   or push to `main`).
4. Confirm recovery: trigger a delta (`delta-scan.yml` → Run workflow, or click
   **Quick Refresh** in the app). On success the Sync Status card flips back to
   green. The connection health is stored in KV as `ls:health` and surfaced by
   the app automatically.

## 7. Rotating the report password

Login is gated by `REPORT_PASSWORD` (checked by the sign-in page; sessions are
signed with `SESSION_SECRET`). To change the password:

1. Update `REPORT_PASSWORD` in Vercel → Settings → Environment Variables.
2. Redeploy.
3. (Optional) rotating `SESSION_SECRET` as well will sign everyone out of
   existing sessions.

Never commit these values; they live only in Vercel.

## 8. Nightly validation failure emails

`nightly-validate.yml` runs ~2:30am Central, calls `/api/scan/validate` for each
active season, and **fails the GitHub Actions run on drift**. GitHub emails the
repo owner on failure. When you get one:

1. Open the failed run's **Summary** — it has a per-season table (Drift / Checked
   / Drifted / Hard qty / Retail drift) and the specific drift reasons.
2. `⚠️ unreachable` / `bad response` rows are **not** drift — usually a transient
   Vercel/LS timeout. Re-run the workflow; if it clears, ignore.
3. A real `❌ DRIFT` row means the report and Lightspeed disagree beyond
   tolerance for that season. Open **Data Health** in the app for that season and
   click **Validate against Lightspeed** to see live detail, then investigate at
   the product level (the data flows bottom-up: product → vendor → department →
   season, so the root cause is always at the product level).

## 9. Local LAN backfill / reconciliation setup

Some one-off scripts (historical RMH backfills, the accuracy harness, the frozen
RMH snapshot) must run **on the store network** because the legacy RMH SQL Server
(`172.16.2.4`) is not reachable from Vercel.

**Important:** `vercel env pull` returns **blank** values for variables marked
"Sensitive" (the LS token and KV credentials). So local scripts need a
hand-built `.env.local` (it is gitignored):

```
LS_DOMAIN_PREFIX=abersons              # subdomain only
LS_ACCESS_TOKEN=...                    # a Lightspeed personal token
KV_REST_API_URL=...                    # from Vercel → Storage → your KV store
KV_REST_API_TOKEN=...
```

And `.env.rmh` for the legacy database (also gitignored):

```
HOST=172.16.2.4
USER=...
PASS=...
DATABASE=abersons
PORT=1433
```

RMH access uses FreeTDS `tsql` (install via Homebrew: `brew install freetds`).

**Key scripts:**

- `scripts/rmh-snapshot.mjs` — exports the authoritative RMH data (purchase
  orders, sales, season summary) to `scripts/out/rmh-snapshot-<date>/`
  (gitignored — contains supplier names and costs). **Run this before handoff and
  copy the folder somewhere safe** — RMH access ends after the cutover and this
  is the only preserved source of truth for later reconciliation.
- `tools/recon-accuracy.js` — replays the real report rollup against live KV and
  diffs each RMH-era season against RMH + the snapshot. Run:
  `npx jest --runTestsByPath tools/recon-accuracy.js --testMatch "**/tools/recon-accuracy.js"`.
  See CLAUDE.md → "Full RMH↔report accuracy reconciliation" for the current
  verdict and known historical gaps (e.g. spring25 ordered).
- `scripts/backfill-rmh-returns.mjs`, `scripts/backfill-rmh-ordered-cost.mjs` —
  durable override backfills (`--write` persists to production KV). These are
  one-offs; the durable override has no TTL, so they don't need re-running.

## 10. Quick reference — environment variables

| Variable | Purpose |
| --- | --- |
| `LS_DOMAIN_PREFIX` | Lightspeed subdomain (e.g. `abersons`) |
| `LS_REFRESH_TOKEN` + `LS_CLIENT_ID` + `LS_CLIENT_SECRET` | Production OAuth refresh flow |
| `LS_ACCESS_TOKEN` | Static token (local/emergency) |
| `REPORT_PASSWORD` | Report login password |
| `SESSION_SECRET` | Signs login sessions |
| `CRON_SECRET` | Authorizes the scheduled GitHub Actions jobs |
| `KV_REST_API_URL` + `KV_REST_API_TOKEN` | Vercel KV access |
