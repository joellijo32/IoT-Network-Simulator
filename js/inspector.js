/**
 * @module inspector
 * @description Slide-over Inspector Drawer (M1 shell, M2/M3/M5 full): node/link
 *              properties, Sever/Restore, Replace Battery, Delete; PDU modal
 *              L2/L3/L4/L7. Click particle/terminal pauses + opens PDU.
 */

const Inspector = (() => {
  'use strict';

  let current = { kind: null, id: null };
  let lastPacket = null;

  function el(id) { return document.getElementById(id); }
  function drawer() { return el('inspector-drawer'); }

  function open() { drawer()?.classList.add('open'); }
  function close() {
    drawer()?.classList.remove('open');
    current = { kind: null, id: null };
    try { CanvasEngine.setSelected(null, null); } catch (e) {}
    try { DragEngine.updateStatusbar?.(); } catch (e) {}
  }

  function openNode(id) {
    const n = GraphStore.getNode(id);
    if (!n) return;
    current = { kind: 'node', id };
    try { CanvasEngine.setSelected('node', id); } catch (e) {}
    renderNode(n);
    open();
    try { DragEngine.updateStatusbar?.(); } catch (e) {}
  }
  function openLink(id) {
    const l = GraphStore.getLink(id);
    if (!l) return;
    current = { kind: 'link', id };
    try { CanvasEngine.setSelected('link', id); } catch (e) {}
    renderLink(l);
    open();
    try { DragEngine.updateStatusbar?.(); } catch (e) {}
  }
  function refresh() {
    if (!current.kind) return;
    if (current.kind === 'node') { const n = GraphStore.getNode(current.id); if (n) renderNode(n); else close(); }
    else { const l = GraphStore.getLink(current.id); if (l) renderLink(l); else close(); }
  }

  function esc(s) {
    return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function slaLine(id) {
    try {
      const s = SLAEngine.stats(id);
      return `<div class="kv-grid"><dt>Availability</dt><dd>${s.availability.toFixed(1)}% (${s.state})</dd>`
        + `<dt>Downtime</dt><dd>${s.downtimeS.toFixed(1)} s</dd>`
        + `<dt>Incidents</dt><dd>${s.incidents}</dd>`
        + `<dt>MTTR</dt><dd>${s.mttr.toFixed(1)} s</dd></div>`;
    } catch (e) { return ''; }
  }

  function renderNode(n) {
    el('drawer-title').textContent = `${n.icon || (n.type === 'gateway' ? '⬡' : '☁️')} ${n.label} (${n.id})`;
    const q = (() => { try { return GatewayQueue.getQueue(n.id); } catch (e) { return null; } })();
    const cap = (() => { try { return GatewayQueue.getCapacity(n.id); } catch (e) { return 20; } })();
    const batt = n.type === 'sensor' ? `<dt>Battery</dt><dd>${n.dead ? '0% DEAD' : n.battery.toFixed?.(1) + '%' || n.battery + '%'}${n.lowPower ? ' (LOW-POWER)' : ''}</dd>` : `<dt>Power</dt><dd>mains ∞</dd>`;
    const body = el('drawer-body');
    body.innerHTML = `
      <div class="kv-grid">
        <dt>Type</dt><dd>${esc(n.type)}${n.sensorType ? ' · ' + esc(n.sensorType) : ''}</dd>
        <dt>IP</dt><dd>${esc(n.ip || '—')}</dd>
        <dt>IPv6</dt><dd>${esc(n.ipv6 || '—')}</dd>
        <dt>MAC</dt><dd>${esc(n.mac || '—')}</dd>
        ${batt}
        <dt>Status</dt><dd>${n.dead ? 'dead' : n.killed ? 'killed' : n.orphan ? 'orphan NO_ROUTE' : (n.slaState || 'up')}</dd>
        ${q ? `<dt>Queue</dt><dd>${q.buffer.length}/${cap} (${Math.round(q.buffer.length / cap * 100)}%) · proc ${q.processed} · drop ${q.dropped}</dd>` : ''}
        ${n.type === 'server' ? `<dt>Received</dt><dd>${n.received || 0}</dd>` : ''}
      </div>
      <div>
        <div class="slider-name" style="margin-bottom:4px">Label</div>
        <input id="drawer-label" value="${esc(n.label)}" style="width:100%;background:#0b111e;border:1px solid var(--border);border-radius:6px;color:var(--text-primary);padding:6px 8px" />
      </div>
      ${slaLine(n.id)}
      <div class="drawer-actions">
        ${n.type === 'sensor' && (n.dead || (n.battery ?? 100) < 100) ? `<button class="btn btn-primary" id="drawer-battery">🔋 Replace Battery</button>` : ''}
        <button class="btn btn-danger" id="drawer-delete">🗑 Delete node</button>
      </div>
      <div class="slider-name">Downstream links</div>
      <div id="drawer-links"></div>
    `;
    const labelInput = el('drawer-label');
    labelInput?.addEventListener('change', () => {
      n.label = labelInput.value.slice(0, 32) || n.label;
      try { GraphStore.emit({ kind: 'rename' }); } catch (e) {}
      try { CanvasEngine.renderNow(); } catch (e) {}
    });
    el('drawer-battery')?.addEventListener('click', () => { BatteryEngine.replaceBattery(n.id); refresh(); try { CanvasEngine.renderNow(); } catch (e) {} });
    el('drawer-delete')?.addEventListener('click', () => { GraphStore.removeNode(n.id); DragEngine.syncTopologyToEngines(); close(); });
    const lw = el('drawer-links');
    if (lw) {
      const outs = GraphStore.getLinks().filter(l => l.source === n.id);
      const ins = GraphStore.getLinks().filter(l => l.target === n.id);
      lw.innerHTML = (outs.map(l => linkRow(l, '→')).join('') + ins.map(l => linkRow(l, '←')).join('')) || '<div class="slider-name">no links</div>';
      lw.querySelectorAll('[data-link]').forEach(b => b.addEventListener('click', () => openLink(b.dataset.link)));
    }
  }
  function linkRow(l, dir) {
    return `<button class="btn btn-ghost" data-link="${l.id}" style="display:block;width:100%;text-align:left;margin-bottom:4px">${dir} ${l.source} → ${l.target} · <b>${l.state}</b></button>`;
  }

  function renderLink(l) {
    el('drawer-title').textContent = `🔗 ${l.source} → ${l.target}`;
    const body = el('drawer-body');
    body.innerHTML = `
      <div class="kv-grid">
        <dt>Link ID</dt><dd>${esc(l.id)}</dd>
        <dt>State</dt><dd><b>${esc(l.state)}</b> (up / flapping 50% / down)</dd>
        <dt>Bandwidth</dt><dd>${l.bandwidthKbps} kbps</dd>
        <dt>Base latency</dt><dd>${l.latencyMs ?? 'global'} ms</dd>
        <dt>Loss override</dt><dd>${l.lossRate ?? 'global'} %</dd>
      </div>
      <div class="drawer-actions">
        <button class="btn ${l.state === 'down' ? 'btn-primary' : 'btn-danger'}" id="drawer-sever">${l.state === 'down' ? '♻️ Restore Link' : '✂ Sever Link'}</button>
        <button class="btn btn-warning" id="drawer-flap">〰 ${l.state === 'flapping' ? 'Stabilize (up)' : 'Flap (RF)'}</button>
        <button class="btn btn-ghost" id="drawer-dellink">🗑 Delete link</button>
      </div>
      <div class="slider-name">Tip: scissors tool (X) cycles up → flapping → down on canvas click.</div>
    `;
    el('drawer-sever')?.addEventListener('click', () => {
      const toDown = l.state !== 'down';
      GraphStore.setLinkState(l.id, toDown ? 'down' : 'up');
      try { ChaosEngine.onLinkStateChanged?.(l.id, GraphStore.getLink(l.id).state); } catch (e) {}
      try { if (toDown) SimEngine.killParticlesOnLink?.(l.id); } catch (e) {}
      DragEngine.syncTopologyToEngines(); openLink(l.id);
    });
    el('drawer-flap')?.addEventListener('click', () => {
      GraphStore.setLinkState(l.id, l.state === 'flapping' ? 'up' : 'flapping');
      try { ChaosEngine.onLinkStateChanged?.(l.id, GraphStore.getLink(l.id).state); } catch (e) {}
      DragEngine.syncTopologyToEngines(); openLink(l.id);
    });
    el('drawer-dellink')?.addEventListener('click', () => { GraphStore.removeLink(l.id); DragEngine.syncTopologyToEngines(); close(); });
  }

  // ─── PDU modal ───
  function openPDU(packet) {
    if (!packet) return;
    lastPacket = { ...packet };
    // Auto-pause per spec
    try { if (UIController.getState() === 'running') UIController.onPause?.() || document.getElementById('btn-pause')?.click(); } catch (e) {}
    renderPDU(lastPacket);
    el('modal-backdrop')?.classList.add('open');
  }
  function closePDU() { el('modal-backdrop')?.classList.remove('open'); }
  function renderPDU(p) {
    const c = p.coap || {};
    const body = el('pdu-body');
    if (!body) return;
    body.innerHTML = `
      <div class="pdu-layer"><h4>L2 · Data Link</h4><dl>
        <dt>Src MAC</dt><dd>${esc(p.srcMac || p.sensorId || '—')}</dd>
        <dt>Dst MAC</dt><dd>${esc(p.dstMac || p.gatewayId || '—')}</dd>
        <dt>EtherType</dt><dd>0x86DD (IPv6)</dd>
      </dl></div>
      <div class="pdu-layer"><h4>L3 · Network (IPv6)</h4><dl>
        <dt>Src IPv6</dt><dd>${esc(p.srcIp || '—')}</dd>
        <dt>Dst IPv6</dt><dd>${esc(p.dstIp || '—')}</dd>
        <dt>Hop Limit / TTL</dt><dd>${c.ttl ?? p.ttl ?? 5} (hops ${c.hops ?? p.hops ?? 0})</dd>
      </dl></div>
      <div class="pdu-layer"><h4>L4 · Transport (UDP)</h4><dl>
        <dt>Src / Dst Port</dt><dd>${p.udpSrc || 5683} → ${p.udpDst || 5683}</dd>
        <dt>Length</dt><dd>${esc(p.udpLen || '—')}</dd>
        <dt>Checksum</dt><dd>${esc(p.udpChecksum || '—')}</dd>
      </dl></div>
      <div class="pdu-layer"><h4>L7 · CoAP + Payload</h4><dl>
        <dt>Ver / Type / Code</dt><dd>1 / ${esc(c.typeName || p.coapType || 'NON')} (${c.type ?? ''}) / ${esc(c.code || '0.02 POST')}</dd>
        <dt>MID / Token</dt><dd>${c.mid !== undefined ? '0x' + c.mid.toString(16).toUpperCase().padStart(4, '0') : '—'} / ${esc(c.token || '—')}</dd>
        <dt>Uri-Path</dt><dd>${esc(c.uriPath || (p.isAlarm ? '/alerts' : '/telemetry'))}</dd>
        <dt>Status</dt><dd>${esc(p.status || '—')}${p.dropReason ? ' · ' + esc(p.dropReason) : ''}</dd>
        <dt>Latency</dt><dd>${p.latency ?? 0} ms</dd>
      </dl>
      <pre style="margin-top:8px;background:#0b111e;border:1px solid var(--border);border-radius:6px;padding:8px;font-size:11px;overflow-x:auto">${esc(JSON.stringify(c.payload || { id: p.sensorId, type: p.sensorType, val: p.value, unit: p.unit, ts: Math.floor((p.timestamp || Date.now()) / 1000) }, null, 2))}</pre></div>
    `;
  }

  function init() {
    el('btn-drawer-close')?.addEventListener('click', close);
    el('btn-pdu-close')?.addEventListener('click', closePDU);
    el('modal-backdrop')?.addEventListener('click', (e) => { if (e.target.id === 'modal-backdrop') closePDU(); });
    window.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePDU(); });
  }

  return { init, open, close, openNode, openLink, refresh, openPDU, closePDU, getSelection: () => ({ ...current }) };
})();
