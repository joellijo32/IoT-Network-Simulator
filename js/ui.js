/**
 * @module ui
 * @author Levin Polly
 * @description Control Panel & UI Layout: Manages the top navigation bar controls including
 *              Start, Pause, Reset, and Simulation Speed multiplier buttons (0.5×, 1×, 2×, 5×).
 *              Drives the simulation state machine and updates button states accordingly.
 */

const UIController = (() => {
  'use strict';

  // ─── State machine ───────────────────────────────────────────────────────────

  /** @type {'stopped'|'running'|'paused'} */
  let state = 'stopped';

  const SPEED_OPTIONS = [0.5, 1, 2, 5];
  let   currentSpeed  = 1;

  // ─── Init ────────────────────────────────────────────────────────────────────

  /**
   * Initialises all control panel UI bindings. Must be called after DOM is ready.
   */
  function init() {
    document.getElementById('btn-start').addEventListener('click', onStart);
    document.getElementById('btn-pause').addEventListener('click', onPause);
    document.getElementById('btn-reset').addEventListener('click', onReset);

    // Speed multiplier buttons
    SPEED_OPTIONS.forEach(speed => {
      const btn = document.getElementById(`btn-speed-${speed.toString().replace('.', '_')}`);
      if (btn) {
        btn.addEventListener('click', () => onSpeed(speed));
      }
    });

    // Scenario dropdown
    const scenarioSelect = document.getElementById('scenario-select');
    if (scenarioSelect) {
      scenarioSelect.addEventListener('change', e => {
        Scenarios.load(e.target.value);
        // If running, restart so new topology takes effect
        if (state === 'running') {
          SimEngine.stop();
          SimEngine.start();
        }
      });
    }

    updateButtons();
    updateHUD({ totalSent: 0, totalDelivered: 0, totalDropped: 0, avgLatency: 0 });
  }

  // ─── Handlers ────────────────────────────────────────────────────────────────

  function onStart() {
    if (state === 'stopped') {
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
    Terminal.log('⏸️  Simulation paused', 'info');
  }

  function onReset() {
    SimEngine.stop();
    ParticleEngine.reset();
    ChartEngine.clear();
    ChaosEngine.resetAll();
    TelemetryEngine.resetCounter();
    Terminal.clear();

    state = 'stopped';
    updateButtons();
    updateHUD({ totalSent: 0, totalDelivered: 0, totalDropped: 0, avgLatency: 0 });

    // Reload default scenario to restore positions
    const select = document.getElementById('scenario-select');
    if (select) Scenarios.load(select.value);

    Terminal.log('🔄 Simulation reset', 'info');
  }

  function onSpeed(speed) {
    currentSpeed = speed;
    SimEngine.setSpeed(speed);
    ParticleEngine.setSpeed(speed);
    Terminal.log(`⚡ Speed set to ${speed}×`, 'debug');

    // Visual: highlight active speed button
    SPEED_OPTIONS.forEach(s => {
      const btn = document.getElementById(`btn-speed-${s.toString().replace('.', '_')}`);
      if (btn) btn.classList.toggle('active', s === speed);
    });
  }

  // ─── UI helpers ──────────────────────────────────────────────────────────────

  /**
   * Updates Start/Pause/Reset button enabled/disabled/label states.
   */
  function updateButtons() {
    const btnStart = document.getElementById('btn-start');
    const btnPause = document.getElementById('btn-pause');
    const btnReset = document.getElementById('btn-reset');

    if (btnStart) {
      btnStart.disabled    = (state === 'running');
      btnStart.textContent = (state === 'paused') ? '▶ Resume' : '▶ Start';
    }
    if (btnPause) btnPause.disabled = (state !== 'running');
    if (btnReset) btnReset.disabled = (state === 'stopped');

    // Status badge
    const badge = document.getElementById('sim-status');
    if (badge) {
      badge.className   = `status-badge status-${state}`;
      badge.textContent = state.toUpperCase();
    }
  }

  /**
   * Updates the HUD metric counters.
   * @param {{ totalSent: number, totalDelivered: number, totalDropped: number, avgLatency: number }} metrics
   */
  function updateHUD(metrics) {
    setEl('hud-sent',      metrics.totalSent);
    setEl('hud-delivered', metrics.totalDelivered);
    setEl('hud-dropped',   metrics.totalDropped);
    setEl('hud-latency',   `${(metrics.avgLatency || 0).toFixed(1)} ms`);

    const lossPercent = metrics.totalSent > 0
      ? ((metrics.totalDropped / metrics.totalSent) * 100).toFixed(1)
      : '0.0';
    setEl('hud-loss', `${lossPercent}%`);
  }

  function setEl(id, value) {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
  }

  // ─── Public API ──────────────────────────────────────────────────────────────

  return {
    init,
    updateHUD,
    getState:   () => state,
    getSpeed:   () => currentSpeed,
  };
})();
