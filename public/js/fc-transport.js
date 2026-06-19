/**
 * FC Transport Abstraction — BLE and USB Serial transports for MSP communication.
 * Owns: device discovery, raw byte read/write over BLE UART or USB Serial.
 * Does NOT own: MSP protocol framing (see msp-client.js).
 */

/* global navigator */

// Common BLE service UUIDs used by Betaflight flight controllers
var FC_BLE_SERVICES = {
  // SpeedyBee / generic FC BLE UART
  SPEEDYBEE_FFF0: '0000fff0-0000-1000-8000-00805f9b34fb',
  // Nordic UART Service (used by many FC BLE modules including SpeedyBee F405)
  NORDIC_UART: '6e400001-b5a3-f393-e0a9-e50e24dcca9e',
  // Alternate SpeedyBee service UUIDs
  SPEEDYBEE_FFE0: '0000ffe0-0000-1000-8000-00805f9b34fb',
  SPEEDYBEE_FFE1: '0000ffe1-0000-1000-8000-00805f9b34fb',
};

// TX/RX characteristic UUIDs per service
var FC_BLE_CHARS = {
  '0000fff0-0000-1000-8000-00805f9b34fb': {
    tx: '0000fff1-0000-1000-8000-00805f9b34fb',
    rx: '0000fff2-0000-1000-8000-00805f9b34fb',
  },
  '6e400001-b5a3-f393-e0a9-e50e24dcca9e': {
    tx: '6e400003-b5a3-f393-e0a9-e50e24dcca9e', // NUS TX (FC → host, notify)
    rx: '6e400002-b5a3-f393-e0a9-e50e24dcca9e', // NUS RX (host → FC, write)
  },
  '0000ffe0-0000-1000-8000-00805f9b34fb': {
    tx: '0000ffe1-0000-1000-8000-00805f9b34fb',
    rx: '0000ffe2-0000-1000-8000-00805f9b34fb',
  },
  '0000ffe1-0000-1000-8000-00805f9b34fb': {
    tx: '0000ffe2-0000-1000-8000-00805f9b34fb',
    rx: '0000ffe3-0000-1000-8000-00805f9b34fb',
  },
};

var ALL_SERVICE_UUIDS = Object.values(FC_BLE_SERVICES);

/**
 * BLE Transport — connects to FC via Web Bluetooth.
 * Supports multiple FC BLE service UUIDs with auto-detection.
 *
 * @param {Object} opts
 * @param {boolean} opts.scanAll - Use acceptAllDevices (for non-standard BLE modules)
 */
function BleTransport(opts) {
  opts = opts || {};
  var device = null;
  var server = null;
  var txChar = null;
  var rxChar = null;
  var _connected = false;
  var _onData = null;
  var _onDisconnect = null;

  function isSupported() {
    return !!navigator.bluetooth;
  }

  async function connect(onDisconnectCb) {
    _onDisconnect = onDisconnectCb || null;

    if (!navigator.bluetooth) {
      throw new Error('Web Bluetooth not supported. Use Chrome or Edge.');
    }

    var requestOpts;
    if (opts.scanAll) {
      // Fallback: show all BLE devices, but request optional access to known services
      requestOpts = {
        acceptAllDevices: true,
        optionalServices: ALL_SERVICE_UUIDS,
      };
    } else {
      // Filtered scan: show only devices advertising known FC services
      requestOpts = {
        filters: ALL_SERVICE_UUIDS.map(function (uuid) {
          return { services: [uuid] };
        }),
        optionalServices: ALL_SERVICE_UUIDS,
      };
    }

    device = await navigator.bluetooth.requestDevice(requestOpts);
    device.addEventListener('gattserverdisconnected', handleGattDisconnect);

    server = await device.gatt.connect();

    // Auto-detect which service the FC advertises
    var foundService = null;
    var foundChars = null;
    for (var i = 0; i < ALL_SERVICE_UUIDS.length; i++) {
      try {
        var svc = await server.getPrimaryService(ALL_SERVICE_UUIDS[i]);
        var charMap = FC_BLE_CHARS[ALL_SERVICE_UUIDS[i]];
        if (charMap) {
          txChar = await svc.getCharacteristic(charMap.tx);
          rxChar = await svc.getCharacteristic(charMap.rx);
          foundService = svc;
          foundChars = charMap;
          break;
        }
      } catch (_e) {
        // Service not available on this device — try next
      }
    }

    if (!foundService || !txChar || !rxChar) {
      if (device.gatt.connected) device.gatt.disconnect();
      throw new Error('No compatible BLE UART service found on this device.');
    }

    // Listen for notifications (FC → host)
    await txChar.startNotifications();
    txChar.addEventListener('characteristicvaluechanged', function (event) {
      if (_onData) {
        _onData(new Uint8Array(event.target.value.buffer));
      }
    });

    _connected = true;
    return { name: device.name || 'FC', id: device.id, type: 'ble' };
  }

  function handleGattDisconnect() {
    _connected = false;
    if (_onDisconnect) _onDisconnect();
  }

  function disconnect() {
    _connected = false;
    if (device && device.gatt && device.gatt.connected) {
      device.gatt.disconnect();
    }
  }

  function isConnected() {
    return _connected && device && device.gatt && device.gatt.connected;
  }

  /** BLE writes are limited to ~20 bytes per packet. Chunk accordingly. */
  async function write(data) {
    if (!rxChar) throw new Error('BLE not connected');
    var CHUNK = 20;
    for (var off = 0; off < data.length; off += CHUNK) {
      var chunk = data.slice(off, off + CHUNK);
      await rxChar.writeValue(chunk);
    }
  }

  function onData(cb) {
    _onData = cb;
  }

  return {
    type: 'ble',
    isSupported: isSupported,
    connect: connect,
    disconnect: disconnect,
    isConnected: isConnected,
    write: write,
    onData: onData,
  };
}

