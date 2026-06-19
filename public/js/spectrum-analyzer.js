/**
 * Spectrum analyzer — FFT-based noise analysis with peak detection.
 * Owns: running FFT on gyro data, detecting resonance peaks, formatting results.
 * Does NOT own: FFT math (see fft.js) or chart rendering (see fft-chart.js).
 */

/* global window, FFT */
(function (exports) {
  'use strict';

  var _FFT = (typeof FFT !== 'undefined') ? FFT : require('./fft.js').FFT;

  var DEFAULT_THROTTLE_BANDS = [
    { id: 'band_0_25', label: '0-25%', min: 0, max: 25 },
    { id: 'band_25_50', label: '25-50%', min: 25, max: 50 },
    { id: 'band_50_75', label: '50-75%', min: 50, max: 75 },
    { id: 'band_75_100', label: '75-100%', min: 75, max: 100 }
  ];

  function analyzeSpectrum(gyroData, looptime, effectiveSampleRate) {
    var sampleRate = resolveSampleRate(looptime, effectiveSampleRate);
    var nyquist = sampleRate / 2;
    var axes = {};
    var axisNames = ['roll', 'pitch', 'yaw'];

    for (var a = 0; a < axisNames.length; a++) {
      var name = axisNames[a];
      var data = gyroData[name] || [];
      if (data.length < 16) {
        axes[name] = { frequencies: [], magnitudesDB: [], peaks: [] };
        continue;
      }

      var result = _FFT.fft(data, sampleRate);
      var db = _FFT.toDecibels(result.magnitudes);

      axes[name] = {
        frequencies: Array.from(result.frequencies),
        magnitudesDB: Array.from(db),
        peaks: detectPeaks(result.frequencies, db, nyquist)
      };
    }

    return { axes: axes, sampleRate: sampleRate, nyquist: nyquist };
  }

  function detectPeaks(frequencies, db, nyquist) {
    if (frequencies.length < 5) return [];

    var windowSize = 31;
    var halfWin = Math.floor(windowSize / 2);
    var noiseFloor = new Float64Array(db.length);

    for (var i = 0; i < db.length; i++) {
      var lo = Math.max(0, i - halfWin);
      var hi = Math.min(db.length - 1, i + halfWin);
      var sum = 0;
      for (var j = lo; j <= hi; j++) sum += db[j];
      noiseFloor[i] = sum / (hi - lo + 1);
    }

    var THRESHOLD_DB = 6;
    var peaks = [];
    var aliasingThreshold = nyquist * 0.9;

    for (var k = 2; k < db.length - 1; k++) {
      var freq = frequencies[k];
      if (freq > nyquist) break;

      if (db[k] > db[k - 1] && db[k] > db[k + 1]) {
        var prominence = db[k] - noiseFloor[k];
        if (prominence < THRESHOLD_DB) continue;
        if (freq > aliasingThreshold) continue;

        var label = '';
        if (freq >= 80 && freq <= 500) {
          label = '电机谐振';
        } else if (freq > 500) {
          label = '高频噪声';
        } else if (freq >= 20 && freq < 80) {
          label = '低频振动';
        } else {
          label = '超低频';
        }

        var halfPowerLevel = db[k] - 3;
        var leftFreq = frequencies[0];
        for (var li = k - 1; li >= 0; li--) {
          if (db[li] <= halfPowerLevel) {
            var frac = (halfPowerLevel - db[li]) / (db[li + 1] - db[li]);
            leftFreq = frequencies[li] + frac * (frequencies[li + 1] - frequencies[li]);
            break;
          }
        }
        var rightFreq = frequencies[db.length - 1];
        for (var ri = k + 1; ri < db.length; ri++) {
          if (db[ri] <= halfPowerLevel) {
            var frac2 = (halfPowerLevel - db[ri]) / (db[ri - 1] - db[ri]);
            rightFreq = frequencies[ri] - frac2 * (frequencies[ri] - frequencies[ri - 1]);
            break;
          }
        }
        var bandwidth = rightFreq - leftFreq;
        var binWidth = frequencies.length > 1 ? frequencies[1] - frequencies[0] : 1;
        if (bandwidth < binWidth) bandwidth = binWidth;

        peaks.push({
          freq: Math.round(freq),
          db: Math.round(db[k] * 10) / 10,
          prominence: Math.round(prominence * 10) / 10,
          bandwidth: Math.round(bandwidth * 10) / 10,
          label: label
        });
      }
    }

    peaks.sort(function (a, b) { return b.prominence - a.prominence; });
    return peaks.slice(0, 8);
  }

  function mergePeaks(peaks, mergeHz, topN) {
    if (!peaks || peaks.length === 0) return [];
    mergeHz = (typeof mergeHz === 'number') ? mergeHz : 5;
    topN = (typeof topN === 'number') ? topN : 3;

    var sorted = peaks.slice().sort(function (a, b) { return a.freq - b.freq; });
    var merged = [];

    for (var i = 0; i < sorted.length; i++) {
      var peak = sorted[i];
      var foundGroup = false;

      for (var m = 0; m < merged.length; m++) {
        if (Math.abs(merged[m].freq - peak.freq) <= mergeHz) {
          if (peak.prominence > merged[m].prominence) {
            merged[m] = peak;
          }
          foundGroup = true;
          break;
        }
      }

      if (!foundGroup) {
        merged.push(peak);
      }
    }

    merged.sort(function (a, b) { return b.prominence - a.prominence; });
    return merged.slice(0, topN);
  }

  function generateNotchParams(spectrumResult) {
    if (!spectrumResult || !spectrumResult.axes) {
      return { suggestions: [], perAxis: { roll: [], pitch: [], yaw: [] } };
    }

    var axisNames = ['roll', 'pitch', 'yaw'];
    var axisLabels = { roll: 'Roll', pitch: 'Pitch', yaw: 'Yaw' };
    var allSuggestions = [];
    var perAxis = { roll: [], pitch: [], yaw: [] };

    for (var a = 0; a < axisNames.length; a++) {
      var name = axisNames[a];
      var axisData = spectrumResult.axes[name];
      if (!axisData || !axisData.peaks) continue;

      var merged = mergePeaks(axisData.peaks, 5, 3);
      var motorPeaks = [];
      for (var p = 0; p < merged.length; p++) {
        if (merged[p].freq >= 50 && merged[p].freq <= 400) {
          motorPeaks.push(merged[p]);
        }
      }

      var count = Math.min(motorPeaks.length, 2);
      for (var n = 0; n < count; n++) {
        var peak = motorPeaks[n];
        var centerHz = peak.freq;
        var bw = peak.bandwidth;
        var q;
        if (bw && bw > 0) {
          q = centerHz / bw;
        } else {
          q = 3.5;
        }
        if (q < 2.0) q = 2.0;
        if (q > 10.0) q = 10.0;
        q = Math.round(q * 10) / 10;

        var cutoffHz = Math.round(centerHz * (1 - 1 / (2 * q)));
        if (cutoffHz < 40) cutoffHz = 40;

        var reason;
        if (motorPeaks.length === 1) {
          reason = axisLabels[name] + ' 轴 ' + centerHz + 'Hz ' + peak.label +
            ' (带宽 ' + (bw ? bw + 'Hz' : '未知') + ', Q=' + q + ')' +
            ' → Notch 滤波器可消除该频段噪声';
        } else {
          reason = axisLabels[name] + ' 检测到 ' + motorPeaks.length + ' 个谐振峰 (' +
            motorPeaks.map(function (pk) { return pk.freq + 'Hz'; }).join(' / ') +
            ') → Notch #' + (n + 1) + ' Q=' + q + ' (带宽 ' + (bw ? bw + 'Hz' : '未知') + ')';
        }

        var entry = {
          axis: name,
          axisLabel: axisLabels[name],
          notchNum: n + 1,
          centerHz: centerHz,
          cutoffHz: cutoffHz,
          q: q,
          bandwidth: bw || null,
          prominence: peak.prominence,
          reason: reason
        };

        allSuggestions.push(entry);
        perAxis[name].push(entry);
      }
    }

    return { suggestions: allSuggestions, perAxis: perAxis };
  }

  function buildThrottleSeries(motorFrames, motorOutputRange) {
    if (!motorFrames || !motorFrames.length) {
      return { series: [], validSamples: 0, range: normalizeMotorRange(motorOutputRange) };
    }

    var range = normalizeMotorRange(motorOutputRange);
    var maxLen = 0;
    for (var i = 0; i < motorFrames.length; i++) {
      if (motorFrames[i] && motorFrames[i].length > maxLen) {
        maxLen = motorFrames[i].length;
      }
    }

    var series = [];
    var validSamples = 0;

    for (var idx = 0; idx < maxLen; idx++) {
      var sum = 0;
      var count = 0;

      for (var m = 0; m < motorFrames.length; m++) {
        var val = motorFrames[m] ? motorFrames[m][idx] : null;
        if (typeof val === 'number' && isFinite(val) && val >= 500 && val < 2500) {
          sum += val;
          count++;
        }
      }

      if (!count) {
        series.push(null);
        continue;
      }

      var avg = sum / count;
      var pct = ((avg - range.min) / range.span) * 100;
      if (pct < 0) pct = 0;
      if (pct > 100) pct = 100;

      series.push(Math.round(pct * 10) / 10);
      validSamples++;
    }

    return { series: series, validSamples: validSamples, range: range };
  }

  function analyzeThrottleRanges(gyroData, throttleSeries, looptime, effectiveSampleRate, options) {
    options = options || {};

    var sampleRate = resolveSampleRate(looptime, effectiveSampleRate);
    var nyquist = sampleRate / 2;
    var bands = options.bands || DEFAULT_THROTTLE_BANDS;
    var windowSize = options.windowSize || 1024;
    var minSamples = options.minSamples || windowSize;
    var commonLength = resolveCommonLength(gyroData, throttleSeries);
    var results = [];

    if (!commonLength || !throttleSeries || throttleSeries.length === 0) {
      return {
        bands: buildEmptyBandResults(bands, minSamples),
        sampleRate: sampleRate,
        nyquist: nyquist,
        windowSize: windowSize,
        minSamples: minSamples,
        totalSamples: 0,
        dynamic: summarizeThrottleShift({ bands: [] }, options.dynamicShiftHz)
      };
    }

    // Cascading window sizes: try requested size first, then 512, then 256.
    // This prevents ALL bands from being skipped when data is fragmented.
    var fallbackSizes = [windowSize];
    if (windowSize > 512) fallbackSizes.push(512);
    if (windowSize > 256) fallbackSizes.push(256);

    for (var b = 0; b < bands.length; b++) {
      var band = bands[b];
      var runs = collectBandRuns(throttleSeries, commonLength, band);
      var totalSamples = countBandSamples(runs);
      var averageThrottle = computeBandAverage(throttleSeries, commonLength, band);

      // Try each window size until one produces usable windows
      var usedWindowSize = 0;
      var windows = [];
      var usableSamples = 0;
      for (var fi = 0; fi < fallbackSizes.length; fi++) {
        var trySize = fallbackSizes[fi];
        var tryWindows = buildWindowsFromRuns(runs, trySize);
        var tryUsable = tryWindows.length * trySize;
        if (tryUsable >= trySize) {
          usedWindowSize = trySize;
          windows = tryWindows;
          usableSamples = tryUsable;
          break;
        }
      }

      if (!usableSamples) {
        results.push({
          id: band.id,
          label: band.label,
          min: band.min,
          max: band.max,
          valid: false,
          sampleCount: totalSamples,
          usableSamples: 0,
          windowCount: 0,
          averageThrottle: averageThrottle,
          warning: buildInsufficientSamplesMessage(totalSamples, 0, 256, 256),
          spectrum: {
            axes: {
              roll: { frequencies: [], magnitudesDB: [], peaks: [] },
              pitch: { frequencies: [], magnitudesDB: [], peaks: [] },
              yaw: { frequencies: [], magnitudesDB: [], peaks: [] }
            },
            sampleRate: sampleRate,
            nyquist: nyquist
          },
          notch: { suggestions: [], perAxis: { roll: [], pitch: [], yaw: [] } },
          axisSummaries: emptyAxisSummaries()
        });
        continue;
      }

      var spectrum = analyzeWindowedSpectrum(gyroData, windows, sampleRate);
      var notch = generateNotchParams(spectrum);
      var axisSummaries = buildAxisSummaries(spectrum);

      // If a smaller window was used, note the resolution degradation
      var bandWarning = '';
      if (usedWindowSize < windowSize) {
        var resLabel = usedWindowSize >= 512 ? '标准' : '基础';
        bandWarning = 'FFT 使用 ' + usedWindowSize + ' 点窗口（分辨率' + resLabel + '），原始 ' + windowSize + ' 点窗口数据不足已自动降级。';
      }

      results.push({
        id: band.id,
        label: band.label,
        min: band.min,
        max: band.max,
        valid: true,
        sampleCount: totalSamples,
        usableSamples: usableSamples,
        windowCount: windows.length,
        windowSize: usedWindowSize,
        averageThrottle: averageThrottle,
        warning: bandWarning,
        spectrum: spectrum,
        notch: notch,
        axisSummaries: axisSummaries
      });
    }

    var analysis = {
      bands: results,
      sampleRate: sampleRate,
      nyquist: nyquist,
      windowSize: windowSize,
      minSamples: minSamples,
      totalSamples: commonLength
    };
    analysis.dynamic = summarizeThrottleShift(analysis, options.dynamicShiftHz);
    return analysis;
  }

  function summarizeThrottleShift(throttleAnalysis, dynamicShiftHz) {
    dynamicShiftHz = (typeof dynamicShiftHz === 'number') ? dynamicShiftHz : 30;

    var axisNames = ['roll', 'pitch', 'yaw'];
    var axisLabels = { roll: 'Roll', pitch: 'Pitch', yaw: 'Yaw' };
    var axes = {};
    var dynamicAxes = [];
    var notes = [];
    var bands = (throttleAnalysis && throttleAnalysis.bands) ? throttleAnalysis.bands : [];

    for (var a = 0; a < axisNames.length; a++) {
      var axis = axisNames[a];
      var samples = [];

      for (var b = 0; b < bands.length; b++) {
        var band = bands[b];
        if (!band.valid || !band.axisSummaries || !band.axisSummaries[axis]) continue;

        var primary = band.axisSummaries[axis].primaryPeak;
        if (!primary) continue;

        samples.push({
          bandLabel: band.label,
          freq: primary.freq,
          prominence: primary.prominence
        });
      }

      var summary = {
        axis: axis,
        axisLabel: axisLabels[axis],
        bandPeaks: samples,
        sampleCount: samples.length,
        dynamic: false,
        shiftHz: 0,
        minFreq: null,
        maxFreq: null
      };

      if (samples.length >= 2) {
        var freqs = samples.map(function (item) { return item.freq; });
        var minFreq = Math.min.apply(Math, freqs);
        var maxFreq = Math.max.apply(Math, freqs);
        var shiftHz = maxFreq - minFreq;

        summary.minFreq = minFreq;
        summary.maxFreq = maxFreq;
        summary.shiftHz = shiftHz;
        summary.dynamic = shiftHz >= dynamicShiftHz;

        if (summary.dynamic) {
          dynamicAxes.push(summary);
          notes.push(
            axisLabels[axis] + ' 轴主共振峰在不同油门段之间变化 ' +
            shiftHz + 'Hz（' + minFreq + '-' + maxFreq + 'Hz），建议优先依赖动态 Notch。'
          );
        }
      }

      axes[axis] = summary;
    }

    return {
      thresholdHz: dynamicShiftHz,
      axes: axes,
      dynamicAxes: dynamicAxes,
      notes: notes
    };
  }

  function analyzeWindowedSpectrum(gyroData, windows, sampleRate) {
    var axisNames = ['roll', 'pitch', 'yaw'];
    var axes = {};
    var nyquist = sampleRate / 2;

    for (var a = 0; a < axisNames.length; a++) {
      var axis = axisNames[a];
      var source = gyroData[axis] || [];
      var accum = null;
      var frequencies = null;
      var count = 0;

      for (var w = 0; w < windows.length; w++) {
        var win = windows[w];
        if (win.end > source.length) continue;

        var signal = source.slice(win.start, win.end);
        var fft = _FFT.fft(signal, sampleRate);

        if (!accum) {
          accum = new Float64Array(fft.magnitudes.length);
          frequencies = fft.frequencies;
        }

        for (var i = 0; i < fft.magnitudes.length; i++) {
          accum[i] += fft.magnitudes[i];
        }
        count++;
      }

      if (!accum || !count) {
        axes[axis] = { frequencies: [], magnitudesDB: [], peaks: [] };
        continue;
      }

      for (var m = 0; m < accum.length; m++) {
        accum[m] = accum[m] / count;
      }

      var db = _FFT.toDecibels(accum);
      axes[axis] = {
        frequencies: Array.from(frequencies),
        magnitudesDB: Array.from(db),
        peaks: detectPeaks(frequencies, db, nyquist)
      };
    }

    return { axes: axes, sampleRate: sampleRate, nyquist: nyquist };
  }

  function buildAxisSummaries(spectrum) {
    var axisNames = ['roll', 'pitch', 'yaw'];
    var summary = {};

    for (var a = 0; a < axisNames.length; a++) {
      var axis = axisNames[a];
      var axisData = spectrum.axes[axis];
      var merged = axisData ? mergePeaks(axisData.peaks, 5, 3) : [];
      var motorPeaks = filterMotorRangePeaks(merged);

      summary[axis] = {
        peaks: merged,
        motorPeaks: motorPeaks,
        primaryPeak: motorPeaks.length ? motorPeaks[0] : (merged.length ? merged[0] : null)
      };
    }

    return summary;
  }

  function emptyAxisSummaries() {
    return {
      roll: { peaks: [], motorPeaks: [], primaryPeak: null },
      pitch: { peaks: [], motorPeaks: [], primaryPeak: null },
      yaw: { peaks: [], motorPeaks: [], primaryPeak: null }
    };
  }

  function resolveSampleRate(looptime, effectiveSampleRate) {
    if (effectiveSampleRate && effectiveSampleRate > 0) {
      return effectiveSampleRate;
    }
    return looptime > 0 ? 1e6 / looptime : 4000;
  }

  function normalizeMotorRange(motorOutputRange) {
    var min = 1000;
    var max = 2000;

    if (motorOutputRange && motorOutputRange.length >= 2) {
      var parsedMin = Number(motorOutputRange[0]);
      var parsedMax = Number(motorOutputRange[1]);
      if (isFinite(parsedMin) && isFinite(parsedMax) && parsedMax > parsedMin) {
        min = parsedMin;
        max = parsedMax;
      }
    }

    return {
      min: min,
      max: max,
      span: Math.max(1, max - min)
    };
  }

  function resolveCommonLength(gyroData, throttleSeries) {
    var lengths = [];
    var axisNames = ['roll', 'pitch', 'yaw'];

    if (throttleSeries && throttleSeries.length) {
      lengths.push(throttleSeries.length);
    }

    for (var a = 0; a < axisNames.length; a++) {
      var data = gyroData[axisNames[a]];
      if (data && data.length) {
        lengths.push(data.length);
      }
    }

    if (!lengths.length) return 0;

    var min = lengths[0];
    for (var i = 1; i < lengths.length; i++) {
      if (lengths[i] < min) min = lengths[i];
    }
    return min;
  }

  function collectBandRuns(throttleSeries, commonLength, band) {
    var runs = [];
    var start = -1;

    for (var i = 0; i < commonLength; i++) {
      var pct = throttleSeries[i];
      var inBand = isThrottleInBand(pct, band);

      if (inBand) {
        if (start === -1) start = i;
      } else if (start !== -1) {
        runs.push({ start: start, end: i });
        start = -1;
      }
    }

    if (start !== -1) {
      runs.push({ start: start, end: commonLength });
    }

    return runs;
  }

  function countBandSamples(runs) {
    var total = 0;
    for (var i = 0; i < runs.length; i++) {
      total += (runs[i].end - runs[i].start);
    }
    return total;
  }

  function buildWindowsFromRuns(runs, windowSize) {
    var windows = [];

    for (var i = 0; i < runs.length; i++) {
      var run = runs[i];
      for (var start = run.start; start + windowSize <= run.end; start += windowSize) {
        windows.push({ start: start, end: start + windowSize });
      }
    }

    return windows;
  }

  function computeBandAverage(throttleSeries, commonLength, band) {
    var sum = 0;
    var count = 0;

    for (var i = 0; i < commonLength; i++) {
      var pct = throttleSeries[i];
      if (!isThrottleInBand(pct, band)) continue;
      sum += pct;
      count++;
    }

    if (!count) return null;
    return Math.round((sum / count) * 10) / 10;
  }

  function isThrottleInBand(pct, band) {
    if (typeof pct !== 'number' || !isFinite(pct)) return false;
    if (band.max === 100) return pct >= band.min && pct <= band.max;
    return pct >= band.min && pct < band.max;
  }

  function buildInsufficientSamplesMessage(totalSamples, usableSamples, minSamples, windowSize) {
    if (!totalSamples) {
      return '该油门段没有可用样本，已跳过分段 FFT。';
    }
    if (!usableSamples) {
      return '该油门段虽然有样本，但没有连续的 ' + windowSize + ' 点窗口，已跳过以避免噪声结果。';
    }
    return '该油门段仅获得 ' + usableSamples + ' 个可用样本，低于最少 ' + minSamples + ' 点要求，已跳过。';
  }

  function buildEmptyBandResults(bands, minSamples) {
    var items = [];
    for (var i = 0; i < bands.length; i++) {
      items.push({
        id: bands[i].id,
        label: bands[i].label,
        min: bands[i].min,
        max: bands[i].max,
        valid: false,
        sampleCount: 0,
        usableSamples: 0,
        windowCount: 0,
        averageThrottle: null,
        warning: '未找到油门轨迹数据，无法进行该分段的 FFT 分析。',
        spectrum: {
          axes: {
            roll: { frequencies: [], magnitudesDB: [], peaks: [] },
            pitch: { frequencies: [], magnitudesDB: [], peaks: [] },
            yaw: { frequencies: [], magnitudesDB: [], peaks: [] }
          },
          sampleRate: 0,
          nyquist: 0
        },
        notch: { suggestions: [], perAxis: { roll: [], pitch: [], yaw: [] } },
        axisSummaries: emptyAxisSummaries()
      });
    }
    return items;
  }

  function filterMotorRangePeaks(peaks) {
    var result = [];
    for (var i = 0; i < peaks.length; i++) {
      if (peaks[i].freq >= 80 && peaks[i].freq <= 500) {
        result.push(peaks[i]);
      }
    }
    return result;
  }

  exports.SpectrumAnalyzer = {
    DEFAULT_THROTTLE_BANDS: DEFAULT_THROTTLE_BANDS,
    analyzeSpectrum: analyzeSpectrum,
    detectPeaks: detectPeaks,
    mergePeaks: mergePeaks,
    generateNotchParams: generateNotchParams,
    buildThrottleSeries: buildThrottleSeries,
    analyzeThrottleRanges: analyzeThrottleRanges,
    summarizeThrottleShift: summarizeThrottleShift
  };
})(typeof window !== 'undefined' ? window : module.exports);
