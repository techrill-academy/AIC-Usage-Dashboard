// AI Credit Usage Dashboard - backend
// Handles: create usage report export -> poll -> download CSV(s) -> parse -> serve JSON
// Uses in-memory job store; suitable for local/single-user use.

const express = require('express');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`AI Credit Usage Dashboard running at http://localhost:${PORT}`);
});
