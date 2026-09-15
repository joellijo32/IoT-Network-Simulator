/**
 * @module ui
 * @description Control panel + workspace router (M1/M5). Tabs 1/2/3, Start/Pause/
 *              Step(1 tick)/Reset, speed, scenario select incl. __custom, HUD incl. avail.
 */

const UIController = (() => {
  'use strict';

  /** @type {'stopped'|'running'|'paused'} */
  let state = 'stopped';
  let view = 'studio';

  const SPEED_OPTIONS = [0.5, 1, 2, 5];
  let currentSpeed = 1;

  function init() {
    document.getElementById('btn-start').addEventListener('click', onStart);
    document.getElementById('btn-pause').addEventListener('click', onPause);
    document.getElementById('btn-step').addEventListener('click', onStep);
    document.getElementById('btn-reset').addEventListener('click', onReset);

    SPEED_OPTIONS.forEach(speed => {
      const btn = document.getElementById(`btn-speed-${speed.toString().replace('.', '_')}`);
      if (btn) btn.addEventListener('click', () => onSpeed(speed));
    });

    const scenarioSelect = document.getElementById('scenario-select');
    if (scenarioSelect) {
      scenarioSelect.addEventListener('change', e => {
        if (e.target.value === '__custom') {
          Terminal.log('🧩 Custom topology selected — build in Studio, autosaved to localStorage', 'info');
          const nodes = GraphStore.getNodes(), links = GraphStore.toCanvasLinks();
          if (nodes.length) SimEngine.onTopologyChanged(nodes, links);
          if (state === 'running') { SimEngine.stop(); SimEngine.start(); }
          return;
        }
        Scenarios.load(e.target.value);
        if (state === 'running') { SimEngine.stop(); SimEngine.start(); }
      });
    }

    // Workspace tabs
    document.querySelectorAll('.ws-tab').forEach(btn => {
      btn.addEventListener('click', () => switchView(btn.dataset.view));
    });

    const gotoDash = document.getElementById('btn-goto-dash');
    if (gotoDash) gotoDash.addEventListener('click', () => switchView('observability'));

    // Topology import/export
    document.getElementById('btn-export-topo')?.addEventListener('click', exportTopo);
    document.getElementById('btn-import-topo')?.addEventListener('click', () => {
      document.getElementById('file-import-topo')?.click();
    });
    document.getElementById('file-import-topo')?.addEventListener('change', importTopoFile);

    // Trace toolbar
    document.getElementById('btn-trace-clear')?.addEventListener('click', () => TraceStore.clear());
    ['trace-filter', 'trace-type-filter', 'trace-status-filter'].forEach(id => {
      document.getElementById(id)?.addEventListener('input', () => { try { TraceTable.render(); } catch (e) {} });
    });
    try { TraceStore.onUpdate(() => TraceTable.renderThrottled?.()); } catch (e) {}

    updateButtons();
    updateHUD({ totalSent: 0, totalDelivered: 0, totalDropped: 0, avgLatency: 0 });
  }

  function switchView(v) {
    view = v;
    document.querySelectorAll('.ws-tab').forEach(b => b.classList.toggle('active', b.dataset.view === v));
    document.querySelectorAll('.ws-view').forEach(s => s.classList.remove('active'));
    const map = { studio: 'view-studio', observability: 'view-observability', inspector: 'view-inspector' };
    document.getElementById(map[v])?.classList.add('active');
    // Resize canvas when returning to studio (container size changed while hidden)
    if (v === 'studio') {
      requestAnimationFrame(() => {
        try { CanvasEngine.resize(); } catch (e) {}
        try { CanvasEngine.renderNow(); } catch (e) {}
      });
    }
  }

  function onStart() {
    if (state === 'stopped') {
      // Warn on orphans but allow start (spec)
      try {
        const orphans = GraphStore.getNodes().filter(n => n.orphan);
        if (orphans.length) Terminal.log(`⚠️ Starting with ${orphans.length} orphaned node(s): ${orphans.map(n => n.id).join(', ')} — packets drop NO_ROUTE`, 'warn');
      } catch (e) {}
      SimEngine.start();
      ParticleEngine.start();
      Terminal.log('▶️  Simulation started', 'success');
    } else if (state === 'paused') {
      SimEngine.resume();
      ParticleEngine.start();
      Terminal.log('▶️  Simulation resumed', 'success');
    }
    state = 'running';
    updateButtons();
  }

  function onPause() {
    if (state !== 'running') return;
    SimEngine.pause();
    ParticleEngine.pause();
    state = 'paused';
    updateButtons();
    Terminal.log('⏸️  Simulation paused (SLA clock frozen)', 'info');
  }

  function onStep() {
    // Step exactly 1 tick: ensure paused, then single tick
    if (state === 'stopped') {
      onStart();
      onPause();
    } else if (state === 'running') {
      onPause();
    }
    SimEngine.stepOnce();
    state = 'paused';
    updateButtons();
    Terminal.log('⏭ Stepped +1 tick (800ms)', 'debug');
  }

  function onReset() {
    SimEngine.stop();
    ParticleEngine.reset();
    ChartEngine.clear();
    ChaosEngine.resetAll();
    TelemetryEngine.resetCounter();
    Terminal.clear();
    try { TraceStore.clear(); } catch (e) {}
    state = 'stopped';
    updateButtons();
    updateHUD({ totalSent: 0, totalDelivered: 0, totalDropped: 0, avgLatency: 0 });
    const select = document.getElementById('scenario-select');
    if (select && select.value !== '__custom') Scenarios.load(select.value);
    else if (select && select.value === '__custom') {
      // Re-apply custom (clears sla/metrics, keeps topology)
      const nodes = GraphStore.getNodes(), links = GraphStore.toCanvasLinks();
      SimEngine.onTopologyChanged(nodes, links);
    }
    Terminal.log('🔄 Simulation reset (SLA + metrics wiped)', 'info');
  }

  function onSpeed(speed) {
    currentSpeed = speed;
    SimEngine.setSpeed(speed);
    ParticleEngine.setSpeed(speed);
    Terminal.log(`⚡ Speed set to ${speed}×`, 'debug');
    SPEED_OPTIONS.forEach(s => {
      const btn = document.getElementById(`btn-speed-${s.toString().replace('.', '_')}`);
      if (btn) btn.classList.toggle('active', s === speed);
    });
  }

  function exportTopo() {
    try {
      const data = JSON.stringify(GraphStore.exportJSON(), null, 2);
      const blob = new Blob([data], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'topology.json';
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      URL.revokeObjectURL(a.href);
      Terminal.log('📥 Topology JSON exported', 'success');
    } catch (e) { Terminal.log(`❌ Export failed: ${e.message}`, 'error'); }
  }
  function importTopoFile(e) {
    const f = e.target.files?.[0];
    if (!f) return;
    const r = new FileReader();
    r.onload = () => {
      try {
        GraphStore.importJSON(JSON.parse(r.result));
        DragEngine.syncTopologyToEngines();
        const sel = document.getElementById('scenario-select');
        if (sel) sel.value = '__custom';
        Terminal.log(`📤 Topology imported: ${GraphStore.getNodes().length} nodes, ${GraphStore.getLinks().length} links`, 'success');
      } catch (err) { Terminal.log(`❌ Import failed: ${err.message}`, 'error'); }
      e.target.value = '';
    };
    r.readAsText(f);
  }

  function updateButtons() {
    const btnStart = document.getElementById('btn-start');
    const btnPause = document.getElementById('btn-pause');
    const btnStep = document.getElementById('btn-step');
    const btnReset = document.getElementById('btn-reset');
    if (btnStart) {
      btnStart.disabled = (state === 'running');
      btnStart.textContent = (state === 'paused') ? '▶ Resume' : '▶ Start';
    }
    if (btnPause) btnPause.disabled = (state !== 'running');
    if (btnStep) btnStep.disabled = (state === 'stopped' && false) ? true : false; // always enabled (auto-starts)
    if (btnReset) btnReset.disabled = (state === 'stopped');
    const badge = document.getElementById('sim-status');
    if (badge) {
      badge.className = `status-badge status-${state === 'paused' ? 'paused' : state}`;
      badge.textContent = state.toUpperCase();
    }
  }

  function updateHUD(metrics) {
    setEl('hud-sent', metrics.totalSent);
    setEl('hud-delivered', metrics.totalDelivered);
    setEl('hud-dropped', metrics.totalDropped);
    setEl('hud-latency', `${(metrics.avgLatency || 0).toFixed(1)} ms`);
    const lossPercent = metrics.totalSent > 0
      ? ((metrics.totalDropped / metrics.totalSent) * 100).toFixed(1) : '0.0';
    setEl('hud-loss', `${lossPercent}%`);
  }

  function setEl(id, value) { const el = document.getElementById(id); if (el) el.textContent = value; }

  return {
    init, updateHUD, switchView, onPause,
    getState: () => state, getSpeed: () => currentSpeed, getView: () => view,
  };
})();
