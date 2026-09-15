/**
 * @module terminal
 * @author Ameen P Jami
 * @description Terminal Console & Data Export: DOM-based scrolling terminal log that records
 *              simulation events in real time. Provides CSV and JSON download functionality
 *              for post-simulation analysis and documentation.
 */

const Terminal = (() => {
  'use strict';

  const MAX_LINES = 300;
  const logBuffer = []; // { time, msg, level, packetData? }

  let terminalEl = null;
  let lineCount = 0;

  /** Colour classes mapped to log level */
  const levelStyles = {
    info:    'log-info',
    success: 'log-success',
    warn:    'log-warn',
    error:   'log-error',
    debug:   'log-debug',
  };

  /**
   * Initialises the terminal – must be called after DOM is ready.
   */
  function init() {
    terminalEl = document.getElementById('terminal-output');
  }

  /**
   * Logs a message to the terminal and internal buffer.
   * @param {string}  msg        - Human-readable message
   * @param {string}  [level]    - 'info' | 'success' | 'warn' | 'error' | 'debug'
   * @param {Object}  [packetData] - Optional packet object for data export
   */
  function log(msg, level = 'info', packetData = null) {
    const entry = {
      time:       new Date().toISOString(),
      msg,
      level,
      packetData: packetData ? { ...packetData } : null,
    };

    logBuffer.push(entry);
    renderLine(entry);
    try { TraceStore?.push?.(entry); } catch (e) {}

    // Keep buffer bounded
    if (logBuffer.length > MAX_LINES) {
      logBuffer.shift();
    }
  }

  /**
   * Renders a single log entry as an HTML row in the terminal.
   * @param {Object} entry
   */
  function renderLine(entry) {
    if (!terminalEl) return;

    const div = document.createElement('div');
    div.className = `log-line ${levelStyles[entry.level] || 'log-info'}`;

    const timeStr = entry.time.substring(11, 23); // HH:MM:SS.mmm
    div.innerHTML =
      `<span class="log-time">${timeStr}</span>` +
      `<span class="log-msg">${escapeHtml(entry.msg)}</span>`;

    // Click packet line -> pause + PDU modal (M5)
    if (entry.packetData) {
      div.title = 'Click to inspect PDU';
      div.addEventListener('click', () => {
        try { Inspector.openPDU(entry.packetData); } catch (e) {}
      });
    }

    terminalEl.appendChild(div);
    lineCount++;

    // Remove oldest DOM line if over limit
    if (lineCount > MAX_LINES) {
      if (terminalEl.firstChild) {
        terminalEl.removeChild(terminalEl.firstChild);
      }
      lineCount--;
    }

    // Auto-scroll to bottom
    terminalEl.scrollTop = terminalEl.scrollHeight;
  }

  /**
   * Clears all terminal entries.
   */
  function clear() {
    logBuffer.length = 0;
    lineCount = 0;
    if (terminalEl) terminalEl.innerHTML = '';
    log('🗑️  Terminal cleared', 'debug');
  }

  /**
   * Exports the current log buffer as a downloadable CSV file.
   */
  function exportCSV() {
    const headers = ['Timestamp', 'Level', 'Message', 'PacketID', 'SensorID', 'SensorType', 'Value', 'Unit', 'Status', 'DropReason', 'Latency(ms)', 'CoAPType', 'MID', 'Token', 'TTL', 'SrcIP', 'DstIP'];
    const rows = logBuffer.map(e => {
      const p = e.packetData;
      const c = p ? (p.coap || {}) : {};
      return [
        e.time,
        e.level,
        `"${e.msg.replace(/"/g, '""')}"`,
        p ? p.id          : '',
        p ? (p.sensorId || '')    : '',
        p ? (p.sensorType || '')  : '',
        p ? (p.value ?? '')       : '',
        p ? (p.unit || '')        : '',
        p ? (p.status || '')      : '',
        p ? (p.dropReason || '')  : '',
        p ? (p.latency ?? '')     : '',
        c.typeName || p?.coapType || '',
        c.mid ?? '',
        c.token || '',
        c.ttl ?? p?.ttl ?? '',
        p?.srcIp || '',
        p?.dstIp || '',
      ].join(',');
    });

    const csvContent = [headers.join(','), ...rows].join('\n');
    triggerDownload('simulation-log.csv', csvContent, 'text/csv');
    log('📥 CSV exported successfully', 'success');
  }

  /**
   * Exports the current log buffer as a downloadable JSON file.
   */
  function exportJSON() {
    const jsonContent = JSON.stringify(logBuffer, null, 2);
    triggerDownload('simulation-log.json', jsonContent, 'application/json');
    log('📥 JSON exported successfully', 'success');
  }

  /**
   * Exports the in-memory Prometheus exposition buffer (.prom snapshot, M4).
   */
  function exportProm() {
    try {
      const content = MetricsRegistry.exportPromText();
      triggerDownload('metrics-snapshot.prom', content, 'text/plain');
      log('📥 .prom snapshot exported successfully', 'success');
    } catch (e) {
      log(`❌ .prom export failed: ${e.message}`, 'error');
    }
  }
  /**
   * Triggers a file download in the browser.
   * @param {string} filename
   * @param {string} content
   * @param {string} mimeType
   */
  function triggerDownload(filename, content, mimeType) {
    const blob = new Blob([content], { type: mimeType });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  /**
   * Escapes HTML special characters to prevent XSS in log messages.
   * @param {string} str
   * @returns {string}
   */
  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  return {
    init,
    log,
    clear,
    exportCSV,
    exportJSON,
    exportProm,
    getBuffer: () => [...logBuffer],
  };
})();
