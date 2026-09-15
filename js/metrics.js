/**
 * @module metrics
 * @description Prometheus-compatible in-memory registry (M4 foundation, M1 scaffold).
 *              Sole source of truth for counters/gauges/histograms. Charts and the
 *              Observability Desk read from here; sim code only writes here.
 *              Later migration: exportPromText() -> push agent -> /metrics route.
 *              Labels: {topology, node_id, node_type, sensor_type, reason}
 *              Reasons: packet_loss|buffer_overflow|link_down|ttl_expired|battery_dead|gateway_killed|no_route
 */

const MetricsRegistry = (() => {
  'use strict';

  const REASONS = ['packet_loss', 'buffer_overflow', 'link_down', 'ttl_expired', 'battery_dead', 'gateway_killed', 'no_route'];

  let topology = 'factory';
  const counters = new Map(); // key -> {name, labels, value, help}
  const gauges = new Map();
  const histograms = new Map(); // name -> {buckets, samples:[], help}

  // Rolling window for dashboard (60s @800ms tick ≈ 75 points)
  const WINDOW_POINTS = 75;
  const history = {
    labels: [],
    sent: [], delivered: [], dropped: [], lossPct: [],
    p50: [], p95: [], p99: [], avg: [],
    stateSeries: new Map(), // nodeId -> ['up'|'degraded'|'down'...]
  };
  let latencySamples = []; // rolling last 200 for quantiles
  let lastTick = { sent: 0, delivered: 0, dropped: 0 };

  function ckey(name, labels) { return name + '|' + JSON.stringify(labels); }

  function registerCounter(name, help) { counters.set(name, { name, help, series: new Map() }); }
  function registerGauge(name, help) { gauges.set(name, { name, help, series: new Map() }); }
  function registerHistogram(name, help) { histograms.set(name, { name, help, samples: [] }); }

  function incCounter(name, labels, by = 1) {
    let c = counters.get(name);
    if (!c) { registerCounter(name, name); c = counters.get(name); }
    const k = ckey(name, labels);
    c.series.set(k, { labels, value: (c.series.get(k)?.value || 0) + by });
  }
  function setGauge(name, labels, value) {
    let g = gauges.get(name);
    if (!g) { registerGauge(name, name); g = gauges.get(name); }
    g.series.set(ckey(name, labels), { labels, value });
  }
  function observeHistogram(name, value) {
    let h = histograms.get(name);
    if (!h) { registerHistogram(name, name); h = histograms.get(name); }
    h.samples.push(value);
    if (h.samples.length > 500) h.samples = h.samples.slice(-500);
  }

  function setTopology(t) { topology = t || topology; }
  function getTopology() { return topology; }

  function quantile(sorted, q) {
    if (!sorted.length) return 0;
    const idx = Math.min(sorted.length - 1, Math.floor(q * sorted.length));
    return sorted[idx];
  }
  function latencyQuantiles() {
    const s = [...latencySamples].sort((a, b) => a - b);
    return { p50: quantile(s, 0.5), p95: quantile(s, 0.95), p99: quantile(s, 0.99), avg: s.length ? s.reduce((a, b) => a + b, 0) / s.length : 0, n: s.length };
  }

  /** Called once per worker TICK from SimEngine. */
  function recordTick(packets, totals, queueDepths, nodeStates) {
    packets.forEach(p => {
      const base = { topology, node_id: p.sensorId || p.gatewayId || 'unknown', node_type: p.nodeType || 'sensor', sensor_type: p.sensorType || 'temperature' };
      if (p.status === 'dropped') {
        const reason = (p.dropReason || 'packet-loss').replace(/-/g, '_');
        const r = REASONS.includes(reason) ? reason : 'packet_loss';
        incCounter('iot_packets_dropped_total', { ...base, reason });
        if (r === 'packet_loss') incCounter('iot_node_packet_loss_total', { topology, node_id: base.node_id, reason: r });
      } else {
        incCounter('iot_packets_delivered_total', { topology, gateway: p.gatewayId || '', sensor_type: base.sensor_type });
      }
      incCounter('iot_packets_sent_total', { topology, sensor_type: base.sensor_type });
      if (p.coapDuplicate) incCounter('coap_duplicate_dropped_total', { topology, node_id: base.node_id });
      if (p.latency > 0) { observeHistogram('iot_latency_ms', p.latency); latencySamples.push(p.latency); }
    });
    if (latencySamples.length > 200) latencySamples = latencySamples.slice(-200);

    (queueDepths || []).forEach(({ nodeId, depth, capacity }) => {
      // Gauges retained for .prom export + future Grafana cutover (heatmap panel removed).
      setGauge('iot_gateway_queue_depth', { topology, gateway: nodeId }, depth);
      setGauge('iot_node_buffer_utilization', { topology, node_id: nodeId }, capacity ? depth / capacity : 0);
    });
    (nodeStates || []).forEach(({ nodeId, state }) => {
      setGauge('iot_gateway_up', { topology, gateway: nodeId }, state === 'up' ? 1 : 0);
      if (!history.stateSeries.has(nodeId)) history.stateSeries.set(nodeId, []);
      const s = history.stateSeries.get(nodeId); s.push(state);
      if (s.length > WINDOW_POINTS) s.shift();
    });

    // Window history
    const label = new Date().toLocaleTimeString('en-GB', { hour12: false });
    history.labels.push(label);
    ['sent', 'delivered', 'dropped', 'lossPct', 'p50', 'p95', 'p99', 'avg'].forEach(k => { if (!history[k]) history[k] = []; });
    const dSent = totals.totalSent - lastTick.sent;
    const dDel = totals.totalDelivered - lastTick.delivered;
    const dDrop = totals.totalDropped - lastTick.dropped;
    lastTick = { sent: totals.totalSent, delivered: totals.totalDelivered, dropped: totals.totalDropped };
    const q = latencyQuantiles();
    history.sent.push(dSent); history.delivered.push(dDel); history.dropped.push(dDrop);
    history.lossPct.push(totals.totalSent ? (totals.totalDropped / totals.totalSent) * 100 : 0);
    history.p50.push(q.p50); history.p95.push(q.p95); history.p99.push(q.p99); history.avg.push(q.avg);
    Object.keys(history).forEach(k => {
      if (Array.isArray(history[k]) && history[k].length > WINDOW_POINTS) history[k].shift();
    });
  }

  function reset() {
    counters.clear(); gauges.clear();
    histograms.forEach(h => { h.samples = []; });
    latencySamples = [];
    lastTick = { sent: 0, delivered: 0, dropped: 0 };
    history.labels = []; history.sent = []; history.delivered = []; history.dropped = [];
    history.lossPct = []; history.p50 = []; history.p95 = []; history.p99 = []; history.avg = [];
    history.stateSeries.clear();
  }

  function promLabelStr(labels) {
    return Object.entries(labels).map(([k, v]) => `${k}="${String(v).replace(/"/g, '\\"')}"`).join(',');
  }
  /** Prometheus text exposition for the .prom snapshot download + future /metrics route. */
  function exportPromText() {
    const lines = [];
    counters.forEach(c => {
      lines.push(`# HELP ${c.name} ${c.help || c.name}`);
      lines.push(`# TYPE ${c.name} counter`);
      if (c.series.size === 0) lines.push(`${c.name} 0`);
      c.series.forEach(({ labels, value }) => lines.push(`${c.name}{${promLabelStr(labels)}} ${value}`));
    });
    gauges.forEach(g => {
      lines.push(`# HELP ${g.name} ${g.help || g.name}`);
      lines.push(`# TYPE ${g.name} gauge`);
      if (g.series.size === 0) lines.push(`${g.name} 0`);
      g.series.forEach(({ labels, value }) => lines.push(`${g.name}{${promLabelStr(labels)}} ${value}`));
    });
    histograms.forEach(h => {
      lines.push(`# HELP ${h.name} ${h.help || h.name}`);
      lines.push(`# TYPE ${h.name} histogram`);
      const s = [...h.samples].sort((a, b) => a - b);
      const q = { p50: quantile(s, 0.5), p95: quantile(s, 0.95), p99: quantile(s, 0.99) };
      lines.push(`${h.name}_count ${h.samples.length}`);
      lines.push(`${h.name}_sum ${h.samples.reduce((a, b) => a + b, 0).toFixed(2)}`);
      lines.push(`${h.name}_p50 ${q.p50.toFixed(2)}`);
      lines.push(`${h.name}_p95 ${q.p95.toFixed(2)}`);
      lines.push(`${h.name}_p99 ${q.p99.toFixed(2)}`);
    });
    return lines.join('\n') + '\n';
  }

  // Seed known metric families
  registerCounter('iot_packets_sent_total', 'Total packets generated');
  registerCounter('iot_packets_delivered_total', 'Total packets delivered to server');
  registerCounter('iot_packets_dropped_total', 'Total packets dropped by reason');
  registerCounter('iot_node_packet_loss_total', 'Loss by node');
  registerCounter('coap_duplicate_dropped_total', 'CoAP duplicate MIDs dropped at gateway');
  registerGauge('iot_gateway_queue_depth', 'Current gateway queue depth');
  registerGauge('iot_node_buffer_utilization', 'Buffer utilization 0-1');
  registerGauge('iot_gateway_up', 'Gateway up 1/0');
  registerGauge('iot_node_battery', 'Sensor battery percent');
  registerHistogram('iot_latency_ms', 'End-to-end latency ms');

  return {
    REASONS, WINDOW_POINTS,
    setTopology, getTopology, recordTick, reset, exportPromText,
    incCounter, setGauge, observeHistogram, latencyQuantiles,
    getHistory: () => history,
    getCounters: () => counters, getGauges: () => gauges,
  };
})();
