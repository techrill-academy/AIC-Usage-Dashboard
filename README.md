# AI Credit Usage Dashboard

Small local web app with three panels:

1. **AI Credit Usage** — pulls GitHub Enterprise AI Credit usage report exports and visualizes them in a dashboard with charts and a searchable/sortable table.
2. **Enterprise Organizations** — lists all organizations under a GitHub Enterprise account; results automatically populate the organization selector in Copilot Seat Management.
3. **Copilot Seat Management & Activity** — fetches Copilot seat assignments for one or more organizations and evaluates each seat's activity status.

---

## REST API Endpoints Used

### AI Credit Usage (API version `2026-03-10`)

- `POST /enterprises/{enterprise}/settings/billing/reports` — [Create a usage report export](https://docs.github.com/en/enterprise-cloud@latest/rest/billing/usage-reports?apiVersion=2026-03-10#create-a-usage-report-export)
- `GET /enterprises/{enterprise}/settings/billing/reports/{report_id}` — [Get a usage report export](https://docs.github.com/en/enterprise-cloud@latest/rest/billing/usage-reports?apiVersion=2026-03-10#get-a-usage-report-export)

### Enterprise Organizations

- `POST /graphql` (GitHub GraphQL API) — `enterprise(slug).organizations` query with `read:enterprise` scope; paginated via cursor (100 orgs per page)

### Copilot Seat Management

- `GET /orgs/{org}/copilot/billing/seats` — [List all Copilot seat assignments for an organization](https://docs.github.com/en/rest/copilot/copilot-user-management#list-all-copilot-seat-assignments-for-an-organization)

---

## Requirements

- Node.js **18+** (uses native `fetch` and `crypto.randomUUID`)
- For **AI Credit Usage**: a GitHub PAT (classic) with the **`manage_billing:enterprise`** scope, owned by an enterprise admin or billing manager
- For **Enterprise Organizations**: a GitHub PAT (classic) with the **`read:enterprise`** scope
- For **Copilot Seat Management**: a GitHub PAT (classic) with the **`manage_billing:copilot`** scope (or `read:org` for read-only access), owned by an org owner or billing manager

---

## Install & Run

```bash
npm install
npm start
```

Then open <http://localhost:3000>.

---

## AI Credit Usage

Fill in:

- **Enterprise slug** (the URL slug, not the display name)
- **PAT** with `manage_billing:enterprise` scope (kept in memory only, forwarded to `api.github.com`)
- **Start date** (required, from May 1 2026) and optional **End date**

Click **Generate Dashboard**. The server will:

1. Create the AI credit usage report export.
2. Poll `GET .../reports/{id}` every few seconds until `status = completed`.
3. Download the CSV(s) from `download_urls`, parse them, and return JSON.

While waiting, you'll get playful progress updates (report generation can take several minutes for large enterprises).

### AI Credit Features

- 📊 Timeline chart (usage over time)
- 🏷️ Top models / SKUs — click a bar to drill down
- 🏢 Usage by organization (doughnut)
- 👤 Top users
- 🔎 Searchable, sortable, paginated raw records table (DataTables)
- 📥 Download combined CSV of all fetched records
- 🎭 Fun, engaging progress messages while polling

The dashboard auto-detects common column names (`date`, `quantity`, `gross_amount`, `net_amount`, `sku`/`product`/`model`, `organization`, `user`/`username`/`actor`). If a field isn't present in the report, that chart shows a friendly "not detected" message but the rest of the dashboard still works.

---

## Enterprise Organizations

Fill in:

- **Enterprise slug** (the URL slug, not the display name)
- **PAT** with `read:enterprise` scope

Click **Fetch Organizations**. The server will:

1. Query the GitHub GraphQL API for `enterprise(slug).organizations`, fetching up to 100 organizations per page.
2. Paginate automatically until all organizations are retrieved.
3. Return the list with each organization's login, name, description, URL, and avatar URL.

### Enterprise Organizations Features

- 🏢 Full paginated list of all organizations under your GitHub Enterprise account
- Normalized response fields (`login`, `name`, `description`, `html_url`, `url`, `avatar_url`)
- 🔗 Results automatically populate the organization selector in **Copilot Seat Management & Activity**

### Troubleshooting

| Error | Likely cause |
| --- | --- |
| `401 Unauthorized` | The PAT is invalid or expired |
| `403 Forbidden` | The PAT lacks the `read:enterprise` scope, or the API rate limit is exceeded |
| `404 Not Found` | The enterprise slug is wrong or the enterprise is not accessible with this token |

---

## Copilot Seat Management & Activity

Fill in:

- **Organization(s)** — after running **Fetch Organizations** in the Enterprise Organizations panel above, a multi-select dropdown is automatically populated with all orgs. Use the **search box** to filter by name, then select the orgs you want (or click **Select All** / **Deselect All**). If you haven't fetched enterprise orgs yet, a plain text input accepts a single org login instead.
- **PAT** with `manage_billing:copilot` scope
- **Activity window (days)** — number of days to look back when classifying a seat as Active or Inactive (default: 30)

Click **Fetch Seats**. The server will:

1. Fetch seat data for every selected organization in parallel via `GET /orgs/{org}/copilot/billing/seats`.
2. Classify each seat as **Active** (last activity within the window) or **Inactive**.
3. Consolidate and return summary counts and per-seat details across all selected orgs.

### Seat Management Features

- 🪑 Summary stats: total seats, active seats, inactive seats, pending cancellation (consolidated across all selected orgs)
- 🏢 Multi-org selection — choose any combination of organizations from a dropdown pre-populated by Enterprise Organizations
- 🔍 Live search/filter box — type to instantly narrow the org list before selecting
- ☑️ Select All / Deselect All — applies to the currently filtered list
- 🔎 Searchable, sortable, paginated seat table — includes an **Organization** column when data spans multiple orgs
- 📥 Download consolidated seat data as CSV (includes Organization column in multi-org mode)
- ⏱️ Configurable activity window — adjust what "active" means for your team

### Troubleshooting

| Error | Likely cause |
| --- | --- |
| `404 Not Found` | The org has no Copilot subscription, the org name is wrong, or the PAT lacks `manage_billing:copilot` scope |
| `403 Forbidden` | The PAT owner is not an org owner or billing manager |
| `401 Unauthorized` | The PAT is invalid or expired |

---

## Security Notes

- PATs are sent from the browser to the **local** Node server only, forwarded as `Authorization: Bearer …` to GitHub, and **never persisted** to disk.
- Run this locally. Do not expose port 3000 publicly without adding authentication.
