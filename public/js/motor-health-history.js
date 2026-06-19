(function () {
  'use strict';

  var DB_NAME = 'flightforge-motor-history';
  var STORE = 'analyses';
  var MAX_RECORDS = 10;

  var SUGGESTIONS = {
    bearing_wear: 'Motor shows signs of bearing wear. Check for unusual noise and consider bearing/motor replacement. / 疑似轴承磨损，建议检查电机是否有异响，必要时更换轴承或电机。',
    imbalance: 'Imbalance detected. Inspect propeller for nicks/bends, try replacing props. / 存在动平衡问题，检查螺旋桨是否有缺口/弯曲，尝试更换桨叶。',
    prop_damage: 'Harmonic anomaly — likely prop damage. Replace propeller immediately. / 谐波异常，可能是桨叶损伤，建议立即更换螺旋桨。',
    motor_mismatch: 'Significant motor mismatch. Check for loose motor screws or mismatched motor batches. / 电机间性能差异较大，检查是否有松动的电机螺丝或不同批次的电机。'
  };

  var AXIS_COLORS = {
    overall: { border: 'rgba(200,200,200,0.8)', bg: 'rgba(200,200,200,0.15)' },
    roll:    { border: '#f44336', bg: 'rgba(244,67,54,0.15)' },
    pitch:   { border: '#4caf50', bg: 'rgba(76,175,80,0.15)' },
    yaw:     { border: '#2196f3', bg: 'rgba(33,150,243,0.15)' }
  };

  function openDb() {
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = function (e) {
        var db = e.target.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
        }
      };
      req.onsuccess = function (e) { resolve(e.target.result); };
      req.onerror = function (e) { reject(e.target.error); };
    });
  }

  function storeAnalysis(db, record) {
    return new Promise(function (resolve, reject) {
      var tx = db.transaction(STORE, 'readwrite');
      var store = tx.objectStore(STORE);
      store.add(record);
      tx.oncomplete = function () { resolve(); };
      tx.onerror = function (e) { reject(e.target.error); };
    });
  }

  function loadHistory(db) {
    return new Promise(function (resolve, reject) {
      var tx = db.transaction(STORE, 'readonly');
      var store = tx.objectStore(STORE);
      var req = store.getAll();
      req.onsuccess = function () { resolve(req.result || []); };
      req.onerror = function (e) { reject(e.target.error); };
    });
  }

  function pruneHistory(db) {
    return new Promise(function (resolve, reject) {
      var tx = db.transaction(STORE, 'readwrite');
      var store = tx.objectStore(STORE);
      var countReq = store.count();
      countReq.onsuccess = function () {
        var total = countReq.result;
        if (total <= MAX_RECORDS) return resolve();
        var toDelete = total - MAX_RECORDS;
        var cursorReq = store.openCursor();
        var deleted = 0;
        cursorReq.onsuccess = function (e) {
          var cursor = e.target.result;
          if (cursor && deleted < toDelete) {
            cursor.delete();
            deleted++;
            cursor.continue();
          }
        };
      };
      tx.oncomplete = function () { resolve(); };
      tx.onerror = function (e) { reject(e.target.error); };
    });
  }

  function clearAllHistory(db) {
    return new Promise(function (resolve, reject) {
      var tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).clear();
      tx.oncomplete = function () { resolve(); };
      tx.onerror = function (e) { reject(e.target.error); };
    });
  }

  function formatDate(ts) {
    var d = new Date(ts);
    var mm = String(d.getMonth() + 1).padStart(2, '0');
    var dd = String(d.getDate()).padStart(2, '0');
    var hh = String(d.getHours()).padStart(2, '0');
    var mi = String(d.getMinutes()).padStart(2, '0');
    return mm + '/' + dd + ' ' + hh + ':' + mi;
  }

  function renderChart(records) {
    if (records.length < 2) return null;
    var labels = records.map(function (r) { return formatDate(r.timestamp); });
    var datasets = [
      { label: 'Overall', data: records.map(function (r) { return r.overall.score; }), borderColor: AXIS_COLORS.overall.border, backgroundColor: AXIS_COLORS.overall.bg, borderDash: [6, 3] },
      { label: 'Roll',    data: records.map(function (r) { return r.axes.roll.score; }), borderColor: AXIS_COLORS.roll.border, backgroundColor: AXIS_COLORS.roll.bg },
      { label: 'Pitch',   data: records.map(function (r) { return r.axes.pitch.score; }), borderColor: AXIS_COLORS.pitch.border, backgroundColor: AXIS_COLORS.pitch.bg },
      { label: 'Yaw',     data: records.map(function (r) { return r.axes.yaw.score; }), borderColor: AXIS_COLORS.yaw.border, backgroundColor: AXIS_COLORS.yaw.bg }
    ];
    datasets.forEach(function (ds) {
      ds.tension = 0.3;
      ds.pointRadius = 4;
      ds.fill = false;
      ds.borderWidth = 2;
    });
    var ctx = document.getElementById('motorHistoryChart').getContext('2d');
    return new Chart(ctx, {
      type: 'line',
      data: { labels: labels, datasets: datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { labels: { color: 'rgba(255,255,255,0.7)', font: { size: 11 } } }
        },
        scales: {
          x: { ticks: { color: 'rgba(255,255,255,0.5)', font: { size: 10 } }, grid: { color: 'rgba(255,255,255,0.06)' } },
          y: { min: 0, max: 100, ticks: { color: 'rgba(255,255,255,0.5)', font: { size: 10 } }, grid: { color: 'rgba(255,255,255,0.06)' } }
        }
      }
    });
  }

  function checkDeclineWarnings(records) {
    var container = document.getElementById('motorHistoryWarnings');
    if (!container || records.length < 2) return;
    container.innerHTML = '';
    var prev = records[records.length - 2];
    var curr = records[records.length - 1];
    var keys = [
      { key: 'overall', label: 'Overall' },
      { key: 'roll', label: 'Roll' },
      { key: 'pitch', label: 'Pitch' },
      { key: 'yaw', label: 'Yaw' }
    ];
    keys.forEach(function (k) {
      var prevScore = k.key === 'overall' ? prev.overall.score : prev.axes[k.key].score;
      var currScore = k.key === 'overall' ? curr.overall.score : curr.axes[k.key].score;
      var drop = prevScore - currScore;
      if (drop > 10) {
        var div = document.createElement('div');
        div.className = 'mh-decline-warning';
        div.textContent = '⚠ ' + k.label + ' health score declining (' + prevScore + ' → ' + currScore + '). Focus attention on this axis. / ' + k.label + ' 健康评分持续下降 (' + prevScore + ' → ' + currScore + ')，建议重点关注。';
        container.appendChild(div);
      }
    });
  }

  function buildReport(current, records) {
    var axes = {};
    ['roll', 'pitch', 'yaw'].forEach(function (ax) {
      var a = current.axes[ax];
      var issues = (a.issues || []).map(function (iss) {
        return { type: iss.type, severity: iss.severity, detail: iss.detail, suggestion: SUGGESTIONS[iss.type] || '' };
      });
      axes[ax] = { score: a.score, rating: a.rating, issues: issues };
    });
    var history = records.map(function (r) {
      return { timestamp: r.timestamp, fileName: r.fileName, overall: r.overall, axes: { roll: { score: r.axes.roll.score, rating: r.axes.roll.rating }, pitch: { score: r.axes.pitch.score, rating: r.axes.pitch.rating }, yaw: { score: r.axes.yaw.score, rating: r.axes.yaw.rating } } };
    });
    return {
      date: new Date().toISOString(),
      firmware: current.firmware,
      craftName: current.craftName,
      fileName: current.fileName,
      overall: current.overall,
      axes: axes,
      history: history
    };
  }

  function downloadJson(obj) {
    var d = new Date();
    var name = 'flightforge-motor-report-' + d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0') + '.json';
    var blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(a.href);
  }

  document.addEventListener('DOMContentLoaded', function () {
    var el = document.getElementById('motorHealthData');
    if (!el) return;
    var raw = el.getAttribute('data-motor-health');
    if (!raw) return;
    var motorHealth;
    try { motorHealth = JSON.parse(raw); } catch (_) { return; }
    if (!motorHealth || !motorHealth.axes) return;

    var firmware = el.getAttribute('data-firmware') || '';
    var craftName = el.getAttribute('data-craft-name') || '';
    var fileName = el.getAttribute('data-file-name') || '';

    var current = {
      timestamp: Date.now(),
      fileName: fileName,
      firmware: firmware,
      craftName: craftName,
      overall: { score: motorHealth.overall.score, rating: motorHealth.overall.rating },
      axes: {}
    };
    ['roll', 'pitch', 'yaw'].forEach(function (ax) {
      var a = motorHealth.axes[ax];
      current.axes[ax] = { score: a.score, rating: a.rating, issues: a.issues || [] };
    });

    var chart = null;

    openDb().then(function (db) {
      return storeAnalysis(db, current).then(function () {
        return pruneHistory(db);
      }).then(function () {
        return loadHistory(db);
      }).then(function (records) {
        if (records.length === 0) return;
        var section = document.getElementById('motorHistorySection');
        if (section) section.style.display = '';

        if (records.length >= 2 && typeof Chart !== 'undefined') {
          chart = renderChart(records);
        }
        checkDeclineWarnings(records);

        var exportBtn = document.getElementById('exportReportBtn');
        if (exportBtn) {
          exportBtn.addEventListener('click', function () {
            loadHistory(db).then(function (latest) {
              downloadJson(buildReport(current, latest));
            });
          });
        }

        var clearBtn = document.getElementById('clearHistoryBtn');
        if (clearBtn) {
          clearBtn.addEventListener('click', function () {
            clearAllHistory(db).then(function () {
              if (chart) { chart.destroy(); chart = null; }
              var warnings = document.getElementById('motorHistoryWarnings');
              if (warnings) warnings.innerHTML = '';
              var section = document.getElementById('motorHistorySection');
              if (section) section.style.display = 'none';
            });
          });
        }
      });
    }).catch(function (err) {
      console.warn('Motor health history unavailable:', err);
    });

    var toggle = document.querySelector('.mh-history-toggle');
    if (toggle) {
      toggle.addEventListener('click', function () {
        var body = document.getElementById('motorHistoryBody');
        var arrow = toggle.querySelector('.mh-toggle-arrow');
        if (!body) return;
        var open = body.style.display !== 'none';
        body.style.display = open ? 'none' : '';
        if (arrow) arrow.classList.toggle('open', !open);
      });
    }
  });
})();
