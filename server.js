// AI Credit Usage Dashboard - backend
// Handles: create usage report export -> poll -> download CSV(s) -> parse -> serve JSON
// Uses in-memory job store; suitable for local/single-user use.

const express = require('express');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(__dirname));

const GITHUB_API = 'https://api.github.com';
const API_VERSION = '2026-03-10';

/** @type {Map<string, {status:string, message:string, progress:number, error?:string, data?:any, startedAt:number}>} */
const jobs = new Map();

// Playful progress messages shown while polling
const FUNNY_MESSAGES = [
  'Convincing GitHub to hand over your AI credits… 🤝',
  'Bribing the billing gnomes with virtual coffee ☕',
  'Counting every token by hand. Yes, really. 🔢',
  'Teaching the hamsters to run faster on the wheel 🐹',
  'Untangling a very long CSV… 🧶',
  'Asking Copilot how much Copilot costs (meta) 🤖',
  'Waiting for the report — patience is a virtue 🧘',
  'Shaking the piggy bank to see what falls out 🐷',
  'Reticulating splines and reconciling receipts 📊',
  'Almost there — the CSV is stretching its legs 🏃',
  'Polishing your dashboard until it shines ✨',
  'Convincing pixels to line up in the right order 🎨'
];

function pickMessage(i) {
  return FUNNY_MESSAGES[i % FUNNY_MESSAGES.length];
}

function newJobId() {
  return crypto.randomUUID();
}

function ghHeaders(pat) {
  return {
    'Accept': 'application/vnd.github+json',
    'Authorization': `Bearer ${pat}`,
    'X-GitHub-Api-Version': API_VERSION,
    'User-Agent': 'aic-usage-dashboard'
  };
}

// Simple CSV parser that handles quoted fields and embedded commas/newlines.
function parseCSV(text) {
  const rows = [];
  let field = '';
  let row = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else { inQuotes = false; }
      } else {
        field += c;
      }
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else if (c === '\r') { /* skip */ }
      else field += c;
    }
  }
  // trailing field
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  if (!rows.length) return { headers: [], records: [] };
  const headers = rows.shift().map(h => h.trim());
  const records = rows
    .filter(r => r.length && !(r.length === 1 && r[0] === ''))
    .map(r => {
      const obj = {};
      headers.forEach((h, idx) => { obj[h] = r[idx] !== undefined ? r[idx] : ''; });
      return obj;
    });
  return { headers, records };
}

