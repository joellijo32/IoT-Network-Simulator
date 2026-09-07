/**
 * @module charts
 * @author Aditya M Manojkumar
 * @description Chart.js Analytics Engine: Integrates Chart.js (loaded via CDN) and renders
 *              two live-updating time-series line graphs — one for Packet Loss % and one for
 *              Network Latency (ms) — that scroll in real-time as simulation data arrives.
 */

const ChartEngine = (() => {
  'use strict';

  const MAX_POINTS = 60; // ~1 minute of history at 1-second intervals

  let lossChart    = null;
  let latencyChart = null;

  // ─── Chart configurations ────────────────────────────────────────────────────

  function makeLossConfig() {
    return {
      type: 'line',
      data: {
        labels: [],
        datasets: [{
          label:           'Packet Loss %',
          data:            [],
          borderColor:     '#F44336',
          backgroundColor: 'rgba(244, 67, 54, 0.12)',
          pointRadius:     2,
          pointHoverRadius:5,
          fill:            true,
          tension:         0.4,
          borderWidth:     2,
        }],
      },
      options: {
        responsive:          true,
        maintainAspectRatio: false,
        animation:           false,
        plugins: {
          legend: {
            labels: { color: '#ccc', font: { size: 11 } },
          },
          tooltip: {
            callbacks: {
              label: ctx => ` ${ctx.parsed.y.toFixed(1)} %`,
            },
          },
        },
        scales: {
          x: {
            ticks:  { color: '#888', font: { size: 9 }, maxTicksLimit: 8 },
            grid:   { color: 'rgba(255,255,255,0.05)' },
          },
          y: {
            min:  0,
            max:  100,
            ticks:{ color: '#888', font: { size: 9 }, callback: v => v + '%' },
            grid: { color: 'rgba(255,255,255,0.05)' },
          },
        },
      },
    };
  }

  function makeLatencyConfig() {
    return {
      type: 'line',
      data: {
        labels: [],
        datasets: [{
          label:           'Avg Latency (ms)',
          data:            [],
          borderColor:     '#29B6F6',
          backgroundColor: 'rgba(41, 182, 246, 0.12)',
          pointRadius:     2,
          pointHoverRadius:5,
          fill:            true,
          tension:         0.4,
          borderWidth:     2,
        }],
      },
      options: {
        responsive:          true,
        maintainAspectRatio: false,
        animation:           false,
        plugins: {
          legend: {
            labels: { color: '#ccc', font: { size: 11 } },
          },
          tooltip: {
            callbacks: {
              label: ctx => ` ${ctx.parsed.y.toFixed(1)} ms`,
            },
          },
        },
        scales: {
          x: {
            ticks:  { color: '#888', font: { size: 9 }, maxTicksLimit: 8 },
            grid:   { color: 'rgba(255,255,255,0.05)' },
          },
          y: {
            min:  0,
            ticks:{ color: '#888', font: { size: 9 }, callback: v => v + ' ms' },
            grid: { color: 'rgba(255,255,255,0.05)' },
          },
        },
      },
    };
  }

  // ─── Initialisation ──────────────────────────────────────────────────────────

  /**
   * Creates both Chart.js instances. Must be called after Chart.js CDN is loaded.
   */
  function init() {
    const lossEl    = document.getElementById('lossChart');
    const latencyEl = document.getElementById('latencyChart');

    if (!lossEl || !latencyEl) {
      console.warn('[ChartEngine] Canvas elements not found');
      return;
    }

    if (typeof Chart === 'undefined') {
      console.warn('[ChartEngine] Chart.js not loaded');
      return;
    }

    // Destroy any existing instances (on reset)
    if (lossChart)    { lossChart.destroy(); }
    if (latencyChart) { latencyChart.destroy(); }

    lossChart    = new Chart(lossEl,    makeLossConfig());
    latencyChart = new Chart(latencyEl, makeLatencyConfig());
  }

  // ─── Live update ─────────────────────────────────────────────────────────────

  /**
   * Pushes a new data point to both charts.
   * @param {number} lossPercent - Packet loss percentage (0–100)
   * @param {number} latencyMs   - Average latency in milliseconds
   */
  function update(lossPercent, latencyMs) {
    if (!lossChart || !latencyChart) return;

    const label = new Date().toLocaleTimeString('en-GB', { hour12: false });

    pushDataPoint(lossChart,    label, Math.min(100, Math.max(0, lossPercent)));
    pushDataPoint(latencyChart, label, Math.max(0, latencyMs));
  }

  /**
   * Appends a data point and scrolls the chart window.
   * @param {Chart}  chart
   * @param {string} label
   * @param {number} value
   */
  function pushDataPoint(chart, label, value) {
    const data   = chart.data.datasets[0].data;
    const labels = chart.data.labels;

    if (labels.length >= MAX_POINTS) {
      labels.shift();
      data.shift();
    }

    labels.push(label);
    data.push(parseFloat(value.toFixed(2)));

    chart.update('none'); // Suppress animation for real-time performance
  }

  /**
   * Clears all chart data (used on reset).
   */
  function clear() {
    [lossChart, latencyChart].forEach(chart => {
      if (!chart) return;
      chart.data.labels = [];
      chart.data.datasets[0].data = [];
      chart.update('none');
    });
  }

  // ─── Public API ──────────────────────────────────────────────────────────────

  return {
    init,
    update,
    clear,
  };
})();
