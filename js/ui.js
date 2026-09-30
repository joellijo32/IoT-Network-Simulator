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
    document.getElementById('btn-start')?.addEventListener('click', onStart);
    document.getElementById('btn-pause')?.addEventListener('click', onPause);
    document.getElementById('btn-step')?.addEventListener('click', onStep);
    document.getElementById('btn-reset')?.addEventListener('click', onReset);

    // Mobile drawer controls
    document.getElementById('mobile-btn-start')?.addEventListener('click', () => { onStart(); });
    document.getElementById('mobile-btn-pause')?.addEventListener('click', () => { onPause(); });
    document.getElementById('mobile-btn-step')?.addEventListener('click', () => { onStep(); });
    document.getElementById('mobile-btn-reset')?.addEventListener('click', () => { onReset(); });

    // Mobile quick bar controls (below topbar)
    document.getElementById('mobile-bar-btn-start')?.addEventListener('click', () => { onStart(); });
    document.getElementById('mobile-bar-btn-pause')?.addEventListener('click', () => { onPause(); });
    document.getElementById('mobile-bar-btn-step')?.addEventListener('click', () => { onStep(); });
    document.getElementById('mobile-bar-btn-reset')?.addEventListener('click', () => { onReset(); });

    // Drawer open/close
    const menuBtn = document.getElementById('btn-topbar-menu');
    const drawer = document.getElementById('topbar-drawer');
    const drawerCloseBtn = document.getElementById('btn-topbar-drawer-close');

    if (menuBtn && drawer) {
      menuBtn.addEventListener('click', () => drawer.classList.toggle('open'));
    }
    if (drawerCloseBtn && drawer) {
      drawerCloseBtn.addEventListener('click', () => drawer.classList.remove('open'));
    }
    if (drawer) {
      drawer.addEventListener('click', e => {
        if (e.target === drawer) drawer.classList.remove('open');
      });
    }

    SPEED_OPTIONS.forEach(speed => {
      const speedStr = speed.toString().replace('.', '_');
      const btn = document.getElementById(`btn-speed-${speedStr}`);
      const mBtn = document.getElementById(`mobile-btn-speed-${speedStr}`);
      if (btn) btn.addEventListener('click', () => onSpeed(speed));
      if (mBtn) mBtn.addEventListener('click', () => onSpeed(speed));
    });

    const scenarioSelect = document.getElementById('scenario-select');
    const scenarioSelectMobile = document.getElementById('scenario-select-mobile');

    function onScenarioChange(val) {
      if (scenarioSelect && scenarioSelect.value !== val) scenarioSelect.value = val;
      if (scenarioSelectMobile && scenarioSelectMobile.value !== val) scenarioSelectMobile.value = val;

      if (val === '__custom') {
        Terminal.log('🧩 Custom topology selected — build in Studio, autosaved to localStorage', 'info');
        const nodes = GraphStore.getNodes(), links = GraphStore.toCanvasLinks();
        if (nodes.length) SimEngine.onTopologyChanged(nodes, links);
        if (state === 'running') { SimEngine.stop(); SimEngine.start(); }
        return;
      }
      Scenarios.load(val);
      if (state === 'running') { SimEngine.stop(); SimEngine.start(); }
    }

    if (scenarioSelect) scenarioSelect.addEventListener('change', e => onScenarioChange(e.target.value));
    if (scenarioSelectMobile) scenarioSelectMobile.addEventListener('change', e => onScenarioChange(e.target.value));

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
      const speedStr = s.toString().replace('.', '_');
      const btn = document.getElementById(`btn-speed-${speedStr}`);
      const mBtn = document.getElementById(`mobile-btn-speed-${speedStr}`);
      if (btn) btn.classList.toggle('active', s === speed);
      if (mBtn) mBtn.classList.toggle('active', s === speed);
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
        const selM = document.getElementById('scenario-select-mobile');
        if (sel) sel.value = '__custom';
        if (selM) selM.value = '__custom';
        Terminal.log(`📤 Topology imported: ${GraphStore.getNodes().length} nodes, ${GraphStore.getLinks().length} links`, 'success');
      } catch (err) { Terminal.log(`❌ Import failed: ${err.message}`, 'error'); }
      e.target.value = '';
    };
    r.readAsText(f);
  }

  function updateButtons() {
    const isRunning = (state === 'running');
    const isPaused = (state === 'paused');
    const isStopped = (state === 'stopped');
    const startText = isPaused ? '▶ Resume' : '▶ Start';

    ['btn-start', 'mobile-btn-start', 'mobile-bar-btn-start'].forEach(id => {
      const b = document.getElementById(id);
      if (b) { b.disabled = isRunning; b.textContent = startText; }
    });
    ['btn-pause', 'mobile-btn-pause', 'mobile-bar-btn-pause'].forEach(id => {
      const b = document.getElementById(id);
      if (b) b.disabled = !isRunning;
    });
    ['btn-step', 'mobile-btn-step', 'mobile-bar-btn-step'].forEach(id => {
      const b = document.getElementById(id);
      if (b) b.disabled = false;
    });
    ['btn-reset', 'mobile-btn-reset', 'mobile-bar-btn-reset'].forEach(id => {
      const b = document.getElementById(id);
      if (b) b.disabled = isStopped;
    });

    document.querySelectorAll('.status-badge').forEach(badge => {
      badge.className = `status-badge status-${state === 'paused' ? 'paused' : state}`;
      badge.textContent = state.toUpperCase();
    });
  }

  function updateHUD(metrics) {
    setHudVal('sent', metrics.totalSent);
    setHudVal('delivered', metrics.totalDelivered);
    setHudVal('dropped', metrics.totalDropped);
    setHudVal('latency', `${(metrics.avgLatency || 0).toFixed(1)} ms`);
    const lossPercent = metrics.totalSent > 0
      ? ((metrics.totalDropped / metrics.totalSent) * 100).toFixed(1) : '0.0';
    setHudVal('loss', `${lossPercent}%`);
  }

  function setHudVal(key, value) {
    document.querySelectorAll(`[data-hud="${key}"]`).forEach(el => {
      el.textContent = value;
    });
  }

  return {
    init, updateHUD, switchView, onPause,
    getState: () => state, getSpeed: () => currentSpeed, getView: () => view,
  };
})();

