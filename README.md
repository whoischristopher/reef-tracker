# Reef Tracker

A self-hosted aquarium log that replaces a spreadsheet. The repo and the image contain no readings: everything you log lives in the SQLite file on your Docker host. Your data leaves the server only if you turn on the optional [GitHub sync](#github-sync), which pushes a copy to a private repo you choose.

It records:

- **Any number of tanks**, each with its own parameters, target ranges and dosing products. There are presets for reef, freshwater and African cichlid tanks, or you can start blank. All tanks share the RODI filter tracking.
- **Water tests and dosing** for each tank.
- **Maintenance as dedicated fields**: water changes (gallons or % of tank) and GFO replacements (grams, e.g. Rowaphos), each with its own column, dashboard tile and chart. Free-text notes are kept separately.
- **A trend dashboard** with one chart per parameter. Each chart shades the target range, highlights out-of-range readings, and marks water changes, GFO changes and notes on the timeline. A water change volume chart is included. There are dosing charts too, and a time-range picker from 30 days to all.
- **RODI filter tracking.** Each stage can alert on age, on gallons used, or on a TDS reading:
  - **Time:** days since install against a rated life.
  - **Usage:** gallons since install against the rated capacity. Pre-filters count feed water, which is product water × (1 + waste ratio), because the waste water passes through them too. The membrane and DI count product water only.
  - **TDS:** the DI stage is flagged when TDS out goes above your limit (and warned at half of it), which is a better guide to DI life than a calendar. If no TDS reading has been logged for 30 days (configurable; 0 turns it off), the stage asks you to take one.
  - Usage comes from the **RODI log**, which records production: log each batch of RODI you make, whatever it's for (water changes, top-off, other household uses). Water changes are tracked separately in the tank logs and don't add RODI rows. For the time before you started logging, **Backfill estimated top-off** on the RODI tab adds weekly *estimated* rows at a gal/day rate you choose (one-off; remove and redo it if the rate was wrong).
- **Alerts** appear at the top of the dashboard and as a badge on the RODI tab. A daily push notification is optional (ntfy or a webhook such as Home Assistant).
- **Optional one-way GitHub sync** of CSVs, a trend digest and a JSON backup to a private repo, so the data can be analysed elsewhere (for example by Claude).
- **Paste import** from Google Sheets or a CSV file (see below), plus JSON backup and restore, and a CSV download for each tank.

The server has no npm dependencies. It uses Node 22's built-in HTTP server and `node:sqlite`, and keeps all data in a single SQLite file at `/data/reef.db`.

## Deploy with Portainer

Each push to `main` makes GitHub Actions run the tests and publish a multi-arch image (amd64 and arm64) to `ghcr.io/whoischristopher/reef-tracker:latest`.

1. In Portainer, go to **Stacks → Add stack**.
2. Either choose **Repository** and enter `https://github.com/whoischristopher/reef-tracker` with compose path `docker-compose.yml`, or paste `docker-compose.yml` into the **Web editor**.
3. Optionally, set environment variables (see below). The most useful is `NTFY_URL`.
4. Deploy, then open `http://<docker-host>:8087`.

On first start, the database is empty apart from four generic RODI stages. The app opens on a welcome screen where you can add a tank or import data.

> **Image pull denied?** GHCR packages sometimes start out private. Open the package on GitHub (**Packages → reef-tracker → Package settings**) and change its visibility to public. Alternatively, add GHCR as a registry in Portainer using a personal access token with the `read:packages` scope.
> **Building locally instead:** in `docker-compose.yml`, comment out `image:` and uncomment `build: .`.

### Behind Nginx Proxy Manager

Add a proxy host such as `reef.<your-domain>` pointing to `http://<docker-host>:8087`. Use your wildcard certificate and turn on **Websockets Support** (not strictly needed, but harmless). If the app can be reached from outside your LAN, set `AUTH_USER` and `AUTH_PASS`, or add an NPM access list.

### Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `TZ` | `America/Toronto` | Sets "today" and the notification hour |
| `NTFY_URL` | — | ntfy topic URL, e.g. `https://ntfy.sh/<long-random-topic>` or your own ntfy server |
| `NTFY_TOKEN` | — | Bearer token for a protected ntfy topic |
| `WEBHOOK_URL` | — | POSTs `{title, message, url}` as JSON (e.g. a Home Assistant webhook automation) |
| `NOTIFY_HOUR` | `9` | Local hour for the daily digest. A digest is sent only on days with alerts |
| `APP_URL` | — | Link that opens when you tap the notification |
| `AUTH_USER` / `AUTH_PASS` | — | Turns on HTTP basic auth for everything except `/healthz` |
| `PORT` | `8080` | Port inside the container |
| `GITHUB_SYNC_REPO` | — | `owner/name` of the private repo to sync to. Turns on [GitHub sync](#github-sync) |
| `GITHUB_SYNC_TOKEN` | — | Fine-grained personal access token for that repo (Contents: read and write) |
| `GITHUB_SYNC_BRANCH` | `main` | Branch to commit to |
| `GITHUB_SYNC_DIR` | — | Optional folder inside the repo for the synced files |
| `GITHUB_SYNC_DELAY_MIN` | `10` | Minutes to wait after the last change before pushing, so a batch of entries becomes one commit |
| `GITHUB_SYNC_HOUR` | `3` | Local hour for the daily refresh of the digest (filter ages, alerts) |
| `SEED_FILE` | — | Optional path inside the container to an export JSON that is loaded once into an empty database |

**Settings → Send test notification** checks your notification setup right away.

### Data and backups

- Keep the `/data` volume on **local disk**. SQLite locking is unreliable over NFS, so don't put the volume on the TrueNAS NFS mount.
- Back up with **Settings → Export JSON**. For an automated copy, use `curl -s http://<host>:8087/api/export > reef-$(date +%F).json` from a cron job on TrueNAS. **Import JSON** restores an export and replaces all current data.

## GitHub sync

An optional, **one-way** copy of the log to a GitHub repository (app → GitHub; nothing is ever read back). It is meant for analysing the data elsewhere, and it doubles as an off-site backup.

**Set-up**

1. Create a **private** repository with any name, **with a README** (the API cannot commit to an empty repo).
2. Create a [fine-grained personal access token](https://github.com/settings/personal-access-tokens/new):
   - **Repository access:** *Only select repositories* → the data repo only.
   - **Permissions:** *Contents: Read and write*. Nothing else (Metadata: read-only is added automatically).
   - Set an expiry and a reminder to rotate it. When it expires, the sync fails and Settings says so; the app keeps working.
3. Set `GITHUB_SYNC_REPO=owner/name` and `GITHUB_SYNC_TOKEN=…` in the Portainer stack's environment variables, then redeploy.
4. Open **Settings → GitHub sync** and click **Sync now** to check it.

Keep the token out of the code repo. Set it only as a stack environment variable. It is never shown in the UI or included in exports.

**What is written**: one commit per sync. Other files in the repo (your README, notes) are left alone.

| File | Contents |
|---|---|
| `digest.md` | Alerts; per tank, the latest value, target, status, 30-day range, 90-day mean and weekly trend for each parameter; recent husbandry; RODI stage status |
| `parameters.csv` | One row per reading: date, tank, param, label, unit, value, targets, status |
| `doses.csv` | One row per dose |
| `maintenance.csv` | Water changes (in gallons), GFO changes, events and notes |
| `rodi_log.csv` | RODI log: batches made and TDS readings (`source` is `manual`, or `history` for estimated rows: past water changes and top-off backfill) |
| `filters.csv` | RODI stages with days and gallons in use, % used, status and projected due date |
| `export.json` | The full export. Restore it with **Settings → Restore JSON** |

**When it runs**: `GITHUB_SYNC_DELAY_MIN` minutes after the last change, and daily at `GITHUB_SYNC_HOUR`. The daily run refreshes the time-based figures, so expect about one commit a day. If a push fails (network or token), it retries on the next change or within the delay. **Sync now** pushes immediately. A sync that would change nothing makes no commit.

The container needs outbound HTTPS to `api.github.com`. Nothing inbound is required.

## Importing data

Open the **Import** tab.

1. In Google Sheets, select a tab's rows, including the header row, and copy them (or use **Load CSV file…**).
2. Paste into the box, choose the tank (or **+ New tank…** with a preset), then click **Preview**.
3. Check the column mapping. Columns are matched by header name (e.g. *Calcium*, *dKH* → Alkalinity, *Phosphate*), and you can change any of them. Columns the tank doesn't have yet can become new parameters or dosing products. A header with `(ml)` or `(g)` is treated as a dosing product.
4. Check the preview and the warnings, then import. If the tank already has entries, you can add to them or replace them.

The importer understands a few patterns:

- Rows without a date take the date of the row above.
- Columns named like *Water change (gal)*, *Water change %* or *GFO (g)* map to the dedicated fields.
- Text in any cell, including a value column, is recognised too: "15 gallon water change" and "40% water change" become a water change, "75g Rowas" or "replaced GFO" becomes a GFO change, and anything else becomes a note.
- "Added 22g of lake salt" becomes a dose. The product is created if the tank doesn't have it yet.
- A range like "10-15" is stored as the midpoint, with a note.
- If Sheets turned a range into a date ("2026-10-15" in a Nitrate column), it is read as 10–15 and listed in the warnings.

The same box works for quick data entry. Paste a header row and one row of new readings.

Each tank's targets are presets. Change them under **Settings**, where you can also rename tanks, set volumes (needed to convert percentage water changes to gallons) add or remove parameters and dosing products, and delete a tank.

### Upgrading from an earlier version

On start-up, older databases are migrated automatically. Water changes and Rowaphos/GFO stored as notes move into the dedicated fields, and RODI rows that earlier versions generated from water changes become estimated production rows dated two days before each change. A JSON backup from an earlier version can also be restored as-is.

## Development

```bash
npm start              # http://localhost:8080, data in ./data
npm test               # logic and API tests (node:test)
```

Layout: `server.js` (API, SQLite storage, notifier), `lib/sync.js` (GitHub sync: file builders and the REST API push), `lib/logic.js` (filter and alert maths and the paste/CSV importer, shared by the server and the browser), and `public/index.html` (the whole UI: no build step, SVG charts).

### API

`GET /api/state` · `GET /api/version` · `GET /api/export` · `POST /api/import` (full restore) · `POST /api/bulk` (append entries, optional `config` and `replaceTank`) · `POST /api/tanks/:id/delete` · `POST|DELETE /api/rodi/backfill` (`{from, to, perDay}`; DELETE removes all backfill rows) · `POST /api/notify/test` · `GET /api/info` · `GET /api/sync` (status) · `POST /api/sync` (push now) ·
`POST /api/doc/:collection` · `PUT|PATCH|DELETE /api/doc/:collection/:id`, where the collection is one of `config`, `entries`, `filters` or `rodi`.
