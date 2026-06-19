/**
 * IndexedDB cache for the latest uploaded BBL file.
 * Owns: bounded browser-side persistence across analyze -> results navigation.
 * Does NOT own: parsing or FFT analysis.
 */

/* global window, indexedDB */
(function (exports) {
  'use strict';

  var DB_NAME = 'flightforge-analysis-cache';
  var STORE_NAME = 'uploads';
  var CACHE_KEY = 'latest-bbl-file';
  var TTL_MS = 2 * 60 * 60 * 1000; // 2 hours

  function isSupported() {
    return typeof indexedDB !== 'undefined';
  }

  function openDb() {
    return new Promise(function (resolve, reject) {
      if (!isSupported()) {
        resolve(null);
        return;
      }

      var req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: 'id' });
        }
      };
      req.onsuccess = function () {
        resolve(req.result);
      };
      req.onerror = function () {
        reject(req.error || new Error('Failed to open IndexedDB.'));
      };
    });
  }

  function readEntry(db) {
    return new Promise(function (resolve, reject) {
      var tx = db.transaction(STORE_NAME, 'readonly');
      var store = tx.objectStore(STORE_NAME);
      var req = store.get(CACHE_KEY);

      req.onsuccess = function () {
        resolve(req.result || null);
      };
      req.onerror = function () {
        reject(req.error || new Error('Failed to read cache entry.'));
      };
    });
  }

  function writeEntry(db, entry) {
    return new Promise(function (resolve, reject) {
      var tx = db.transaction(STORE_NAME, 'readwrite');
      var store = tx.objectStore(STORE_NAME);
      var req = store.put(entry);

      req.onsuccess = function () {
        resolve(entry);
      };
      req.onerror = function () {
        reject(req.error || new Error('Failed to write cache entry.'));
      };
    });
  }

  function deleteEntry(db) {
    return new Promise(function (resolve, reject) {
      var tx = db.transaction(STORE_NAME, 'readwrite');
      var store = tx.objectStore(STORE_NAME);
      var req = store.delete(CACHE_KEY);

      req.onsuccess = function () {
        resolve();
      };
      req.onerror = function () {
        reject(req.error || new Error('Failed to clear cache entry.'));
      };
    });
  }

  function closeDb(db) {
    if (db && typeof db.close === 'function') {
      db.close();
    }
  }

  function cleanupExpired() {
    return openDb().then(function (db) {
      if (!db) return false;

      return readEntry(db).then(function (entry) {
        if (!entry || !entry.expiresAt || entry.expiresAt > Date.now()) {
          closeDb(db);
          return false;
        }
        return deleteEntry(db).then(function () {
          closeDb(db);
          return true;
        });
      }).catch(function (err) {
        closeDb(db);
        throw err;
      });
    });
  }

  function storeLatestFile(file) {
    if (!file) {
      return Promise.reject(new Error('No file provided for cache.'));
    }

    return openDb().then(function (db) {
      if (!db) return false;

      var now = Date.now();
      var entry = {
        id: CACHE_KEY,
        file: file,
        name: file.name || '',
        size: file.size || 0,
        type: file.type || '',
        lastModified: file.lastModified || 0,
        createdAt: now,
        expiresAt: now + TTL_MS
      };

      return writeEntry(db, entry).then(function () {
        closeDb(db);
        return true;
      }).catch(function (err) {
        closeDb(db);
        throw err;
      });
    });
  }

  function loadLatestFile() {
    return openDb().then(function (db) {
      if (!db) return null;

      return readEntry(db).then(function (entry) {
        if (!entry) {
          closeDb(db);
          return null;
        }
        if (entry.expiresAt && entry.expiresAt <= Date.now()) {
          return deleteEntry(db).then(function () {
            closeDb(db);
            return null;
          });
        }
        closeDb(db);
        return entry;
      }).catch(function (err) {
        closeDb(db);
        throw err;
      });
    });
  }

  function clearLatestFile() {
    return openDb().then(function (db) {
      if (!db) return false;

      return deleteEntry(db).then(function () {
        closeDb(db);
        return true;
      }).catch(function (err) {
        closeDb(db);
        throw err;
      });
    });
  }

  exports.AnalysisCache = {
    isSupported: isSupported,
    cleanupExpired: cleanupExpired,
    storeLatestFile: storeLatestFile,
    loadLatestFile: loadLatestFile,
    clearLatestFile: clearLatestFile,
    ttlMs: TTL_MS
  };
})(typeof window !== 'undefined' ? window : module.exports);
