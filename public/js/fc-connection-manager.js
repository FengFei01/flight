/**
 * FC Connection Manager — global singleton that holds the active FC connection.
 * Owns: shared MspClient instance, connection state, event dispatch.
 * Does NOT own: UI rendering, MSP protocol (see msp-client.js), transports (see fc-transport.js).
 *
 * Survives document.write() page transitions (analyze → results) because it
 * lives on window. Both ble-connector.js and fc-pid-reader.js use this instead
 * of creating their own MspClient instances.
 */

(function () {
  'use strict';

  // Singleton — skip if already initialized (survives document.write)
  if (window.FcConnectionManager) return;

  var client = null;       // MspClient instance
  var connInfo = null;     // { name, id, type } from transport.connect()
  var listeners = [];      // state-change callbacks

  /**
   * Register a listener for connection state changes.
   * @param {Function} cb - called with (state, info) where state is
   *   'connected' | 'disconnected' and info is { name, id, type } or null.
   * @returns {Function} unsubscribe function
   */
  function onStateChange(cb) {
    listeners.push(cb);
    return function () {
      listeners = listeners.filter(function (fn) { return fn !== cb; });
    };
  }

  function notifyListeners(state) {
    for (var i = 0; i < listeners.length; i++) {
      try { listeners[i](state, connInfo); } catch (_e) { /* don't break loop */ }
    }
  }

  /**
   * Connect to FC using the given transport.
   * If already connected, disconnects first.
   * @param {Object} transport - BleTransport() or UsbTransport() instance
   * @returns {Promise<Object>} connection info { name, id, type }
   */
  async function connect(transport) {
    // Disconnect existing connection first
    if (client && client.isConnected()) {
      client.disconnect();
    }

    client = MspClient(transport);
    var info = await client.connect(function () {
      // On unexpected disconnect
      connInfo = null;
      notifyListeners('disconnected');
    });

    connInfo = info;
    notifyListeners('connected');
    return info;
  }

  /** Disconnect from FC */
  function disconnect() {
    if (client) client.disconnect();
    client = null;
    connInfo = null;
    notifyListeners('disconnected');
  }

  /** @returns {boolean} whether FC is currently connected */
  function isConnected() {
    return !!(client && client.isConnected());
  }

  /** @returns {Object|null} the active MspClient, or null */
  function getClient() {
    return client;
  }

  /** @returns {Object|null} connection info { name, id, type } */
  function getInfo() {
    return connInfo;
  }

  // Expose singleton
  window.FcConnectionManager = {
    connect: connect,
    disconnect: disconnect,
    isConnected: isConnected,
    getClient: getClient,
    getInfo: getInfo,
    onStateChange: onStateChange,
  };
})();
