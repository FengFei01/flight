/**
 * MSP (MultiWii Serial Protocol) v1 client — transport-agnostic.
 * Owns: MSP frame encode/decode, command send/receive.
 * Does NOT own: Physical transport (see fc-transport.js for BLE/USB).
 */

/* global BleTransport, UsbTransport */

// MSP command codes used by Betaflight
var MSP = {
  MSP_API_VERSION: 1,
  MSP_FC_VARIANT: 2,
  MSP_FC_VERSION: 3,
  MSP_BOARD_INFO: 4,
  MSP_NAME: 10,
  MSP_PID: 112,
  MSP_SET_PID: 202,
  MSP_RC_TUNING: 111,
  MSP_PID_ADVANCED: 94,
  MSP_SET_PID_ADVANCED: 95,
  MSP_SET_FILTER_CONFIG: 29,
  MSP_FILTER_CONFIG: 92,
  MSP_EEPROM_WRITE: 250,
};

/**
 * Create an MSP client instance.
 * Accepts a transport object (from fc-transport.js): BleTransport() or UsbTransport().
 * If no transport provided, defaults to BleTransport for backward compat.
 *
 * Usage:
 *   var client = MspClient(BleTransport());
 *   await client.connect(onDisconnect);
 *   var pids = await client.sendCommand(MSP.MSP_PID);
 *   client.disconnect();
 */
function MspClient(transport) {
  // Default to BLE transport if none provided (backward compat)
  if (!transport) {
    transport = (typeof BleTransport === 'function') ? BleTransport() : null;
  }

  var responseBuffer = [];
  var pendingResolve = null;
  var pendingReject = null;
  var pendingTimeout = null;
  var connected = false;
  var onDisconnect = null;

  /**
   * Connect to FC via the configured transport.
   * @param {Function} disconnectCb - called on unexpected disconnect
   */
  async function connect(disconnectCb) {
    onDisconnect = disconnectCb || null;

    if (!transport) {
      throw new Error('No transport available. Use Chrome or Edge.');
    }

    if (!transport.isSupported()) {
      var label = transport.type === 'usb' ? 'Web Serial' : 'Web Bluetooth';
      throw new Error(label + ' not supported in this browser. Use Chrome or Edge.');
    }

    // Wire up data handler before connecting
    transport.onData(onTransportData);

    var info = await transport.connect(function () {
      connected = false;
      if (pendingReject) {
        pendingReject(new Error('Device disconnected'));
        clearPending();
      }
      if (onDisconnect) onDisconnect();
    });

    connected = true;
    return info;
  }

  /** Handle incoming bytes from transport (BLE notifications or serial reads) */
  function onTransportData(data) {
    for (var k = 0; k < data.length; k++) {
      responseBuffer.push(data[k]);
    }
    tryParseResponse();
  }

  /**
   * Try to parse a complete MSP v1 response from the buffer.
   * Frame: '$' 'M' '<' <len> <cmd> <payload...> <crc>
   */
  function tryParseResponse() {
    // Find frame start '$M'
    while (responseBuffer.length >= 2) {
      if (responseBuffer[0] === 0x24 && responseBuffer[1] === 0x4D) break;
      responseBuffer.shift();
    }

    if (responseBuffer.length < 5) return;

    var direction = responseBuffer[2]; // '<' (0x3C) = response, '!' (0x21) = error
    var payloadLen = responseBuffer[3];
    var totalLen = 6 + payloadLen; // $M< + len + cmd + payload + crc

    if (responseBuffer.length < totalLen) return;

    var cmd = responseBuffer[4];
    var payload = responseBuffer.slice(5, 5 + payloadLen);
    var crc = responseBuffer[5 + payloadLen];

    // Verify checksum: XOR of length, cmd, and all payload bytes
    var check = payloadLen ^ cmd;
    for (var j = 0; j < payload.length; j++) {
      check ^= payload[j];
    }

    // Remove parsed frame from buffer
    responseBuffer = responseBuffer.slice(totalLen);

    if (direction === 0x21) {
      if (pendingReject) {
        pendingReject(new Error('MSP error for command ' + cmd));
        clearPending();
      }
      return;
    }

    if (check !== crc) {
      if (pendingReject) {
        pendingReject(new Error('MSP checksum error'));
        clearPending();
      }
      return;
    }

    // Valid response
    if (pendingResolve) {
      pendingResolve({ cmd: cmd, payload: payload });
      clearPending();
    }
  }

  function clearPending() {
    pendingResolve = null;
    pendingReject = null;
    if (pendingTimeout) {
      clearTimeout(pendingTimeout);
      pendingTimeout = null;
    }
  }

  function disconnect() {
    connected = false;
    if (transport) transport.disconnect();
  }

  function isConnected() {
    return connected && transport && transport.isConnected();
  }

  /**
   * Encode and send an MSP v1 command, wait for response.
   * Frame: '$' 'M' '<' <len> <cmd> <payload...> <crc>
   */
  function sendCommand(cmd, payload) {
    payload = payload || [];
    return new Promise(function (resolve, reject) {
      if (!isConnected()) {
        return reject(new Error('Not connected to FC'));
      }

      // Build MSP v1 frame
      var len = payload.length;
      var frame = new Uint8Array(6 + len);
      frame[0] = 0x24; // $
      frame[1] = 0x4D; // M
      frame[2] = 0x3C; // < (request)
      frame[3] = len;
      frame[4] = cmd;

      var crc = len ^ cmd;
      for (var j = 0; j < payload.length; j++) {
        frame[5 + j] = payload[j];
        crc ^= payload[j];
      }
      frame[5 + len] = crc;

      // Set up response handler
      pendingResolve = resolve;
      pendingReject = reject;
      responseBuffer = [];

      pendingTimeout = setTimeout(function () {
        if (pendingReject) {
          pendingReject(new Error('MSP command timeout (cmd=' + cmd + ')'));
          clearPending();
        }
      }, 3000);

      // Send via transport
      transport.write(frame).catch(function (err) {
        clearPending();
        reject(err);
      });
    });
  }

  /** Get the transport type ('ble' or 'usb') */
  function getTransportType() {
    return transport ? transport.type : null;
  }

  // Public API
  return {
    MSP: MSP,
    connect: connect,
    disconnect: disconnect,
    isConnected: isConnected,
    sendCommand: sendCommand,
    getTransportType: getTransportType,
  };
}

// Make globally accessible
window.MspClient = MspClient;
window.MSP_CODES = MSP;
