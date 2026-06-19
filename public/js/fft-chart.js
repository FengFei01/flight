/**
 * FFT spectrum chart — renders noise frequency graph with peak annotations.
 * Owns: Chart.js integration, axis toggle, peak markers, zoom via chartjs-plugin-zoom.
 * Does NOT own: FFT math (fft.js) or peak detection (spectrum-analyzer.js).
 */

/* global AnalysisCache, BBLClientParser, Chart, SpectrumAnalyzer, document, window */
(function () {
  'use strict';

  var AXIS_COLORS = {
    roll: { line: 'rgba(244, 67, 54, 0.9)', fill: 'rgba(244, 67, 54, 0.08)' },
    pitch: { line: 'rgba(76, 175, 80, 0.9)', fill: 'rgba(76, 175, 80, 0.08)' },
    yaw: { line: 'rgba(33, 150, 243, 0.9)', fill: 'rgba(33, 150, 243, 0.08)' }
  };

  var AXIS_LABELS = { roll: 'Roll', pitch: 'Pitch', yaw: 'Yaw' };
  var THROTTLE_MIN_SAMPLES = 1024;
  var THROTTLE_WINDOW_SIZE = 1024;

  var chartInstance = null;
  var spectrumData = null;
  var throttleChartInstances = [];

  function initFFTChart() {
    var container = document.getElementById('fftAnalysisSection');
    if (!container) return;

    var gyroEl = document.getElementById('fftGyroData');
    if (!gyroEl) return;

    var gyroData;
    var looptime;
    var effectiveSampleRate;
    var fileName;

    try {
      gyroData = JSON.parse(gyroEl.getAttribute('data-gyro'));
      looptime = parseInt(gyroEl.getAttribute('data-looptime'), 10) || 0;
      effectiveSampleRate = parseFloat(gyroEl.getAttribute('data-effective-samplerate')) || 0;
      fileName = gyroEl.getAttribute('data-file-name') || '';
    } catch (e) {
      console.error('[fft-chart] Failed to parse gyro data:', e);
      return;
    }

    if (!gyroData || (!gyroData.roll && !gyroData.pitch && !gyroData.yaw)) {
      var fallback = container.querySelector('.fft-no-data');
      if (fallback) fallback.style.display = 'block';
      return;
    }

    container.style.display = 'block';

    spectrumData = SpectrumAnalyzer.analyzeSpectrum(gyroData, looptime, effectiveSampleRate);
    renderChart(spectrumData);
    renderPeakTable(spectrumData);
    renderNotchSuggestions(spectrumData);
    setupAxisToggles();
    setupResetZoom();
    initThrottleRangeAnalysis({
      fileName: fileName,
      looptime: looptime,
      effectiveSampleRate: effectiveSampleRate
    });
  }

  function renderChart(data) {
    var canvas = document.getElementById('fftCanvas');
    if (!canvas) return;

    if (chartInstance) {
      chartInstance.destroy();
    }

    chartInstance = createSpectrumChart(canvas, data, {
      maxPeaks: 3,
      enableZoom: true,
      xMax: Math.ceil(Math.min(data.nyquist, 1000))
    });
  }

  function createSpectrumChart(canvas, data, options) {
    options = options || {};

    var datasets = buildDatasets(data);
    var peakAnnotations = buildPeakAnnotations(data, { maxPeaks: options.maxPeaks || 3 });
    var ctx = canvas.getContext('2d');
    var xMax = options.xMax || Math.ceil(Math.min(data.nyquist, 1000));

    return new Chart(ctx, {
      type: 'line',
      data: { datasets: datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'nearest', intersect: false },
        scales: {
          x: {
            type: 'linear',
            title: {
              display: true,
              text: '频率 (Hz)',
              color: 'rgba(255,255,255,0.6)',
              font: { family: 'Space Grotesk', size: 12 }
            },
            min: 0,
            max: xMax,
            grid: { color: 'rgba(255,255,255,0.06)' },
            ticks: { color: 'rgba(255,255,255,0.5)', font: { size: 11 } }
          },
          y: {
            title: {
              display: true,
              text: '幅值 (dB)',
              color: 'rgba(255,255,255,0.6)',
              font: { family: 'Space Grotesk', size: 12 }
            },
            min: -80,
            max: 0,
            grid: { color: 'rgba(255,255,255,0.06)' },
            ticks: { color: 'rgba(255,255,255,0.5)', font: { size: 11 } }
          }
        },
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: 'rgba(15,20,35,0.95)',
            titleColor: '#fff',
            bodyColor: 'rgba(255,255,255,0.8)',
            borderColor: 'rgba(0,212,255,0.3)',
            borderWidth: 1,
            callbacks: {
              title: function (items) {
                return items[0] ? Math.round(items[0].parsed.x) + ' Hz' : '';
              },
              label: function (ctx) {
                return ctx.dataset.label + ': ' + ctx.parsed.y.toFixed(1) + ' dB';
              }
            }
          },
          zoom: options.enableZoom ? {
            pan: { enabled: true, mode: 'x' },
            zoom: {
              wheel: { enabled: true },
              pinch: { enabled: true },
              mode: 'x'
            },
            limits: {
              x: { min: 0, max: xMax, minRange: 10 }
            }
          } : undefined,
          annotation: peakAnnotations.length > 0 ? { annotations: peakAnnotations } : undefined
        }
      }
    });
  }

  function buildDatasets(data) {
    var datasets = [];
    var axisNames = ['roll', 'pitch', 'yaw'];

    for (var a = 0; a < axisNames.length; a++) {
      var name = axisNames[a];
      var axisData = data.axes[name];
      if (!axisData || axisData.frequencies.length === 0) continue;

      var points = [];
      for (var i = 0; i < axisData.frequencies.length; i++) {
        if (axisData.frequencies[i] > data.nyquist) break;
        points.push({ x: axisData.frequencies[i], y: axisData.magnitudesDB[i] });
      }

      datasets.push({
        label: AXIS_LABELS[name],
        data: points,
        borderColor: AXIS_COLORS[name].line,
        backgroundColor: AXIS_COLORS[name].fill,
        borderWidth: 1.5,
        pointRadius: 0,
        fill: true,
        tension: 0.1
      });
    }

    return datasets;
  }

  function buildPeakAnnotations(data, options) {
    options = options || {};

    var annotations = {};
    var idx = 0;
    var axisNames = ['roll', 'pitch', 'yaw'];
    var colors = { roll: '#f44336', pitch: '#4caf50', yaw: '#2196f3' };
    var maxPeaks = options.maxPeaks || 3;

    for (var a = 0; a < axisNames.length; a++) {
      var name = axisNames[a];
      var axisData = data.axes[name];
      if (!axisData) continue;

      var peaks = axisData.peaks.slice(0, maxPeaks);
      for (var p = 0; p < peaks.length; p++) {
        var peak = peaks[p];
        var key = 'peak_' + idx++;
        annotations[key] = {
          type: 'line',
          xMin: peak.freq,
          xMax: peak.freq,
          borderColor: colors[name],
          borderWidth: 1,
          borderDash: [4, 4],
          label: {
            display: true,
            content: peak.freq + 'Hz (' + peak.db + 'dB)',
            position: 'start',
            backgroundColor: 'rgba(15,20,35,0.85)',
            color: colors[name],
            font: { size: 10, family: 'JetBrains Mono' },
            padding: { top: 2, bottom: 2, left: 4, right: 4 }
          }
        };
      }
    }

    return Object.keys(annotations).length > 0 ? annotations : [];
  }

  function renderPeakTable(data) {
    var tbody = document.getElementById('fftPeaksBody');
    if (!tbody) return;

    var axisNames = ['roll', 'pitch', 'yaw'];
    var html = '';
    var hasAny = false;
    var advisorPeaks = [];

    for (var a = 0; a < axisNames.length; a++) {
      var name = axisNames[a];
      var axisData = data.axes[name];
      if (!axisData || axisData.peaks.length === 0) continue;

      var merged = SpectrumAnalyzer.mergePeaks(axisData.peaks, 5, 3);
      for (var p = 0; p < merged.length; p++) {
        hasAny = true;
        var peak = merged[p];
        var isMotor = peak.freq >= 80 && peak.freq <= 500;
        html += '<tr class="' + (isMotor ? 'peak-motor' : '') + '">';
        html += '<td class="peak-axis peak-axis-' + name + '">' + AXIS_LABELS[name] + '</td>';
        html += '<td class="peak-freq">' + peak.freq + ' Hz</td>';
        html += '<td class="peak-db">' + peak.db + ' dB</td>';
        html += '<td class="peak-prom">+' + peak.prominence + ' dB</td>';
        html += '<td class="peak-label">' + peak.label;
        if (isMotor) {
          html += '<span class="peak-hint">（建议设置 Notch 滤波器）</span>';
        }
        html += '</td>';
        html += '</tr>';

        advisorPeaks.push({
          axis: name,
          freq: peak.freq,
          db: peak.db,
          prominence: peak.prominence,
          label: peak.label
        });
      }
    }

    if (!hasAny) {
      html = '<tr><td colspan="5" class="peak-none">未检测到显著谐振峰值 ✓</td></tr>';
    }

    tbody.innerHTML = html;

    var infoEl = document.getElementById('fftSampleInfo');
    if (infoEl) {
      infoEl.textContent = '采样率: ' + Math.round(data.sampleRate) +
        ' Hz | 奈奎斯特频率: ' + Math.round(data.nyquist) + ' Hz';
    }

    if (window._ffAdvisorContext) {
      window._ffAdvisorContext.fftPeaks = advisorPeaks;
    }
  }

  function renderNotchSuggestions(data) {
    var container = document.getElementById('notchSuggestionsSection');
    if (!container) return;

    var notchResult = SpectrumAnalyzer.generateNotchParams(data);
    if (!notchResult.suggestions || notchResult.suggestions.length === 0) {
      container.style.display = 'none';
      return;
    }

    container.style.display = 'block';

    var tbody = document.getElementById('notchSuggestionsBody');
    if (tbody) {
      var html = '';
      for (var i = 0; i < notchResult.suggestions.length; i++) {
        var s = notchResult.suggestions[i];
        html += '<tr>';
        html += '<td class="peak-axis peak-axis-' + s.axis + '">' + s.axisLabel + '</td>';
        html += '<td>Notch ' + s.notchNum + '</td>';
        html += '<td class="peak-freq">' + s.centerHz + ' Hz</td>';
        html += '<td class="peak-freq">' + s.cutoffHz + ' Hz</td>';
        html += '<td class="notch-q">' + s.q + '</td>';
        html += '<td class="peak-freq">' + (s.bandwidth ? s.bandwidth + ' Hz' : '-') + '</td>';
        html += '<td class="notch-reason">' + s.reason + '</td>';
        html += '</tr>';
      }
      tbody.innerHTML = html;
    }

    container.setAttribute('data-notch', JSON.stringify(notchResult));

    var notesEl = document.getElementById('notchNotes');
    if (!notesEl) return;

    var notes = [];
    var axisNames = ['roll', 'pitch', 'yaw'];
    for (var a = 0; a < axisNames.length; a++) {
      var axisName = axisNames[a];
      var perAxis = notchResult.perAxis[axisName];
      if (!perAxis || perAxis.length === 0) continue;

      if (perAxis.length === 1) {
        var s1 = perAxis[0];
        notes.push(
          AXIS_LABELS[axisName] + ' 轴主噪声在 ' + s1.centerHz + 'Hz，建议 Notch 中心频率 ' +
          s1.centerHz + 'Hz / 截止频率 ' + s1.cutoffHz + 'Hz / Q=' + s1.q +
          (s1.bandwidth ? ' (带宽 ' + s1.bandwidth + 'Hz)' : '')
        );
      } else {
        notes.push(
          AXIS_LABELS[axisName] + ' 检测到 ' + perAxis.length + ' 个谐振峰 (' +
          perAxis.map(function (item) { return item.centerHz + 'Hz'; }).join(' / ') +
          ') → 建议配置 ' + perAxis.length + ' 个 Notch 滤波器'
        );
      }
    }

    notesEl.innerHTML = notes.map(function (note) {
      return '<li class="tuning-note-item">' + note + '</li>';
    }).join('');
  }

  function setupAxisToggles() {
    var btns = document.querySelectorAll('.fft-axis-toggle');
    for (var i = 0; i < btns.length; i++) {
      btns[i].addEventListener('click', function () {
        var axis = this.getAttribute('data-axis');
        var idx = getDatasetIndex(axis);
        if (idx === -1 || !chartInstance) return;

        var meta = chartInstance.getDatasetMeta(idx);
        meta.hidden = !meta.hidden;
        this.classList.toggle('fft-toggle-off', meta.hidden);
        chartInstance.update();
      });
    }
  }

  function setupResetZoom() {
    var btn = document.getElementById('fftResetZoom');
    if (!btn) return;

    btn.addEventListener('click', function () {
      if (chartInstance && chartInstance.resetZoom) {
        chartInstance.resetZoom();
      }
    });
  }

  function getDatasetIndex(axisName) {
    if (!chartInstance) return -1;

    for (var i = 0; i < chartInstance.data.datasets.length; i++) {
      if (chartInstance.data.datasets[i].label === AXIS_LABELS[axisName]) {
        return i;
      }
    }
    return -1;
  }

  function initThrottleRangeAnalysis(meta) {
    var section = document.getElementById('throttleRangeSection');
    if (!section) return;

    section.style.display = 'block';
    setThrottleRangeStatus('正在读取本次上传的 BBL 原始文件，并计算油门分段 FFT...', true);

    if (typeof AnalysisCache === 'undefined' || typeof BBLClientParser === 'undefined') {
      setThrottleRangeStatus('当前浏览器不支持分段分析所需的本地缓存或解析能力。', true);
      return;
    }

    AnalysisCache.loadLatestFile()
      .then(function (entry) {
        if (!entry || !entry.file) {
          throw new Error('未找到本次上传的原始 BBL 缓存。');
        }
        if (meta.fileName && entry.name && entry.name !== meta.fileName) {
          throw new Error('当前页面对应的原始 BBL 缓存已被新的上传覆盖。');
        }
        return BBLClientParser.parseFile(entry.file);
      })
      .then(function (parsed) {
        if (!parsed || !parsed.frames || !parsed.frames.gyro) {
          throw new Error('原始 BBL 解析失败。');
        }

        var throttleData = SpectrumAnalyzer.buildThrottleSeries(
          parsed.frames.motor,
          parsed.header.motorOutput
        );

        var analysis = SpectrumAnalyzer.analyzeThrottleRanges(
          parsed.frames.gyro,
          throttleData.series,
          parsed.header.looptime || meta.looptime,
          parsed.frames.effectiveSampleRate || meta.effectiveSampleRate,
          {
            minSamples: THROTTLE_MIN_SAMPLES,
            windowSize: THROTTLE_WINDOW_SIZE
          }
        );

        renderThrottleRangeAnalysis(analysis);
        appendThrottleAwareNotchNotes(analysis);

        if (window._ffAdvisorContext) {
          window._ffAdvisorContext.throttleRangeAnalysis = buildAdvisorThrottleSummary(analysis);
        }
      })
      .catch(function (err) {
        console.warn('[fft-chart] Throttle range analysis unavailable:', err);
        setThrottleRangeStatus(err.message || '油门分段分析暂时不可用。', true);
      });
  }

  function renderThrottleRangeAnalysis(analysis) {
    setThrottleRangeStatus('', false);
    renderThrottleRangeCards(analysis);
    renderThrottleRangeSummary(analysis);
  }

  function renderThrottleRangeCards(analysis) {
    destroyThrottleCharts();

    var container = document.getElementById('throttleRangeCards');
    if (!container) return;

    var html = '';
    for (var i = 0; i < analysis.bands.length; i++) {
      var band = analysis.bands[i];
      var statText = '样本 ' + band.sampleCount + ' | 可用 ' + band.usableSamples +
        ' | 窗口 ' + band.windowCount;
      if (band.averageThrottle !== null) {
        statText += ' | 均值 ' + band.averageThrottle + '%';
      }

      html += '<div class="throttle-band-card">';
      html += '<div class="throttle-band-head">';
      html += '<div>';
      html += '<div class="throttle-band-label">' + band.label + '</div>';
      html += '<div class="throttle-band-meta">' + statText + '</div>';
      html += '</div>';
      html += '<div class="throttle-band-peaks">' + formatBandHeaderPeaks(band) + '</div>';
      html += '</div>';

      if (band.valid) {
        html += '<div class="fft-chart-wrap throttle-chart-wrap">';
        html += '<canvas id="throttleRangeCanvas_' + i + '"></canvas>';
        html += '</div>';
      } else {
        html += '<div class="info-banner throttle-band-warning">';
        html += '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>';
        html += '<span>' + band.warning + '</span>';
        html += '</div>';
      }

      html += '</div>';
    }

    container.innerHTML = html;

    for (var b = 0; b < analysis.bands.length; b++) {
      if (!analysis.bands[b].valid) continue;
      var canvas = document.getElementById('throttleRangeCanvas_' + b);
      if (!canvas) continue;

      throttleChartInstances.push(createSpectrumChart(canvas, analysis.bands[b].spectrum, {
        maxPeaks: 2,
        enableZoom: false,
        xMax: Math.ceil(Math.min(analysis.bands[b].spectrum.nyquist, 800))
      }));
    }
  }

  function renderThrottleRangeSummary(analysis) {
    var section = document.getElementById('throttleRangeSummarySection');
    var tbody = document.getElementById('throttleRangeSummaryBody');
    var notesEl = document.getElementById('throttleRangeNotes');
    if (!section || !tbody || !notesEl) return;

    section.style.display = 'block';

    var rows = '';
    for (var i = 0; i < analysis.bands.length; i++) {
      var band = analysis.bands[i];
      rows += '<tr>';
      rows += '<td class="throttle-summary-band">' + band.label + '</td>';
      rows += '<td class="throttle-summary-meta">' + band.sampleCount + ' / ' + band.windowCount + '</td>';
      rows += '<td>' + formatAxisSummaryCell(band.axisSummaries.roll) + '</td>';
      rows += '<td>' + formatAxisSummaryCell(band.axisSummaries.pitch) + '</td>';
      rows += '<td>' + formatAxisSummaryCell(band.axisSummaries.yaw) + '</td>';
      rows += '<td class="throttle-summary-notch">' + formatBandNotchSummary(band) + '</td>';
      rows += '<td class="throttle-summary-note">' + (band.valid ? formatBandNote(band) : band.warning) + '</td>';
      rows += '</tr>';
    }
    tbody.innerHTML = rows;

    var notes = analysis.dynamic && analysis.dynamic.notes ? analysis.dynamic.notes.slice() : [];
    if (!notes.length) {
      notes.push('各油门段主共振峰变化不大，可以优先参考上方静态 Notch 建议。');
    }

    notesEl.innerHTML = notes.map(function (note) {
      return '<li class="tuning-note-item">' + note + '</li>';
    }).join('');
  }

  function appendThrottleAwareNotchNotes(analysis) {
    var notesEl = document.getElementById('notchNotes');
    if (!notesEl || !analysis.dynamic || !analysis.dynamic.dynamicAxes.length) return;

    var oldNotes = notesEl.querySelectorAll('.throttle-dynamic-note');
    for (var i = 0; i < oldNotes.length; i++) {
      oldNotes[i].remove();
    }

    for (var d = 0; d < analysis.dynamic.dynamicAxes.length; d++) {
      var axis = analysis.dynamic.dynamicAxes[d];
      var li = document.createElement('li');
      li.className = 'tuning-note-item throttle-dynamic-note';
      li.textContent = axis.axisLabel + ' 轴主共振峰在油门段之间变化 ' + axis.shiftHz +
        'Hz（' + axis.minFreq + '-' + axis.maxFreq + 'Hz），建议优先使用动态 Notch，静态 Notch 仅处理最突出的固定峰。';
      notesEl.appendChild(li);
    }
  }

  function buildAdvisorThrottleSummary(analysis) {
    var summary = [];
    for (var i = 0; i < analysis.bands.length; i++) {
      var band = analysis.bands[i];
      summary.push({
        label: band.label,
        valid: band.valid,
        roll: extractAxisAdvisorPeaks(band.axisSummaries.roll),
        pitch: extractAxisAdvisorPeaks(band.axisSummaries.pitch),
        yaw: extractAxisAdvisorPeaks(band.axisSummaries.yaw)
      });
    }
    return {
      bands: summary,
      dynamicNotes: analysis.dynamic ? analysis.dynamic.notes : []
    };
  }

  function extractAxisAdvisorPeaks(axisSummary) {
    if (!axisSummary || !axisSummary.motorPeaks || !axisSummary.motorPeaks.length) {
      return [];
    }
    return axisSummary.motorPeaks.map(function (peak) { return peak.freq; });
  }

  function formatBandHeaderPeaks(band) {
    if (!band.valid) {
      return '<span class="throttle-band-tag throttle-band-tag-muted">数据不足</span>';
    }

    var items = [];
    var axisNames = ['roll', 'pitch', 'yaw'];
    for (var i = 0; i < axisNames.length; i++) {
      var axis = axisNames[i];
      var primary = band.axisSummaries[axis].primaryPeak;
      if (!primary) continue;
      items.push(
        '<span class="throttle-band-tag throttle-axis-' + axis + '">' +
        AXIS_LABELS[axis] + ' ' + primary.freq + 'Hz</span>'
      );
    }

    if (!items.length) {
      return '<span class="throttle-band-tag throttle-band-tag-muted">未见稳定峰值</span>';
    }

    return items.join('');
  }

  function formatAxisSummaryCell(axisSummary) {
    if (!axisSummary || !axisSummary.motorPeaks || !axisSummary.motorPeaks.length) {
      return '<span class="throttle-summary-empty">-</span>';
    }
    return axisSummary.motorPeaks.map(function (peak) {
      return peak.freq + 'Hz';
    }).join(' / ');
  }

  function formatBandNotchSummary(band) {
    if (!band.valid) {
      return '<span class="throttle-summary-empty">-</span>';
    }

    if (!band.notch || !band.notch.suggestions || !band.notch.suggestions.length) {
      return '未检测到稳定的固定 Notch 目标';
    }

    var perAxis = [];
    var axisNames = ['roll', 'pitch', 'yaw'];
    for (var i = 0; i < axisNames.length; i++) {
      var axis = axisNames[i];
      var entries = band.notch.perAxis[axis];
      if (!entries || !entries.length) continue;
      perAxis.push(
        AXIS_LABELS[axis] + ': ' + entries.map(function (entry) {
          return entry.centerHz + '/' + entry.cutoffHz + 'Hz Q=' + entry.q;
        }).join(', ')
      );
    }

    return perAxis.length ? perAxis.join('<br>') : '未检测到稳定的固定 Notch 目标';
  }

  function formatBandNote(band) {
    var axisNames = ['roll', 'pitch', 'yaw'];
    var primary = [];

    for (var i = 0; i < axisNames.length; i++) {
      var axis = axisNames[i];
      var peak = band.axisSummaries[axis].primaryPeak;
      if (peak) {
        primary.push(AXIS_LABELS[axis] + ' ' + peak.freq + 'Hz');
      }
    }

    if (!primary.length) {
      return '该油门段未检测到稳定的主峰。';
    }

    return '主峰集中在 ' + primary.join(' / ') + '。';
  }

  function setThrottleRangeStatus(message, visible) {
    var banner = document.getElementById('throttleRangeStatus');
    var text = document.getElementById('throttleRangeStatusText');
    if (!banner || !text) return;

    text.textContent = message || '';
    banner.style.display = visible ? 'flex' : 'none';
  }

  function destroyThrottleCharts() {
    for (var i = 0; i < throttleChartInstances.length; i++) {
      throttleChartInstances[i].destroy();
    }
    throttleChartInstances = [];
  }

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', initFFTChart);
    } else {
      initFFTChart();
    }
  }
})();