/**
 * USB Serial Transport — connects to FC via Web Serial API.
 * Standard Betaflight MSP serial: 115200 baud, 8N1.
 */
function UsbTransport() {
  var port = null;
  var reader = null;
  var _connected = false;
  var _onData = null;
  var _onDisconnect = null;
  var _reading = false;

  function isSupported() {
    return !!navigator.serial;
  }

  async function connect(onDisconnectCb) {
    _onDisconnect = onDisconnectCb || null;

    if (!navigator.serial) {
      throw new Error('Web Serial not supported. Use Chrome or Edge.');
    }

    port = await navigator.serial.requestPort();

    // Guard: skip open if port is already open (avoids "port is already open" error)
    if (!port.readable) {
      await port.open({
        baudRate: 115200,
        dataBits: 8,
        stopBits: 1,
        parity: 'none',
        flowControl: 'none',
      });
    }

    _connected = true;

    // Start reading in background
    _reading = true;
    readLoop();

    // Listen for disconnect
    navigator.serial.addEventListener('disconnect', function (ev) {
      if (ev.target === port) handleSerialDisconnect();
    });

    return { name: 'USB Serial', id: 'usb', type: 'usb' };
  }

  /** Continuously read from serial port */
  async function readLoop() {
    try {
      while (port && port.readable && _reading) {
        reader = port.readable.getReader();
        try {
          while (_reading) {
            var result = await reader.read();
            if (result.done) break;
            if (result.value && _onData) {
              _onData(new Uint8Array(result.value));
            }
          }
        } finally {
          reader.releaseLock();
          reader = null;
        }
      }
    } catch (err) {
      if (_connected) {
        handleSerialDisconnect();
      }
    }
  }

  function handleSerialDisconnect() {
    _connected = false;
    _reading = false;
    if (_onDisconnect) _onDisconnect();
  }

  async function disconnect() {
    _reading = false;
    _connected = false;

    // Cancel active reader first (must release lock before closing port)
    if (reader) {
      try { await reader.cancel(); } catch (_e) { /* ignore */ }
      reader = null;
    }

    // Close port only if it's actually open (has readable stream)
    if (port && port.readable) {
      try { await port.close(); } catch (_e) { /* ignore */ }
    }
    port = null;
  }

  function isConnected() {
    return _connected && !!port;
  }

  async function write(data) {
    if (!port || !port.writable) throw new Error('USB Serial not connected');
    var writer = port.writable.getWriter();
    try {
      await writer.write(data);
    } finally {
      writer.releaseLock();
    }
  }

  function onData(cb) {
    _onData = cb;
  }

  return {
    type: 'usb',
    isSupported: isSupported,
    connect: connect,
    disconnect: disconnect,
    isConnected: isConnected,
    write: write,
    onData: onData,
  };
}

// Expose globally
window.BleTransport = BleTransport;
window.UsbTransport = UsbTransport;
window.FC_BLE_SERVICES = FC_BLE_SERVICES;
