/**
 * FC Connector — connection UI for the analyze page.
 * Owns: connect/disconnect UI, transport selection (BLE/USB), firmware version display.
 * Does NOT own: PID reading (see fc-pid-reader.js), connection state (see fc-connection-manager.js).
 */

/* global FcConnectionManager, MSP_CODES, BleTransport, UsbTransport */

(function () {
  'use strict';

  var connectBtn, disconnectBtn, statusEl, statusDot, fwInfoEl, connPanel;
  var transportBtns, bleBtnEl, usbBtnEl, scanAllBtnEl;

  /** Set UI connection state */
  function setState(state, message) {
    if (!statusEl) return;
    statusEl.textContent = message;
    statusDot.className = 'ble-dot ble-dot-' + state;

    if (state === 'connected') {
      connectBtn.style.display = 'none';
      disconnectBtn.style.display = 'inline-flex';
      if (transportBtns) transportBtns.style.display = 'none';
    } else {
      connectBtn.style.display = 'none';
      disconnectBtn.style.display = 'none';
      fwInfoEl.style.display = 'none';
      if (transportBtns) transportBtns.style.display = 'flex';
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

  /** Read FC firmware version via MSP_FC_VERSION (cmd 3) */
  async function readFirmwareVersion(client) {
    try {
      var resp = await client.sendCommand(MSP_CODES.MSP_FC_VERSION);
      var payload = resp.payload;
      if (payload.length >= 3) {
        return payload[0] + '.' + payload[1] + '.' + payload[2];
      }
      return 'Unknown';
    } catch (_e) {
      return 'Unknown';
    }
  }

  /** Read FC variant via MSP_FC_VARIANT (cmd 2) */
  async function readFirmwareVariant(client) {
    try {
      var resp = await client.sendCommand(MSP_CODES.MSP_FC_VARIANT);
      var payload = resp.payload;
      var variant = '';
      for (var i = 0; i < Math.min(payload.length, 4); i++) {
        variant += String.fromCharCode(payload[i]);
      }
      return variant || 'Unknown';
    } catch (_e) {
      return 'Unknown';
    }
  }

  /** Connect with a transport object via the global manager, read firmware info */
  async function doConnect(transport) {
    try {
      setState('connecting', 'Connecting...');
      var info = await FcConnectionManager.connect(transport);

      var connLabel = info.type === 'usb' ? 'USB' : 'BLE';
      setState('connected', 'Connected via ' + connLabel + ' to ' + info.name);

      // Read firmware info
      var client = FcConnectionManager.getClient();
      var variant = await readFirmwareVariant(client);
      var version = await readFirmwareVersion(client);
      fwInfoEl.innerHTML =
        '<span class="ble-fw-label">Firmware</span>' +
        '<span class="ble-fw-value">' + variant + ' ' + version + '</span>';
      fwInfoEl.style.display = 'flex';
    } catch (err) {
      setState('disconnected', err.message);
    }
  }

  /** Disconnect handler */
  function handleDisconnect() {
    FcConnectionManager.disconnect();
    setState('disconnected', 'Disconnected');
  }

  /** Check connectivity support */
  function checkSupport() {
    var hasBle = !!(navigator.bluetooth);
    var hasUsb = !!(navigator.serial);

    if (!hasBle && !hasUsb) {
      connPanel.innerHTML =
        '<div class="ble-unsupported">' +
        '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="var(--fg-muted)" stroke-width="2"><path d="M6.5 6.5l11 11M12 2v20M17.5 6.5l-11 11"/></svg>' +
        '<span>Web Bluetooth and Web Serial not available. Use <strong>Chrome</strong> or <strong>Edge</strong> to connect your FC.</span>' +
        '</div>';
      return false;
    }

    if (bleBtnEl) bleBtnEl.style.display = hasBle ? 'inline-flex' : 'none';
    if (scanAllBtnEl) scanAllBtnEl.style.display = hasBle ? 'inline-flex' : 'none';
    if (usbBtnEl) usbBtnEl.style.display = hasUsb ? 'inline-flex' : 'none';
    return true;
  }

  /** Initialize */
  function init() {
    connPanel = document.getElementById('bleConnectorPanel');
    if (!connPanel) return;

    connectBtn = document.getElementById('bleConnBtn');
    disconnectBtn = document.getElementById('bleDiscBtn');
    statusEl = document.getElementById('bleConnStatus');
    statusDot = document.getElementById('bleConnDot');
    fwInfoEl = document.getElementById('bleFwInfo');
    transportBtns = document.getElementById('fcTransportBtns');
    bleBtnEl = document.getElementById('fcBleBtn');
    usbBtnEl = document.getElementById('fcUsbBtn');
    scanAllBtnEl = document.getElementById('fcScanAllBtn');

    if (!checkSupport()) return;

    // Hide legacy connect button
    if (connectBtn) connectBtn.style.display = 'none';

    if (bleBtnEl) bleBtnEl.addEventListener('click', function () { doConnect(BleTransport()); });
    if (scanAllBtnEl) scanAllBtnEl.addEventListener('click', function () { doConnect(BleTransport({ scanAll: true })); });
    if (usbBtnEl) usbBtnEl.addEventListener('click', function () { doConnect(UsbTransport()); });
    if (disconnectBtn) disconnectBtn.addEventListener('click', handleDisconnect);

    // Listen for external disconnect events (e.g. from results page)
    FcConnectionManager.onStateChange(function (state) {
      if (state === 'disconnected' && statusEl) {
        setState('disconnected', 'Disconnected');
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
