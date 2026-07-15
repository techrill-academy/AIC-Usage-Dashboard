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

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
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
      drawChart('chart-timeline', 'line', labels, values, measureField);
    } else {
      drawEmpty('chart-timeline', 'No date/measure fields detected');
    }

    // SKU
    if (skuField && measureField) {
      const rows = groupSum(records, skuField, measureField).slice(0, 10);
      drawChart('chart-sku', 'bar', rows.map(r => r[0]), rows.map(r => r[1]), measureField);
    } else drawEmpty('chart-sku', 'No SKU/product field detected');

    // Org
    if (orgField && measureField) {
      const rows = groupSum(records, orgField, measureField).slice(0, 10);
      drawChart('chart-org', 'doughnut', rows.map(r => r[0]), rows.map(r => r[1]), measureField);
    } else drawEmpty('chart-org', 'No organization field detected');

    // User
    if (userField && measureField) {
      const rows = groupSum(records, userField, measureField).slice(0, 10);
      drawChart('chart-user', 'bar', rows.map(r => r[0]), rows.map(r => r[1]), measureField);
    } else drawEmpty('chart-user', 'No user field detected');

    // User summary table with drill-down
    currentFields = {
      dateField, qtyField, grossField, netField,
      discField: firstKey(headers, ['discount_amount', 'discount']),
      skuField, orgField, userField,
      modelField: firstKey(headers, ['model'])
    };
    renderUsersTable(records);
    hideDrill();
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
      showDrill(String(user));
    });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  function hideDrill() {
    document.getElementById('drill-card').classList.add('hidden');
    document.getElementById('users-card').classList.remove('hidden');
  }

  function showDrill(username) {
    const f = currentFields;
    const userRecords = currentData.records.filter(r => (r[f.userField] || '').toString().trim() === username);
    document.getElementById('drill-user').textContent = username;

    renderDailyTable(userRecords);
    renderModelTable(userRecords);

    document.getElementById('users-card').classList.add('hidden');
    document.getElementById('drill-card').classList.remove('hidden');
    document.getElementById('drill-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function renderDailyTable(userRecords) {
    const f = currentFields;
    const $t = jQuery('#daily-table');
    if (dailyTable) { dailyTable.destroy(); $t.empty(); }

    if (!f.dateField) {
      $t[0].innerHTML = '<thead><tr><th>No date column detected</th></tr></thead>';
      return;
    }

    const groups = aggregateBy(userRecords, r => (r[f.dateField] || '').toString().slice(0, 10));
    groups.sort((a, b) => a.key.localeCompare(b.key));

    const columns = [
      { title: 'Date' },
      { title: 'Records', className: 'dt-right' },
      f.qtyField ? { title: 'Quantity', className: 'dt-right' } : null,
      f.grossField ? { title: 'Gross', className: 'dt-right' } : null,
      f.discField ? { title: 'Discount', className: 'dt-right' } : null,
      f.netField ? { title: 'Net', className: 'dt-right' } : null,
      f.modelField ? { title: 'Models used', className: 'dt-right' } : null
    ].filter(Boolean);

    const rows = groups.map(g => {
      const models = f.modelField ? new Set(g.records.map(r => r[f.modelField])).size : null;
      const row = [g.key, g.records.length];
      if (f.qtyField) row.push(fmtNum(g.qty));
      if (f.grossField) row.push(fmtNum(g.gross, 4));
      if (f.discField) row.push(fmtNum(g.disc, 4));
      if (f.netField) row.push(fmtNum(g.net, 4));
      if (f.modelField) row.push(models);
      return row;
    });

    dailyTable = $t.DataTable({
      data: rows,
      columns,
      pageLength: 25,
      lengthMenu: [10, 25, 50, 100],
      order: [[0, 'asc']]
    });
  }

  function renderModelTable(userRecords) {
    const f = currentFields;
    const $t = jQuery('#model-table');
    if (modelTable) { modelTable.destroy(); $t.empty(); }

    const keyField = f.modelField || f.skuField;
    if (!keyField) {
      $t[0].innerHTML = '<thead><tr><th>No model/SKU column detected</th></tr></thead>';
      return;
    }

    const groups = aggregateBy(userRecords, r => (r[keyField] || '—').toString());
    groups.sort((a, b) => b.qty - a.qty);

    const columns = [
      { title: f.modelField ? 'Model' : 'SKU' },
      f.skuField && f.modelField ? { title: 'SKU(s)' } : null,
      { title: 'Records', className: 'dt-right' },
      f.qtyField ? { title: 'Quantity', className: 'dt-right' } : null,
      f.grossField ? { title: 'Gross', className: 'dt-right' } : null,
      f.discField ? { title: 'Discount', className: 'dt-right' } : null,
      f.netField ? { title: 'Net', className: 'dt-right' } : null,
      f.dateField ? { title: 'Active days', className: 'dt-right' } : null
    ].filter(Boolean);

    const rows = groups.map(g => {
      const skus = f.skuField && f.modelField
        ? [...new Set(g.records.map(r => r[f.skuField]))].join(', ') : null;
      const days = f.dateField
        ? new Set(g.records.map(r => (r[f.dateField] || '').toString().slice(0, 10))).size : null;
      const row = [g.key];
      if (skus !== null) row.push(skus);
      row.push(g.records.length);
      if (f.qtyField) row.push(fmtNum(g.qty));
      if (f.grossField) row.push(fmtNum(g.gross, 4));
      if (f.discField) row.push(fmtNum(g.disc, 4));
      if (f.netField) row.push(fmtNum(g.net, 4));
      if (f.dateField) row.push(days);
      return row;
    });

    // Determine best default-sort column (quantity, then gross, then records)
    let sortIdx = f.skuField && f.modelField ? 2 : 1; // "Records" col
    if (f.qtyField) sortIdx += 1;
    else if (f.grossField) sortIdx += 1;

    modelTable = $t.DataTable({
      data: rows,
      columns,
      pageLength: 25,
      lengthMenu: [10, 25, 50, 100],
      order: [[sortIdx, 'desc']]
    });
  }

  function skusCol(_f) { return 0; /* legacy, unused */ }

  document.getElementById('drill-back').addEventListener('click', () => {
    hideDrill();
    document.getElementById('users-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  function drawChart(canvasId, type, labels, values, label) {
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
