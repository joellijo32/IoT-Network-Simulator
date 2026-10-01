/**
 * @module dashboard
 * @description Observability Desk: KPI tiles + 2 timeseries + state timeline.
 *              Buffers every tick, renders batched every 1.5s. Queue depth lives
 *              only in Prometheus gauges (heatmap panel removed).
 */

const DashboardEngine = (() => {
  'use strict';

  let tputChart = null, latChart = null;
  let lastRender = 0;
  const RENDER_MS = 1500;

  function init() {
    if (typeof Chart === 'undefined') { console.warn('[Dashboard] Chart.js missing'); return; }
    const tputEl = document.getElementById('dash-tputChart');
    const latEl = document.getElementById('dash-latChart');
    if (!tputEl || !latEl) return;
    if (tputChart) tputChart.destroy();
    if (latChart) latChart.destroy();
    const base = (extra) => ({
      type: 'line',
      data: { labels: [], datasets: [] },
      options: {
        responsive: true, maintainAspectRatio: false, animation: false,
        plugins: { legend: { labels: { color: '#9AA6BC', font: { size: 10 } } } },
        scales: {
          x: { ticks: { color: '#5B6B85', font: { size: 9 }, maxTicksLimit: 8 }, grid: { color: 'rgba(255,255,255,0.05)' } },
          y: { min: 0, ticks: { color: '#5B6B85', font: { size: 9 } }, grid: { color: 'rgba(255,255,255,0.05)' } },
        },
        ...extra,
      },
    });
    tputChart = new Chart(tputEl, base());
    tputChart.data.datasets = [
      { label: 'sent/tick', data: [], borderColor: '#00E5FF', pointRadius: 0, tension: 0.3, borderWidth: 2 },
      { label: 'delivered/tick', data: [], borderColor: '#4CAF50', pointRadius: 0, tension: 0.3, borderWidth: 2 },
      { label: 'loss %', data: [], borderColor: '#F44336', pointRadius: 0, tension: 0.3, borderWidth: 2, yAxisID: 'y1' },
    ];
    tputChart.options.scales.y1 = { position: 'right', min: 0, max: 100, ticks: { color: '#5B6B85', font: { size: 9 } }, grid: { display: false } };
    latChart = new Chart(latEl, base());
    latChart.data.datasets = [
      { label: 'p50', data: [], borderColor: '#00E5FF', pointRadius: 0, tension: 0.3, borderWidth: 2 },
      { label: 'p95', data: [], borderColor: '#FFB300', pointRadius: 0, tension: 0.3, borderWidth: 2 },
      { label: 'p99', data: [], borderColor: '#F44336', pointRadius: 0, tension: 0.3, borderWidth: 2 },
    ];
  }

  /** Called every tick with fresh totals; throttles canvas renders to 1.5s. */
  function onTick(totals) {
    const now = performance.now();
    updateKPIs(totals);
    if (now - lastRender < RENDER_MS) { updateMatrices(false); return; }
    lastRender = now;
    renderCharts();
    updateMatrices(true);
  }

  function updateKPIs(totals) {
    const set = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = v; };
    let avail = 100, up = 0, total = 0, incidents = 0;
    try {
      const nodes = GraphStore.getNodes();
      avail = SLAEngine.systemAvailability(nodes);
      const ac = SLAEngine.activeCount(nodes);
      up = ac.up; total = ac.total;
      incidents = nodes.reduce((a, n) => a + (SLAEngine.stats(n.id).incidents || 0), 0);
    } catch (e) {}
    const q = MetricsRegistry.latencyQuantiles();
    const loss = totals.totalSent ? (totals.totalDropped / totals.totalSent) * 100 : 0;
    set('kpi-avail', avail.toFixed(1) + '%');
    set('kpi-avail-sub', `${incidents} incidents`);
    set('kpi-nodes', `${up} / ${total}`);
    try {
      const links = GraphStore.getLinks();
      const upLinks = links.filter(l => (l.state || 'up') === 'up').length;
      set('kpi-nodes-sub', `${upLinks}/${links.length} links up`);
    } catch (e) {}
    set('kpi-drops', String(totals.totalDropped));
    set('kpi-drops-sub', `loss ${loss.toFixed(1)}%`);
    set('kpi-p95', `${q.p95.toFixed(0)} ms`);
    set('kpi-p95-sub', `p50 ${q.p50.toFixed(0)} ms · n=${q.n}`);
    const ka = document.getElementById('kpi-avail');
    if (ka) ka.className = 'kpi-value ' + (avail >= 99 ? 'good' : avail >= 90 ? 'warn' : 'bad');
    try {
      document.querySelectorAll('[data-hud="avail"]').forEach(ha => {
        ha.textContent = avail.toFixed(1) + '%';
      });
    } catch (e) {}
  }

  function renderCharts() {
    const h = MetricsRegistry.getHistory();
    if (tputChart) {
      tputChart.data.labels = [...h.labels];
      tputChart.data.datasets[0].data = [...h.sent];
      tputChart.data.datasets[1].data = [...h.delivered];
      tputChart.data.datasets[2].data = h.lossPct.map(v => parseFloat(v.toFixed(2)));
      tputChart.update('none');
    }
    if (latChart) {
      latChart.data.labels = [...h.labels];
      latChart.data.datasets[0].data = [...h.p50];
      latChart.data.datasets[1].data = [...h.p95];
      latChart.data.datasets[2].data = [...h.p99];
      latChart.update('none');
    }
  }

  function updateMatrices(force) {
    // Node state timeline only (queue heatmap removed; queue depth lives on
    // in Prometheus gauges for the future Grafana cutover).
    try {
      const tl = document.getElementById('state-timeline');
      if (tl && (force || !tl.children.length)) {
        const h = MetricsRegistry.getHistory();
        const ids = [...h.stateSeries.keys()].slice(0, 10);
        tl.innerHTML = ids.map(id => {
          const series = (h.stateSeries.get(id) || []).slice(-30);
          const segs = Array.from({ length: 30 }, (_, i) => {
            const s = series[series.length - 30 + i] ?? 'unknown';
            return `<div class="gantt-seg ${s === 'up' ? '' : s === 'degraded' ? 'degraded' : s === 'down' ? 'down' : 'unknown'}"></div>`;
          }).join('');
          return `<div class="gantt-row"><div class="gantt-label">${id}</div><div class="gantt-track">${segs}</div></div>`;
        }).join('') || '<div class="slider-name">no state history yet — start the sim</div>';
      }
    } catch (e) { console.warn('[Dashboard] timeline update failed', e); }
  }

  function clear() {
    [tputChart, latChart].forEach(c => {
      if (!c) return;
      c.data.labels = []; c.data.datasets.forEach(d => { d.data = []; }); c.update('none');
    });
    const tl = document.getElementById('state-timeline'); if (tl) tl.innerHTML = '';
  }

  return { init, onTick, clear };
})();
