/**
 * FC PID Reader — reads current PID/rate values from a connected FC via MSP
 * and renders a side-by-side comparison with AI recommendations.
 * Owns: UI state for FC connect, PID read, comparison rendering, transport selection.
 * Does NOT own: MSP protocol encoding (see msp-client.js), transports (see fc-transport.js),
 *               connection state (see fc-connection-manager.js).
 */

/* global FcConnectionManager, MSP_CODES, BleTransport, UsbTransport */

(function () {
  'use strict';

  var fcPids = null;   // { roll: {p,i,d,f,dMax}, pitch: {p,i,d,f,dMax}, yaw: {p,i,d,f,dMax} }
  var fcRates = null;  // { roll: {rcRate, rate, expo}, ... }
  var originalPids = null; // Backup before write — for rollback
  var lastAdvancedPayload = null; // Full MSP_PID_ADVANCED response — needed for read-modify-write

  // DOM refs (set on init)
  var connectBtn, disconnectBtn, refreshBtn, statusEl, statusDot;
  var comparisonSection, comparisonBody, ratesSection, ratesBody;
  var blePanel, applyBtn, restoreBtn, writeStatusEl;
  var confirmModal, confirmBody, confirmYes, confirmNo;
  var transportBtns, bleBtnEl, usbBtnEl, scanAllBtnEl;

  /**
   * Parse MSP_PID response (cmd 112).
   * Betaflight sends 10 axes × 3 bytes (P, I, D) = 30 bytes.
   * We only care about the first 3 axes: Roll (0-2), Pitch (3-5), Yaw (6-8).
   * Feedforward is NOT here — it lives in MSP_PID_ADVANCED (cmd 94).
   */
  function parsePidResponse(payload) {
    var pids = { roll: {}, pitch: {}, yaw: {} };
    var axes = ['roll', 'pitch', 'yaw'];

    for (var a = 0; a < 3; a++) {
      var offset = a * 3; // 3-byte stride: P, I, D per axis
      pids[axes[a]].p = payload[offset] || 0;
      pids[axes[a]].i = payload[offset + 1] || 0;
      pids[axes[a]].d = payload[offset + 2] || 0;
      pids[axes[a]].f = 0; // Placeholder — filled by parsePidAdvancedResponse
    }
    return pids;
  }

  /**
   * Parse MSP_PID_ADVANCED response (cmd 94).
   * Feedforward (U16 LE): roll=offset 32, pitch=34, yaw=36.
   * D_Max (U8): roll=offset 39, pitch=40, yaw=41.
   * Merges into existing pids object.
   */
  function parsePidAdvancedResponse(payload, pids) {
    if (payload.length < 42) return; // Not enough data for D_Max fields

    // Feedforward: U16 little-endian at offsets 32, 34, 36
    pids.roll.f  = payload[32] | (payload[33] << 8);
    pids.pitch.f = payload[34] | (payload[35] << 8);
    pids.yaw.f   = payload[36] | (payload[37] << 8);

    // D_Max: U8 at offsets 39, 40, 41
    pids.roll.dMax  = payload[39];
    pids.pitch.dMax = payload[40];
    pids.yaw.dMax   = payload[41];
  }

  /**
   * Parse MSP_RC_TUNING response (cmd 111).
   * Layout varies by firmware; first few bytes are:
   * [0] rcRate, [1] rcExpo, [2] rollRate, [3] pitchRate,
   * [4] yawRate, [5] dynThrottlePID, [6] throttleMid, [7] throttleExpo,
   * [8] tpaBreakpoint(lo), [9] tpaBreakpoint(hi),
   * [10] rcYawExpo, [11] rcYawRate, [12] rcPitchRate
   */
  function parseRcTuningResponse(payload) {
    var rates = {
      roll: { rcRate: 0, rate: 0, expo: 0 },
      pitch: { rcRate: 0, rate: 0, expo: 0 },
      yaw: { rcRate: 0, rate: 0, expo: 0 },
    };

    if (payload.length < 5) return rates;

    rates.roll.rcRate = payload[0];
    rates.roll.expo = payload[1];
    rates.roll.rate = payload[2];
    rates.pitch.rate = payload[3];
    rates.yaw.rate = payload[4];

    if (payload.length > 10) rates.yaw.expo = payload[10];
    if (payload.length > 11) rates.yaw.rcRate = payload[11];
    if (payload.length > 12) {
      rates.pitch.rcRate = payload[12];
    } else {
      rates.pitch.rcRate = rates.roll.rcRate;
    }
    rates.pitch.expo = rates.roll.expo;

    return rates;
  }

  /** Set UI connection state */
  function setConnectionState(state, message) {
    if (!statusEl) return;
    statusEl.textContent = message;
    statusDot.className = 'ble-dot ble-dot-' + state;

    if (state === 'connected') {
      connectBtn.style.display = 'none';
      disconnectBtn.style.display = 'inline-flex';
      refreshBtn.style.display = 'inline-flex';
      if (applyBtn) applyBtn.style.display = 'inline-flex';
      if (transportBtns) transportBtns.style.display = 'none';
      // Show notch write button when FC is connected and suggestions exist
      var notchBtn = document.getElementById('applyNotchBtn');
      if (notchBtn && document.getElementById('notchSuggestionsSection') &&
          document.getElementById('notchSuggestionsSection').style.display !== 'none') {
        notchBtn.style.display = 'inline-flex';
      }
    } else {
      connectBtn.style.display = 'none';
      disconnectBtn.style.display = 'none';
      refreshBtn.style.display = 'none';
      if (applyBtn) applyBtn.style.display = 'none';
      if (restoreBtn) restoreBtn.style.display = 'none';
      if (writeStatusEl) { writeStatusEl.style.display = 'none'; writeStatusEl.textContent = ''; }
      if (transportBtns) transportBtns.style.display = 'flex';
      // Hide notch write buttons on disconnect
      var notchBtn = document.getElementById('applyNotchBtn');
      var restoreNotch = document.getElementById('restoreNotchBtn');
      var notchStatus = document.getElementById('notchWriteStatus');
      if (notchBtn) notchBtn.style.display = 'none';
      if (restoreNotch) restoreNotch.style.display = 'none';
      if (notchStatus) { notchStatus.style.display = 'none'; notchStatus.textContent = ''; }
    }

    if (state === 'connecting') {
      if (transportBtns) transportBtns.style.display = 'none';
      disconnectBtn.style.display = 'none';
      connectBtn.style.display = 'inline-flex';
      connectBtn.disabled = true;
      connectBtn.innerHTML = '<span class="spinner"></span> Connecting...';
    } else if (state !== 'connected') {
      connectBtn.disabled = false;
      connectBtn.style.display = 'none';
    }
  }

  /** Connect to FC with given transport via global manager and read PIDs */
  async function doConnect(transport) {
    try {
      setConnectionState('connecting', 'Connecting...');
      var info = await FcConnectionManager.connect(transport);
      var connLabel = info.type === 'usb' ? 'USB' : 'BLE';
      setConnectionState('connected', 'Connected via ' + connLabel + ' to ' + info.name);
      await readAllParams();
    } catch (err) {
      setConnectionState('disconnected', err.message);
    }
  }

  function handleDisconnect() {
    FcConnectionManager.disconnect();
    fcPids = null;
    fcRates = null;
    originalPids = null;
    setConnectionState('disconnected', 'Disconnected');
    hideComparison();
    hideConfirmModal();
  }

  /** Read PID and rate params from the FC */
  async function readAllParams() {
    var client = FcConnectionManager.getClient();
    if (!client || !client.isConnected()) return;

    refreshBtn.disabled = true;
    refreshBtn.innerHTML = '<span class="spinner"></span> Reading...';

    try {
      // Read PIDs (MSP_PID = 112) — returns P, I, D per axis
      var pidResp = await client.sendCommand(MSP_CODES.MSP_PID);
      fcPids = parsePidResponse(pidResp.payload);

      // Read advanced PID params (MSP_PID_ADVANCED = 94) — feedforward, D_Max
      try {
        var advResp = await client.sendCommand(MSP_CODES.MSP_PID_ADVANCED);
        parsePidAdvancedResponse(advResp.payload, fcPids);
        lastAdvancedPayload = advResp.payload.slice(); // Keep full payload for writes
      } catch (_e) {
        // PID_ADVANCED read is optional — older firmware may not support it
        lastAdvancedPayload = null;
      }

      // Read rates (MSP_RC_TUNING = 111)
      try {
        var rateResp = await client.sendCommand(MSP_CODES.MSP_RC_TUNING);
        fcRates = parseRcTuningResponse(rateResp.payload);
      } catch (_e) {
        // Rates read is optional — some FCs don't support it over BLE
        fcRates = null;
      }

      renderComparison();
    } catch (err) {
      statusEl.textContent = 'Read error: ' + err.message;
    } finally {
      refreshBtn.disabled = false;
      refreshBtn.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 11-2.12-9.36L23 10"/></svg> Refresh';
    }
  }

  /**
   * Chinese tuning effect descriptions — maps param changes to flight feel.
   */
  var paramInfoCn = {
    p:    { up: '锁定感更强，响应更快', down: '手感更柔和，减少过冲' },
    i:    { up: '悬停更稳，抗风性更好', down: '减少低速振荡，响应更灵活' },
    d:    { up: '制动更强，减少回弹', down: '减少高速抖动和电机发热' },
    f:    { up: '前馈增强，操控更跟手', down: '减少操控噪声注入' },
    dMax: { up: 'D项动态上限提高，快速动作抑制更强', down: '降低动态D上限，减少高转速抖动' },
  };

  /** Build live tuning notes from FC vs recommended diffs */
  function buildLiveTuningNotes(fcP, recommended) {
    var notes = [];
    var axes = ['roll', 'pitch', 'yaw'];
    var axisNames = { roll: 'Roll', pitch: 'Pitch', yaw: 'Yaw' };
    var params = ['p', 'i', 'd', 'f', 'dMax'];
    var paramLabels = { p: 'P', i: 'I', d: 'D', f: 'FF', dMax: 'D_Max' };

    for (var a = 0; a < axes.length; a++) {
      var axis = axes[a];
      var cur = fcP[axis] || {};
      var rec = recommended[axis] || {};
      for (var pi = 0; pi < params.length; pi++) {
        var param = params[pi];
        var curVal = cur[param] || 0;
        var recVal = rec[param] || 0;
        var diff = recVal - curVal;
        if (diff === 0) continue;
        var sign = diff > 0 ? '+' : '';
        var pct = curVal !== 0 ? Math.round((diff / curVal) * 100) : 0;
        var pctStr = curVal !== 0 ? ' (' + sign + pct + '%)' : '';
        var info = paramInfoCn[param];
        var desc = diff > 0 ? info.up : info.down;
        notes.push(axisNames[axis] + ' ' + paramLabels[param] + ' ' + sign + diff + pctStr + ' → ' + desc);
      }
    }
    return notes;
  }

  /** Render the PID comparison table */
  function renderComparison() {
    if (!fcPids) return;

    comparisonSection.style.display = 'block';

    // Get AI recommended values from the page's data attribute
    var recData = comparisonSection.getAttribute('data-recommended');
    var recommended = null;
    if (recData) {
      try {
        recommended = JSON.parse(recData);
      } catch (_e) {
        recommended = null;
      }
    }

    var html = '';
    var axes = ['roll', 'pitch', 'yaw'];
    var params = ['p', 'i', 'd', 'f', 'dMax'];

    for (var a = 0; a < axes.length; a++) {
      var axis = axes[a];
      var axisLabel = axis.charAt(0).toUpperCase() + axis.slice(1);
      html += '<tr>';
      html += '<td class="axis-name">' + axisLabel + '</td>';

      for (var p = 0; p < params.length; p++) {
        var param = params[p];
        var fcVal = fcPids[axis][param] || 0;
        var recVal = recommended && recommended[axis] ? (recommended[axis][param] || 0) : null;
        var diff = recVal !== null ? recVal - fcVal : null;
        var diffClass = '';
        var diffText = '';
        var pctText = '';

        if (diff !== null && diff !== 0) {
          diffClass = diff > 0 ? 'pid-diff-up' : 'pid-diff-down';
          var sign = diff > 0 ? '+' : '';
          diffText = sign + diff;
          // Percentage display
          if (fcVal !== 0) {
            var pct = Math.round((diff / fcVal) * 100);
            pctText = ' / ' + sign + pct + '%';
          }
        }

        html += '<td><div class="pid-cmp-cell">';
        html += '<span class="pid-fc-val">' + fcVal + '</span>';
        if (recVal !== null) {
          html += '<span class="pid-rec-val ' + diffClass + '">';
          html += recVal;
          if (diffText) html += ' <small>(' + diffText + pctText + ')</small>';
          html += '</span>';
        }
        html += '</div></td>';
      }
      html += '</tr>';
    }

    comparisonBody.innerHTML = html;

    // Render live Chinese tuning notes
    if (recommended) {
      var liveNotes = buildLiveTuningNotes(fcPids, recommended);
      var notesSection = document.getElementById('pidTuningNotesLive');
      var notesBody = document.getElementById('pidTuningNotesBody');
      if (notesSection && notesBody && liveNotes.length > 0) {
        var nhtml = '';
        for (var n = 0; n < liveNotes.length; n++) {
          nhtml += '<li class="tuning-note-item">' + liveNotes[n] + '</li>';
        }
        notesBody.innerHTML = nhtml;
        notesSection.style.display = 'block';
      } else if (notesSection) {
        notesSection.style.display = 'none';
      }
    }

    // Render rates if available
    if (fcRates && ratesSection) {
      ratesSection.style.display = 'block';
      var rhtml = '';
      for (var r = 0; r < axes.length; r++) {
        var raxis = axes[r];
        var rlabel = raxis.charAt(0).toUpperCase() + raxis.slice(1);
        var rd = fcRates[raxis];
        rhtml += '<tr>';
        rhtml += '<td class="axis-name">' + rlabel + '</td>';
        rhtml += '<td>' + (rd.rcRate || '-') + '</td>';
        rhtml += '<td>' + (rd.rate || '-') + '</td>';
        rhtml += '<td>' + (rd.expo || '-') + '</td>';
        rhtml += '</tr>';
      }
      ratesBody.innerHTML = rhtml;
    }
  }

  /**
   * Build MSP_SET_PID payload (cmd 202) from a pids object.
   * Betaflight expects 10 axes × 3 bytes (P, I, D) = 30 bytes.
   * We set Roll/Pitch/Yaw (axes 0-2) and zero-fill the remaining 7 axes.
   */
  function buildPidPayload(pids) {
    var axes = ['roll', 'pitch', 'yaw'];
    var payload = [];
    for (var a = 0; a < axes.length; a++) {
      var ax = pids[axes[a]];
      payload.push(ax.p || 0, ax.i || 0, ax.d || 0);
    }
    // Pad remaining 7 axes with zeros (Level, Mag, etc.) — 21 more bytes
    for (var z = 0; z < 21; z++) payload.push(0);
    return payload;
  }

  /**
   * Build MSP_SET_PID_ADVANCED payload (cmd 95) by read-modify-write.
   * Takes the last-read full advanced payload and patches FF + D_Max values.
   * FF: U16 LE at offsets 32,34,36. D_Max: U8 at offsets 39,40,41.
   */
  function buildAdvancedPayload(pids) {
    if (!lastAdvancedPayload || lastAdvancedPayload.length < 42) return null;
    var payload = lastAdvancedPayload.slice(); // Copy full payload

    // Patch feedforward (U16 LE) at offsets 32, 34, 36
    var ff = [pids.roll.f || 0, pids.pitch.f || 0, pids.yaw.f || 0];
    for (var i = 0; i < 3; i++) {
      payload[32 + i * 2] = ff[i] & 0xFF;
      payload[33 + i * 2] = (ff[i] >> 8) & 0xFF;
    }

    // Patch D_Max (U8) at offsets 39, 40, 41
    payload[39] = pids.roll.dMax || 0;
    payload[40] = pids.pitch.dMax || 0;
    payload[41] = pids.yaw.dMax || 0;

    return payload;
  }

  /** Get recommended PIDs from the page data attribute */
  function getRecommended() {
    var recData = comparisonSection.getAttribute('data-recommended');
    if (!recData) return null;
    try {
      return JSON.parse(recData);
    } catch (_e) {
      return null;
    }
  }

  /** Show the confirmation modal with a diff of changes */
  function showConfirmModal(targetPids, label) {
    if (!fcPids || !confirmModal) return;
    var axes = ['roll', 'pitch', 'yaw'];
    var params = ['p', 'i', 'd', 'f', 'dMax'];
    var paramLabels = { p: 'P', i: 'I', d: 'D', f: 'FF', dMax: 'D_MAX' };
    var html = '<table class="pid-table pid-confirm-table"><thead><tr><th>Axis</th><th>Param</th><th>Current</th><th>&rarr;</th><th>' + label + '</th></tr></thead><tbody>';
    for (var a = 0; a < axes.length; a++) {
      var axis = axes[a];
      for (var p = 0; p < params.length; p++) {
        var param = params[p];
        var cur = fcPids[axis][param] || 0;
        var nxt = targetPids[axis][param] || 0;
        if (cur !== nxt) {
          var cls = nxt > cur ? 'pid-diff-up' : 'pid-diff-down';
          html += '<tr><td class="axis-name">' + axis.charAt(0).toUpperCase() + axis.slice(1) + '</td>';
          html += '<td>' + paramLabels[param] + '</td>';
          html += '<td>' + cur + '</td><td>&rarr;</td>';
          html += '<td class="' + cls + '">' + nxt + '</td></tr>';
        }
      }
    }
    html += '</tbody></table>';

    confirmBody.innerHTML = html;
    confirmModal.style.display = 'flex';
    confirmModal._targetPids = targetPids;
  }

  function hideConfirmModal() {
    if (confirmModal) {
      confirmModal.style.display = 'none';
      confirmModal._targetPids = null;
    }
  }

  /** Write PIDs to FC, save EEPROM, verify */
  async function writePidsToFc(targetPids) {
    var client = FcConnectionManager.getClient();
    if (!client || !client.isConnected()) return;

    // Backup current PIDs before writing (for rollback)
    if (!originalPids && fcPids) {
      originalPids = JSON.parse(JSON.stringify(fcPids));
    }

    setWriteState('writing');

    try {
      // 1. Send MSP_SET_PID (202) — P, I, D only (3 bytes/axis)
      var pidPayload = buildPidPayload(targetPids);
      await client.sendCommand(MSP_CODES.MSP_SET_PID, pidPayload);

      // 2. Send MSP_SET_PID_ADVANCED (95) — feedforward via read-modify-write
      var advPayload = buildAdvancedPayload(targetPids);
      if (advPayload) {
        setWriteStatus('Writing advanced PID params...');
        await client.sendCommand(MSP_CODES.MSP_SET_PID_ADVANCED, advPayload);
      }

      // 3. Save to EEPROM (250)
      setWriteStatus('Saving to EEPROM...');
      await client.sendCommand(MSP_CODES.MSP_EEPROM_WRITE);

      // 4. Re-read to verify
      setWriteStatus('Verifying...');
      var pidResp = await client.sendCommand(MSP_CODES.MSP_PID);
      fcPids = parsePidResponse(pidResp.payload);

      // Also re-read advanced to verify FF
      try {
        var advResp = await client.sendCommand(MSP_CODES.MSP_PID_ADVANCED);
        parsePidAdvancedResponse(advResp.payload, fcPids);
        lastAdvancedPayload = advResp.payload.slice();
      } catch (_e) { /* optional */ }

      // Check verification — P, I, D, FF, and D_Max
      var allMatch = true;
      var mismatchList = [];
      var axes = ['roll', 'pitch', 'yaw'];
      var verifyParams = ['p', 'i', 'd', 'f', 'dMax'];
      for (var a = 0; a < axes.length; a++) {
        for (var p = 0; p < verifyParams.length; p++) {
          var vp = verifyParams[p];
          var wrote = targetPids[axes[a]][vp] || 0;
          var readBack = fcPids[axes[a]][vp] || 0;
          if (wrote !== readBack) {
            allMatch = false;
            mismatchList.push(axes[a] + '.' + vp + ': wrote=' + wrote + ' read=' + readBack);
          }
        }
      }

      renderComparison();

      if (allMatch) {
        setWriteState('success');
        setWriteStatus('✅ 写入校验成功！所有参数已正确写入FC。');
        if (restoreBtn) restoreBtn.style.display = 'inline-flex';
      } else {
        setWriteState('warning');
        setWriteStatus('⚠️ 写入校验失败，建议重试。不匹配: ' + mismatchList.join(', '));
      }
    } catch (err) {
      setWriteState('error');
      setWriteStatus('Write failed: ' + err.message);
    }
  }

  /** Restore original PIDs that were saved before the write */
  async function handleRestore() {
    if (!originalPids) return;
    showConfirmModal(originalPids, 'Original');
  }

  function setWriteState(state) {
    if (!applyBtn) return;
    if (state === 'writing') {
      applyBtn.disabled = true;
      applyBtn.innerHTML = '<span class="spinner"></span> Writing...';
      if (restoreBtn) restoreBtn.disabled = true;
    } else {
      applyBtn.disabled = false;
      applyBtn.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 3a2.85 2.83 0 114 4L7.5 20.5 2 22l1.5-5.5z"/></svg> Apply to FC';
      if (restoreBtn) restoreBtn.disabled = false;
    }
  }

  function setWriteStatus(msg) {
    if (writeStatusEl) {
      writeStatusEl.textContent = msg;
      writeStatusEl.style.display = msg ? 'block' : 'none';
    }
  }

  function hideComparison() {
    if (comparisonSection) comparisonSection.style.display = 'none';
    if (ratesSection) ratesSection.style.display = 'none';
  }

  /** Check for Web Bluetooth or Web Serial support */
  function checkConnectivitySupport() {
    var hasBle = !!navigator.bluetooth;
    var hasUsb = !!navigator.serial;

    if (!hasBle && !hasUsb) {
      blePanel.innerHTML =
        '<div class="ble-unsupported">' +
        '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="var(--fg-muted)" stroke-width="2"><path d="M6.5 6.5l11 11M12 2v20M17.5 6.5l-11 11"/></svg>' +
        '<span>Web Bluetooth and Web Serial not available. Use <strong>Chrome</strong> or <strong>Edge</strong> on desktop to connect your FC.</span>' +
        '</div>';
      return false;
    }

    if (bleBtnEl) bleBtnEl.style.display = hasBle ? 'inline-flex' : 'none';
    if (scanAllBtnEl) scanAllBtnEl.style.display = hasBle ? 'inline-flex' : 'none';
    if (usbBtnEl) usbBtnEl.style.display = hasUsb ? 'inline-flex' : 'none';
    return true;
  }

  /** Initialize on DOM ready */
  function init() {
    blePanel = document.getElementById('blePidPanel');
    if (!blePanel) return; // Not on results page

    connectBtn = document.getElementById('bleConnectBtn');
    disconnectBtn = document.getElementById('bleDisconnectBtn');
    refreshBtn = document.getElementById('bleRefreshBtn');
    statusEl = document.getElementById('bleStatus');
    statusDot = document.getElementById('bleStatusDot');
    comparisonSection = document.getElementById('pidComparisonSection');
    comparisonBody = document.getElementById('pidComparisonBody');
    ratesSection = document.getElementById('ratesSection');
    ratesBody = document.getElementById('ratesBody');

    applyBtn = document.getElementById('bleApplyBtn');
    restoreBtn = document.getElementById('bleRestoreBtn');
    writeStatusEl = document.getElementById('bleWriteStatus');
    confirmModal = document.getElementById('pidConfirmModal');
    confirmBody = document.getElementById('pidConfirmBody');
    confirmYes = document.getElementById('pidConfirmYes');
    confirmNo = document.getElementById('pidConfirmNo');
    transportBtns = document.getElementById('resFcTransportBtns');
    bleBtnEl = document.getElementById('resFcBleBtn');
    usbBtnEl = document.getElementById('resFcUsbBtn');
    scanAllBtnEl = document.getElementById('resFcScanAllBtn');

    // Auto-detect existing connection from the global manager.
    // This handles the case where user connected on /analyze page and
    // the AJAX page transition preserved the window.FcConnectionManager state.
    if (FcConnectionManager && FcConnectionManager.isConnected()) {
      var info = FcConnectionManager.getInfo();
      var connLabel = info.type === 'usb' ? 'USB' : 'BLE';
      setConnectionState('connected', 'Connected via ' + connLabel + ' to ' + info.name);
      // Auto-read PIDs since we're already connected
      readAllParams();
    } else if (!checkConnectivitySupport()) {
      return;
    }

    // Transport buttons (BLE/USB/Scan All)
    if (bleBtnEl) bleBtnEl.addEventListener('click', function () { doConnect(BleTransport()); });
    if (scanAllBtnEl) scanAllBtnEl.addEventListener('click', function () { doConnect(BleTransport({ scanAll: true })); });
    if (usbBtnEl) usbBtnEl.addEventListener('click', function () { doConnect(UsbTransport()); });
    // Legacy buttons (hidden but kept for fallback)
    if (connectBtn) connectBtn.addEventListener('click', function () { doConnect(BleTransport()); });
    if (disconnectBtn) disconnectBtn.addEventListener('click', handleDisconnect);
    if (refreshBtn) refreshBtn.addEventListener('click', readAllParams);

    if (applyBtn) {
      applyBtn.addEventListener('click', function () {
        var rec = getRecommended();
        if (!rec || !fcPids) return;
        showConfirmModal(rec, 'AI Recommended');
      });
    }
    if (restoreBtn) {
      restoreBtn.addEventListener('click', handleRestore);
    }
    if (confirmYes) {
      confirmYes.addEventListener('click', function () {
        var target = confirmModal._targetPids;
        hideConfirmModal();
        if (target) writePidsToFc(target);
      });
    }
    if (confirmNo) {
      confirmNo.addEventListener('click', hideConfirmModal);
    }

    // Listen for disconnect events from the global manager
    FcConnectionManager.onStateChange(function (state, info) {
      if (state === 'disconnected') {
        fcPids = null;
        fcRates = null;
        originalPids = null;
        setConnectionState('disconnected', 'Disconnected');
        hideComparison();
      } else if (state === 'connected' && info) {
        var lbl = info.type === 'usb' ? 'USB' : 'BLE';
        setConnectionState('connected', 'Connected via ' + lbl + ' to ' + info.name);
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