async function createExport(enterprise, pat, startDate, endDate) {
  const body = { report_type: 'ai_credit', start_date: startDate };
  if (endDate) body.end_date = endDate;
  const res = await fetch(`${GITHUB_API}/enterprises/${encodeURIComponent(enterprise)}/settings/billing/reports`, {
    method: 'POST',
    headers: { ...ghHeaders(pat), 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Create export failed (${res.status}): ${t}`);
  }
  return res.json();
}

async function getExport(enterprise, pat, reportId) {
  const res = await fetch(`${GITHUB_API}/enterprises/${encodeURIComponent(enterprise)}/settings/billing/reports/${reportId}`, {
    headers: ghHeaders(pat)
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Get export failed (${res.status}): ${t}`);
  }
  return res.json();
}

async function downloadAndParseAll(urls) {
  const all = { headers: [], records: [] };
  for (const url of urls) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Download failed (${res.status}) for ${url}`);
    const text = await res.text();
    const parsed = parseCSV(text);
    if (!all.headers.length) all.headers = parsed.headers;
    all.records.push(...parsed.records);
  }
  return all;
}

async function runJob(jobId, { enterprise, pat, startDate, endDate }) {
  const job = jobs.get(jobId);
  try {
    job.status = 'processing';
    job.progress = 5;
    job.message = 'Asking GitHub to prepare your AI credit report… 📮';

    const created = await createExport(enterprise, pat, startDate, endDate);
    const reportId = created.id;
    job.progress = 15;
    job.message = `Report queued (id ${reportId.slice(0, 8)}…). ${pickMessage(0)}`;

    // Poll until completed or failed. Backoff 3s -> up to 15s, max ~10 minutes.
    const started = Date.now();
    const maxMs = 10 * 60 * 1000;
    let attempt = 0;
    let current = created;
    while (current.status === 'processing') {
      if (Date.now() - started > maxMs) throw new Error('Timed out waiting for report (10 min).');
      const wait = Math.min(3000 + attempt * 1000, 15000);
      await new Promise(r => setTimeout(r, wait));
      attempt++;
      current = await getExport(enterprise, pat, reportId);
      // Progress creeps toward 85 while we wait.
      job.progress = Math.min(85, 15 + attempt * 4);
      job.message = pickMessage(attempt);
    }

    if (current.status !== 'completed') {
      throw new Error(`Report ${current.status}. No download available.`);
    }

    const urls = current.download_urls || [];
    if (!urls.length) throw new Error('Report completed but returned no download URLs.');

    job.progress = 90;
    job.message = 'Downloading and unwrapping the CSV… 📦';
    const parsed = await downloadAndParseAll(urls);

    job.progress = 100;
    job.status = 'completed';
    job.message = `Done! Loaded ${parsed.records.length} rows. 🎉`;
    job.data = {
      reportId,
      start_date: current.start_date,
      end_date: current.end_date,
      created_at: current.created_at,
      headers: parsed.headers,
      records: parsed.records
    };
  } catch (err) {
    job.status = 'failed';
    job.error = err.message || String(err);
    job.message = `Something went sideways: ${job.error}`;
  }
}

// --- GitHub Enterprise Organizations ---

// Fetches all organizations under a GitHub Enterprise account via the GraphQL API.
// Using GraphQL (read:enterprise scope) instead of the REST endpoint which requires
// the heavier admin:enterprise scope that billing tokens typically don't have.
async function get_enterprise_organizations(enterprise_slug, auth_token) {
  if (!enterprise_slug) throw new Error('enterprise_slug is required.');
  if (!auth_token) throw new Error('auth_token is required.');

  const QUERY = `
    query($slug: String!, $after: String) {
      enterprise(slug: $slug) {
        organizations(first: 100, after: $after) {
          pageInfo { hasNextPage endCursor }
          nodes {
            login
            name
            description
            url
            avatarUrl
          }
        }
      }
    }
  `;

  const organizations = [];
  let afterCursor = null;

  while (true) {
    let res;
    try {
      res = await fetch(`${GITHUB_API}/graphql`, {
        method: 'POST',
        headers: { ...ghHeaders(auth_token), 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: QUERY, variables: { slug: enterprise_slug, after: afterCursor } })
      });
    } catch (err) {
      console.error(`[get_enterprise_organizations] Network error: ${err.message || err}`);
      throw new Error(`Network error while fetching enterprise organizations: ${err.message || err}`);
    }

    if (res.status === 401) {
      const details = await res.text().catch(() => '');
      const msg = `Unauthorized (401): the provided auth token is invalid or expired.`;
      console.error(`[get_enterprise_organizations] ${msg} ${details}`);
      throw new Error(msg);
    }
    if (res.status === 403) {
      const details = await res.text().catch(() => '');
      const rateLimitRemaining = res.headers.get('x-ratelimit-remaining');
      const msg = rateLimitRemaining === '0'
        ? `Forbidden (403): API rate limit exceeded. Try again later.`
        : `Forbidden (403): the token lacks sufficient permissions to list organizations for enterprise "${enterprise_slug}".`;
      console.error(`[get_enterprise_organizations] ${msg} ${details}`);
      throw new Error(msg);
    }
    if (!res.ok) {
      const details = await res.text().catch(() => '');
      const msg = `Get enterprise organizations failed (${res.status}): ${details}`;
      console.error(`[get_enterprise_organizations] ${msg}`);
      throw new Error(msg);
    }

    const json = await res.json();

    // Surface GraphQL-level errors
    if (json.errors && json.errors.length) {
      const first = json.errors[0];
      const msg = /NOT_FOUND/i.test(first.type || '') || /Could not resolve/i.test(first.message || '')
        ? `Not Found: enterprise "${enterprise_slug}" does not exist or is not accessible with this token.`
        : `GitHub API error: ${first.message}`;
      console.error(`[get_enterprise_organizations] ${msg}`);
      throw new Error(msg);
    }

    const enterprise = json.data && json.data.enterprise;
    if (!enterprise) {
      const msg = `Not Found: enterprise "${enterprise_slug}" does not exist or is not accessible with this token.`;
      console.error(`[get_enterprise_organizations] ${msg}`);
      throw new Error(msg);
    }

    const orgs = enterprise.organizations;
    // Normalize GraphQL camelCase fields to snake_case for frontend compatibility
    const nodes = (orgs.nodes || []).map(o => ({
      login: o.login,
      name: o.name || '',
      description: o.description || '',
      html_url: o.url,
      url: o.url,
      avatar_url: o.avatarUrl
    }));
    organizations.push(...nodes);

    if (orgs.pageInfo.hasNextPage) {
      afterCursor = orgs.pageInfo.endCursor;
    } else {
      break;
    }
  }

  console.log(`[get_enterprise_organizations] Retrieved ${organizations.length} organizations for enterprise "${enterprise_slug}".`);
  return organizations;
}

// --- Copilot Seat Management & Activity ---

async function fetchAllSeats(org, pat) {
  let seats = [];
  let totalSeats = 0;
  let url = `${GITHUB_API}/orgs/${encodeURIComponent(org)}/copilot/billing/seats?per_page=100`;
  while (url) {
    const res = await fetch(url, { headers: ghHeaders(pat) });
    if (!res.ok) {
      const t = await res.text();
      throw new Error(`Get seats failed (${res.status}): ${t}`);
    }
    const json = await res.json();
    if (typeof json.total_seats === 'number') totalSeats = json.total_seats;
    if (Array.isArray(json.seats)) seats.push(...json.seats);

    // Follow pagination via the Link header (rel="next").
    url = null;
    const link = res.headers.get('link');
    if (link) {
      const next = link.split(',').map(s => s.trim()).find(s => /rel="next"/.test(s));
      if (next) {
        const m = next.match(/<([^>]+)>/);
        if (m) url = m[1];
      }
    }
  }
  if (!totalSeats) totalSeats = seats.length;
  return { totalSeats, seats };
}

// Computes active/inactive/pending-cancellation counts since GitHub's API
// does not return a direct status field.
function computeSeatMetrics(totalSeats, seats, activityWindowDays) {
  const now = Date.now();
  const windowMs = activityWindowDays * 24 * 60 * 60 * 1000;
  let activeSeats = 0;
  let inactiveSeats = 0;
  let pendingCancellationSeats = 0;

  const enrichedSeats = seats.map(seat => {
    const lastActivityAt = seat.last_activity_at || null;
    const lastActivityMs = lastActivityAt ? new Date(lastActivityAt).getTime() : NaN;
    const isActive = lastActivityAt != null && Number.isFinite(lastActivityMs) && (now - lastActivityMs) <= windowMs;

    if (isActive) activeSeats++; else inactiveSeats++;
    if (seat.pending_cancellation_date) pendingCancellationSeats++;

    return {
      login: (seat.assignee && (seat.assignee.login || seat.assignee.slug || seat.assignee.name)) || 'unknown',
      avatarUrl: seat.assignee ? seat.assignee.avatar_url : null,
      org: seat.org || null,
      team: seat.assigning_team ? seat.assigning_team.name : null,
      createdAt: seat.created_at || null,
      lastActivityAt,
      lastActivityEditor: seat.last_activity_editor || null,
      pendingCancellationDate: seat.pending_cancellation_date || null,
      status: isActive ? 'active' : 'inactive'
    };
  });

  return {
    totalSeats: totalSeats || seats.length,
    activeSeats,
    inactiveSeats,
    pendingCancellationSeats,
    activityWindowDays,
    seats: enrichedSeats
  };
}

app.post('/api/seats', async (req, res) => {
  const { org, orgs: orgsInput, pat, activityWindowDays } = req.body || {};
  // Support both single org (string) and multiple orgs (array).
  const orgList = Array.isArray(orgsInput) && orgsInput.length > 0
    ? orgsInput.map(o => String(o).trim()).filter(Boolean)
    : (org ? [String(org).trim()] : []);
  if (!orgList.length || !pat) {
    return res.status(400).json({ error: 'org (or orgs) and pat are required.' });
  }
  const days = Number(activityWindowDays) > 0 ? Number(activityWindowDays) : 30;
  try {
    // Fetch all orgs in parallel; tag each raw seat with its source org.
    const results = await Promise.all(
      orgList.map(async o => {
        const { totalSeats, seats } = await fetchAllSeats(o, pat);
        return { org: o, totalSeats, seats: seats.map(s => ({ ...s, org: o })) };
      })
    );
    const totalSeats = results.reduce((sum, r) => sum + r.totalSeats, 0);
    const allSeats = results.flatMap(r => r.seats);
    const metrics = computeSeatMetrics(totalSeats, allSeats, days);
    if (orgList.length > 1) metrics.multiOrg = true;
    res.json(metrics);
  } catch (err) {
    res.status(502).json({ error: err.message || String(err) });
  }
});

app.post('/api/jobs', (req, res) => {
  const { enterprise, pat, startDate, endDate } = req.body || {};
  if (!enterprise || !pat || !startDate) {
    return res.status(400).json({ error: 'enterprise, pat, and startDate are required.' });
  }
  const id = newJobId();
  jobs.set(id, {
    status: 'queued',
    message: 'Warming up the report engine… 🔥',
    progress: 1,
    startedAt: Date.now()
  });
  // Fire and forget
  runJob(id, { enterprise, pat, startDate, endDate }).catch(() => {});
  res.json({ jobId: id });
});

app.get('/api/jobs/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'job not found' });
  // Only expose data when complete
  const { status, message, progress, error } = job;
  const out = { status, message, progress };
  if (error) out.error = error;
  if (status === 'completed') out.data = job.data;
  res.json(out);
});

// Optional: allow client to forget a job (frees memory)
app.delete('/api/jobs/:id', (req, res) => {
  jobs.delete(req.params.id);
  res.json({ ok: true });
});

app.post('/api/enterprise-organizations', async (req, res) => {
  const { enterprise, pat } = req.body || {};
  if (!enterprise || !pat) {
    return res.status(400).json({ error: 'enterprise and pat are required.' });
  }
  try {
    const organizations = await get_enterprise_organizations(enterprise, pat);
    res.json({ organizations });
  } catch (err) {
    const message = err.message || String(err);
    const status = /^Unauthorized \(401\)/.test(message) ? 401
      : /^Forbidden \(403\)/.test(message) ? 403
      : /^Not Found \(404\)/.test(message) ? 404
      : 502;
    res.status(status).json({ error: message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`AI Credit Usage Dashboard running at http://localhost:${PORT}`);
});

module.exports = { get_enterprise_organizations };
