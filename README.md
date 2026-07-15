# AI Credit Usage Dashboard

Small local web app that pulls GitHub Enterprise **AI Credit** usage report exports and visualizes them in a dashboard with charts and a searchable/sortable table.

Uses these REST endpoints (API version `2026-03-10`):

- `POST /enterprises/{enterprise}/settings/billing/reports` — [Create a usage report export](https://docs.github.com/en/enterprise-cloud@latest/rest/billing/usage-reports?apiVersion=2026-03-10#create-a-usage-report-export)
- `GET /enterprises/{enterprise}/settings/billing/reports/{report_id}` — [Get a usage report export](https://docs.github.com/en/enterprise-cloud@latest/rest/billing/usage-reports?apiVersion=2026-03-10#get-a-usage-report-export)

## Requirements

- Node.js **18+** (uses native `fetch` and `crypto.randomUUID`)
- A GitHub PAT (classic) with the **`manage_billing:enterprise`** scope, owned by an **enterprise admin or billing manager** for the enterprise you want to query

## Install & Run

```bash
npm install
npm start
```

Then open http://localhost:3000, fill in:

- **Enterprise slug** (the URL slug, not the display name)
- **PAT** with scope as `manage_billing:enterprise` (kept in memory only, forwarded to `api.github.com`)
- **Start date** (required) and optional **End date**

Click **Generate Dashboard**. The server will:

1. Create the AI credit usage report export.
2. Poll `GET .../reports/{id}` every few seconds until `status = completed`.
3. Download the CSV(s) from `download_urls`, parse them, and return JSON.

While waiting, you'll get playful progress updates (report generation can take several minutes for large enterprises).

## Features

- 📊 Timeline chart (usage over time)
- 🏷️ Top SKUs / products
- 🏢 Usage by organization (doughnut)
- 👤 Top users
- 🔎 Searchable, sortable, paginated raw records table (DataTables)
- 📥 Download combined CSV of all fetched records
- 🎭 Fun, engaging progress messages while polling

The dashboard auto-detects common column names (`date`, `quantity`, `gross_amount`, `net_amount`, `sku`/`product`/`model`, `organization`, `user`/`username`/`actor`). If a field isn't present in the report, that chart shows a friendly "not detected" message but the rest of the dashboard still works.

## Security notes

- The PAT is sent from the browser to the local Node server, which forwards it as `Authorization: Bearer …` to GitHub. It is **not persisted** to disk.
- Run this locally; do not expose the port publicly without adding auth.
