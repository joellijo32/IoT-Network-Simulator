/**
 * @module trace
 * @description Wireshark-lite frame buffer (M5). Bounded 500 frames, fed by
 *              Terminal.log via TraceStore.push. Rendered in Protocol Inspector tab.
 */

const TraceStore = (() => {
  'use strict';

  const MAX = 500;
  const frames = [];
  let seq = 0;
  const listeners = [];

  function onUpdate(fn) { listeners.push(fn); }
  function emit() { listeners.forEach(fn => { try { fn(); } catch (e) {} }); }

  function push(entry) {
    const p = entry.packetData;
    if (!p) return;
    seq++;
    frames.push({
      seq,
      time: entry.time,
      frameId: p.id || `PKT-${seq}`,
      src: p.sensorId || p.srcId || '?',
      dst: p.gatewayId || p.dstId || '→srv',
      srcIp: p.srcIp || '', dstIp: p.dstIp || '',
      type: (p.coap && p.coap.typeName) || p.coapType || (p.isAlarm ? 'CON' : 'NON'),
      mid: p.coap && p.coap.mid !== undefined ? ('0x' + p.coap.mid.toString(16).toUpperCase().padStart(4, '0')) : '—',
      token: (p.coap && p.coap.token) || '—',
      path: p.pathTrace ? p.pathTrace.join('→') : [p.sensorId, p.gatewayId].filter(Boolean).join('→'),
      status: p.status || '',
      reason: (p.dropReason || '').replace(/-/g, '_'),
      latency: p.latency ?? 0,
      packet: { ...p },
      level: entry.level,
    });
    if (frames.length > MAX) frames.shift();
    emit();
  }
  function clear() { frames.length = 0; seq = 0; emit(); }
  function getAll() { return [...frames]; }

  return { push, clear, getAll, onUpdate, MAX };
})();

/**
 * @module TraceTable
 * @description Renders TraceStore into #trace-tbody with filters (M5).
 */
const TraceTable = (() => {
  'use strict';

  let lastRender = 0;

  function renderThrottled() {
    const now = performance.now();
    if (now - lastRender < 800) return;
    lastRender = now;
    render();
  }
  function render() {
    const tbody = document.getElementById('trace-tbody');
    if (!tbody) return;
    const q = (document.getElementById('trace-filter')?.value || '').toLowerCase().trim();
    const tf = document.getElementById('trace-type-filter')?.value || '';
    const sf = document.getElementById('trace-status-filter')?.value || '';
    const all = TraceStore.getAll();
    const rows = all.filter(f => {
      if (tf && f.type !== tf) return false;
      if (sf && f.status !== sf) return false;
      if (q && ![f.frameId, f.src, f.dst, f.mid, f.token, f.path, f.status, f.reason, f.srcIp, f.dstIp].join(' ').toLowerCase().includes(q)) return false;
      return true;
    }).slice(-200).reverse();
    const count = document.getElementById('trace-count');
    if (count) count.textContent = `${rows.length}/${all.length} frames`;
    tbody.innerHTML = rows.map(f => {
      const t = f.time.substring(11, 23);
      const st = f.status === 'dropped' ? `dropped · ${f.reason || ''}` : f.status;
      const cls = f.status === 'dropped' ? 'log-error' : f.type === 'CON' ? 'log-warn' : 'log-info';
      return `<tr class="${cls}" data-seq="${f.seq}"><td>${t}</td><td>${f.frameId}</td>`
        + `<td>${f.src} → ${f.dst}</td><td>${f.type}</td><td>${f.mid}</td>`
        + `<td>${f.path}</td><td>${st}</td><td>${f.latency}ms</td></tr>`;
    }).join('');
    tbody.querySelectorAll('tr[data-seq]').forEach(tr => {
      tr.addEventListener('click', () => {
        const f = TraceStore.getAll().find(x => x.seq === Number(tr.dataset.seq));
        if (f) { try { Inspector.openPDU(f.packet); } catch (e) {} }
      });
    });
  }

  return { render, renderThrottled };
})();
