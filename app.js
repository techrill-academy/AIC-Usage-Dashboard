/* AI Credit Usage Dashboard - frontend */
(function () {
  const form = document.getElementById('report-form');
  const runBtn = document.getElementById('run-btn');
  const progressSection = document.getElementById('progress-section');
  const dashSection = document.getElementById('dashboard-section');
  const progressFill = document.getElementById('progress-fill');
  const progressMessage = document.getElementById('progress-message');
  const progressLog = document.getElementById('progress-log');

  const charts = {};
  let usersTable = null;
  let dailyTable = null;
  let modelTable = null;
  let currentData = null;
  let currentFields = null;

  // --- Date range constraints ---
  const MIN_START = '2026-05-01';
  const MIN_END = '2026-05-02';
  const startInput = document.getElementById('startDate');
  const endInput = document.getElementById('endDate');
  const dateError = document.getElementById('date-error');

  function today() {
    const d = new Date();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${d.getFullYear()}-${mm}-${dd}`;
  }

  function applyDateBounds() {
    const t = today();
    startInput.min = MIN_START;
    startInput.max = t;
    // End date must be at least day-after-start (and >= MIN_END), and no later than today.
    const s = startInput.value;
    let endMin = MIN_END;
    if (s) {
      const nextDay = new Date(s);
      nextDay.setDate(nextDay.getDate() + 1);
      const mm = String(nextDay.getMonth() + 1).padStart(2, '0');
      const dd = String(nextDay.getDate()).padStart(2, '0');
      const nd = `${nextDay.getFullYear()}-${mm}-${dd}`;
      if (nd > endMin) endMin = nd;
    }
    endInput.min = endMin;
    endInput.max = t;
  }

  function validateDates() {
    const t = today();
    const s = startInput.value;
    const e = endInput.value;
    let msg = '';
    if (!s) {
      msg = 'Please choose a start date.';
    } else if (s < MIN_START) {
      msg = `Start date must be on or after ${MIN_START}.`;
    } else if (s > t) {
      msg = 'Start date cannot be in the future.';
    } else if (e) {
      if (e < MIN_END) msg = `End date must be on or after ${MIN_END}.`;
      else if (e > t) msg = 'End date cannot be in the future.';
      else if (e <= s) msg = 'End date must be after the start date.';
    }
    if (msg) {
      dateError.textContent = msg;
      dateError.classList.remove('hidden');
      return false;
    }
    dateError.classList.add('hidden');
    dateError.textContent = '';
    return true;
  }

  startInput.addEventListener('change', () => { applyDateBounds(); validateDates(); });
  endInput.addEventListener('change', () => { validateDates(); });
  applyDateBounds();

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!validateDates()) return;
    runBtn.disabled = true;

    const payload = {
      enterprise: document.getElementById('enterprise').value.trim(),
      pat: document.getElementById('pat').value.trim(),
      startDate: document.getElementById('startDate').value,
      endDate: document.getElementById('endDate').value || undefined
    };

    resetUI();
    progressSection.classList.remove('hidden');
    setProgress(2, 'Sending your request to the local server…');

    try {
      const res = await fetch('/api/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `Failed to start job (${res.status})`);
      }
      const { jobId } = await res.json();
      await pollJob(jobId);
    } catch (err) {
      logLine(`❌ ${err.message}`, true);
      setProgress(0, `Failed: ${err.message}`);
    } finally {
      runBtn.disabled = false;
    }
  });

  document.getElementById('download-csv').addEventListener('click', () => {
    if (!currentData) return;
    const { headers, records } = currentData;
    const escape = (v) => {
      const s = v == null ? '' : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const csv = [headers.join(',')]
      .concat(records.map(r => headers.map(h => escape(r[h])).join(',')))
      .join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `ai-credit-usage-${Date.now()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  });

  function resetUI() {
    progressLog.innerHTML = '';
    dashSection.classList.add('hidden');
    progressFill.style.width = '0%';
    progressMessage.textContent = 'Starting…';
  }

  function setProgress(pct, msg) {
    progressFill.style.width = `${Math.max(0, Math.min(100, pct))}%`;
    if (msg) progressMessage.textContent = msg;
  }

  function logLine(text, isErr = false) {
    const li = document.createElement('li');
    li.textContent = `[${new Date().toLocaleTimeString()}] ${text}`;
    if (isErr) li.classList.add('err');
    progressLog.prepend(li);
  }

  async function pollJob(jobId) {
    let lastMsg = '';
    while (true) {
      await sleep(1500);
      const res = await fetch(`/api/jobs/${jobId}`);
      if (!res.ok) throw new Error(`Lost job ${jobId}`);
      const info = await res.json();
      if (info.message && info.message !== lastMsg) {
        logLine(info.message);
        lastMsg = info.message;
      }
      setProgress(info.progress || 0, info.message);
      if (info.status === 'completed') {
        renderDashboard(info.data);
        return;
      }
      if (info.status === 'failed') {
        throw new Error(info.error || 'Job failed');
      }
    }
  }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  // --- Dashboard rendering ---

  function num(v) {
    if (v == null || v === '') return 0;
    const n = Number(String(v).replace(/[^0-9.\-eE]/g, ''));
    return Number.isFinite(n) ? n : 0;
  }

  function firstKey(headers, candidates) {
    const lower = headers.map(h => h.toLowerCase());
    for (const c of candidates) {
      const idx = lower.indexOf(c.toLowerCase());
      if (idx !== -1) return headers[idx];
    }
    // partial match
    for (const c of candidates) {
      const idx = lower.findIndex(h => h.includes(c.toLowerCase()));
      if (idx !== -1) return headers[idx];
    }
    return null;
  }

  function groupSum(records, keyField, valueField) {
    const map = new Map();
    for (const r of records) {
      const k = (r[keyField] || '—').toString();
      map.set(k, (map.get(k) || 0) + num(r[valueField]));
    }
    return [...map.entries()].sort((a, b) => b[1] - a[1]);
  }

  function renderDashboard(data) {
    currentData = data;
    setProgress(100, `Loaded ${data.records.length} rows. Rendering… ✨`);
    dashSection.classList.remove('hidden');

    const { headers, records } = data;
    const dateField = firstKey(headers, ['date', 'usage_at', 'timestamp', 'day']);
    const qtyField = firstKey(headers, ['quantity', 'credits', 'amount', 'ai_credits', 'units']);
    const grossField = firstKey(headers, ['gross_amount', 'gross', 'total', 'cost']);
    const netField = firstKey(headers, ['net_amount', 'net']);
    const skuField = firstKey(headers, ['sku', 'product', 'model']);
    const orgField = firstKey(headers, ['organization', 'org', 'organization_name']);
    const userField = firstKey(headers, ['user', 'username', 'actor', 'user_login']);

    // Summary
    const totalQty = qtyField ? records.reduce((s, r) => s + num(r[qtyField]), 0) : 0;
    const totalGross = grossField ? records.reduce((s, r) => s + num(r[grossField]), 0) : 0;
    const totalNet = netField ? records.reduce((s, r) => s + num(r[netField]), 0) : 0;
    document.getElementById('stat-rows').textContent = records.length.toLocaleString();
    document.getElementById('stat-qty').textContent = qtyField ? totalQty.toLocaleString(undefined, { maximumFractionDigits: 2 }) : 'n/a';
    document.getElementById('stat-gross').textContent = grossField ? totalGross.toLocaleString(undefined, { maximumFractionDigits: 2 }) : 'n/a';
    document.getElementById('stat-net').textContent = netField ? totalNet.toLocaleString(undefined, { maximumFractionDigits: 2 }) : 'n/a';
    document.getElementById('stat-range').textContent = `${data.start_date || '?'} → ${data.end_date || '?'}`;

    // Charts
    const measureField = qtyField || grossField || netField;

    // Timeline
    if (dateField && measureField) {
      const byDate = new Map();
      for (const r of records) {
        const d = (r[dateField] || '').toString().slice(0, 10);
        if (!d) continue;
        byDate.set(d, (byDate.get(d) || 0) + num(r[measureField]));
      }
      const labels = [...byDate.keys()].sort();
      const values = labels.map(l => byDate.get(l));
      drawChart('chart-timeline', 'line', labels, values, measureField, 'date');
    } else {
      drawEmpty('chart-timeline', 'No date/measure fields detected');
    }

    // Top models
    const modelKeyField = firstKey(headers, ['model']) || skuField;
    if (modelKeyField && measureField) {
      const rows = groupSum(records, modelKeyField, measureField).slice(0, 10);
      drawChart('chart-model', 'bar', rows.map(r => r[0]), rows.map(r => r[1]), measureField, 'model');
    } else drawEmpty('chart-model', 'No model/SKU field detected');

    // Org
    if (orgField && measureField) {
      const rows = groupSum(records, orgField, measureField).slice(0, 10);
      drawChart('chart-org', 'doughnut', rows.map(r => r[0]), rows.map(r => r[1]), measureField, 'org');
    } else drawEmpty('chart-org', 'No organization field detected');

    // User
    if (userField && measureField) {
      const rows = groupSum(records, userField, measureField).slice(0, 10);
      drawChart('chart-user', 'bar', rows.map(r => r[0]), rows.map(r => r[1]), measureField, 'user');
    } else drawEmpty('chart-user', 'No user field detected');

    // User summary table
    currentFields = {
      dateField, qtyField, grossField, netField,
      discField: firstKey(headers, ['discount_amount', 'discount']),
      skuField, orgField, userField,
      modelField: firstKey(headers, ['model'])
    };

    renderUsersTable(records);
  }

  // --- Aggregation helpers ---

  function fmtNum(n, digits = 2) {
    if (!Number.isFinite(n)) return '';
    return n.toLocaleString(undefined, { maximumFractionDigits: digits });
  }

  function aggregateBy(records, keyFn) {
    const map = new Map();
    for (const r of records) {
      const key = keyFn(r);
      if (key == null || key === '') continue;
      let bucket = map.get(key);
      if (!bucket) {
        bucket = { key, records: [], qty: 0, gross: 0, net: 0, disc: 0 };
        map.set(key, bucket);
      }
      bucket.records.push(r);
      const f = currentFields;
      if (f.qtyField) bucket.qty += num(r[f.qtyField]);
      if (f.grossField) bucket.gross += num(r[f.grossField]);
      if (f.netField) bucket.net += num(r[f.netField]);
      if (f.discField) bucket.disc += num(r[f.discField]);
    }
    return [...map.values()];
  }

  function renderUsersTable(records) {
    const f = currentFields;
    const $t = jQuery('#users-table');
    if (usersTable) { usersTable.destroy(); $t.empty(); }

    if (!f.userField) {
      $t[0].innerHTML = '<thead><tr><th>No user/username column detected in report</th></tr></thead>';
      return;
    }

    const groups = aggregateBy(records, r => (r[f.userField] || '').toString().trim());
    groups.sort((a, b) => b.qty - a.qty);

    const columns = [
      { title: 'Username' },
      { title: 'Records', className: 'dt-right' },
      f.qtyField ? { title: 'Total quantity', className: 'dt-right' } : null,
      f.grossField ? { title: 'Gross amount', className: 'dt-right' } : null,
      f.discField ? { title: 'Discount', className: 'dt-right' } : null,
      f.netField ? { title: 'Net amount', className: 'dt-right' } : null,
      f.modelField ? { title: 'Distinct models', className: 'dt-right' } : null,
      f.dateField ? { title: 'Active days', className: 'dt-right' } : null
    ].filter(Boolean);

    const rows = groups.map(g => {
      const distinctModels = f.modelField
        ? new Set(g.records.map(r => r[f.modelField])).size : null;
      const activeDays = f.dateField
        ? new Set(g.records.map(r => (r[f.dateField] || '').toString().slice(0, 10))).size : null;
      const userCell = `<a class="user-link" data-user="${escapeHtml(g.key)}">${escapeHtml(g.key)}</a>`;
      const row = [userCell, g.records.length];
      if (f.qtyField) row.push(fmtNum(g.qty));
      if (f.grossField) row.push(fmtNum(g.gross, 4));
      if (f.discField) row.push(fmtNum(g.disc, 4));
      if (f.netField) row.push(fmtNum(g.net, 4));
      if (f.modelField) row.push(distinctModels);
      if (f.dateField) row.push(activeDays);
      return row;
    });

    usersTable = $t.DataTable({
      data: rows,
      columns,
      pageLength: 25,
      lengthMenu: [10, 25, 50, 100, 250],
      order: [[2, 'desc']]
    });

    $t.off('click', '.user-link').on('click', '.user-link', function () {
      const user = jQuery(this).data('user');
      openDrill('user', String(user));
    });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  function hideDrill() { /* removed: drill-down now runs on a dedicated page */ }

  function drawChart(canvasId, type, labels, values, label, drillType) {
    const ctx = document.getElementById(canvasId);
    if (charts[canvasId]) charts[canvasId].destroy();
    const palette = [
      '#2f81f7', '#a371f7', '#3fb950', '#d29922', '#f85149',
      '#db61a2', '#39c5cf', '#f0883e', '#8957e5', '#57ab5a'
    ];
    const config = {
      type,
      data: {
        labels,
        datasets: [{
          label,
          data: values,
          backgroundColor: type === 'line'
            ? 'rgba(47,129,247,0.2)'
            : labels.map((_, i) => palette[i % palette.length]),
          borderColor: type === 'line' ? '#2f81f7' : 'rgba(255,255,255,0.1)',
          borderWidth: type === 'line' ? 2 : 1,
          tension: 0.25,
          fill: type === 'line'
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        onClick: (_evt, els, chart) => {
          if (!drillType || !els || !els.length) return;
          const idx = els[0].index;
          const key = chart.data.labels[idx];
          openDrill(drillType, key);
        },
        onHover: (evt, els) => {
          if (drillType && evt.native && evt.native.target) {
            evt.native.target.style.cursor = els && els.length ? 'pointer' : 'default';
          }
        },
        plugins: {
          legend: { display: type === 'doughnut', labels: { color: '#e6edf3' } }
        },
        scales: type === 'doughnut' ? {} : {
          x: { ticks: { color: '#8b949e' }, grid: { color: 'rgba(255,255,255,0.05)' } },
          y: { ticks: { color: '#8b949e' }, grid: { color: 'rgba(255,255,255,0.05)' }, beginAtZero: true }
        }
      }
    };
    charts[canvasId] = new Chart(ctx, config);
  }

  // --- Drill-down modal (in-page, uses currentData/currentFields directly) ---

  const drillModal = document.getElementById('drill-modal');
  const drillAggContainer = document.getElementById('drill-agg');
  const drillTables = { agg: [], raw: null };

  const DRILL_TYPE_FIELD = () => ({
    user: currentFields.userField,
    model: currentFields.modelField || currentFields.skuField,
    org: currentFields.orgField,
    date: currentFields.dateField
  });

  const DRILL_TYPE_LABEL = { user: 'User', model: 'Model / SKU', org: 'Organization', date: 'Date' };

  const DRILL_AGG_DEFS = () => ({
    user:  [
      { title: 'By day',            field: currentFields.dateField,                              header: 'Date',         sort: 'key-asc' },
      { title: 'By model / SKU',    field: currentFields.modelField || currentFields.skuField,   header: 'Model / SKU' }
    ],
    model: [
      { title: 'By user',           field: currentFields.userField,                              header: 'User' },
      { title: 'By day',            field: currentFields.dateField,                              header: 'Date',         sort: 'key-asc' },
      { title: 'By organization',   field: currentFields.orgField,                               header: 'Organization' }
    ],
    org:   [
      { title: 'By user',           field: currentFields.userField,                              header: 'User' },
      { title: 'By model / SKU',    field: currentFields.modelField || currentFields.skuField,   header: 'Model / SKU' },
      { title: 'By day',            field: currentFields.dateField,                              header: 'Date',         sort: 'key-asc' }
    ],
    date:  [
      { title: 'By user',           field: currentFields.userField,                              header: 'User' },
      { title: 'By model / SKU',    field: currentFields.modelField || currentFields.skuField,   header: 'Model / SKU' },
      { title: 'By organization',   field: currentFields.orgField,                               header: 'Organization' }
    ]
  });

  function openDrill(type, key) {
    if (!currentData || !currentFields) return;
    const filterField = DRILL_TYPE_FIELD()[type];
    if (!filterField) return;

    const filtered = currentData.records.filter(r => {
      const v = r[filterField];
      if (v == null) return false;
      if (type === 'date') return String(v).slice(0, 10) === String(key).slice(0, 10);
      return String(v).trim() === String(key).trim();
    });

    // Tear down any previous drill tables before rebuilding.
    drillTables.agg.forEach(t => { try { t.destroy(); } catch (_) {} });
    drillTables.agg = [];
    if (drillTables.raw) { try { drillTables.raw.destroy(); } catch (_) {} drillTables.raw = null; }
    drillAggContainer.innerHTML = '';
    jQuery('#drill-raw').empty();

    document.getElementById('drill-modal-title').textContent = `${DRILL_TYPE_LABEL[type] || type}: ${key}`;
    document.getElementById('drill-modal-meta').textContent = currentData.start_date
      ? `Report window: ${currentData.start_date} → ${currentData.end_date || 'today'} · ${filtered.length} matching record(s)`
      : `${filtered.length} matching record(s)`;

    renderDrillStats(filtered);

    const aggs = (DRILL_AGG_DEFS()[type] || []).filter(a => a.field);
    aggs.forEach((spec, i) => renderDrillAgg(spec, filtered, `drill-agg-${i}`));

    renderDrillRaw(filtered);

    if (typeof drillModal.showModal === 'function') drillModal.showModal();
    else drillModal.setAttribute('open', '');
  }

  function closeDrill() {
    if (typeof drillModal.close === 'function') drillModal.close();
    else drillModal.removeAttribute('open');
  }

  document.getElementById('drill-close').addEventListener('click', closeDrill);
  // Close on backdrop click (dialog is the click target when clicking outside content).
  drillModal.addEventListener('click', (e) => { if (e.target === drillModal) closeDrill(); });

  function drillTotals(rs) {
    const f = currentFields;
    const t = { qty: 0, gross: 0, disc: 0, net: 0 };
    for (const r of rs) {
      if (f.qtyField)   t.qty   += num(r[f.qtyField]);
      if (f.grossField) t.gross += num(r[f.grossField]);
      if (f.discField)  t.disc  += num(r[f.discField]);
      if (f.netField)   t.net   += num(r[f.netField]);
    }
    return t;
  }

  function renderDrillStats(rs) {
    const f = currentFields;
    const t = drillTotals(rs);
    const users  = f.userField  ? new Set(rs.map(r => r[f.userField])).size  : null;
    const modelsField = f.modelField || f.skuField;
    const models = modelsField ? new Set(rs.map(r => r[modelsField])).size : null;
    const days   = f.dateField  ? new Set(rs.map(r => String(r[f.dateField] || '').slice(0, 10))).size : null;

    const stats = [
      ['Records', rs.length.toLocaleString()],
      f.qtyField   ? ['Total quantity', fmtNum(t.qty)] : null,
      f.grossField ? ['Gross amount',   fmtNum(t.gross, 4)] : null,
      f.discField  ? ['Discount',       fmtNum(t.disc, 4)] : null,
      f.netField   ? ['Net amount',     fmtNum(t.net, 4)] : null,
      users != null  ? ['Distinct users',  users]  : null,
      models != null ? ['Distinct models', models] : null,
      days != null   ? ['Active days',     days]   : null
    ].filter(Boolean);

    document.getElementById('drill-stats').innerHTML = stats.map(([label, value]) =>
      `<div class="stat"><div class="stat-label">${escapeHtml(label)}</div><div class="stat-value">${escapeHtml(String(value))}</div></div>`
    ).join('');
  }

  function renderDrillAgg(spec, rs, tableId) {
    const f = currentFields;
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `
      <div class="table-controls">
        <h3>${escapeHtml(spec.title)}</h3>
        <button class="csv-btn" data-target="${tableId}" type="button">Download CSV</button>
      </div>
      <div class="table-wrap"><table id="${tableId}" class="display" style="width:100%"></table></div>
    `;
    drillAggContainer.appendChild(card);

    const keyFn = spec.field === f.dateField
      ? (r) => String(r[spec.field] || '').slice(0, 10)
      : (r) => String(r[spec.field] || '').trim();
    const groups = aggregateBy(rs, keyFn);

    if (spec.sort === 'key-asc') groups.sort((a, b) => String(a.key).localeCompare(String(b.key)));
    else groups.sort((a, b) => b.qty - a.qty || b.gross - a.gross);

    const cols = [
      { title: spec.header },
      { title: 'Records', className: 'dt-right' },
      f.qtyField   ? { title: 'Quantity', className: 'dt-right' } : null,
      f.grossField ? { title: 'Gross',    className: 'dt-right' } : null,
      f.discField  ? { title: 'Discount', className: 'dt-right' } : null,
      f.netField   ? { title: 'Net',      className: 'dt-right' } : null
    ].filter(Boolean);

    const rows = groups.map(g => {
      const row = [g.key, g.records.length];
      if (f.qtyField)   row.push(fmtNum(g.qty));
      if (f.grossField) row.push(fmtNum(g.gross, 4));
      if (f.discField)  row.push(fmtNum(g.disc, 4));
      if (f.netField)   row.push(fmtNum(g.net, 4));
      return row;
    });

    const sortCol = f.qtyField ? 2 : 1;
    const dt = jQuery(`#${tableId}`).DataTable({
      data: rows,
      columns: cols,
      pageLength: 10,
      lengthMenu: [10, 25, 50, 100],
      order: spec.sort === 'key-asc' ? [[0, 'asc']] : [[sortCol, 'desc']]
    });
    drillTables.agg.push(dt);
  }

  function renderDrillRaw(rs) {
    const headers = currentData.headers;
    const $t = jQuery('#drill-raw');

    const thead = document.createElement('thead');
    const trh = document.createElement('tr');
    headers.forEach(h => {
      const th = document.createElement('th');
      th.textContent = h;
      trh.appendChild(th);
    });
    thead.appendChild(trh);
    $t[0].appendChild(thead);

    const tbody = document.createElement('tbody');
    for (const r of rs) {
      const tr = document.createElement('tr');
      for (const h of headers) {
        const td = document.createElement('td');
        td.textContent = r[h] != null ? r[h] : '';
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    $t[0].appendChild(tbody);

    drillTables.raw = $t.DataTable({
      pageLength: 25,
      lengthMenu: [10, 25, 50, 100, 250],
      deferRender: true
    });
  }

  // Handle CSV downloads for any drill table (delegated).
  drillModal.addEventListener('click', (e) => {
    const btn = e.target.closest('.csv-btn');
    if (!btn) return;
    const targetId = btn.dataset.target;
    const dt = jQuery(`#${targetId}`).DataTable();
    if (!dt) return;
    exportDataTableToCsv(dt, `${targetId}-${Date.now()}.csv`);
  });

  function exportDataTableToCsv(table, filename) {
    const header = table.columns().header().toArray().map(h => h.textContent);
    const dataRows = table.rows({ search: 'applied', order: 'applied' }).data().toArray();
    const escape = (v) => {
      const s = v == null ? '' : String(v).replace(/<[^>]+>/g, '');
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [header.map(escape).join(',')];
    for (const row of dataRows) {
      const arr = Array.isArray(row) ? row : header.map((_, i) => row[i]);
      lines.push(arr.map(escape).join(','));
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  function drawEmpty(canvasId, msg) {
    const ctx = document.getElementById(canvasId);
    if (charts[canvasId]) charts[canvasId].destroy();
    const parent = ctx.parentElement;
    let placeholder = parent.querySelector('.empty-msg');
    if (!placeholder) {
      placeholder = document.createElement('p');
      placeholder.className = 'empty-msg';
      placeholder.style.color = '#8b949e';
      placeholder.style.fontSize = '13px';
      parent.appendChild(placeholder);
    }
    placeholder.textContent = msg;
  }

  function renderTable_UNUSED() { /* replaced by renderUsersTable + drill-down */ }
})();
